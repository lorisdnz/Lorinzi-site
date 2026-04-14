import PDFDocument from 'pdfkit';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FONT_REGULAR = join(__dirname, 'fonts', 'Nunito.ttf');
const FONT_BOLD = join(__dirname, 'fonts', 'Nunito-Bold.ttf');

const PAGE_SIZE = 567; // 20x20 cm at 72 DPI
const MARGIN = 40;
const GOLDEN = '#C98C10';
const CREAM = '#FFFDF7';
const DARK = '#2D1B00';

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

  // Register fonts
  doc.registerFont('Nunito', FONT_REGULAR);
  doc.registerFont('Nunito-Bold', FONT_BOLD);

  // Helper: fetch image buffer
  async function fetchImage(url) {
    try {
      const r = await fetch(url);
      const buf = await r.arrayBuffer();
      return Buffer.from(buf);
    } catch (_) { return null; }
  }

  // ── COVER PAGE ──────────────────────────────────────────────
  doc.addPage();

  // Background gradient effect
  doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);

  // Cover illustration (full page)
  const coverImg = story.pages?.[0]?.imageUrl;
  if (coverImg) {
    const buf = await fetchImage(coverImg);
    if (buf) doc.image(buf, 0, 0, { width: PAGE_SIZE, height: PAGE_SIZE, cover: [PAGE_SIZE, PAGE_SIZE] });
  }

  // Golden overlay band at bottom
  doc.save();
  doc.fillOpacity(0.55);
  doc.rect(0, PAGE_SIZE * 0.65, PAGE_SIZE, PAGE_SIZE * 0.35).fill('#000000');
  doc.restore();

  // Title
  doc.font('Nunito-Bold').fontSize(26).fillColor('white')
    .text(story.title || `L'histoire de ${childName}`, MARGIN, PAGE_SIZE * 0.67, {
      width: PAGE_SIZE - MARGIN * 2,
      align: 'center',
      lineGap: 4,
    });

  // Subtitle
  doc.font('Nunito').fontSize(13).fillColor('#FFD980')
    .text(`Un livre créé rien que pour ${childName} ✨`, MARGIN, PAGE_SIZE * 0.82, {
      width: PAGE_SIZE - MARGIN * 2,
      align: 'center',
    });

  // Lorinizi branding
  doc.font('Nunito').fontSize(9).fillColor('#AAAAAA')
    .text('Lorinizi — Des livres uniques pour des enfants uniques', MARGIN, PAGE_SIZE - 22, {
      width: PAGE_SIZE - MARGIN * 2,
      align: 'center',
    });

  // ── STORY PAGES (2 pages per story page: illustration + text) ──
  for (const page of story.pages) {

    // --- Page A: Full illustration ---
    doc.addPage();
    doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);

    const imgBuf = page.imageUrl ? await fetchImage(page.imageUrl) : null;
    if (imgBuf) {
      doc.image(imgBuf, 0, 0, { width: PAGE_SIZE, height: PAGE_SIZE, cover: [PAGE_SIZE, PAGE_SIZE] });
    } else {
      // Decorative placeholder
      doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill('#FEF3C7');
      doc.font('Nunito').fontSize(40).fillColor(GOLDEN)
        .text('✨', 0, PAGE_SIZE / 2 - 30, { width: PAGE_SIZE, align: 'center' });
    }

    // Page number badge
    doc.circle(PAGE_SIZE - 24, PAGE_SIZE - 24, 14).fill(GOLDEN);
    doc.font('Nunito-Bold').fontSize(9).fillColor('white')
      .text(String(page.pageNumber), PAGE_SIZE - 38, PAGE_SIZE - 29, { width: 28, align: 'center' });

    // --- Page B: Text page ---
    doc.addPage();
    doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);

    // Decorative top strip
    doc.rect(0, 0, PAGE_SIZE, 6).fill(GOLDEN);

    // Small golden dots decoration
    for (let i = 0; i < 5; i++) {
      doc.circle(MARGIN + i * 18, 28, 3).fill(GOLDEN);
    }

    // Story text
    const textY = 50;
    const textH = PAGE_SIZE - textY - 60;
    doc.font('Nunito').fontSize(15).fillColor(DARK)
      .text(page.text, MARGIN, textY, {
        width: PAGE_SIZE - MARGIN * 2,
        height: textH,
        align: 'justify',
        lineGap: 6,
      });

    // Bottom decoration
    doc.rect(0, PAGE_SIZE - 6, PAGE_SIZE, 6).fill(GOLDEN);

    // Page number
    doc.font('Nunito').fontSize(9).fillColor(GOLDEN)
      .text(`— ${page.pageNumber} —`, 0, PAGE_SIZE - 28, { width: PAGE_SIZE, align: 'center' });
  }

  // ── END PAGE ─────────────────────────────────────────────────
  doc.addPage();
  doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);
  doc.rect(0, 0, PAGE_SIZE, 6).fill(GOLDEN);
  doc.rect(0, PAGE_SIZE - 6, PAGE_SIZE, 6).fill(GOLDEN);

  doc.font('Nunito-Bold').fontSize(60).fillColor(GOLDEN)
    .text('Fin', 0, PAGE_SIZE * 0.25, { width: PAGE_SIZE, align: 'center' });

  doc.font('Nunito').fontSize(18).fillColor(DARK)
    .text(`Bravo ${childName} ! 🎉`, 0, PAGE_SIZE * 0.48, { width: PAGE_SIZE, align: 'center' });

  doc.font('Nunito').fontSize(13).fillColor('#A8700C')
    .text('Ce livre a été créé rien que pour toi.', 0, PAGE_SIZE * 0.58, { width: PAGE_SIZE, align: 'center' });

  doc.font('Nunito').fontSize(10).fillColor(GOLDEN)
    .text('✨ Lorinizi ✨', 0, PAGE_SIZE * 0.78, { width: PAGE_SIZE, align: 'center' });

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

    const { data: { publicUrl } } = supabase.storage.from('pdfs').getPublicUrl(filename);

    return res.status(200).json({ pdfUrl: publicUrl });
  } catch (err) {
    console.error('[generate-pdf]', err);
    return res.status(500).json({ error: err.message });
  }
}
