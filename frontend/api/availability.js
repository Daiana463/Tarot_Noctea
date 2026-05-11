const { google } = require('googleapis');

const TIMEZONE = 'Europe/Madrid';
const SLOT_MINUTES = 30;

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

function buildDate(date, time) {
  return new Date(`${date}T${time}:00+02:00`);
}

function overlaps(slotStart, slotEnd, eventStart, eventEnd) {
  return slotStart < eventEnd && slotEnd > eventStart;
}

module.exports = async function handler(req, res) {
  try {
    const { date } = req.query;

    if (!date) {
      return res.status(400).json({
        error: 'Falta la fecha.'
      });
    }

    const selectedDay = new Date(`${date}T12:00:00+02:00`).getDay();

    if (selectedDay === 0 || selectedDay === 6) {
      return res.status(200).json({
        slots: []
      });
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
      ['https://www.googleapis.com/auth/calendar']
    );

    const calendar = google.calendar({
      version: 'v3',
      auth
    });

    const timeMin = new Date(`${date}T00:00:00+02:00`).toISOString();
    const timeMax = new Date(`${date}T23:59:59+02:00`).toISOString();

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
      const slotStart = buildDate(date, start);
      const slotEnd = buildDate(date, end);

      const occupied = busyEvents.some(event => {
        return overlaps(slotStart, slotEnd, event.start, event.end);
      });

      return {
        start,
        end,
        label: `${start} a ${end}`,
        available: !occupied
      };
    });

    return res.status(200).json({
      slots
    });
  } catch (error) {
    console.error('Google Calendar availability error:', error);

    return res.status(500).json({
      error: 'No se pudo consultar disponibilidad en Google Calendar.'
    });
  }
};