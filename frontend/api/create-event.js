require('dotenv').config({ path: '.env.local' });

const { google } = require('googleapis');

const TIMEZONE = process.env.TIMEZONE || 'Europe/Madrid';

function getMadridOffset(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const year = d.getUTCFullYear();
  const lastSunMarch = new Date(Date.UTC(year, 2, 31 - new Date(Date.UTC(year, 2, 31)).getUTCDay()));
  const lastSunOct   = new Date(Date.UTC(year, 9, 31 - new Date(Date.UTC(year, 9, 31)).getUTCDay()));
  return (d >= lastSunMarch && d < lastSunOct) ? '+02:00' : '+01:00';
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido.' });
  }

  const {
    nombre,
    email,
    telefono,
    fecha_reserva,
    horario_inicio,
    horario_fin,
    horario_label,
    preferencia_contacto
  } = req.body || {};

  if (!nombre || !email || !fecha_reserva || !horario_inicio || !horario_fin) {
    return res.status(400).json({ error: 'Faltan datos obligatorios para crear el evento.' });
  }

  if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY || !process.env.GOOGLE_CALENDAR_ID) {
    return res.status(500).json({ error: 'Configuración de calendario incompleta.' });
  }

  try {
    const auth = new google.auth.JWT(
      process.env.GOOGLE_CLIENT_EMAIL,
      null,
      process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      ['https://www.googleapis.com/auth/calendar']
    );

    const calendar = google.calendar({ version: 'v3', auth });

    const offset = getMadridOffset(fecha_reserva);
    const slotStart = new Date(`${fecha_reserva}T${horario_inicio}:00${offset}`);
    const slotEnd   = new Date(`${fecha_reserva}T${horario_fin}:00${offset}`);

    // Verificar disponibilidad antes de crear (doble check contra race conditions)
    const checkRes = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      timeMin: slotStart.toISOString(),
      timeMax: slotEnd.toISOString(),
      singleEvents: true,
    });

    const conflicts = (checkRes.data.items || []).filter(
      e => e.start?.dateTime && e.end?.dateTime
    );

    if (conflicts.length > 0) {
      console.warn(`Conflicto de horario para ${fecha_reserva} ${horario_inicio}: ya existe evento.`);
      return res.status(409).json({
        error: 'El horario ya estaba reservado. Tu pago fue procesado correctamente: nos pondremos en contacto para coordinar una nueva fecha.'
      });
    }

    const event = {
      summary: `Lectura NOCTEA — ${nombre}`,
      description: [
        `Cliente: ${nombre}`,
        `Email: ${email}`,
        `Teléfono: ${telefono || '—'}`,
        `Horario: ${horario_label || `${horario_inicio} – ${horario_fin}`}`,
        `Vía: ${preferencia_contacto || '—'}`,
        '',
        'Origen: Noctea Studio Web',
      ].join('\n'),
      start: {
        dateTime: slotStart.toISOString(),
        timeZone: TIMEZONE,
      },
      end: {
        dateTime: slotEnd.toISOString(),
        timeZone: TIMEZONE,
      },
      attendees: [{ email, displayName: nombre }],
      reminders: {
        useDefault: false,
        overrides: [
          { method: 'email',  minutes: 60 },
          { method: 'popup',  minutes: 15 },
        ],
      },
    };

    const created = await calendar.events.insert({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      resource: event,
      sendUpdates: 'all',
    });

    console.log(`Evento creado: ${created.data.id} — ${nombre} — ${fecha_reserva} ${horario_inicio}`);
    return res.status(200).json({ success: true, eventId: created.data.id });

  } catch (error) {
    console.error('Error al crear evento en Google Calendar:', error);
    return res.status(500).json({
      error: 'No se pudo registrar el evento. Tu pago fue procesado: contactanos a contacto@nocteastudio.com.'
    });
  }
};
