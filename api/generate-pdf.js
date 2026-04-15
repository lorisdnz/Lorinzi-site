import PDFDocument from 'pdfkit';
import { createClient } from '@supabase/supabase-js';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const FONT_REGULAR = join(__dirname, 'fonts', 'Nunito.ttf');
const FONT_BOLD    = join(__dirname, 'fonts', 'Nunito-Bold.ttf');

const PAGE_SIZE = 567;
const MARGIN    = 40;
const GOLDEN    = '#C98C10';
const CREAM     = '#FFFDF7';
const DARK      = '#2D1B00';

const MAX_STORY_PAGES = { court: 14, classique: 20, long: 25 };

// ── True PDFKit-aware text fitting ─────────────────────────────
// Uses doc.heightOfString() so we KNOW the text fits before rendering.
// Binary search on word count to find maximum fitting text.
function fitText(doc, text, width, maxHeight, lineGap) {
  if (!text || text.trim() === '') return '';

  // MUST set both font AND size to get correct measurements
  doc.font('Nunito').fontSize(26);

  // If it fits as-is, return it directly
  if (doc.heightOfString(text, { width, lineGap }) <= maxHeight) return text;

  // Binary search: find the max word count that fits
  const words = text.split(' ');
  let lo = 1, hi = words.length;

  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = words.slice(0, mid).join(' ') + '…';
    if (doc.heightOfString(candidate, { width, lineGap }) <= maxHeight) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  if (lo === 0) return '';
  return words.slice(0, lo).join(' ') + '…';
}

