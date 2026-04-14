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

const MAX_STORY_PAGES = { court: 14, classique: 20, long: 25 };

// Aggressively truncate text to fit within maxChars
function truncateText(text, maxChars) {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1).trimEnd() + '…';
}

export async function buildBookPdf(order) {
  const story = order.story;
  const childName = order.child_first_name;
  const bookFormat = order.form_data?.bookFormat || 'classique';
  const maxPages = MAX_STORY_PAGES[bookFormat] || 20;

  // HARD LIMIT — always slice here too as safety net
  const storyPages = (story.pages || []).slice(0, maxPages);
  console.log(`[pdf] Building PDF: format=${bookFormat}, pages=${storyPages.length}/${maxPages}`);

  const doc = new PDFDocument({
    size: [PAGE_SIZE, PAGE_SIZE],
    autoFirstPage: false,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
    bufferPages: true, // prevent auto page-add on overflow
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

  // Title — with height limit to prevent overflow
  const title = story.title || `L'histoire de ${childName}`;
  const safeTitle = truncateText(title, 80);
  doc.font('Nunito-Bold').fontSize(30).fillColor('#FFD980')
    .text(safeTitle, MARGIN, PAGE_SIZE * 0.55, {
      width: PAGE_SIZE - MARGIN * 2,
      height: 100,
      align: 'center',
      lineGap: 5,
      ellipsis: true,
    });

  // Separator
  doc.rect(PAGE_SIZE / 2 - 50, PAGE_SIZE * 0.72, 100, 2).fill(GOLDEN);

  // Subtitle
  doc.font('Nunito').fontSize(14).fillColor('#FFFFFF')
    .text(`Un livre créé rien que pour ${childName}`, MARGIN, PAGE_SIZE * 0.75, {
      width: PAGE_SIZE - MARGIN * 2,
      height: 30,
      align: 'center',
      ellipsis: true,
    });

  // Lorinizi branding
  doc.font('Nunito').fontSize(9).fillColor('#AAAAAA')
    .text('Lorinizi — Des livres uniques pour des enfants uniques', MARGIN, PAGE_SIZE - 22, {
      width: PAGE_SIZE - MARGIN * 2,
      height: 18,
      align: 'center',
      ellipsis: true,
    });

  // ── STORY PAGES ──────────────────────────────────────────────
  let pdfPageNum = 1;

  // Text zone constants (computed once)
  const PAD_X = 50;
  const TEXT_TOP = 78;
  const TEXT_W = PAGE_SIZE - PAD_X * 2;
  const TEXT_AVAIL_H = PAGE_SIZE - TEXT_TOP - 62; // 427px
  const FONT_SIZE = 26;
  const LINE_GAP = 22;
  // Conservative: ~34 chars per line, 8 lines max
  const CHARS_PER_LINE = Math.floor(TEXT_W / (FONT_SIZE * 0.50));
  const MAX_LINES = Math.floor(TEXT_AVAIL_H / (FONT_SIZE + LINE_GAP));
  const MAX_CHARS = MAX_LINES * CHARS_PER_LINE;

  for (const page of storyPages) {
    // ─── Page A: Full illustration ───
    pdfPageNum++;
    doc.addPage();
    doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);

    const imgBuf = page.imageUrl ? await fetchImage(page.imageUrl) : null;
    if (imgBuf) {
      doc.image(imgBuf, 0, 0, { width: PAGE_SIZE, height: PAGE_SIZE, cover: [PAGE_SIZE, PAGE_SIZE] });
    } else {
      doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill('#FEF3C7');
      doc.font('Nunito-Bold').fontSize(40).fillColor(GOLDEN)
        .text('*', 0, PAGE_SIZE / 2 - 30, { width: PAGE_SIZE, height: 60, align: 'center' });
    }

    // ─── Page B: Premium cream text page ───
    pdfPageNum++;
    doc.addPage();
    doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);

    // Thick golden top + bottom bars
    doc.rect(0, 0, PAGE_SIZE, 12).fill(GOLDEN);
    doc.rect(0, PAGE_SIZE - 12, PAGE_SIZE, 12).fill(GOLDEN);

    // Inner golden frame
    doc.rect(22, 22, PAGE_SIZE - 44, 1.5).fill(GOLDEN);
    doc.rect(22, PAGE_SIZE - 23.5, PAGE_SIZE - 44, 1.5).fill(GOLDEN);
    doc.rect(22, 22, 1.5, PAGE_SIZE - 44).fill(GOLDEN);
    doc.rect(PAGE_SIZE - 23.5, 22, 1.5, PAGE_SIZE - 44).fill(GOLDEN);

    // Corner dots
    [22, PAGE_SIZE - 22].forEach(cx => {
      [22, PAGE_SIZE - 22].forEach(cy => {
        doc.circle(cx, cy, 4).fill(GOLDEN);
      });
    });

    // Decorative dots top center
    [-50, -25, 0, 25, 50].forEach((offset, i) => {
      doc.circle(PAGE_SIZE / 2 + offset, 44, i === 2 ? 6 : 3.5).fill(GOLDEN);
    });

    // Separator line
    doc.rect(60, 57, PAGE_SIZE - 120, 2).fill(GOLDEN);

    // Story text — aggressively truncated + height limited
    const safeText = truncateText(page.text, MAX_CHARS);

    doc.font('Nunito').fontSize(FONT_SIZE).fillColor(DARK)
      .text(safeText, PAD_X, TEXT_TOP, {
        width: TEXT_W,
        height: TEXT_AVAIL_H,
        align: 'left',
        lineGap: LINE_GAP,
        ellipsis: true,
      });

    // Page number — fixed position, no overflow possible
    doc.font('Nunito-Bold').fontSize(13).fillColor(GOLDEN)
      .text(`— ${pdfPageNum} —`, 0, PAGE_SIZE - 34, {
        width: PAGE_SIZE,
        height: 20,
        align: 'center',
      });
  }

  // ── END PAGE ─────────────────────────────────────────────────
  doc.addPage();
  doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);
  doc.rect(0, 0, PAGE_SIZE, 8).fill(GOLDEN);
  doc.rect(0, PAGE_SIZE - 8, PAGE_SIZE, 8).fill(GOLDEN);

  // Decorative circle ring
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
    .text('Fin', 0, PAGE_SIZE * 0.2, { width: PAGE_SIZE, height: 100, align: 'center' });

  doc.font('Nunito').fontSize(21).fillColor(DARK)
    .text(`Bravo ${childName} !`, 0, PAGE_SIZE * 0.5, { width: PAGE_SIZE, height: 40, align: 'center' });

  doc.font('Nunito').fontSize(14).fillColor('#A8700C')
    .text('Ce livre a ete cree rien que pour toi.', 0, PAGE_SIZE * 0.61, {
      width: PAGE_SIZE, height: 30, align: 'center',
    });

  // Row of decorative dots
  for (let i = 0; i < 7; i++) {
    doc.circle(PAGE_SIZE / 2 - 60 + i * 20, PAGE_SIZE * 0.73, i === 3 ? 5 : 3).fill(GOLDEN);
  }

  doc.font('Nunito-Bold').fontSize(13).fillColor(GOLDEN)
    .text('Lorinizi', 0, PAGE_SIZE * 0.8, { width: PAGE_SIZE, height: 25, align: 'center' });

  doc.end();
  await pdfEnd;

  const finalBuffer = Buffer.concat(buffers);
  console.log(`[pdf] Done — ${finalBuffer.length} bytes`);
  return finalBuffer;
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

    if (uploadErr) throw new Error('Upload PDF echoue : ' + uploadErr.message);

    const { data: { publicUrl } } = supabase.storage.from('pdfs').getPublicUrl(filename);

    return res.status(200).json({ pdfUrl: publicUrl });
  } catch (err) {
    console.error('[generate-pdf]', err);
    return res.status(500).json({ error: err.message });
  }
}
