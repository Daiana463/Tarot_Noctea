require('dotenv').config({ path: '.env.local' });

const Stripe     = require('stripe');
const { google } = require('googleapis');
const { Resend } = require('resend');

const TIMEZONE = process.env.TIMEZONE || 'Europe/Madrid';

// ── Handler ─────────────────────────────────────────────────────────────────

async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).end('Method not allowed');
  }

  const sig = req.headers['stripe-signature'];
  if (!sig || !process.env.STRIPE_WEBHOOK_SECRET || !process.env.STRIPE_SECRET_KEY) {
    console.error('[webhook] Faltan STRIPE_SECRET_KEY o STRIPE_WEBHOOK_SECRET.');
    return res.status(400).end('Missing Stripe configuration.');
  }

  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (e) {
    console.error('[webhook] No se pudo leer el body:', e.message);
    return res.status(400).end('Cannot read request body.');
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[webhook] Firma inválida:', err.message);
    return res.status(400).end(`Webhook error: ${err.message}`);
  }

  // Solo procesamos checkout completado
  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true });
  }

  const session = event.data.object;
  const meta    = session.metadata || {};

  console.log(`[webhook] checkout.session.completed — ${session.id} — ${meta.nombre} — ${meta.fecha_reserva} ${meta.horario_inicio}`);

  // ── 1. Crear evento en Calendar ──────────────────────────────────────────
  let calResult = {};
  try {
    calResult = await createCalendarEvent({ sessionId: session.id, meta });
  } catch (calErr) {
    console.error('[webhook] Error en Calendar:', calErr.message || calErr);
    calResult = { calendarError: true, errorMsg: calErr.message };
  }

  // ── 2. Enviar emails (siempre, salvo que sea un reintento ya procesado) ──
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
    } catch (emailErr) {
      console.error('[webhook] Error enviando emails:', emailErr.message || emailErr);
    }
  } else {
    console.log(`[webhook] Sesión ${session.id} ya procesada. Ignorando reintento.`);
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
    req.on('data',  chunk => chunks.push(chunk));
    req.on('end',   ()    => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function getMadridOffset(dateStr) {
  const d    = new Date(dateStr + 'T12:00:00Z');
  const year = d.getUTCFullYear();
  const lsm  = new Date(Date.UTC(year, 2, 31 - new Date(Date.UTC(year, 2, 31)).getUTCDay()));
  const lso  = new Date(Date.UTC(year, 9, 31 - new Date(Date.UTC(year, 9, 31)).getUTCDay()));
  return (d >= lsm && d < lso) ? '+02:00' : '+01:00';
}

async function createCalendarEvent({ sessionId, meta }) {
  const {
    nombre, email, telefono, mensaje,
    fecha_reserva, horario_inicio, horario_fin, horario_label, preferencia_contacto
  } = meta;

  if (!fecha_reserva || !horario_inicio || !horario_fin) {
    console.error('[calendar] Metadata incompleta — falta fecha u horario.');
    return { error: true };
  }

  if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY || !process.env.GOOGLE_CALENDAR_ID) {
    console.error('[calendar] Faltan variables de entorno de Google.');
    return { error: true };
  }

  const auth = new google.auth.JWT(
    process.env.GOOGLE_CLIENT_EMAIL,
    null,
    process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
    ['https://www.googleapis.com/auth/calendar']
  );

  const calendar  = google.calendar({ version: 'v3', auth });
  const offset    = getMadridOffset(fecha_reserva);
  const slotStart = new Date(`${fecha_reserva}T${horario_inicio}:00${offset}`);
  const slotEnd   = new Date(`${fecha_reserva}T${horario_fin}:00${offset}`);

  // Verificar disponibilidad y detectar duplicado
  const checkRes  = await calendar.events.list({
    calendarId:   process.env.GOOGLE_CALENDAR_ID,
    timeMin:      slotStart.toISOString(),
    timeMax:      slotEnd.toISOString(),
    singleEvents: true,
  });

  const existing = checkRes.data.items || [];

  if (existing.some(e => e.description?.includes(sessionId))) {
    console.log(`[calendar] Evento ya existe para sesión ${sessionId}.`);
    return { skipped: true };
  }

  if (existing.some(e => e.start?.dateTime && e.end?.dateTime)) {
    console.warn(`[calendar] Conflicto: ${fecha_reserva} ${horario_inicio}–${horario_fin} ya ocupado. Sesión ${sessionId}.`);
    return { conflict: true };
  }

  const label = horario_label || `${horario_inicio}–${horario_fin}`;
  const description = [
    `Cliente: ${nombre || '—'}`,
    `Email: ${email || '—'}`,
    telefono             ? `Teléfono: ${telefono}`      : null,
    `Horario: ${label}`,
    preferencia_contacto ? `Vía: ${preferencia_contacto}` : null,
    mensaje              ? `Mensaje: ${mensaje}`         : null,
    '',
    'Estado: Pago confirmado vía Stripe',
    `Stripe Session: ${sessionId}`,
    'Origen: Noctea Studio Web',
  ].filter(l => l !== null).join('\n');

  const created = await calendar.events.insert({
    calendarId: process.env.GOOGLE_CALENDAR_ID,
    resource: {
      summary:     `Sesión NOCTEA — ${nombre || 'Cliente'}`,
      description,
      start: { dateTime: slotStart.toISOString(), timeZone: TIMEZONE },
      end:   { dateTime: slotEnd.toISOString(),   timeZone: TIMEZONE },
      attendees: email ? [{ email, displayName: nombre || '' }] : [],
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email', minutes: 60 },
          { method: 'popup', minutes: 15 },
        ],
      },
    },
    sendUpdates: 'all',
  });

  console.log(`[calendar] Evento creado: ${created.data.id} — ${nombre} — ${fecha_reserva} ${horario_inicio}`);
  return { eventId: created.data.id };
}

