import PDFDocument from 'pdfkit';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const FONT_REGULAR = join(__dirname, 'fonts', 'Nunito.ttf');
const FONT_BOLD    = join(__dirname, 'fonts', 'Nunito-Bold.ttf');
const LOGO_PATH    = join(__dirname, '..', 'logo.png');

const PAGE_SIZE = 567;
const MARGIN    = 40;
const GOLDEN    = '#C98C10';
const CREAM     = '#FFFDF7';
const DARK      = '#2D1B00';

const MAX_STORY_PAGES = { court: 14, classique: 20, long: 25 };

// ── Rendu texte ligne par ligne — 100% garanti sans débordement ──
// Construit les lignes manuellement avec widthOfString puis les rend
// une par une avec lineBreak:false → PDFKit ne peut JAMAIS créer de page.
function renderTextLines(doc, text, x, y, width, maxHeight, fontSize, lineGap) {
  if (!text) return;

  doc.font('Nunito').fontSize(fontSize);
  const lineH    = fontSize + lineGap;
  const maxLines = Math.floor(maxHeight / lineH);

  // Découpe le texte en lignes en mesurant chaque mot
  const words = text.split(/\s+/).filter(Boolean);
  const lines  = [];
  let current  = '';

  for (const word of words) {
    if (lines.length >= maxLines) break;
    const test = current ? `${current} ${word}` : word;
    if (doc.widthOfString(test) <= width) {
      current = test;
    } else {
      if (current) lines.push(current);
      current = word;
    }
  }
  if (current && lines.length < maxLines) lines.push(current);

  // Tronquer la dernière ligne si trop de lignes
  const display = lines.slice(0, maxLines);
  if (lines.length > maxLines && display.length > 0) {
    const last = display[display.length - 1];
    display[display.length - 1] = last.length > 3 ? last.slice(0, -3).trimEnd() + '…' : last;
  }

  // Rendre chaque ligne à position Y fixe — aucun page break possible
  display.forEach((line, i) => {
    doc.font('Nunito').fontSize(fontSize).fillColor(DARK)
      .text(line, x, y + i * lineH, { width, lineBreak: false });
  });
}

