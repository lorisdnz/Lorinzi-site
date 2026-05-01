import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { Resend } from 'resend';
import { buildBookPdf } from './generate-pdf.js';

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
    console.error('[webhook] Signature invalide:', err.message);
    return res.status(400).json({ error: 'Webhook signature invalide' });
  }

  if (event.type !== 'checkout.session.completed') {
    return res.status(200).json({ received: true });
  }

  const session = event.data.object;
  const orderId = session.metadata?.orderId;
  if (!orderId) return res.status(400).json({ error: 'orderId manquant' });

  const supabase = createClient(
    process.env.PUBLIC_SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  try {
    // 1. Mark as paid
    await supabase
      .from('orders')
      .update({ status: 'paid', stripe_payment_intent_id: session.payment_intent })
      .eq('id', orderId);

    // 2. Fetch full order
    const { data: rawOrder } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .single();

    if (!rawOrder) return res.status(200).json({ received: true });

    // 3. Hard-limit story pages BEFORE building PDF (FIX: use let, not const)
    const FORMAT_MAX_PAGES = { court: 14, classique: 20, long: 25 };
    const bookFormat = rawOrder.form_data?.bookFormat || 'classique';
    const maxStoryPages = FORMAT_MAX_PAGES[bookFormat] || 20;
    const storyPageCount = rawOrder.story?.pages?.length || 0;
    console.log('[webhook] Story pages:', storyPageCount, '→ limiting to', maxStoryPages);

    const orderRow = {
      ...rawOrder,
      story: {
        ...rawOrder.story,
        pages: (rawOrder.story?.pages || []).slice(0, maxStoryPages),
      },
    };
    console.log('[webhook] Final page count:', orderRow.story.pages.length);
    console.log('[webhook] Generating PDF for order:', orderId);
    await supabase.from('orders').update({ status: 'generating_pdf' }).eq('id', orderId);
    const pdfBuffer = await buildBookPdf(orderRow, supabase);
    console.log('[webhook] PDF generated, size:', pdfBuffer.length);

    // 4. Upload PDF
    const filename = `books/${orderId}.pdf`;
    const { error: uploadErr } = await supabase.storage
      .from('pdfs')
      .upload(filename, pdfBuffer, { contentType: 'application/pdf', upsert: true });

    if (uploadErr) throw new Error('Upload PDF échoué: ' + uploadErr.message);

    const { data: { publicUrl: pdfUrl } } = supabase.storage.from('pdfs').getPublicUrl(filename);
    console.log('[webhook] PDF uploaded:', pdfUrl);

    await supabase.from('orders').update({ status: 'sending_to_manufacturer', pdf_url: pdfUrl }).eq('id', orderId);

    // 5. Send to Gelato
    try {
      const gelatoOrderId = await sendToGelato(orderRow, pdfUrl);
      await supabase.from('orders').update({ status: 'sent_to_manufacturer', gelato_order_id: gelatoOrderId }).eq('id', orderId);
      console.log('[webhook] Sent to Gelato:', gelatoOrderId);
    } catch (gelatoErr) {
      console.error('[webhook] Gelato error (non-fatal):', gelatoErr.message);
      await supabase.from('orders').update({ status: 'sent_to_manufacturer' }).eq('id', orderId);
    }

    // 6. Send confirmation email
    try {
      const resend = new Resend(process.env.RESEND_API_KEY);
      const siteUrl = process.env.SITE_URL || 'https://lorinzi-site.vercel.app';
      const shipping = orderRow.shipping_details || {};

      await resend.emails.send({
        from: 'Lorinizi <bonjour@lorinizi.com>',
        to: orderRow.customer_email,
        subject: `✨ Votre livre pour ${orderRow.child_first_name} est en cours de création !`,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 40px 20px;">
            <h1 style="color: #C98C10; font-size: 28px;">Lorinizi ✨</h1>
            <h2 style="color: #1f2937;">Commande confirmée ! 🎉</h2>
            <p style="color: #4b5563; line-height: 1.6;">
              Merci pour votre commande ! Nous créons en ce moment le livre de
              <strong>${orderRow.child_first_name}</strong> :
              <em>"${orderRow.story?.title || ''}"</em>.
            </p>
            <div style="background: #FEF8E7; border-radius: 16px; padding: 20px; margin: 24px 0;">
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
      console.log('[webhook] Confirmation email sent');
    } catch (emailErr) {
      console.error('[webhook] Email error (non-fatal):', emailErr.message);
    }

    return res.status(200).json({ received: true });

  } catch (err) {
    console.error('[webhook] Error:', err.message);
    await supabase.from('orders').update({ status: 'error', error_message: err.message }).eq('id', orderId);
    return res.status(200).json({ received: true });
  }
}
