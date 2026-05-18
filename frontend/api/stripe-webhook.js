require('dotenv').config({ path: '.env.local' });

const Stripe     = require('stripe');
const { google } = require('googleapis');
const { Resend } = require('resend');

const TIMEZONE        = process.env.TIMEZONE         || 'Europe/Madrid';
const NOTIFICATION_EMAIL = process.env.NOTIFICATION_EMAIL || 'contacto@nocteastudio.com';
const FROM_EMAIL      = process.env.FROM_EMAIL        || 'contacto@nocteastudio.com';
const SUPPORT_EMAIL   = 'contacto@nocteastudio.com';

// ── Handler principal ────────────────────────────────────────────────────────

async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end('Method not allowed');

  const sig = req.headers['stripe-signature'];
  if (!sig || !process.env.STRIPE_WEBHOOK_SECRET || !process.env.STRIPE_SECRET_KEY) {
    console.error('[webhook] Faltan STRIPE_SECRET_KEY o STRIPE_WEBHOOK_SECRET.');
    return res.status(400).end('Missing Stripe configuration.');
  }

  // Vercel: necesitamos el body crudo para verificar la firma
  let rawBody;
  try { rawBody = await getRawBody(req); }
  catch (e) { console.error('[webhook] Error leyendo body:', e.message); return res.status(400).end('Cannot read body.'); }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] Firma inválida:', err.message);
    return res.status(400).end(`Webhook error: ${err.message}`);
  }

  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true });
  }

  const session    = event.data.object;
  const meta       = session.metadata || {};
  const amount     = session.amount_total || 0;

  console.log(`[webhook] ✅ checkout.session.completed`);
  console.log(`[webhook] Session: ${session.id}`);
  console.log(`[webhook] Importe: ${amount} céntimos`);

  // ── Productos directos (9€/15€): sin calendario, email simple ───────────
  const isEsencial = amount === 900;
  const isProfunda = amount === 1500;

  if (isEsencial || isProfunda) {
    const clientEmail = session.customer_details?.email || meta.email;
    console.log(`[webhook] Producto directo (${amount / 100}€) — cliente: ${clientEmail}`);
    try {
      await sendSimpleEmail({ amount, clientEmail, sessionId: session.id });
      console.log('[email] ✅ Email de consulta directa enviado.');
    } catch (emailErr) {
      console.error(`[email] ❌ Error: ${emailErr.message}`);
    }
    return res.status(200).json({ received: true });
  }

  // ── Consulta NOCTEA (32€) — flujo completo con Google Calendar ──────────
  console.log(`[webhook] Cliente: ${meta.nombre} <${meta.email}>`);
  console.log(`[webhook] Reserva: ${meta.fecha_reserva} ${meta.horario_inicio}–${meta.horario_fin}`);
  console.log(`[webhook] Calendar ID: ${process.env.GOOGLE_CALENDAR_ID}`);

  // ── 1. Google Calendar ───────────────────────────────────────────────────
  let calResult = {};
  try {
    calResult = await createCalendarEvent(session.id, meta);
    if (calResult.eventId) console.log(`[calendar] ✅ Evento creado: ${calResult.eventId}`);
    if (calResult.skipped)  console.log(`[calendar] ⏭️  Sesión ya procesada, ignorando.`);
    if (calResult.conflict) console.warn(`[calendar] ⚠️  Conflicto de horario para ${meta.fecha_reserva} ${meta.horario_inicio}.`);
  } catch (calErr) {
    console.error(`[calendar] ❌ Error: ${calErr.message}`);
    console.error(`[calendar] Código: ${calErr.code || calErr.status || 'n/a'}`);
    calResult = { calendarError: true, errorMsg: calErr.message };
  }

  // ── 2. Emails (siempre, salvo reintentos ya procesados) ─────────────────
  if (!calResult.skipped) {
    try {
      await sendEmails({
        meta,
        sessionId:    session.id,
        amountPaid:   session.amount_total,
        paymentDate:  new Date((session.created || Date.now() / 1000) * 1000),
        calConflict:  Boolean(calResult.conflict),
        calError:     Boolean(calResult.calendarError),
        eventId:      calResult.eventId || null,
      });
      console.log('[email] ✅ Emails enviados.');
    } catch (emailErr) {
      console.error(`[email] ❌ Error: ${emailErr.message}`);
    }
  }

  return res.status(200).json({ received: true });
}

