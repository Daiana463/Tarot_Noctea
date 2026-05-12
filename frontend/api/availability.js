require('dotenv').config({ path: '.env.local' });

const { google } = require('googleapis');

const TIMEZONE = 'Europe/Madrid';

const AVAILABLE_SLOTS = [
  ['10:00', '10:30'],
  ['10:30', '11:00'],
  ['11:00', '11:30'],
  ['11:30', '12:00'],
  ['12:00', '12:30'],
  ['12:30', '13:00'],
  ['16:00', '16:30'],
  ['16:30', '17:00'],
  ['17:00', '17:30'],
  ['17:30', '18:00'],
  ['18:00', '18:30'],
  ['18:30', '19:00'],
];

function parsePrivateKey(raw) {
  if (!raw) return '';
  let key = raw.trim();
  if (key.startsWith('"') && key.endsWith('"')) key = key.slice(1, -1);
  if (key.includes('\\n')) key = key.replace(/\\n/g, '\n');
  return key;
}

function getMadridOffset(dateStr) {
  const d   = new Date(dateStr + 'T12:00:00Z');
  const y   = d.getUTCFullYear();
  const lsm = new Date(Date.UTC(y, 2, 31 - new Date(Date.UTC(y, 2, 31)).getUTCDay()));
  const lso = new Date(Date.UTC(y, 9, 31 - new Date(Date.UTC(y, 9, 31)).getUTCDay()));
  return (d >= lsm && d < lso) ? '+02:00' : '+01:00';
}

function buildDate(date, time, offset) {
  return new Date(`${date}T${time}:00${offset}`);
}

function overlaps(slotStart, slotEnd, evStart, evEnd) {
  return slotStart < evEnd && slotEnd > evStart;
}

module.exports = async function handler(req, res) {
  const { date } = req.query;

  if (!date) return res.status(400).json({ error: 'Falta la fecha.' });

  const dayOfWeek = new Date(`${date}T12:00:00Z`).getUTCDay();
  if (dayOfWeek === 0 || dayOfWeek === 6) {
    return res.status(200).json({ slots: [] });
  }

  const calId      = process.env.GOOGLE_CALENDAR_ID;
  const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
  const privateKey  = parsePrivateKey(process.env.GOOGLE_PRIVATE_KEY);

  if (!calId || !clientEmail || !privateKey) {
    console.error('[availability] Variables de Google faltantes.');
    return res.status(500).json({ error: 'Configuración de calendario incompleta.' });
  }

  try {
    const auth = new google.auth.JWT(clientEmail, null, privateKey,
      ['https://www.googleapis.com/auth/calendar.readonly']);

    const calendar = google.calendar({ version: 'v3', auth });
    const offset   = getMadridOffset(date);

    const response = await calendar.events.list({
      calendarId:   calId,
      timeMin:      new Date(`${date}T00:00:00${offset}`).toISOString(),
      timeMax:      new Date(`${date}T23:59:59${offset}`).toISOString(),
      singleEvents: true,
      orderBy:      'startTime',
      timeZone:     TIMEZONE,
    });

    const busyEvents = (response.data.items || [])
      .filter(e => e.start?.dateTime && e.end?.dateTime)
      .map(e => ({ start: new Date(e.start.dateTime), end: new Date(e.end.dateTime) }));

    const slots = AVAILABLE_SLOTS.map(([start, end]) => {
      const slotStart = buildDate(date, start, offset);
      const slotEnd   = buildDate(date, end,   offset);
      const occupied  = busyEvents.some(ev => overlaps(slotStart, slotEnd, ev.start, ev.end));
      return { start, end, label: `${start} a ${end}`, available: !occupied };
    });

    return res.status(200).json({ slots });

  } catch (error) {
    console.error('[availability] Error Google Calendar:', error.message, '| code:', error.code);
    return res.status(500).json({
      error: 'No se pudo consultar disponibilidad. Contactanos en contacto@nocteastudio.com.',
    });
  }
};
