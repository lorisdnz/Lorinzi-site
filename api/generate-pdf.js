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
const CARD_BG = '#FEF6E0';

const MAX_STORY_PAGES = { court: 14, classique: 20, long: 25 };

export async function buildBookPdf(order) {
  const story = order.story;
  const childName = order.child_first_name;
  const bookFormat = order.form_data?.bookFormat || 'classique';
  const maxPages = MAX_STORY_PAGES[bookFormat] || 20;

  // Limit pages to expected count (prevents GPT from generating too many)
  const storyPages = (story.pages || []).slice(0, maxPages);

  const doc = new PDFDocument({
    size: [PAGE_SIZE, PAGE_SIZE],
    autoFirstPage: false,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
  });

  const buffers = [];
  doc.on('data', (chunk) => buffers.push(chunk));
  const pdfEnd = new Promise((resolve) => doc.on('end', resolve));

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
  doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);

  const coverImg = storyPages?.[0]?.imageUrl;
  if (coverImg) {
    const buf = await fetchImage(coverImg);
    if (buf) doc.image(buf, 0, 0, { width: PAGE_SIZE, height: PAGE_SIZE, cover: [PAGE_SIZE, PAGE_SIZE] });
  }

  // Dark overlay at bottom
  doc.save();
  doc.fillOpacity(0.68);
  doc.rect(0, PAGE_SIZE * 0.52, PAGE_SIZE, PAGE_SIZE * 0.48).fill('#000000');
  doc.restore();

  // Title
  const title = story.title || `L'histoire de ${childName}`;
  doc.font('Nunito-Bold').fontSize(30).fillColor('#FFD980')
    .text(title, MARGIN, PAGE_SIZE * 0.55, {
      width: PAGE_SIZE - MARGIN * 2,
      align: 'center',
      lineGap: 5,
    });

  // Separator
  doc.rect(PAGE_SIZE / 2 - 50, PAGE_SIZE * 0.72, 100, 2).fill(GOLDEN);

  // Subtitle
  doc.font('Nunito').fontSize(14).fillColor('#FFFFFF')
    .text(`Un livre créé rien que pour ${childName}`, MARGIN, PAGE_SIZE * 0.75, {
      width: PAGE_SIZE - MARGIN * 2,
      align: 'center',
    });

  // Lorinizi branding bottom
  doc.font('Nunito').fontSize(9).fillColor('#AAAAAA')
    .text('Lorinizi — Des livres uniques pour des enfants uniques', MARGIN, PAGE_SIZE - 20, {
      width: PAGE_SIZE - MARGIN * 2,
      align: 'center',
    });

  // ── STORY PAGES (2 PDF pages per story page: illustration + text) ──
  // PDF page counter: cover = page 1, then 2 per story page
  let pdfPageNum = 1;

  for (const page of storyPages) {
    pdfPageNum++; // illustration page

    // ─── Page A: Full illustration ───
    doc.addPage();
    doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);

    const imgBuf = page.imageUrl ? await fetchImage(page.imageUrl) : null;
    if (imgBuf) {
      doc.image(imgBuf, 0, 0, { width: PAGE_SIZE, height: PAGE_SIZE, cover: [PAGE_SIZE, PAGE_SIZE] });
    } else {
      doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill('#FEF3C7');
      doc.font('Nunito').fontSize(40).fillColor(GOLDEN)
        .text('✨', 0, PAGE_SIZE / 2 - 30, { width: PAGE_SIZE, align: 'center' });
    }

    // No page number on illustration pages — cleaner look

    pdfPageNum++; // text page

    // ─── Page B: Premium cream text page ───
    doc.addPage();
    doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);

    // Thick golden top + bottom bars
    doc.rect(0, 0, PAGE_SIZE, 12).fill(GOLDEN);
    doc.rect(0, PAGE_SIZE - 12, PAGE_SIZE, 12).fill(GOLDEN);

    // Inner golden frame lines (elegant border effect)
    doc.rect(22, 22, PAGE_SIZE - 44, 1.5).fill(GOLDEN);
    doc.rect(22, PAGE_SIZE - 23.5, PAGE_SIZE - 44, 1.5).fill(GOLDEN);
    doc.rect(22, 22, 1.5, PAGE_SIZE - 44).fill(GOLDEN);
    doc.rect(PAGE_SIZE - 23.5, 22, 1.5, PAGE_SIZE - 44).fill(GOLDEN);

    // Corner dots at frame intersections
    [22, PAGE_SIZE - 22].forEach(cx => {
      [22, PAGE_SIZE - 22].forEach(cy => {
        doc.circle(cx, cy, 4).fill(GOLDEN);
      });
    });

    // Decorative dots row top center
    [-50, -25, 0, 25, 50].forEach((offset, i) => {
      doc.circle(PAGE_SIZE / 2 + offset, 44, i === 2 ? 6 : 3.5).fill(GOLDEN);
    });

    // Separator line under dots
    doc.rect(60, 57, PAGE_SIZE - 120, 2).fill(GOLDEN);

    // Text — manually truncated to prevent overflow
    const padX = 50;
    const textTop = 78;
    const textW = PAGE_SIZE - padX * 2;
    const textAvailH = PAGE_SIZE - textTop - 62;
    const fontSize = 26;
    const lineGap = 22;
    const maxLines = Math.floor(textAvailH / (fontSize + lineGap));
    const maxChars = maxLines * Math.floor(textW / (fontSize * 0.52));
    const safeText = page.text && page.text.length > maxChars
      ? page.text.slice(0, maxChars - 1).trimEnd() + '…'
      : (page.text || '');

    doc.font('Nunito').fontSize(fontSize).fillColor(DARK)
      .text(safeText, padX, textTop, {
        width: textW,
        height: textAvailH,
        align: 'left',
        lineGap,
        ellipsis: true,
      });

    // Page number bottom center — elegant style
    doc.font('Nunito-Bold').fontSize(13).fillColor(GOLDEN)
      .text(`— ${pdfPageNum} —`, 0, PAGE_SIZE - 34, {
        width: PAGE_SIZE,
        align: 'center',
      });
  }

  // ── END PAGE ─────────────────────────────────────────────────
  doc.addPage();
  doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);
  doc.rect(0, 0, PAGE_SIZE, 8).fill(GOLDEN);
  doc.rect(0, PAGE_SIZE - 8, PAGE_SIZE, 8).fill(GOLDEN);

  // Decorative circle ring around "Fin"
  const cx = PAGE_SIZE / 2;
  const cy = PAGE_SIZE * 0.28;
  for (let i = 0; i < 10; i++) {
    const angle = (i / 10) * Math.PI * 2;
    const r = 80;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r;
    doc.circle(x, y, i % 2 === 0 ? 4 : 2.5).fill(GOLDEN);
  }

  doc.font('Nunito-Bold').fontSize(72).fillColor(GOLDEN)
    .text('Fin', 0, PAGE_SIZE * 0.2, { width: PAGE_SIZE, align: 'center' });

  doc.font('Nunito').fontSize(21).fillColor(DARK)
    .text(`Bravo ${childName} ! 🎉`, 0, PAGE_SIZE * 0.5, { width: PAGE_SIZE, align: 'center' });

  doc.font('Nunito').fontSize(14).fillColor('#A8700C')
    .text('Ce livre a été créé rien que pour toi.', 0, PAGE_SIZE * 0.61, {
      width: PAGE_SIZE, align: 'center',
    });

  // Row of decorative dots
  for (let i = 0; i < 7; i++) {
    doc.circle(PAGE_SIZE / 2 - 60 + i * 20, PAGE_SIZE * 0.73, i === 3 ? 5 : 3).fill(GOLDEN);
  }

  doc.font('Nunito-Bold').fontSize(13).fillColor(GOLDEN)
    .text('✨  Lorinizi  ✨', 0, PAGE_SIZE * 0.8, { width: PAGE_SIZE, align: 'center' });

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
