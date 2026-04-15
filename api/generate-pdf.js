import PDFDocument from 'pdfkit';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const FONT_REGULAR = join(__dirname, 'fonts', 'Nunito.ttf');
const FONT_BOLD    = join(__dirname, 'fonts', 'Nunito-Bold.ttf');
const LOGO_PATH    = join(__dirname, '..', 'logo.png');

const PAGE_SIZE = 567;
const MARGIN    = 40;
const GOLDEN    = '#C98C10';
const CREAM     = '#FFFDF7';
const DARK      = '#2D1B00';

const MAX_STORY_PAGES = { court: 14, classique: 20, long: 25 };

// ── Truncate text to a hard character limit ─────────────────────
// At font-size 26, Nunito averages ~13.5px per char, page width=467px
// → ~34 chars per line × 8 lines = ~272 chars max.
// We use 220 chars as a safe conservative limit.
function hardTruncate(text, maxChars = 220) {
  if (!text) return '';
  const t = text.trim();
  if (t.length <= maxChars) return t;
  // Cut at last space before limit
  const cut = t.slice(0, maxChars).replace(/\s+\S*$/, '');
  return cut + '…';
}

export async function buildBookPdf(order) {
  const story      = order.story;
  const childName  = order.child_first_name || 'Toi';
  const bookFormat = order.form_data?.bookFormat || 'classique';
  const maxPages   = MAX_STORY_PAGES[bookFormat] || 20;

  // Triple safety net — slice to maxPages
  const storyPages = (story?.pages || []).slice(0, maxPages);
  console.log(`[pdf] format=${bookFormat} maxPages=${maxPages} storyPages=${storyPages.length}`);

  const doc = new PDFDocument({
    size: [PAGE_SIZE, PAGE_SIZE],
    autoFirstPage: false,
    margins: { top: 0, bottom: 0, left: 0, right: 0 },
  });

  const buffers = [];
  doc.on('data', chunk => buffers.push(chunk));
  const pdfEnd = new Promise(resolve => doc.on('end', resolve));

  doc.registerFont('Nunito',      FONT_REGULAR);
  doc.registerFont('Nunito-Bold', FONT_BOLD);

  async function fetchImage(url) {
    try {
      const r   = await fetch(url);
      const buf = await r.arrayBuffer();
      return Buffer.from(buf);
    } catch { return null; }
  }

  // Text zone
  const PAD_X      = 50;
  const TEXT_TOP   = 78;
  const TEXT_W     = PAGE_SIZE - PAD_X * 2;   // 467px
  const TEXT_H     = PAGE_SIZE - TEXT_TOP - 60; // 429px
  const FONT_SZ    = 26;
  const LINE_GAP   = 22;

  // ── COVER PAGE ──────────────────────────────────────────────
  doc.addPage();
  doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);

  const COVER_H = Math.floor(PAGE_SIZE * 0.70); // top 70% = image
  const coverImg = storyPages[0]?.imageUrl;
  if (coverImg) {
    const buf = await fetchImage(coverImg);
    if (buf) doc.image(buf, 0, 0, { width: PAGE_SIZE, height: COVER_H, cover: [PAGE_SIZE, COVER_H] });
  }

  // Golden strip at bottom of image
  doc.rect(0, COVER_H - 5, PAGE_SIZE, 5).fill(GOLDEN);

  // Cream title zone
  const TZ = COVER_H; // title zone starts here
  doc.rect(0, TZ, PAGE_SIZE, PAGE_SIZE - TZ).fill(CREAM);

  // Frame
  doc.rect(0, TZ,           PAGE_SIZE, 4).fill(GOLDEN);
  doc.rect(0, PAGE_SIZE - 4, PAGE_SIZE, 4).fill(GOLDEN);
  doc.rect(0, TZ,           4, PAGE_SIZE - TZ).fill(GOLDEN);
  doc.rect(PAGE_SIZE - 4, TZ, 4, PAGE_SIZE - TZ).fill(GOLDEN);

  // Decorative dots
  [-50, -25, 0, 25, 50].forEach((off, i) => {
    doc.circle(PAGE_SIZE / 2 + off, TZ + 20, i === 2 ? 5 : 3).fill(GOLDEN);
  });

  // Title — big, centered
  const title = story?.title || `L'histoire de ${childName}`;
  doc.font('Nunito-Bold').fontSize(30).fillColor(DARK)
    .text(title.slice(0, 55), 20, TZ + 35, {
      width: PAGE_SIZE - 40, align: 'center',
      height: 80, lineGap: 4, ellipsis: true,
    });

  // Golden separator line
  doc.rect(PAGE_SIZE / 2 - 55, TZ + 125, 110, 2.5).fill(GOLDEN);

  // Small Lorinizi branding only
  doc.font('Nunito').fontSize(9).fillColor('#BBBBBB')
    .text('Lorinizi', 0, PAGE_SIZE - 18, {
      width: PAGE_SIZE, align: 'center', lineBreak: false,
    });

  // ── STORY PAGES ──────────────────────────────────────────────
  let pdfPageNum = 1;

  for (const page of storyPages) {

    // ─── Illustration page ───
    pdfPageNum++;
    doc.addPage();
    doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);
    const imgBuf = page.imageUrl ? await fetchImage(page.imageUrl) : null;
    if (imgBuf) {
      doc.image(imgBuf, 0, 0, { width: PAGE_SIZE, height: PAGE_SIZE, cover: [PAGE_SIZE, PAGE_SIZE] });
    } else {
      doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill('#FEF3C7');
    }

    // ─── Text page ───
    pdfPageNum++;
    doc.addPage();
    doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);

    // Golden bars
    doc.rect(0, 0,             PAGE_SIZE, 12).fill(GOLDEN);
    doc.rect(0, PAGE_SIZE - 12, PAGE_SIZE, 12).fill(GOLDEN);

    // Inner frame
    doc.rect(22, 22,            PAGE_SIZE - 44, 1.5).fill(GOLDEN);
    doc.rect(22, PAGE_SIZE - 23.5, PAGE_SIZE - 44, 1.5).fill(GOLDEN);
    doc.rect(22, 22,            1.5, PAGE_SIZE - 44).fill(GOLDEN);
    doc.rect(PAGE_SIZE - 23.5, 22, 1.5, PAGE_SIZE - 44).fill(GOLDEN);

    // Corner dots
    [22, PAGE_SIZE - 22].forEach(cx => {
      [22, PAGE_SIZE - 22].forEach(cy => {
        doc.circle(cx, cy, 4).fill(GOLDEN);
      });
    });

    // Decorative dots top
    [-50, -25, 0, 25, 50].forEach((off, i) => {
      doc.circle(PAGE_SIZE / 2 + off, 44, i === 2 ? 6 : 3.5).fill(GOLDEN);
    });

    // Separator
    doc.rect(60, 57, PAGE_SIZE - 120, 2).fill(GOLDEN);

    // ── TEXT — hard truncate then render with height clip ──────
    const safeText = hardTruncate(page.text, 220);

    doc.font('Nunito').fontSize(FONT_SZ).fillColor(DARK)
      .text(safeText, PAD_X, TEXT_TOP, {
        width:    TEXT_W,
        height:   TEXT_H,
        align:    'left',
        lineGap:  LINE_GAP,
        ellipsis: true,
      });

    // Page number inside bottom golden bar
    doc.font('Nunito-Bold').fontSize(11).fillColor(CREAM)
      .text(`${pdfPageNum}`, 0, PAGE_SIZE - 9, {
        width: PAGE_SIZE, align: 'center', lineBreak: false,
      });
  }

  // ── LAST PAGE ────────────────────────────────────────────────
  doc.addPage();
  doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);
  doc.rect(0, 0,              PAGE_SIZE, 8).fill(GOLDEN);
  doc.rect(0, PAGE_SIZE - 8,  PAGE_SIZE, 8).fill(GOLDEN);

  // Decorative circle
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    doc.circle(PAGE_SIZE / 2 + Math.cos(a) * 80, PAGE_SIZE * 0.28 + Math.sin(a) * 80,
      i % 2 === 0 ? 4 : 2.5).fill(GOLDEN);
  }

  doc.font('Nunito-Bold').fontSize(72).fillColor(GOLDEN)
    .text('Fin', 0, PAGE_SIZE * 0.18, { width: PAGE_SIZE, align: 'center', lineBreak: false });

  doc.font('Nunito-Bold').fontSize(20).fillColor(DARK)
    .text(`Bravo ${childName} !`, 0, PAGE_SIZE * 0.47, {
      width: PAGE_SIZE, align: 'center', lineBreak: false,
    });

  // Dots
  for (let i = 0; i < 7; i++) {
    doc.circle(PAGE_SIZE / 2 - 60 + i * 20, PAGE_SIZE * 0.60, i === 3 ? 5 : 3).fill(GOLDEN);
  }

  // Logo
  try {
    const logoBuf = readFileSync(LOGO_PATH);
    const logoSize = 110;
    doc.image(logoBuf, (PAGE_SIZE - logoSize) / 2, PAGE_SIZE * 0.66, {
      fit: [logoSize, logoSize],
    });
  } catch (e) {
    console.error('[pdf] Logo not found:', e.message);
    doc.font('Nunito-Bold').fontSize(18).fillColor(GOLDEN)
      .text('Lorinizi', 0, PAGE_SIZE * 0.72, { width: PAGE_SIZE, align: 'center', lineBreak: false });
  }

  doc.end();
  await pdfEnd;

  const buf = Buffer.concat(buffers);
  console.log(`[pdf] Done — ${buf.length} bytes, expected ~${storyPages.length * 2 + 2} pages`);
  return buf;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  try {
    const { orderId } = req.body;
    const supabase = createClient(
      process.env.PUBLIC_SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY
    );
    const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).single();
    if (!order) return res.status(404).json({ error: 'Commande introuvable' });
    const pdfBuffer = await buildBookPdf(order);
    const filename  = `books/${orderId}.pdf`;
    const { error } = await supabase.storage.from('pdfs')
      .upload(filename, pdfBuffer, { contentType: 'application/pdf', upsert: true });
    if (error) throw new Error('Upload: ' + error.message);
    const { data: { publicUrl } } = supabase.storage.from('pdfs').getPublicUrl(filename);
    return res.status(200).json({ pdfUrl: publicUrl });
  } catch (err) {
    console.error('[generate-pdf]', err);
    return res.status(500).json({ error: err.message });
  }
}