export async function buildBookPdf(order) {
  const story      = order.story;
  const childName  = order.child_first_name || 'Toi';
  const bookFormat = order.form_data?.bookFormat || 'classique';
  const maxPages   = MAX_STORY_PAGES[bookFormat] || 20;

  // Hard limit — always slice as safety net
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
  const PAD_X       = 50;
  const TEXT_TOP    = 78;
  const TEXT_W      = PAGE_SIZE - PAD_X * 2;   // 467
  const TEXT_AVAIL  = PAGE_SIZE - TEXT_TOP - 55; // 434  (bottom bar 12 + pagenum 43)
  const FONT_SZ     = 26;
  const LINE_GAP    = 22;

  // ── COVER PAGE ──────────────────────────────────────────────
  doc.addPage();
  doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);

  const coverImg = storyPages[0]?.imageUrl;
  if (coverImg) {
    const buf = await fetchImage(coverImg);
    if (buf) doc.image(buf, 0, 0, { width: PAGE_SIZE, height: PAGE_SIZE, cover: [PAGE_SIZE, PAGE_SIZE] });
  }

  doc.save();
  doc.fillOpacity(0.68);
  doc.rect(0, PAGE_SIZE * 0.52, PAGE_SIZE, PAGE_SIZE * 0.48).fill('#000000');
  doc.restore();

  const title = story.title || `L'histoire de ${childName}`;
  doc.font('Nunito-Bold').fontSize(30).fillColor('#FFD980')
    .text(title.slice(0, 80), MARGIN, PAGE_SIZE * 0.55, {
      width: PAGE_SIZE - MARGIN * 2, align: 'center', lineGap: 5,
    });

  doc.rect(PAGE_SIZE / 2 - 50, PAGE_SIZE * 0.72, 100, 2).fill(GOLDEN);

  doc.font('Nunito').fontSize(14).fillColor('#FFFFFF')
    .text(`Un livre créé rien que pour ${childName}`, MARGIN, PAGE_SIZE * 0.75, {
      width: PAGE_SIZE - MARGIN * 2, align: 'center',
    });

  doc.font('Nunito').fontSize(9).fillColor('#AAAAAA')
    .text('Lorinizi — Des livres uniques pour des enfants uniques', MARGIN, PAGE_SIZE - 22, {
      width: PAGE_SIZE - MARGIN * 2, align: 'center',
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
      doc.image(imgBuf, 0, 0, {
        width: PAGE_SIZE, height: PAGE_SIZE, cover: [PAGE_SIZE, PAGE_SIZE],
      });
    } else {
      // Placeholder doré si pas d'image
      doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill('#FEF3C7');
      doc.font('Nunito-Bold').fontSize(60).fillColor(GOLDEN)
        .text('?', 0, PAGE_SIZE / 2 - 40, { width: PAGE_SIZE, align: 'center' });
    }

    // ─── Page B : Page texte premium ───
    pdfPageNum++;
    doc.addPage();
    doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);

    // Barres or épaisses top + bottom
    doc.rect(0, 0, PAGE_SIZE, 12).fill(GOLDEN);
    doc.rect(0, PAGE_SIZE - 12, PAGE_SIZE, 12).fill(GOLDEN);

    // Cadre intérieur doré
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

    // ── Texte : mesuré et tronqué avec PDFKit lui-même ─────────
    doc.font('Nunito'); // set font before measuring
    const displayText = fitText(doc, page.text || '', TEXT_W, TEXT_AVAIL, LINE_GAP);

    doc.font('Nunito').fontSize(FONT_SZ).fillColor(DARK)
      .text(displayText, PAD_X, TEXT_TOP, {
        width:     TEXT_W,
        height:    TEXT_AVAIL,  // hard clip — prevents any page overflow
        align:     'left',
        lineGap:   LINE_GAP,
        lineBreak: true,
        ellipsis:  true,
      });

    // Numéro de page — position absolue fixe
    doc.font('Nunito-Bold').fontSize(13).fillColor(GOLDEN)
      .text(`— ${pdfPageNum} —`, 0, PAGE_SIZE - 32, {
        width: PAGE_SIZE, align: 'center',
      });
  }

  // ── PAGE DE FIN ──────────────────────────────────────────────
  doc.addPage();
  doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);
  doc.rect(0, 0, PAGE_SIZE, 8).fill(GOLDEN);
  doc.rect(0, PAGE_SIZE - 8, PAGE_SIZE, 8).fill(GOLDEN);

  // Cercle décoratif
  const cx = PAGE_SIZE / 2;
  for (let i = 0; i < 10; i++) {
    const angle = (i / 10) * Math.PI * 2;
    const x = cx + Math.cos(angle) * 80;
    const y = PAGE_SIZE * 0.28 + Math.sin(angle) * 80;
    doc.circle(x, y, i % 2 === 0 ? 4 : 2.5).fill(GOLDEN);
  }

  doc.font('Nunito-Bold').fontSize(72).fillColor(GOLDEN)
    .text('Fin', 0, PAGE_SIZE * 0.2, { width: PAGE_SIZE, align: 'center' });

  doc.font('Nunito').fontSize(21).fillColor(DARK)
    .text(`Bravo ${childName} !`, 0, PAGE_SIZE * 0.5, { width: PAGE_SIZE, align: 'center' });

  doc.font('Nunito').fontSize(14).fillColor('#A8700C')
    .text('Ce livre a ete cree rien que pour toi.', 0, PAGE_SIZE * 0.61, {
      width: PAGE_SIZE, align: 'center',
    });

  for (let i = 0; i < 7; i++) {
    doc.circle(PAGE_SIZE / 2 - 60 + i * 20, PAGE_SIZE * 0.73, i === 3 ? 5 : 3).fill(GOLDEN);
  }

  doc.font('Nunito-Bold').fontSize(13).fillColor(GOLDEN)
    .text('Lorinizi', 0, PAGE_SIZE * 0.8, { width: PAGE_SIZE, align: 'center' });

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
      .from('pdfs')
      .upload(filename, pdfBuffer, { contentType: 'application/pdf', upsert: true });
    if (uploadErr) throw new Error('Upload PDF: ' + uploadErr.message);

    const { data: { publicUrl } } = supabase.storage.from('pdfs').getPublicUrl(filename);
    return res.status(200).json({ pdfUrl: publicUrl });
  } catch (err) {
    console.error('[generate-pdf]', err);
    return res.status(500).json({ error: err.message });
  }
}
