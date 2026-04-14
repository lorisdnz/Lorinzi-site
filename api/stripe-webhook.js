import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import { buildBookPdf } from './generate-pdf.js';
import { waitUntil } from '@vercel/functions';

export const config = { api: { bodyParser: false } };

const PAGE_COUNTS = { court: 30, classique: 40, long: 50 };

async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function getGelatoProductUid() {
  try {
    const res = await fetch(
      'https://product.gelatoapis.com/v3/catalogs/photobooks/products:search',
      {
        method: 'POST',
        headers: {
          'X-API-KEY': process.env.GELATO_API_KEY,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          attributeFilters: { ProductFormat: ['200x200-mm-8x8-inch'] },
          limit: 20,
          offset: 0,
        }),
      }
    );
    const data = await res.json();
    const hardcover = data.products?.find(
      (p) => p.productUid?.includes('hardcover') && p.productUid?.includes('200x200')
    );
    if (hardcover?.productUid) return hardcover.productUid;
  } catch (_) {}
  // Fallback known UID
  return 'photobooks-hardcover_pf_200x200-mm-8x8-inch_pt_170-gsm-65lb-coated-silk_cl_4-4_ccl_4-4_bt_glued-left_ct_matt-lamination_prt_1-0_cpt_130-gsm-65-lb-cover-coated-silk_ver';
}

async function sendToGelato(order, pdfUrl) {
  const bookFormat = order.form_data?.bookFormat || 'classique';
  const pageCount = PAGE_COUNTS[bookFormat] || 40;
  const productUid = await getGelatoProductUid();

  const shipping = order.shipping_details || {};
  const fullName = shipping.fullName || shipping.name || order.child_first_name || '';
  const nameParts = fullName.trim().split(' ');
  const firstName = nameParts[0] || 'Client';
  const lastName = nameParts.slice(1).join(' ') || '';

  const body = {
    orderReferenceId: order.id,
    customerReferenceId: order.id,
    currency: 'EUR',
    items: [
      {
        itemReferenceId: `item-${order.id}`,
        productUid,
        pageCount,
        quantity: 1,
        files: [{ type: 'default', url: pdfUrl }],
      },
    ],
    shipTo: {
      firstName,
      lastName,
      addressLine1: shipping.address || '',
      city: shipping.city || '',
      postCode: shipping.postalCode || '',
      country: shipping.country || 'FR',
      email: order.customer_email,
      phone: shipping.phone || '',
    },
  };

  const res = await fetch('https://order.gelatoapis.com/v4/orders', {
    method: 'POST',
    headers: {
      'X-API-KEY': process.env.GELATO_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  const result = await res.json();
  if (!res.ok) throw new Error('Gelato error: ' + JSON.stringify(result));
  return result.id;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
  const sig = req.headers['stripe-signature'];
  const rawBody = await getRawBody(req);

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).json({ error: 'Webhook signature invalide' });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = session.metadata?.orderId;
    if (!orderId) return res.status(400).json({ error: 'orderId manquant' });

    const supabase = createClient(
      process.env.PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    // Mark as paid immediately
    await supabase
      .from('orders')
      .update({ status: 'paid', stripe_payment_intent_id: session.payment_intent })
      .eq('id', orderId);

    // Fetch full order
    const { data: orderRow } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .single();

    if (!orderRow) return res.status(200).json({ received: true });

    // Respond to Stripe immediately (30s timeout)
    res.status(200).json({ received: true });

    // Process asynchronously with waitUntil (keeps Vercel function alive)
    waitUntil((async () => {
      try {
        // 1. Generate PDF
        await supabase.from('orders').update({ status: 'generating_pdf' }).eq('id', orderId);
        const pdfBuffer = await buildBookPdf(orderRow);

        // 2. Upload PDF to Supabase Storage
        const filename = `books/${orderId}.pdf`;
        await supabase.storage
          .from('pdfs')
          .upload(filename, pdfBuffer, { contentType: 'application/pdf', upsert: true });
        const { data: { publicUrl: pdfUrl } } = supabase.storage.from('pdfs').getPublicUrl(filename);

        await supabase.from('orders').update({ status: 'sending_to_manufacturer', pdf_url: pdfUrl }).eq('id', orderId);

        // 3. Send to Gelato
        const gelatoOrderId = await sendToGelato(orderRow, pdfUrl);
        await supabase
          .from('orders')
          .update({ status: 'sent_to_manufacturer', gelato_order_id: gelatoOrderId })
          .eq('id', orderId);

        // 4. Send confirmation email
        const resend = new Resend(process.env.RESEND_API_KEY);
        const siteUrl = process.env.SITE_URL || 'https://lorinizi.com';
        const shipping = orderRow.shipping_details || {};

        await resend.emails.send({
          from: 'Lorinizi <bonjour@lorinizi.com>',
          to: orderRow.customer_email,
          subject: `✨ Votre livre pour ${orderRow.child_first_name} est en cours de création !`,
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
              <h1 style="color: #7c3aed; font-size: 28px;">Lorinizi ✨</h1>
              <h2 style="color: #1f2937;">Commande confirmée ! 🎉</h2>
              <p style="color: #4b5563; line-height: 1.6;">
                Merci pour votre commande ! Nous créons en ce moment le livre de
                <strong>${orderRow.child_first_name}</strong> :
                <em>"${orderRow.story?.title || ''}"</em>.
              </p>
              <div style="background: #f3e8ff; border-radius: 16px; padding: 20px; margin: 24px 0;">
                <p style="margin: 4px 0; color: #4b5563;">📦 Livraison : ${shipping.address || ''}, ${shipping.postalCode || ''} ${shipping.city || ''}</p>
                <p style="margin: 4px 0; color: #4b5563;">⏱️ Délai estimé : 5–7 jours ouvrés</p>
                <p style="margin: 4px 0; color: #4b5563;">🔖 Commande : #${orderId.slice(0, 8).toUpperCase()}</p>
              </div>
              <p style="color: #9ca3af; font-size: 12px; margin-top: 40px; text-align: center;">
                © 2025 Lorinizi — Des livres uniques pour des enfants uniques
              </p>
            </div>
          `,
        });
      } catch (err) {
        console.error('[webhook-async]', err);
        await supabase
          .from('orders')
          .update({ status: 'error', error_message: err.message })
          .eq('id', orderId);
      }
    })());

    return;
  }

  return res.status(200).json({ received: true });
}
