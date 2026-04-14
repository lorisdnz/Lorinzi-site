import PDFDocument from 'pdfkit';
import { createClient } from '@supabase/supabase-js';

const PAGE_SIZE = 567; // 20x20 cm in points (at 72 DPI)
const MARGIN = 32;

export async function buildBookPdf(order) {
  const story = order.story;
  const childName = order.child_first_name;

  const doc = new PDFDocument({
    size: [PAGE_SIZE, PAGE_SIZE],
    autoFirstPage: false,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
  });

  const buffers = [];
  doc.on('data', (chunk) => buffers.push(chunk));
  const pdfEnd = new Promise((resolve) => doc.on('end', resolve));

  // ── COVER PAGE ──────────────────────────────────────────────
  doc.addPage();
  doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill('#f3e8ff');

  const coverPage = story.pages?.[0];
  if (coverPage?.imageUrl) {
    try {
      const r = await fetch(coverPage.imageUrl);
      const buf = await r.arrayBuffer();
      const imgH = Math.floor(PAGE_SIZE * 0.62);
      doc.image(Buffer.from(buf), 0, 0, { width: PAGE_SIZE, height: imgH });
    } catch (_) {}
  }

  const titleY = PAGE_SIZE * 0.64;
  doc.rect(0, titleY, PAGE_SIZE, PAGE_SIZE - titleY).fill('#7c3aed');

  doc
    .fontSize(22)
    .fillColor('white')
    .font('Helvetica-Bold')
    .text(story.title || `L'histoire de ${childName}`, MARGIN, titleY + 16, {
      width: PAGE_SIZE - MARGIN * 2,
      align: 'center',
    });

  doc
    .fontSize(13)
    .fillColor('#ddd6fe')
    .font('Helvetica')
    .text(`Un livre créé rien que pour ${childName}`, MARGIN, titleY + 60, {
      width: PAGE_SIZE - MARGIN * 2,
      align: 'center',
    });

  doc
    .fontSize(9)
    .fillColor('#c4b5fd')
    .text('✨ Lorinizi — Des livres uniques pour des enfants uniques', MARGIN, PAGE_SIZE - 28, {
      width: PAGE_SIZE - MARGIN * 2,
      align: 'center',
    });

  // ── STORY PAGES ─────────────────────────────────────────────
  for (const page of story.pages) {
    doc.addPage();

    const imgH = Math.floor(PAGE_SIZE * 0.60);

    if (page.imageUrl) {
      try {
        const r = await fetch(page.imageUrl);
        const buf = await r.arrayBuffer();
        doc.image(Buffer.from(buf), 0, 0, { width: PAGE_SIZE, height: imgH });
      } catch (_) {
        doc.rect(0, 0, PAGE_SIZE, imgH).fill('#ede9fe');
      }
    } else {
      doc.rect(0, 0, PAGE_SIZE, imgH).fill('#ede9fe');
    }

    // Purple separator bar
    doc.rect(0, imgH, PAGE_SIZE, 4).fill('#7c3aed');

    // Text background
    doc.rect(0, imgH + 4, PAGE_SIZE, PAGE_SIZE - imgH - 4).fill('#fffbff');

    // Story text
    doc
      .fontSize(12)
      .fillColor('#1f2937')
      .font('Helvetica')
      .text(page.text, MARGIN, imgH + 18, {
        width: PAGE_SIZE - MARGIN * 2,
        height: PAGE_SIZE - imgH - 36,
        align: 'justify',
        lineGap: 2,
      });

    // Page number
    doc
      .fontSize(8)
      .fillColor('#9ca3af')
      .text(String(page.pageNumber), PAGE_SIZE - MARGIN - 5, PAGE_SIZE - 18, {
        width: 20,
        align: 'right',
      });
  }

  // ── END PAGE ─────────────────────────────────────────────────
  doc.addPage();
  doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill('#f3e8ff');
  doc
    .fontSize(40)
    .fillColor('#7c3aed')
    .font('Helvetica-Bold')
    .text('Fin', 0, PAGE_SIZE * 0.28, { width: PAGE_SIZE, align: 'center' });
  doc
    .fontSize(16)
    .fillColor('#6d28d9')
    .font('Helvetica')
    .text(`Bravo ${childName} !`, 0, PAGE_SIZE * 0.44, { width: PAGE_SIZE, align: 'center' });
  doc
    .fontSize(12)
    .fillColor('#7c3aed')
    .text('Ce livre a été créé rien que pour toi.', 0, PAGE_SIZE * 0.54, {
      width: PAGE_SIZE,
      align: 'center',
    });
  doc
    .fontSize(9)
    .fillColor('#a78bfa')
    .text('✨ Lorinizi — Des livres uniques pour des enfants uniques', 0, PAGE_SIZE * 0.84, {
      width: PAGE_SIZE,
      align: 'center',
    });

  doc.end();
  await pdfEnd;

  return Buffer.concat(buffers);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  try {
    const { orderId } = req.body;

    const supabase = createClient(
      process.env.PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );

    const { data: order } = await supabase
      .from('orders')
      .select('*')
      .eq('id', orderId)
      .single();

    if (!order) return res.status(404).json({ error: 'Commande introuvable' });

    const pdfBuffer = await buildBookPdf(order);

    const filename = `books/${orderId}.pdf`;
    const { error: uploadErr } = await supabase.storage
      .from('pdfs')
      .upload(filename, pdfBuffer, { contentType: 'application/pdf', upsert: true });

    if (uploadErr) throw new Error('Upload PDF échoué : ' + uploadErr.message);

    const {
      data: { publicUrl },
    } = supabase.storage.from('pdfs').getPublicUrl(filename);

    return res.status(200).json({ pdfUrl: publicUrl });
  } catch (err) {
    console.error('[generate-pdf]', err);
    return res.status(500).json({ error: err.message });
  }
}