handler.config = { api: { bodyParser: false } };
module.exports  = handler;

// ── Helpers ──────────────────────────────────────────────────────────────────

function getRawBody(req) {
  return new Promise((resolve, reject) => {
    if (req.body instanceof Buffer) { resolve(req.body); return; }
    const chunks = [];
    req.on('data',  c => chunks.push(c));
    req.on('end',   ()  => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function getMadridOffset(dateStr) {
  const d   = new Date(dateStr + 'T12:00:00Z');
  const y   = d.getUTCFullYear();
  const lsm = new Date(Date.UTC(y, 2, 31 - new Date(Date.UTC(y, 2, 31)).getUTCDay()));
  const lso = new Date(Date.UTC(y, 9, 31 - new Date(Date.UTC(y, 9, 31)).getUTCDay()));
  return (d >= lsm && d < lso) ? '+02:00' : '+01:00';
}

async function createCalendarEvent(sessionId, meta) {
  const { nombre, email, telefono, mensaje,
    fecha_reserva, horario_inicio, horario_fin, horario_label, preferencia_contacto } = meta;

  if (!fecha_reserva || !horario_inicio || !horario_fin) {
    console.error('[calendar] Metadata incompleta: faltan fecha u horario.');
    return { error: true };
  }

  const calId = process.env.GOOGLE_CALENDAR_ID;
  const saJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  // ── Logs de diagnóstico seguros ───────────────────────────────────────────
  console.log('[calendar:diag] --- Variables en runtime ---');
  console.log(`[calendar:diag] GOOGLE_CALENDAR_ID          : ${calId
    ? calId.slice(0, 8) + '...' + calId.slice(-8) : '(no definido)'}`);
  console.log(`[calendar:diag] GOOGLE_SERVICE_ACCOUNT_JSON : ${saJson ? '✅ definida' : '❌ no definida'}`);

  if (!calId || !saJson) {
    console.error('[calendar] ❌ Faltan GOOGLE_CALENDAR_ID o GOOGLE_SERVICE_ACCOUNT_JSON.');
    return { error: true };
  }

  let credentials;
  try {
    credentials = JSON.parse(saJson);
  } catch (parseErr) {
    console.error('[calendar] ❌ GOOGLE_SERVICE_ACCOUNT_JSON no es JSON válido:', parseErr.message);
    return { error: true };
  }

  console.log(`[calendar] Service account email: ${credentials.client_email}`);
  console.log(`[calendar] Calendar ID: ${calId.slice(0, 8)}...${calId.slice(-8)}`);
  console.log(`[calendar:diag] Intentando crear evento: ${fecha_reserva} ${horario_inicio}–${horario_fin}`);

  const auth = new google.auth.JWT(
    credentials.client_email,
    null,
    credentials.private_key,
    ['https://www.googleapis.com/auth/calendar']
  );

  try {
    await auth.authorize();
    console.log('[calendar] ✅ Auth JWT OK');
  } catch (authErr) {
    console.error('[calendar] ❌ Auth error:', authErr.message);
    console.error('[calendar] Auth error code:', authErr.code || 'n/a');
    throw authErr;
  }

  const calendar  = google.calendar({ version: 'v3', auth });
  const offset    = getMadridOffset(fecha_reserva);
  const slotStart = new Date(`${fecha_reserva}T${horario_inicio}:00${offset}`);
  const slotEnd   = new Date(`${fecha_reserva}T${horario_fin}:00${offset}`);

  console.log(`[calendar:diag] slotStart ISO : ${slotStart.toISOString()}`);
  console.log(`[calendar:diag] slotEnd ISO   : ${slotEnd.toISOString()}`);
  console.log(`[calendar:diag] offset Madrid  : ${offset}`);

  // Verificar disponibilidad + idempotencia
  let checkRes;
  try {
    checkRes = await calendar.events.list({
      calendarId: calId, timeMin: slotStart.toISOString(),
      timeMax: slotEnd.toISOString(), singleEvents: true,
    });
    console.log(`[calendar] events.list OK — ${(checkRes.data.items || []).length} evento(s) encontrado(s) en ese slot`);
  } catch (listErr) {
    const gErr = listErr.response?.data?.error || {};
    console.error(`[calendar] ❌ events.list falló — HTTP ${listErr.code || listErr.status}`);
    console.error(`[calendar]   Google error code    : ${gErr.code || 'n/a'}`);
    console.error(`[calendar]   Google error message : ${gErr.message || listErr.message}`);
    console.error(`[calendar]   Google error status  : ${gErr.status || 'n/a'}`);
    throw listErr;
  }

  const existing  = checkRes.data.items || [];

  if (existing.some(e => e.description?.includes(sessionId))) return { skipped: true };
  if (existing.some(e => e.start?.dateTime && e.end?.dateTime)) return { conflict: true };

  const label = horario_label || `${horario_inicio}–${horario_fin}`;
  const desc  = [
    `Cliente: ${nombre || '—'}`,
    `Email: ${email || '—'}`,
    telefono             ? `Teléfono: ${telefono}`             : null,
    `Horario: ${label}`,
    preferencia_contacto ? `Vía: ${preferencia_contacto}`      : null,
    mensaje              ? `Mensaje: ${mensaje}`               : null,
    '',
    `Importe: 25 €`,
    `Estado: Pago confirmado vía Stripe`,
    `Stripe Session: ${sessionId}`,
    `Origen: Noctea Studio Web`,
  ].filter(l => l !== null).join('\n');

  let created;
  try {
    created = await calendar.events.insert({
      calendarId: calId,
      resource: {
        summary:     `Sesión NOCTEA — ${nombre || 'Cliente'}`,
        description: desc,
        start: { dateTime: slotStart.toISOString(), timeZone: TIMEZONE },
        end:   { dateTime: slotEnd.toISOString(),   timeZone: TIMEZONE },
        reminders: { useDefault: false, overrides: [
          { method: 'email', minutes: 60 },
          { method: 'popup', minutes: 15 },
        ]},
      },
      sendUpdates: 'none',
    });
    console.log(`[calendar] ✅ Evento creado correctamente. ID: ${created.data.id}`);
  } catch (insertErr) {
    const gErr = insertErr.response?.data?.error || {};
    console.error(`[calendar] ❌ events.insert falló — HTTP ${insertErr.code || insertErr.status}`);
    console.error(`[calendar]   Google error code    : ${gErr.code || 'n/a'}`);
    console.error(`[calendar]   Google error message : ${gErr.message || insertErr.message}`);
    console.error(`[calendar]   Google error status  : ${gErr.status || 'n/a'}`);
    throw insertErr;
  }

  return { eventId: created.data.id };
}

async function sendEmails({ meta, sessionId, amountPaid, paymentDate, calConflict, calError, eventId }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[email] RESEND_API_KEY no configurado.');
    return;
  }

  const { nombre, email, telefono, mensaje,
    fecha_reserva, horario_label, horario_inicio, horario_fin, preferencia_contacto } = meta;

  if (!email) { console.warn('[email] Sin email de cliente.'); return; }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const label  = horario_label || `${horario_inicio}–${horario_fin}`;
  const fechaDisplay = new Date(fecha_reserva + 'T12:00:00Z').toLocaleDateString('es-ES', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const paymentDateDisplay = (paymentDate || new Date()).toLocaleDateString('es-ES', {
    day: 'numeric', month: 'long', year: 'numeric',
  });

  const row = (label, value) => `
    <tr>
      <td style="padding:10px 16px;font-family:sans-serif;font-size:12px;letter-spacing:0.06em;text-transform:uppercase;color:#9aaa99;white-space:nowrap;vertical-align:top;width:38%;">${label}</td>
      <td style="padding:10px 16px;font-family:sans-serif;font-size:14px;color:#1a2e1a;font-weight:500;vertical-align:top;">${value}</td>
    </tr>`;

  const td = (label, value) => `
    <tr>
      <td style="padding:8px 12px;font-family:sans-serif;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#888;white-space:nowrap;vertical-align:top;width:30%;border-bottom:1px solid #f0ece2;">${label}</td>
      <td style="padding:8px 12px;font-family:sans-serif;font-size:13px;color:#1a2e1a;vertical-align:top;border-bottom:1px solid #f0ece2;">${value}</td>
    </tr>`;

  // ── Email al cliente — diseño premium ────────────────────────────────────
  const clientHtml = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Confirmación NOCTEA STUDIO</title>
</head>
<body style="margin:0;padding:0;background:#F0EBE0;font-family:sans-serif;">

<table width="100%" cellpadding="0" cellspacing="0" style="background:#F0EBE0;padding:48px 20px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">

  <!-- Cabecera verde noche -->
  <tr>
    <td style="background:#061A12;border-radius:14px 14px 0 0;padding:36px 48px;text-align:center;">
      <p style="margin:0 0 6px;font-size:10px;letter-spacing:0.3em;color:#C9A85A;text-transform:uppercase;">✦ NOCTEA STUDIO ✦</p>
      <p style="margin:0;font-size:11px;letter-spacing:0.12em;color:rgba(255,253,247,0.38);text-transform:uppercase;">Lecturas que iluminan tu camino</p>
    </td>
  </tr>

  <!-- Franja dorada -->
  <tr><td style="background:linear-gradient(90deg,#b8943a,#C9A85A,#b8943a);height:2px;"></td></tr>

  <!-- Cuerpo principal -->
  <tr>
    <td style="background:#FFFDF7;padding:48px 48px 36px;">

      <!-- Título -->
      <h1 style="margin:0 0 10px;font-family:Georgia,'Times New Roman',serif;font-size:28px;font-weight:400;color:#061A12;line-height:1.25;text-align:center;">
        Gracias por confiar en<br>NOCTEA STUDIO
      </h1>
      <p style="margin:0 0 8px;text-align:center;font-size:14px;color:#2F6B3C;line-height:1.6;">
        Tu pago ha sido procesado correctamente.
      </p>
      <p style="margin:0 0 36px;text-align:center;font-size:13px;color:#888;line-height:1.6;">
        A continuación encontrarás el detalle de tu reserva.
      </p>

      <!-- Separador dorado -->
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:32px;">
        <tr>
          <td style="width:45%;border-top:1px solid #e4ddd0;"></td>
          <td style="width:10%;text-align:center;font-size:12px;color:#C9A85A;padding:0 8px;">✦</td>
          <td style="width:45%;border-top:1px solid #e4ddd0;"></td>
        </tr>
      </table>

      <!-- Bloque: Detalle de pago -->
      <p style="margin:0 0 10px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#C9A85A;font-weight:600;">Detalle de pago</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F3EA;border-radius:10px;margin-bottom:24px;border:1px solid #e8e2d8;overflow:hidden;">
        ${row('Importe pagado', '<strong style="color:#061A12;">25 €</strong>')}
        <tr><td colspan="2" style="border-top:1px solid #e8e2d8;"></td></tr>
        ${row('Fecha de pago', paymentDateDisplay)}
        <tr><td colspan="2" style="border-top:1px solid #e8e2d8;"></td></tr>
        ${row('Método', 'Tarjeta · Procesado por Stripe')}
      </table>

      <!-- Bloque: Detalle de reserva -->
      <p style="margin:0 0 10px;font-size:10px;letter-spacing:0.18em;text-transform:uppercase;color:#C9A85A;font-weight:600;">Detalle de tu reserva</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#F7F3EA;border-radius:10px;margin-bottom:32px;border:1px solid #e8e2d8;overflow:hidden;">
        ${row('Sesión', 'Sesión NOCTEA STUDIO — Lectura completa')}
        <tr><td colspan="2" style="border-top:1px solid #e8e2d8;"></td></tr>
        ${row('Día', fechaDisplay)}
        <tr><td colspan="2" style="border-top:1px solid #e8e2d8;"></td></tr>
        ${row('Horario', label)}
        <tr><td colspan="2" style="border-top:1px solid #e8e2d8;"></td></tr>
        ${row('Duración', '30 minutos')}
        <tr><td colspan="2" style="border-top:1px solid #e8e2d8;"></td></tr>
        ${row('Modalidad', preferencia_contacto || 'Online')}
      </table>

      <!-- Contacto -->
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#EEF4ED;border-radius:10px;margin-bottom:36px;border:1px solid #d3e4d0;">
        <tr>
          <td style="padding:20px 24px;text-align:center;">
            <p style="margin:0 0 4px;font-size:13px;color:#2F6B3C;font-weight:600;">¿Tenés alguna consulta?</p>
            <a href="mailto:${SUPPORT_EMAIL}" style="font-size:13px;color:#1a5a2a;text-decoration:none;font-weight:500;">${SUPPORT_EMAIL}</a>
          </td>
        </tr>
      </table>

      <!-- Firma -->
      <p style="margin:0 0 4px;text-align:center;font-family:Georgia,serif;font-size:15px;color:#2F6B3C;font-style:italic;">Con cariño,</p>
      <p style="margin:0;text-align:center;font-size:13px;letter-spacing:0.12em;color:#061A12;text-transform:uppercase;font-weight:600;">NOCTEA STUDIO</p>

    </td>
  </tr>

  <!-- Footer verde noche -->
  <tr>
    <td style="background:#061A12;border-radius:0 0 14px 14px;padding:22px 48px;text-align:center;">
      <p style="margin:0;font-size:11px;color:rgba(255,253,247,0.35);line-height:1.7;">
        La lectura NOCTEA STUDIO es una guía simbólica y espiritual.<br>
        No reemplaza asesoramiento médico, psicológico, legal ni financiero.
      </p>
    </td>
  </tr>

</table>
</td></tr>
</table>
</body></html>`;

  // ── Email interno a Noctea ───────────────────────────────────────────────
  const calStatus = calConflict
    ? `<tr><td colspan="2" style="padding:10px 12px;background:#fff3cd;border-radius:6px;font-family:sans-serif;font-size:13px;color:#856404;">
        ⚠️ <strong>CONFLICTO DE HORARIO:</strong> ${label} ya estaba ocupado. Coordinar manualmente con el cliente.
       </td></tr>`
    : calError
    ? `<tr><td colspan="2" style="padding:10px 12px;background:#f8d7da;border-radius:6px;font-family:sans-serif;font-size:13px;color:#842029;">
        ❌ <strong>ERROR EN GOOGLE CALENDAR:</strong> el evento no se creó automáticamente. Crear manualmente.
       </td></tr>`
    : eventId
    ? `<tr><td colspan="2" style="padding:8px 12px;background:#d1e7dd;border-radius:6px;font-family:sans-serif;font-size:13px;color:#0a3622;">
        ✅ Evento creado en Google Calendar correctamente.
       </td></tr>`
    : '';

  const nocteaHtml = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f0e8;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:40px 20px;">
<tr><td align="center">
<table width="100%" style="max-width:520px;background:#fff;border-radius:12px;overflow:hidden;">
  <tr><td style="background:#061A12;padding:20px 28px;">
    <p style="margin:0;font-family:sans-serif;font-size:11px;letter-spacing:0.15em;color:#C9A85A;text-transform:uppercase;">NOCTEA STUDIO — Nueva reserva</p>
  </td></tr>
  <tr><td style="padding:28px;">
    <h2 style="margin:0 0 20px;font-family:Georgia,serif;font-weight:400;color:#061A12;font-size:22px;">
      ${calError ? '⚠️ ' : ''}Reserva confirmada · ${fechaDisplay}
    </h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e8e4da;">
      ${calStatus}
      ${td('Nombre',   nombre || '—')}
      ${td('Email',    `<a href="mailto:${email}" style="color:#2F6B3C;">${email}</a>`)}
      ${td('Teléfono', telefono || '—')}
      ${td('Fecha',    fechaDisplay)}
      ${td('Horario',  label)}
      ${td('Vía',      preferencia_contacto || '—')}
      ${mensaje ? td('Mensaje', `<em>${mensaje}</em>`) : ''}
      ${td('Importe',  `<strong>${((amountPaid || 2500) / 100).toFixed(2)} €</strong>`)}
      ${td('Pago',     'Confirmado vía Stripe')}
      ${td('Stripe ID', `<span style="font-size:11px;color:#aaa;">${sessionId}</span>`)}
    </table>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  console.log(`[email:diag] FROM_EMAIL        : ${FROM_EMAIL}`);
  console.log(`[email:diag] NOTIFICATION_EMAIL: ${NOTIFICATION_EMAIL}`);
  console.log(`[email:diag] to cliente        : ${email}`);
  console.log(`[email:diag] RESEND_API_KEY    : ${process.env.RESEND_API_KEY ? '✅ definida' : '❌ no definida'}`);

  const [r1, r2] = await Promise.all([
    resend.emails.send({
      from:    `NOCTEA <${FROM_EMAIL}>`,
      to:      email,
      subject: 'Confirmación de tu sesión NOCTEA',
      html:    clientHtml,
    }),
    resend.emails.send({
      from:    `NOCTEA Web <${FROM_EMAIL}>`,
      to:      NOTIFICATION_EMAIL,
      subject: calConflict
        ? `⚠️ CONFLICTO — Reserva pagada — ${nombre} · ${fechaDisplay}`
        : calError
        ? `❌ ERROR CALENDAR — Reserva pagada — ${nombre} · ${fechaDisplay}`
        : `✅ Nueva reserva — ${nombre} · ${fechaDisplay}`,
      html:    nocteaHtml,
    }),
  ]);

  console.log(`[email] ✅ Email cliente enviado  — id: ${r1?.data?.id || r1?.id || 'n/a'}`);
  console.log(`[email] ✅ Email interno enviado  — id: ${r2?.data?.id || r2?.id || 'n/a'}`);
}

// ── Email simple para Consulta Esencial (9€) y Consulta Profunda (15€) ──────

async function sendSimpleEmail({ amount, clientEmail, sessionId }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[email] RESEND_API_KEY no configurado.');
    return;
  }
  if (!clientEmail) {
    console.warn('[email] Sin email de cliente para consulta directa.');
    return;
  }

  const resend = new Resend(process.env.RESEND_API_KEY);
  const isEsencial = amount === 900;

  const subject = isEsencial
    ? 'Tu Consulta Esencial de Noctea está confirmada'
    : 'Tu Consulta Profunda de Noctea está confirmada';

  const whatsappInstructions = isEsencial
    ? `<li style="margin-bottom:8px;">Tu <strong>nombre</strong></li>
       <li style="margin-bottom:8px;">Una <strong>pregunta concreta</strong></li>
       <li style="margin-bottom:8px;">Cualquier contexto breve que consideres importante</li>`
    : `<li style="margin-bottom:8px;">Tu <strong>nombre</strong></li>
       <li style="margin-bottom:8px;">Hasta <strong>dos preguntas relacionadas</strong></li>
       <li style="margin-bottom:8px;">Cualquier contexto breve que consideres importante</li>`;

  const extraNote = isEsencial
    ? ''
    : `<p style="margin:0 0 16px;font-size:14px;color:#444;line-height:1.7;">
        Esta lectura incluye mensaje del <strong>Oráculo Green Witch</strong>.
       </p>`;

  const consultaName = isEsencial ? 'Consulta Esencial' : 'Consulta Profunda';

  const clientHtml = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#F0EBE0;font-family:sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F0EBE0;padding:48px 20px;">
<tr><td align="center">
<table width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;">
  <tr>
    <td style="background:#061A12;border-radius:14px 14px 0 0;padding:36px 48px;text-align:center;">
      <p style="margin:0 0 6px;font-size:10px;letter-spacing:0.3em;color:#C9A85A;text-transform:uppercase;">✦ NOCTEA STUDIO ✦</p>
      <p style="margin:0;font-size:11px;letter-spacing:0.12em;color:rgba(255,253,247,0.38);text-transform:uppercase;">Lecturas que iluminan tu camino</p>
    </td>
  </tr>
  <tr><td style="background:linear-gradient(90deg,#b8943a,#C9A85A,#b8943a);height:2px;"></td></tr>
  <tr>
    <td style="background:#FFFDF7;padding:48px 48px 36px;">
      <h1 style="margin:0 0 10px;font-family:Georgia,'Times New Roman',serif;font-size:26px;font-weight:400;color:#061A12;line-height:1.25;text-align:center;">
        Tu ${consultaName} está confirmada
      </h1>
      <p style="margin:0 0 32px;text-align:center;font-size:14px;color:#2F6B3C;line-height:1.6;">
        Gracias por confiar en Noctea Studio.
      </p>
      <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
        <tr>
          <td style="width:45%;border-top:1px solid #e4ddd0;"></td>
          <td style="width:10%;text-align:center;font-size:12px;color:#C9A85A;padding:0 8px;">✦</td>
          <td style="width:45%;border-top:1px solid #e4ddd0;"></td>
        </tr>
      </table>
      <p style="margin:0 0 12px;font-size:14px;color:#1a2e1a;line-height:1.7;">
        Para preparar tu lectura, envíanos por <strong>WhatsApp</strong>:
      </p>
      <ul style="margin:0 0 24px;padding-left:20px;font-size:14px;color:#444;line-height:1.7;">
        ${whatsappInstructions}
      </ul>
      <table width="100%" cellpadding="0" cellspacing="0" style="background:#EEF4ED;border-radius:10px;margin-bottom:24px;border:1px solid #d3e4d0;">
        <tr>
          <td style="padding:18px 24px;text-align:center;">
            <p style="margin:0 0 4px;font-size:14px;color:#2F6B3C;font-weight:600;">Recibirás tu audio en menos de 24 horas.</p>
          </td>
        </tr>
      </table>
      ${extraNote}
      <p style="margin:0 0 32px;font-size:12px;color:#999;line-height:1.7;font-style:italic;">
        Esta lectura es simbólica y orientativa. No sustituye asesoramiento médico, psicológico, legal o financiero. No realizamos lecturas sobre salud, embarazo, temas legales o diagnósticos médicos.
      </p>
      <p style="margin:0 0 4px;text-align:center;font-family:Georgia,serif;font-size:15px;color:#2F6B3C;font-style:italic;">Con cariño,</p>
      <p style="margin:0;text-align:center;font-size:13px;letter-spacing:0.12em;color:#061A12;text-transform:uppercase;font-weight:600;">NOCTEA STUDIO</p>
    </td>
  </tr>
  <tr>
    <td style="background:#061A12;border-radius:0 0 14px 14px;padding:22px 48px;text-align:center;">
      <p style="margin:0;font-size:11px;color:rgba(255,253,247,0.35);line-height:1.7;">
        La lectura NOCTEA STUDIO es una guía simbólica y espiritual.<br>
        No reemplaza asesoramiento médico, psicológico, legal ni financiero.
      </p>
    </td>
  </tr>
</table>
</td></tr>
</table>
</body></html>`;

  const internalHtml = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f0e8;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:40px 20px;">
<tr><td align="center">
<table width="100%" style="max-width:480px;background:#fff;border-radius:12px;overflow:hidden;">
  <tr><td style="background:#061A12;padding:20px 28px;">
    <p style="margin:0;font-family:sans-serif;font-size:11px;letter-spacing:0.15em;color:#C9A85A;text-transform:uppercase;">NOCTEA — ${consultaName} · ${(amount / 100).toFixed(2)} €</p>
  </td></tr>
  <tr><td style="padding:24px;">
    <h2 style="margin:0 0 16px;font-family:Georgia,serif;font-weight:400;color:#061A12;font-size:20px;">Nuevo pago recibido</h2>
    <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eee;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:10px 14px;font-size:12px;text-transform:uppercase;color:#888;width:35%;border-bottom:1px solid #f0f0f0;">Producto</td><td style="padding:10px 14px;font-size:13px;color:#1a2e1a;border-bottom:1px solid #f0f0f0;">${consultaName}</td></tr>
      <tr><td style="padding:10px 14px;font-size:12px;text-transform:uppercase;color:#888;border-bottom:1px solid #f0f0f0;">Importe</td><td style="padding:10px 14px;font-size:13px;font-weight:600;color:#1a2e1a;border-bottom:1px solid #f0f0f0;">${(amount / 100).toFixed(2)} €</td></tr>
      <tr><td style="padding:10px 14px;font-size:12px;text-transform:uppercase;color:#888;border-bottom:1px solid #f0f0f0;">Email cliente</td><td style="padding:10px 14px;font-size:13px;color:#2F6B3C;border-bottom:1px solid #f0f0f0;"><a href="mailto:${clientEmail}" style="color:#2F6B3C;">${clientEmail}</a></td></tr>
      <tr><td style="padding:10px 14px;font-size:12px;text-transform:uppercase;color:#888;">Stripe ID</td><td style="padding:10px 14px;font-size:11px;color:#aaa;">${sessionId}</td></tr>
    </table>
    <p style="margin:16px 0 0;font-size:12px;color:#999;">El cliente recibirá las instrucciones para enviar sus preguntas por WhatsApp. Entrega en menos de 24 h.</p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  console.log(`[email:diag] sendSimpleEmail — to: ${clientEmail}, product: ${consultaName}`);

  const [r1, r2] = await Promise.all([
    resend.emails.send({
      from:    `NOCTEA <${FROM_EMAIL}>`,
      to:      clientEmail,
      subject,
      html:    clientHtml,
    }),
    resend.emails.send({
      from:    `NOCTEA Web <${FROM_EMAIL}>`,
      to:      NOTIFICATION_EMAIL,
      subject: `💳 ${consultaName} · ${(amount / 100).toFixed(2)}€ · ${clientEmail}`,
      html:    internalHtml,
    }),
  ]);

  console.log(`[email] ✅ Email cliente enviado  — id: ${r1?.data?.id || r1?.id || 'n/a'}`);
  console.log(`[email] ✅ Email interno enviado  — id: ${r2?.data?.id || r2?.id || 'n/a'}`);
}
