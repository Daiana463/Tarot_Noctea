require('dotenv').config();
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { google } = require('googleapis');

const app = express();
const PORT = process.env.PORT || 3000;

// Stripe webhook necesita raw body antes que el parser JSON
app.use('/api/stripe-webhook', bodyParser.raw({ type: 'application/json' }));
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('../frontend'));

// ─── Google Calendar ──────────────────────────────────────────────────────────
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);
oauth2Client.setCredentials({ refresh_token: process.env.GOOGLE_REFRESH_TOKEN });
const calendar = google.calendar({ version: 'v3', auth: oauth2Client });

// ─── Horarios disponibles ─────────────────────────────────────────────────────
const TIME_SLOTS = [
  { start: '09:00', end: '09:30' },
  { start: '09:45', end: '10:15' },
  { start: '10:30', end: '11:00' },
  { start: '11:15', end: '11:45' },
  { start: '14:00', end: '14:30' },
  { start: '14:45', end: '15:15' },
  { start: '15:30', end: '16:00' },
  { start: '20:00', end: '20:30' },
  { start: '20:45', end: '21:15' },
  { start: '21:30', end: '22:00' }
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function isWeekend(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const day = d.getUTCDay();
  return day === 0 || day === 6;
}

function isPast(dateStr) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const target = new Date(dateStr + 'T00:00:00Z');
  return target < today;
}

async function getAvailability(dateStr) {
  const timeMin = `${dateStr}T00:00:00+02:00`;
  const timeMax = `${dateStr}T23:59:59+02:00`;
  const calId = process.env.GOOGLE_CALENDAR_ID || 'primary';

  let busySlots = [];
  try {
    const res = await calendar.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        timeZone: 'Europe/Madrid',
        items: [{ id: calId }]
      }
    });
    busySlots = res.data.calendars[calId]?.busy || [];
  } catch (err) {
    console.error('[Calendar] freebusy error:', err.message);
    // Si el calendario no está configurado, devuelve todos disponibles
  }

  return TIME_SLOTS.map(slot => {
    const slotStart = new Date(`${dateStr}T${slot.start}:00`);
    const slotEnd   = new Date(`${dateStr}T${slot.end}:00`);
    const isBusy = busySlots.some(b => {
      const bs = new Date(b.start);
      const be = new Date(b.end);
      return slotStart < be && slotEnd > bs;
    });
    return {
      start: slot.start,
      end: slot.end,
      label: `${slot.start} a ${slot.end}`,
      available: !isBusy
    };
  });
}

async function createCalendarEvent(booking) {
  const { nombre, email, telefono, fecha_reserva, horario_reserva,
          preferencia_contacto, metodo_pago, estado_pago } = booking;
  const [startTime, endTime] = horario_reserva.split(' a ');
  const calId = process.env.GOOGLE_CALENDAR_ID || 'primary';

  const event = {
    summary: `NOCTEA — Lectura completa — ${nombre}`,
    description: [
      `Servicio: Lectura completa NOCTEA`,
      `Incluye: Tarot + Oráculo de la Bruja Verde + Carta astral`,
      `Método de pago: ${metodo_pago}`,
      `Estado del pago: ${estado_pago}`,
      `Preferencia de consulta: ${preferencia_contacto}`,
      ``,
      `Datos del cliente:`,
      `Nombre: ${nombre}`,
      `Email: ${email}`,
      `Teléfono: ${telefono}`,
      ``,
      `Nota: La información necesaria para la carta astral se solicitará luego de confirmar la reserva.`
    ].join('\n'),
    start: { dateTime: `${fecha_reserva}T${startTime}:00`, timeZone: 'Europe/Madrid' },
    end:   { dateTime: `${fecha_reserva}T${endTime}:00`,   timeZone: 'Europe/Madrid' },
    attendees: [{ email, displayName: nombre }]
    // sin conferenceData → sin Google Meet
  };

  const res = await calendar.events.insert({
    calendarId: calId,
    requestBody: event,
    sendUpdates: 'all'
  });
  return res.data;
}

