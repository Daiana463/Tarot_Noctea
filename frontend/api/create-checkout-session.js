require('dotenv').config({ path: '.env.local' });

const Stripe = require('stripe');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido.' });
  }

  const {
    nombre,
    email,
    telefono,
    mensaje,
    fecha_reserva,
    horario_inicio,
    horario_fin,
    horario_label,
    preferencia
  } = req.body || {};

  if (!nombre || !email || !fecha_reserva || !horario_inicio || !horario_fin) {
    return res.status(400).json({ error: 'Faltan datos obligatorios.' });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Configuración de pago incompleta.' });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

  const label = horario_label || `${horario_inicio}–${horario_fin}`;
  const fechaDisplay = new Date(fecha_reserva + 'T12:00:00Z').toLocaleDateString('es-ES', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: email,
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: {
            name: 'Sesión NOCTEA — Lectura completa',
            description: `${label} · ${fechaDisplay} · 30 min · Online`,
          },
          unit_amount: 2200,
        },
        quantity: 1,
      }],
      metadata: {
        nombre,
        email,
        telefono:             telefono ? telefono.substring(0, 200)  : '',
        mensaje:              mensaje  ? mensaje.substring(0, 500)   : '',
        fecha_reserva,
        horario_inicio,
        horario_fin,
        horario_label:        label,
        preferencia_contacto: preferencia || '',
        origen:               'Noctea Studio Web',
      },
      success_url: `${process.env.SITE_URL || 'https://www.nocteastudio.com'}/reserva-confirmada`,
      cancel_url:  `${process.env.SITE_URL || 'https://www.nocteastudio.com'}/reserva-cancelada`,
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('Error creando Checkout Session:', error);
    return res.status(500).json({ error: 'No se pudo iniciar el pago. Intentá de nuevo.' });
  }
};
