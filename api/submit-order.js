import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const PRICES = { court: 3490, classique: 4490, long: 5490 };
const FORMAT_LABELS = { court: 'Court (30 pages)', classique: 'Classique (40 pages)', long: 'Long (50 pages)' };

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { formData, story } = req.body;

    if (!formData || !story) {
      return res.status(400).json({ error: 'Données manquantes' });
    }

    const supabase = createClient(
      process.env.PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: order, error: dbError } = await supabase
      .from('orders')
      .insert({
        status: 'payment_pending',
        child_first_name: formData.childFirstName,
        customer_email: formData.customerEmail,
        form_data: formData,
        story,
        shipping_details: formData.shippingDetails,
      })
      .select('id')
      .single();

    if (dbError) throw new Error('Erreur base de données : ' + dbError.message);

    const orderId = order.id;

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
    const siteUrl = process.env.SITE_URL || 'https://lorinizi.com';

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      customer_email: formData.customerEmail,
      metadata: { orderId },
      locale: 'fr',
      line_items: [
        {
          price_data: {
            currency: 'eur',
            unit_amount: PRICES[formData.bookFormat] || 4490,
            product_data: {
              name: `📖 "${story.title}"`,
              description: `${FORMAT_LABELS[formData.bookFormat]} • Pour ${formData.childFirstName}`,
            },
          },
          quantity: 1,
        },
      ],
      success_url: `${siteUrl}/confirmation.html?orderId=${orderId}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/creer.html`,
    });

    return res.status(200).json({ orderId, checkoutUrl: session.url });
  } catch (err) {
    console.error('[submit-order]', err);
    return res.status(500).json({ error: err.message });
  }
}