export async function buildBookPdf(order) {
  const story      = order.story;
  const childName  = order.child_first_name || 'Toi';
  const bookFormat = order.form_data?.bookFormat || 'classique';
  const maxPages   = MAX_STORY_PAGES[bookFormat] || 20;

  const storyPages = (story.pages || []).slice(0, maxPages);
  console.log(`[pdf] format=${bookFormat} pages=${storyPages.length}/${maxPages}`);

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

  // ── TEXT ZONE CONSTANTS ──────────────────────────────────────
  const PAD_X      = 50;
  const TEXT_TOP   = 78;
  const TEXT_W     = PAGE_SIZE - PAD_X * 2;   // 467px
  const TEXT_AVAIL = PAGE_SIZE - TEXT_TOP - 60; // 429px
  const FONT_SZ    = 26;
  const LINE_GAP   = 22;

  // ── COVER PAGE ──────────────────────────────────────────────
  doc.addPage();
  doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);

  const COVER_IMG_H = Math.floor(PAGE_SIZE * 0.68);
  const coverImg = storyPages[0]?.imageUrl;
  if (coverImg) {
    const buf = await fetchImage(coverImg);
    if (buf) doc.image(buf, 0, 0, { width: PAGE_SIZE, height: COVER_IMG_H, cover: [PAGE_SIZE, COVER_IMG_H] });
  }

  doc.rect(0, COVER_IMG_H - 6, PAGE_SIZE, 6).fill(GOLDEN);

  const titleZoneY = COVER_IMG_H;
  doc.rect(0, titleZoneY, PAGE_SIZE, PAGE_SIZE - titleZoneY).fill(CREAM);
  doc.rect(0, titleZoneY, PAGE_SIZE, 4).fill(GOLDEN);
  doc.rect(0, PAGE_SIZE - 4, PAGE_SIZE, 4).fill(GOLDEN);
  doc.rect(0, titleZoneY, 4, PAGE_SIZE - titleZoneY).fill(GOLDEN);
  doc.rect(PAGE_SIZE - 4, titleZoneY, 4, PAGE_SIZE - titleZoneY).fill(GOLDEN);

  [-50, -25, 0, 25, 50].forEach((offset, i) => {
    doc.circle(PAGE_SIZE / 2 + offset, titleZoneY + 22, i === 2 ? 5 : 3).fill(GOLDEN);
  });

  const title = story.title || `L'histoire de ${childName}`;
  doc.font('Nunito-Bold').fontSize(32).fillColor(DARK)
    .text(title.slice(0, 60), 20, titleZoneY + 38, {
      width: PAGE_SIZE - 40, align: 'center', lineGap: 6,
      height: 88, ellipsis: true,
    });

  doc.rect(PAGE_SIZE / 2 - 60, titleZoneY + 138, 120, 2.5).fill(GOLDEN);

  doc.font('Nunito-Bold').fontSize(16).fillColor(GOLDEN)
    .text(childName.toUpperCase(), 20, titleZoneY + 150, {
      width: PAGE_SIZE - 40, align: 'center', height: 25,
    });

  doc.font('Nunito').fontSize(8).fillColor('#BBBBBB')
    .text('Lorinizi', 20, PAGE_SIZE - 18, {
      width: PAGE_SIZE - 40, align: 'center', height: 14,
    });

  // ── STORY PAGES ──────────────────────────────────────────────
  let pdfPageNum = 1;

  for (const page of storyPages) {

    // ─── Page A : Illustration pleine page ───
    pdfPageNum++;
    doc.addPage();
    doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);

    const imgBuf = page.imageUrl ? await fetchImage(page.imageUrl) : null;
    if (imgBuf) {
      doc.image(imgBuf, 0, 0, { width: PAGE_SIZE, height: PAGE_SIZE, cover: [PAGE_SIZE, PAGE_SIZE] });
    } else {
      doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill('#FEF3C7');
      doc.font('Nunito-Bold').fontSize(60).fillColor(GOLDEN)
        .text('?', 0, PAGE_SIZE / 2 - 40, { width: PAGE_SIZE, align: 'center', lineBreak: false });
    }

    // ─── Page B : Page texte premium ───
    pdfPageNum++;
    doc.addPage();
    doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);

    // Barres dorées top + bottom
    doc.rect(0, 0, PAGE_SIZE, 12).fill(GOLDEN);
    doc.rect(0, PAGE_SIZE - 12, PAGE_SIZE, 12).fill(GOLDEN);

    // Cadre intérieur
    doc.rect(22, 22, PAGE_SIZE - 44, 1.5).fill(GOLDEN);
    doc.rect(22, PAGE_SIZE - 23.5, PAGE_SIZE - 44, 1.5).fill(GOLDEN);
    doc.rect(22, 22, 1.5, PAGE_SIZE - 44).fill(GOLDEN);
    doc.rect(PAGE_SIZE - 23.5, 22, 1.5, PAGE_SIZE - 44).fill(GOLDEN);

    // Points aux coins
    [22, PAGE_SIZE - 22].forEach(cx => {
      [22, PAGE_SIZE - 22].forEach(cy => {
        doc.circle(cx, cy, 4).fill(GOLDEN);
      });
    });

    // Points décoratifs
    [-50, -25, 0, 25, 50].forEach((offset, i) => {
      doc.circle(PAGE_SIZE / 2 + offset, 44, i === 2 ? 6 : 3.5).fill(GOLDEN);
    });

    // Ligne séparatrice
    doc.rect(60, 57, PAGE_SIZE - 120, 2).fill(GOLDEN);

    // ── Texte rendu ligne par ligne — ZERO débordement possible ──
    renderTextLines(doc, page.text, PAD_X, TEXT_TOP, TEXT_W, TEXT_AVAIL, FONT_SZ, LINE_GAP);

    // Numéro de page centré dans la bande dorée du bas
    doc.font('Nunito-Bold').fontSize(12).fillColor(CREAM)
      .text(`${pdfPageNum}`, 0, PAGE_SIZE - 10, {
        width: PAGE_SIZE, align: 'center', lineBreak: false,
      });
  }

  // ── PAGE DE FIN ──────────────────────────────────────────────
  doc.addPage();
  doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);
  doc.rect(0, 0, PAGE_SIZE, 8).fill(GOLDEN);
  doc.rect(0, PAGE_SIZE - 8, PAGE_SIZE, 8).fill(GOLDEN);

  // Cercle décoratif autour de "Fin"
  const fcx = PAGE_SIZE / 2;
  for (let i = 0; i < 12; i++) {
    const angle = (i / 12) * Math.PI * 2;
    doc.circle(fcx + Math.cos(angle) * 80, PAGE_SIZE * 0.28 + Math.sin(angle) * 80,
      i % 2 === 0 ? 4 : 2.5).fill(GOLDEN);
  }

  doc.font('Nunito-Bold').fontSize(72).fillColor(GOLDEN)
    .text('Fin', 0, PAGE_SIZE * 0.18, { width: PAGE_SIZE, align: 'center', lineBreak: false });

  doc.font('Nunito-Bold').fontSize(20).fillColor(DARK)
    .text(`Bravo ${childName} !`, 0, PAGE_SIZE * 0.48, { width: PAGE_SIZE, align: 'center', lineBreak: false });

  // Points décoratifs
  for (let i = 0; i < 7; i++) {
    doc.circle(PAGE_SIZE / 2 - 60 + i * 20, PAGE_SIZE * 0.62, i === 3 ? 5 : 3).fill(GOLDEN);
  }

  // Logo Lorinizi
  try {
    const logoBuf = readFileSync(LOGO_PATH);
    const logoSize = 120;
    doc.image(logoBuf, (PAGE_SIZE - logoSize) / 2, PAGE_SIZE * 0.68, {
      width: logoSize, height: logoSize, fit: [logoSize, logoSize],
    });
  } catch {
    doc.font('Nunito-Bold').fontSize(18).fillColor(GOLDEN)
      .text('Lorinizi', 0, PAGE_SIZE * 0.72, { width: PAGE_SIZE, align: 'center', lineBreak: false });
  }

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
    const { data: order } = await supabase.from('orders').select('*').eq('id', orderId).single();
    if (!order) return res.status(404).json({ error: 'Commande introuvable' });

    const pdfBuffer = await buildBookPdf(order);
    const filename  = `books/${orderId}.pdf`;

    const { error: uploadErr } = await supabase.storage
      .from('pdfs').upload(filename, pdfBuffer, { contentType: 'application/pdf', upsert: true });
    if (uploadErr) throw new Error('Upload PDF: ' + uploadErr.message);

    const { data: { publicUrl } } = supabase.storage.from('pdfs').getPublicUrl(filename);
    return res.status(200).json({ pdfUrl: publicUrl });
  } catch (err) {
    console.error('[generate-pdf]', err);
    return res.status(500).json({ error: err.message });
  }
}
