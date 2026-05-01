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
const GOLDEN    = '#C98C10';
const CREAM     = '#FFFDF7';
const DARK      = '#2D1B00';

const MAX_STORY_PAGES = { court: 14, classique: 20, long: 25 };

// ── Render text line-by-line at explicit Y coords ────────────────
// The ONLY reliable way to prevent PDFKit from adding extra pages.
function renderTextSafe(doc, text, x, y, maxWidth, maxHeight, fontSize, lineGap) {
  if (!text) return;
  doc.font('Nunito').fontSize(fontSize).fillColor(DARK);

  const LINE_H    = fontSize + lineGap;
  const MAX_LINES = Math.floor(maxHeight / LINE_H);
  const words     = text.trim().split(/\s+/);

  const lines = [];
  let current = '';
  for (const word of words) {
    const test = current ? current + ' ' + word : word;
    if (doc.widthOfString(test) > maxWidth) {
      if (current) {
        lines.push(current);
        if (lines.length >= MAX_LINES) break;
      }
      current = word;
    } else {
      current = test;
    }
  }
  if (current && lines.length < MAX_LINES) lines.push(current);

  // Add ellipsis if text was cut
  const rendered = lines.join(' ');
  if (rendered.length < text.trim().length - 3 && lines.length > 0) {
    let last = lines[lines.length - 1];
    while (last.length > 0 && doc.widthOfString(last + '…') > maxWidth) {
      last = last.slice(0, -1).trimEnd();
    }
    lines[lines.length - 1] = last + '…';
  }

  // Render each line at explicit Y — PDFKit cannot auto-add pages this way
  lines.forEach((ln, i) => {
    doc.text(ln, x, y + i * LINE_H, { lineBreak: false });
  });
}

// ── Download image from Supabase Storage (bypasses public URL auth issues) ──
async function downloadImage(supabase, url) {
  if (!url) return null;

  // Method 1: Supabase admin download (most reliable — bypasses RLS/public settings)
  if (supabase) {
    try {
      // Extract path from URL: /storage/v1/object/public/images/FILENAME
      const match = url.match(/\/storage\/v1\/object\/(?:public\/)?images\/(.+?)(?:\?|$)/);
      if (match && match[1]) {
        const { data, error } = await supabase.storage.from('images').download(match[1]);
        if (data && !error) {
          const buf = await data.arrayBuffer();
          console.log(`[pdf] Supabase download OK: ${match[1]}`);
          return Buffer.from(buf);
        }
        if (error) console.warn(`[pdf] Supabase download error: ${error.message}`);
      }
    } catch (e) {
      console.warn(`[pdf] Supabase download failed: ${e.message}`);
    }
  }

  // Method 2: HTTP fetch fallback (works if bucket is truly public)
  try {
    const controller = new AbortController();
    const timeout    = setTimeout(() => controller.abort(), 20000);
    const r          = await fetch(url, { signal: controller.signal });
    clearTimeout(timeout);
    if (!r.ok) {
      console.warn(`[pdf] HTTP fetch failed for image: ${r.status} ${url}`);
      return null;
    }
    const buf = await r.arrayBuffer();
    console.log(`[pdf] HTTP fetch OK: ${url.slice(-40)}`);
    return Buffer.from(buf);
  } catch (e) {
    console.warn(`[pdf] HTTP fetch error: ${e.message}`);
    return null;
  }
}

