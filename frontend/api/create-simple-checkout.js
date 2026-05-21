require('dotenv').config({ path: '.env.local' });

const Stripe = require('stripe');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método no permitido.' });
  }

  const { product } = req.body || {};

  if (!product || !['esencial', 'profunda'].includes(product)) {
    return res.status(400).json({ error: 'Producto no válido.' });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return res.status(500).json({ error: 'Configuración de pago incompleta.' });
  }

  const stripe     = new Stripe(process.env.STRIPE_SECRET_KEY);
  const isEsencial = product === 'esencial';
  const servicio   = isEsencial ? 'Consulta Esencial' : 'Consulta Profunda';
  const unitAmount = isEsencial ? 900 : 1500;
  const description = isEsencial
    ? '1 pregunta · Audio personalizado por WhatsApp · Entrega en menos de 24 h'
    : '2 preguntas · Audio personalizado por WhatsApp · Oráculo Green Witch · Entrega en menos de 24 h';

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      phone_number_collection: { enabled: true },
      billing_address_collection: 'auto',
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: `NOCTEA — ${servicio}`, description },
          unit_amount: unitAmount,
        },
        quantity: 1,
      }],
      metadata: {
        servicio,
        precio: (unitAmount / 100).toString(),
        origen: 'Noctea Studio Web',
      },
      success_url: `${process.env.SITE_URL || 'https://www.nocteastudio.com'}/reserva-confirmada`,
      cancel_url:  `${process.env.SITE_URL || 'https://www.nocteastudio.com'}/reserva-cancelada`,
    });

    return res.status(200).json({ url: session.url });
  } catch (error) {
    console.error('[create-simple-checkout] Error:', error.message);
    return res.status(500).json({ error: 'No se pudo iniciar el pago. Intentá de nuevo.' });
  }
};