async function sendEmail(booking) {
  const { nombre, email, telefono, fecha_reserva, horario_reserva,
          preferencia_contacto, metodo_pago, estado_pago } = booking;

  const payload = {
    access_key: process.env.WEB3FORMS_ACCESS_KEY,
    subject: `Nueva reserva NOCTEA — ${nombre} — ${fecha_reserva}`,
    from_name: 'NOCTEA Reservas',
    to_email: 'nocteatarot@gmail.com',
    name: nombre,
    email,
    message: `
NUEVA RESERVA NOCTEA
${'─'.repeat(40)}

SERVICIO
Lectura completa NOCTEA
Incluye: Tarot + Oráculo de la Bruja Verde + Carta astral
Precio: 22 €

CITA
Fecha:   ${fecha_reserva}
Horario: ${horario_reserva}

CLIENTE
Nombre:                ${nombre}
Email:                 ${email}
Teléfono:              ${telefono}
Preferencia consulta:  ${preferencia_contacto}

PAGO
Método: ${metodo_pago}
Estado: ${estado_pago}

${'─'.repeat(40)}
Nota: La carta astral se preparará con los datos que se soliciten tras confirmar la reserva.
`.trim()
  };

  const res = await fetch('https://api.web3forms.com/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  return res.json();
}

// ─── Routes ───────────────────────────────────────────────────────────────────

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', service: 'NOCTEA Backend', timestamp: new Date().toISOString() });
});

app.get('/api/availability', async (req, res) => {
  const { date } = req.query;
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Formato de fecha inválido. Use YYYY-MM-DD.' });
  }
  if (isWeekend(date)) {
    return res.status(400).json({ error: 'No hay disponibilidad los fines de semana.' });
  }
  if (isPast(date)) {
    return res.status(400).json({ error: 'No se pueden reservar fechas pasadas.' });
  }
  try {
    const slots = await getAvailability(date);
    res.json({ date, slots });
  } catch (err) {
    console.error('[Availability]', err.message);
    res.status(500).json({ error: 'Error consultando disponibilidad.' });
  }
});

app.post('/api/create-checkout-session', async (req, res) => {
  const { nombre, email, telefono, fecha_reserva, horario_reserva, preferencia_contacto } = req.body;
  if (!nombre || !email || !telefono || !fecha_reserva || !horario_reserva || !preferencia_contacto) {
    return res.status(400).json({ error: 'Faltan datos obligatorios.' });
  }

  // Re-validar disponibilidad antes de cobrar
  try {
    const slots = await getAvailability(fecha_reserva);
    const slotStart = horario_reserva.split(' a ')[0];
    const slot = slots.find(s => s.start === slotStart);
    if (!slot || !slot.available) {
      return res.status(409).json({
        error: 'Este horario acaba de ser reservado. Por favor elegí otro.'
      });
    }
  } catch (err) {
    console.error('[Pre-checkout availability]', err.message);
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: 'Lectura completa NOCTEA',
            description: 'Tarot + Oráculo de la Bruja Verde + Carta astral · 30 min'
          },
          unit_amount: 2200
        },
        quantity: 1
      }],
      mode: 'payment',
      customer_email: email,
      success_url: `${process.env.DOMAIN_URL || 'http://localhost:3000'}/index.html?pago=exito&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${process.env.DOMAIN_URL || 'http://localhost:3000'}/index.html?pago=cancelado`,
      metadata: {
        servicio: 'Lectura completa NOCTEA',
        precio: '22',
        nombre, email, telefono,
        fecha_reserva, horario_reserva,
        preferencia_contacto,
        metodo_pago: 'Bizum'
      }
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[Stripe]', err.message);
    res.status(500).json({ error: 'Error al crear sesión de pago: ' + err.message });
  }
});

app.post('/api/stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('[Webhook]', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const meta = event.data.object.metadata;
    const booking = {
      nombre: meta.nombre,
      email: meta.email,
      telefono: meta.telefono,
      fecha_reserva: meta.fecha_reserva,
      horario_reserva: meta.horario_reserva,
      preferencia_contacto: meta.preferencia_contacto,
      metodo_pago: 'Stripe (tarjeta)',
      estado_pago: 'Pagado'
    };
    try {
      await createCalendarEvent(booking);
      await sendEmail(booking);
      console.log('[Booking confirmed]', booking.nombre, booking.fecha_reserva);
    } catch (err) {
      console.error('[Post-payment]', err.message);
    }
  }
  res.json({ received: true });
});

// Endpoint eliminado: /api/transfer-booking (solo Stripe)

// ─── OAuth2 helper (solo para obtener el refresh token inicial) ───────────────
app.get('/oauth2callback', async (req, res) => {
  const { code } = req.query;
  try {
    const { tokens } = await oauth2Client.getToken(code);
    res.send(`<pre>Copia este GOOGLE_REFRESH_TOKEN en tu .env:\n\n${tokens.refresh_token}</pre>`);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

app.listen(PORT, () => {
  console.log(`🌿 NOCTEA Backend · http://localhost:${PORT}`);
});