async function sendEmails({ meta, sessionId, amountPaid, calConflict, calError, eventId }) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[email] RESEND_API_KEY no configurado. Omitiendo emails.');
    return;
  }

  const {
    nombre, email, telefono, mensaje,
    fecha_reserva, horario_label, horario_inicio, horario_fin, preferencia_contacto
  } = meta;

  if (!email) {
    console.warn('[email] Sin email de cliente. Omitiendo.');
    return;
  }

  const resend     = new Resend(process.env.RESEND_API_KEY);
  const fromEmail  = process.env.FROM_EMAIL         || 'hola@nocteastudio.com';
  const notifEmail = process.env.NOTIFICATION_EMAIL || 'nocteatarot@gmail.com';
  const label      = horario_label || `${horario_inicio}–${horario_fin}`;

  const fechaDisplay = new Date(fecha_reserva + 'T12:00:00Z').toLocaleDateString('es-ES', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });

  const tr = (k, v) => `
    <tr>
      <td style="padding:8px 0 8px;color:#888;font-size:13px;font-family:sans-serif;width:120px;vertical-align:top;white-space:nowrap;">${k}</td>
      <td style="padding:8px 0 8px;font-size:14px;font-family:sans-serif;color:#151515;">${v}</td>
    </tr>`;

  // ── Email al cliente ────────────────────────────────────────────────────────
  const clientHtml = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#F5F0E8;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#F5F0E8;padding:40px 20px;">
  <tr><td align="center">
    <table width="100%" style="max-width:520px;background:#FFFDF7;border-radius:12px;overflow:hidden;">

      <!-- Cabecera -->
      <tr><td style="background:#061A12;padding:28px 32px;">
        <p style="margin:0;font-family:sans-serif;font-size:11px;letter-spacing:0.18em;color:#C9A85A;text-transform:uppercase;">NOCTEA</p>
      </td></tr>

      <!-- Cuerpo -->
      <tr><td style="padding:36px 32px 20px;">
        <h1 style="margin:0 0 8px;font-family:Georgia,serif;font-size:26px;font-weight:400;color:#061A12;">Tu sesión está confirmada</h1>
        <p style="margin:0 0 28px;font-family:sans-serif;font-size:15px;color:#2F6B3C;">Gracias, ${nombre || 'consultante'}. Tu pago fue recibido.</p>

        <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #DCE8D6;border-bottom:1px solid #DCE8D6;margin-bottom:28px;">
          ${tr('Fecha',     fechaDisplay)}
          ${tr('Horario',   label)}
          ${tr('Duración',  '30 minutos')}
          ${tr('Modalidad', preferencia_contacto || 'Online')}
          ${tr('Importe',   '<strong>22 €</strong>')}
        </table>

        <p style="font-family:sans-serif;font-size:14px;color:#555;line-height:1.75;margin:0 0 16px;">
          Me pondré en contacto contigo para coordinar los detalles finales de la sesión.
          Si necesitás cambiar o cancelar la cita, escribime con al menos 24 horas de anticipación a
          <a href="mailto:nocteatarot@gmail.com" style="color:#2F6B3C;text-decoration:none;">nocteatarot@gmail.com</a>.
        </p>

        <p style="font-family:Georgia,serif;font-size:15px;color:#2F6B3C;font-style:italic;margin:0 0 8px;">Con cariño,</p>
        <p style="font-family:sans-serif;font-size:14px;font-weight:600;color:#061A12;margin:0;">NOCTEA</p>
      </td></tr>

      <!-- Pie -->
      <tr><td style="padding:20px 32px;background:#F7F3EA;border-top:1px solid #DCE8D6;">
        <p style="margin:0;font-family:sans-serif;font-size:11px;color:#bbb;line-height:1.6;">
          La lectura NOCTEA es una guía simbólica y espiritual. No reemplaza asesoramiento médico, psicológico, legal ni financiero.
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;

  // ── Email a Noctea ──────────────────────────────────────────────────────────
  const alertBanner = calConflict
    ? `<tr><td colspan="2" style="padding:10px 12px;background:#fff3cd;border-radius:6px;font-family:sans-serif;font-size:13px;color:#856404;margin-bottom:12px;">
        ⚠️ <strong>CONFLICTO DE HORARIO:</strong> el slot ${label} ya estaba ocupado en el calendario. El pago se procesó correctamente. Coordinar manualmente con el cliente.
       </td></tr>`
    : calError
    ? `<tr><td colspan="2" style="padding:10px 12px;background:#f8d7da;border-radius:6px;font-family:sans-serif;font-size:13px;color:#842029;margin-bottom:12px;">
        ❌ <strong>ERROR EN GOOGLE CALENDAR:</strong> el evento no pudo crearse automáticamente. El pago se procesó correctamente. Crear el evento manualmente.
       </td></tr>`
    : '';

  const nocteaHtml = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"></head>
