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
  ['18:30', '19:00']
];

// Returns '+02:00' (CEST) or '+01:00' (CET) for Europe/Madrid on a given date.
function getMadridOffset(dateStr) {
  const d = new Date(dateStr + 'T12:00:00Z');
  const year = d.getUTCFullYear();
  const lastSunMarch = new Date(Date.UTC(year, 2, 31 - new Date(Date.UTC(year, 2, 31)).getUTCDay()));
  const lastSunOct   = new Date(Date.UTC(year, 9, 31 - new Date(Date.UTC(year, 9, 31)).getUTCDay()));
  return (d >= lastSunMarch && d < lastSunOct) ? '+02:00' : '+01:00';
}

function buildDate(date, time, offset) {
  return new Date(`${date}T${time}:00${offset}`);
}

function overlaps(slotStart, slotEnd, eventStart, eventEnd) {
  return slotStart < eventEnd && slotEnd > eventStart;
}

module.exports = async function handler(req, res) {
  try {
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({ error: 'Falta la fecha.' });
    }

    const selectedDay = new Date(`${date}T12:00:00+02:00`).getDay();

    if (selectedDay === 0 || selectedDay === 6) {
      return res.status(200).json({ slots: [] });
    }

    if (!process.env.GOOGLE_CLIENT_EMAIL || !process.env.GOOGLE_PRIVATE_KEY || !process.env.GOOGLE_CALENDAR_ID) {
      return res.status(500).json({
        error: 'Faltan variables de entorno de Google Calendar.'
      });
    }

    const auth = new google.auth.JWT(
      process.env.GOOGLE_CLIENT_EMAIL,
      null,
      process.env.GOOGLE_PRIVATE_KEY.replace(/\\n/g, '\n'),
      ['https://www.googleapis.com/auth/calendar.readonly']
    );

    const calendar = google.calendar({
      version: 'v3',
      auth
    });

    const offset = getMadridOffset(date);
    const timeMin = new Date(`${date}T00:00:00${offset}`).toISOString();
    const timeMax = new Date(`${date}T23:59:59${offset}`).toISOString();

    const response = await calendar.events.list({
      calendarId: process.env.GOOGLE_CALENDAR_ID,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      timeZone: TIMEZONE
    });

    const events = response.data.items || [];

    const busyEvents = events
      .filter(event => event.start?.dateTime && event.end?.dateTime)
      .map(event => ({
        start: new Date(event.start.dateTime),
        end: new Date(event.end.dateTime)
      }));

    const slots = AVAILABLE_SLOTS.map(([start, end]) => {
      const slotStart = buildDate(date, start, offset);
      const slotEnd = buildDate(date, end, offset);

      const occupied = busyEvents.some(event =>
        overlaps(slotStart, slotEnd, event.start, event.end)
      );

      return {
        start,
        end,
        label: `${start} a ${end}`,
        available: !occupied
      };
    });

    return res.status(200).json({ slots });
  } catch (error) {
    console.error('Google Calendar availability error:', error);

    const isCalendarNotFound = error?.code === 404 || error?.message?.includes('notFound') || error?.message?.includes('notACalendarUser');
    if (isCalendarNotFound) {
      console.error(
        'IMPORTANTE: El calendario no existe o la cuenta de servicio no tiene acceso. ' +
        'Si usás un Gmail personal como Calendar ID, compartí el calendario con la cuenta ' +
        'de servicio desde Google Calendar > Configuración > Compartir. ' +
        'Para calendarios secundarios usá el ID tipo "xxx@group.calendar.google.com".'
      );
    }

    return res.status(500).json({
      error: 'No se pudo consultar disponibilidad. Contactanos directamente a nocteatarot@gmail.com.'
    });
  }
};