export async function buildBookPdf(order, supabase = null) {
  const story      = order.story;
  const childName  = order.child_first_name || 'Toi';
  const bookFormat = order.form_data?.bookFormat || 'classique';
  const maxPages   = MAX_STORY_PAGES[bookFormat] || 20;

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

  // Text zone — 19px fits ~96 words (GPT generates 60-90 words/page)
  const PAD_X    = 48;
  const TEXT_TOP = 72;
  const TEXT_W   = PAGE_SIZE - PAD_X * 2;   // 471px
  const TEXT_H   = PAGE_SIZE - TEXT_TOP - 55; // 440px
  const FONT_SZ  = 19;
  const LINE_GAP = 14;
  // → LINE_H = 33px, MAX_LINES = floor(440/33) = 13 lines
  // → ~8 words/line × 13 = ~104 words max ✓

  // ── PRE-FETCH ALL IMAGES IN PARALLEL via Supabase admin ──
  console.log(`[pdf] Downloading ${storyPages.length} images in parallel...`);
  const imageBuffers = await Promise.all(
    storyPages.map(page => downloadImage(supabase, page.imageUrl))
  );
  const loaded = imageBuffers.filter(Boolean).length;
  console.log(`[pdf] Images loaded: ${loaded}/${storyPages.length}`);

  // ── COVER PAGE ──────────────────────────────────────────────
  doc.addPage();
  doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);

  const COVER_H  = Math.floor(PAGE_SIZE * 0.70);
  const coverBuf = imageBuffers[0];
  if (coverBuf) {
    doc.image(coverBuf, 0, 0, { width: PAGE_SIZE, height: COVER_H, cover: [PAGE_SIZE, COVER_H] });
  }

  doc.rect(0, COVER_H - 5, PAGE_SIZE, 5).fill(GOLDEN);

  const TZ = COVER_H;
  doc.rect(0, TZ, PAGE_SIZE, PAGE_SIZE - TZ).fill(CREAM);
  doc.rect(0, TZ,            PAGE_SIZE, 4).fill(GOLDEN);
  doc.rect(0, PAGE_SIZE - 4, PAGE_SIZE, 4).fill(GOLDEN);
  doc.rect(0, TZ,            4, PAGE_SIZE - TZ).fill(GOLDEN);
  doc.rect(PAGE_SIZE - 4, TZ, 4, PAGE_SIZE - TZ).fill(GOLDEN);

  [-50, -25, 0, 25, 50].forEach((off, i) => {
    doc.circle(PAGE_SIZE / 2 + off, TZ + 20, i === 2 ? 5 : 3).fill(GOLDEN);
  });

  const title = story?.title || `L'histoire de ${childName}`;
  doc.font('Nunito-Bold').fontSize(30).fillColor(DARK)
    .text(title.slice(0, 55), 20, TZ + 35, {
      width: PAGE_SIZE - 40, align: 'center',
      height: 80, lineGap: 4, ellipsis: true,
    });

  doc.rect(PAGE_SIZE / 2 - 55, TZ + 125, 110, 2.5).fill(GOLDEN);

  doc.font('Nunito').fontSize(9).fillColor('#BBBBBB')
    .text('Lorinizi', 0, PAGE_SIZE - 18, {
      width: PAGE_SIZE, align: 'center', lineBreak: false,
    });

  // ── STORY PAGES ──────────────────────────────────────────────
  let pdfPageNum = 1;

  for (let pi = 0; pi < storyPages.length; pi++) {
    const page   = storyPages[pi];
    const imgBuf = imageBuffers[pi];

    // ─── Illustration page ───
    pdfPageNum++;
    doc.addPage();
    doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);
    if (imgBuf) {
      doc.image(imgBuf, 0, 0, { width: PAGE_SIZE, height: PAGE_SIZE, cover: [PAGE_SIZE, PAGE_SIZE] });
    } else {
      // Fallback: styled page (not blank)
      doc.rect(0, 0,             PAGE_SIZE, 8).fill(GOLDEN);
      doc.rect(0, PAGE_SIZE - 8, PAGE_SIZE, 8).fill(GOLDEN);
      doc.rect(0, 0,             8, PAGE_SIZE).fill(GOLDEN);
      doc.rect(PAGE_SIZE - 8, 0, 8, PAGE_SIZE).fill(GOLDEN);
      doc.font('Nunito-Bold').fontSize(36).fillColor(GOLDEN)
        .text('✨', 0, PAGE_SIZE / 2 - 25, { width: PAGE_SIZE, align: 'center', lineBreak: false });
    }

    // ─── Text page ───
    pdfPageNum++;
    doc.addPage();
    doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);

    doc.rect(0, 0,              PAGE_SIZE, 12).fill(GOLDEN);
    doc.rect(0, PAGE_SIZE - 12, PAGE_SIZE, 12).fill(GOLDEN);

    doc.rect(22, 22,               PAGE_SIZE - 44, 1.5).fill(GOLDEN);
    doc.rect(22, PAGE_SIZE - 23.5, PAGE_SIZE - 44, 1.5).fill(GOLDEN);
    doc.rect(22, 22,               1.5, PAGE_SIZE - 44).fill(GOLDEN);
    doc.rect(PAGE_SIZE - 23.5, 22, 1.5, PAGE_SIZE - 44).fill(GOLDEN);

    [22, PAGE_SIZE - 22].forEach(cx => {
      [22, PAGE_SIZE - 22].forEach(cy => {
        doc.circle(cx, cy, 4).fill(GOLDEN);
      });
    });

    [-50, -25, 0, 25, 50].forEach((off, i) => {
      doc.circle(PAGE_SIZE / 2 + off, 44, i === 2 ? 6 : 3.5).fill(GOLDEN);
    });

    doc.rect(60, 57, PAGE_SIZE - 120, 2).fill(GOLDEN);

    // TEXT — line-by-line rendering (no auto page breaks possible)
    renderTextSafe(doc, page.text || '', PAD_X, TEXT_TOP, TEXT_W, TEXT_H, FONT_SZ, LINE_GAP);

    // Page number in golden bar
    doc.font('Nunito-Bold').fontSize(11).fillColor(CREAM)
      .text(`${pdfPageNum}`, 0, PAGE_SIZE - 9, {
        width: PAGE_SIZE, align: 'center', lineBreak: false,
      });
  }

  // ── LAST PAGE ────────────────────────────────────────────────
  doc.addPage();
  doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);
  doc.rect(0, 0,             PAGE_SIZE, 8).fill(GOLDEN);
  doc.rect(0, PAGE_SIZE - 8, PAGE_SIZE, 8).fill(GOLDEN);

  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    doc.circle(
      PAGE_SIZE / 2 + Math.cos(a) * 80,
      PAGE_SIZE * 0.26 + Math.sin(a) * 80,
      i % 2 === 0 ? 4 : 2.5
    ).fill(GOLDEN);
  }

  doc.font('Nunito-Bold').fontSize(72).fillColor(GOLDEN)
    .text('Fin', 0, PAGE_SIZE * 0.16, { width: PAGE_SIZE, align: 'center', lineBreak: false });

  doc.font('Nunito-Bold').fontSize(20).fillColor(DARK)
    .text(`Bravo ${childName} !`, 0, PAGE_SIZE * 0.38, {
      width: PAGE_SIZE, align: 'center', lineBreak: false,
    });

  for (let i = 0; i < 7; i++) {
    doc.circle(PAGE_SIZE / 2 - 60 + i * 20, PAGE_SIZE * 0.47, i === 3 ? 5 : 3).fill(GOLDEN);
  }

  try {
    const logoBuf  = readFileSync(LOGO_PATH);
    const logoSize = 240;
    doc.image(logoBuf, (PAGE_SIZE - logoSize) / 2, PAGE_SIZE * 0.51, {
      fit: [logoSize, logoSize],
    });
  } catch (e) {
    console.error('[pdf] Logo not found:', e.message);
    doc.font('Nunito-Bold').fontSize(26).fillColor(GOLDEN)
      .text('Lorinizi', 0, PAGE_SIZE * 0.58, { width: PAGE_SIZE, align: 'center', lineBreak: false });
  }

  doc.end();
  await pdfEnd;

  const buf = Buffer.concat(buffers);
  console.log(`[pdf] Done — ${(buf.length / 1024 / 1024).toFixed(1)}MB, ${storyPages.length * 2 + 2} pages`);
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
    const pdfBuffer = await buildBookPdf(order, supabase);
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