<body style="margin:0;padding:0;background:#f5f0e8;">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0e8;padding:40px 20px;">
  <tr><td align="center">
    <table width="100%" style="max-width:520px;background:#fff;border-radius:12px;overflow:hidden;">
      <tr><td style="background:#061A12;padding:20px 28px;">
        <p style="margin:0;font-family:sans-serif;font-size:11px;letter-spacing:0.15em;color:#C9A85A;text-transform:uppercase;">NOCTEA — Nueva reserva</p>
      </td></tr>
      <tr><td style="padding:28px;">
        <h2 style="margin:0 0 20px;font-family:Georgia,serif;font-weight:400;color:#061A12;font-size:22px;">Reserva confirmada · ${fechaDisplay}</h2>
        <table width="100%" cellpadding="0" cellspacing="0" style="border-top:1px solid #e8e4da;">
          ${alertBanner}
          ${tr('Nombre',   nombre || '—')}
          ${tr('Email',    `<a href="mailto:${email}" style="color:#2F6B3C;">${email}</a>`)}
          ${tr('Teléfono', telefono || '—')}
          ${tr('Fecha',    fechaDisplay)}
          ${tr('Horario',  label)}
          ${tr('Vía',      preferencia_contacto || '—')}
          ${mensaje ? tr('Mensaje', `<em>${mensaje}</em>`) : ''}
          ${tr('Importe',  `<strong>${((amountPaid || 2200) / 100).toFixed(2)} €</strong>`)}
          ${eventId ? tr('Evento', `<span style="font-size:12px;color:#2F6B3C;">Creado en Calendar ✓</span>`) : ''}
          ${tr('Stripe ID', `<span style="font-size:11px;color:#aaa;">${sessionId}</span>`)}
        </table>
      </td></tr>
    </table>
  </td></tr>
</table>
</body></html>`;

  await Promise.all([
    resend.emails.send({
      from:    `NOCTEA <${fromEmail}>`,
      to:      email,
      subject: 'Confirmación de tu sesión NOCTEA',
      html:    clientHtml,
    }),
    resend.emails.send({
      from:    `NOCTEA Web <${fromEmail}>`,
      to:      notifEmail,
      subject: calConflict
        ? `⚠️ CONFLICTO — Reserva pagada — ${nombre} · ${fechaDisplay}`
        : calError
        ? `❌ ERROR CALENDAR — Reserva pagada — ${nombre} · ${fechaDisplay}`
        : `Nueva reserva — ${nombre} · ${fechaDisplay}`,
      html:    nocteaHtml,
    }),
  ]);

  console.log(`[email] Enviados a ${email} y ${notifEmail}.`);
}
