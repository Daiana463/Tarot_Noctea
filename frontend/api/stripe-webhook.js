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

  const session = event.data.object;
  const meta    = session.metadata || {};

  console.log(`[webhook] ✅ checkout.session.completed`);
  console.log(`[webhook] Session: ${session.id}`);
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
        sessionId:   session.id,
        amountPaid:  session.amount_total,
        calConflict: Boolean(calResult.conflict),
        calError:    Boolean(calResult.calendarError),
        eventId:     calResult.eventId || null,
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
    `Importe: 22 €`,
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

async function sendEmails({ meta, sessionId, amountPaid, calConflict, calError, eventId }) {
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

  const td = (k, v) => `<tr>
    <td style="padding:8px 0;color:#888;font-size:13px;font-family:sans-serif;width:120px;vertical-align:top;">${k}</td>
    <td style="padding:8px 0;font-size:14px;font-family:sans-serif;color:#151515;">${v}</td>
  </tr>`;

  // ── Email al cliente ─────────────────────────────────────────────────────
  const clientHtml = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F0E8;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F0E8;padding:40px 20px;">
<tr><td align="center">
<table width="100%" style="max-width:520px;background:#FFFDF7;border-radius:12px;overflow:hidden;font-family:Georgia,serif;">
  <tr><td style="background:#061A12;padding:24px 32px;">
    <p style="margin:0;font-family:sans-serif;font-size:11px;letter-spacing:0.18em;color:#C9A85A;text-transform:uppercase;">NOCTEA</p>
  </td></tr>
  <tr><td style="padding:36px 32px 28px;">
    <h1 style="margin:0 0 8px;font-size:26px;font-weight:400;color:#061A12;line-height:1.2;">Tu sesión está confirmada</h1>
    <p style="margin:0 0 28px;font-family:sans-serif;font-size:15px;color:#2F6B3C;">Gracias, ${nombre || 'consultante'}. Tu pago fue recibido.</p>
    <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #DCE8D6;border-bottom:1px solid #DCE8D6;margin-bottom:28px;">
      ${td('Fecha',     fechaDisplay)}
      ${td('Horario',   label)}
      ${td('Duración',  '30 minutos')}
      ${td('Modalidad', preferencia_contacto || 'Online')}
      ${td('Importe',   '<strong>22 €</strong>')}
    </table>
    <p style="font-family:sans-serif;font-size:14px;color:#555;line-height:1.75;margin:0 0 16px;">
      Tu sesión está confirmada para el día y horario indicados. Me pondré en contacto contigo próximamente para coordinar los últimos detalles.
    </p>
    <p style="font-family:sans-serif;font-size:14px;color:#555;line-height:1.75;margin:0 0 16px;">
      Para cambios o cancelaciones, escribime con al menos 24 horas de anticipación a
      <a href="mailto:${SUPPORT_EMAIL}" style="color:#2F6B3C;text-decoration:none;">${SUPPORT_EMAIL}</a>.
    </p>
    <p style="font-family:Georgia,serif;font-size:15px;color:#2F6B3C;font-style:italic;margin:0 0 4px;">Con cariño,</p>
    <p style="font-family:sans-serif;font-size:14px;font-weight:600;color:#061A12;margin:0;">NOCTEA</p>
  </td></tr>
  <tr><td style="padding:18px 32px;background:#F7F3EA;border-top:1px solid #DCE8D6;">
    <p style="margin:0;font-family:sans-serif;font-size:11px;color:#bbb;line-height:1.6;">
      La lectura NOCTEA es una guía simbólica y espiritual. No reemplaza asesoramiento médico, psicológico, legal ni financiero.
    </p>
  </td></tr>
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
    <p style="margin:0;font-family:sans-serif;font-size:11px;letter-spacing:0.15em;color:#C9A85A;text-transform:uppercase;">NOCTEA — Nueva reserva</p>
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
      ${td('Importe',  `<strong>${((amountPaid || 2200) / 100).toFixed(2)} €</strong>`)}
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
