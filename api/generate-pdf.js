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
  doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill('#1a0a2e');

  const coverImg = storyPages?.[0]?.imageUrl;
  if (coverImg) {
    const buf = await fetchImage(coverImg);
    if (buf) doc.image(buf, 0, 0, { width: PAGE_SIZE, height: PAGE_SIZE * 0.62, cover: [PAGE_SIZE, PAGE_SIZE * 0.62] });
  }

  // Bottom panel — solid dark purple
  doc.rect(0, PAGE_SIZE * 0.60, PAGE_SIZE, PAGE_SIZE * 0.40).fill('#1a0a2e');

  // Golden top border on bottom panel
  doc.rect(0, PAGE_SIZE * 0.60, PAGE_SIZE, 4).fill(GOLDEN);

  // Decorative stars
  [[60,PAGE_SIZE*0.67,2],[PAGE_SIZE-55,PAGE_SIZE*0.69,1.5],[PAGE_SIZE/2-100,PAGE_SIZE*0.91,1.5],[PAGE_SIZE/2+110,PAGE_SIZE*0.88,2],[40,PAGE_SIZE*0.85,1]].forEach(([x,y,r]) => {
    doc.circle(x, y, r).fill('#FFD980');
  });

  // Title box
  const titleY = PAGE_SIZE * 0.63;
  const title = story.title || `L'histoire de ${childName}`;
  doc.font('Nunito-Bold').fontSize(30).fillColor('#FFD980')
    .text(title, MARGIN, titleY, {
      width: PAGE_SIZE - MARGIN * 2,
      align: 'center',
      lineGap: 6,
    });

  // Golden separator line
  doc.rect(PAGE_SIZE / 2 - 60, PAGE_SIZE * 0.77, 120, 2).fill(GOLDEN);

  // Subtitle
  doc.font('Nunito').fontSize(14).fillColor('#FFFFFF')
    .text(`Un livre créé rien que pour ${childName}`, MARGIN, PAGE_SIZE * 0.79, {
      width: PAGE_SIZE - MARGIN * 2,
      align: 'center',
    });

  // Lorinizi badge at bottom
  doc.roundedRect(PAGE_SIZE/2 - 50, PAGE_SIZE * 0.90, 100, 22, 11).fill(GOLDEN);
  doc.font('Nunito-Bold').fontSize(9).fillColor('#1a0a2e')
    .text('LORINIZI', PAGE_SIZE/2 - 50, PAGE_SIZE * 0.90 + 7, { width: 100, align: 'center' });

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

    // ─── Page B: Full-page text, dark theme ───
    doc.addPage();
    doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill('#1a0a2e');

    // Subtle star dots background
    [[30,40,1],[PAGE_SIZE-30,60,1.5],[20,PAGE_SIZE-40,1],[PAGE_SIZE-25,PAGE_SIZE-50,1.5],[PAGE_SIZE/2+130,30,1],[PAGE_SIZE/2-140,PAGE_SIZE-35,1]].forEach(([x,y,r]) => {
      doc.save(); doc.fillOpacity(0.5); doc.circle(x,y,r).fill('#FFD980'); doc.restore();
    });

    // White rounded text area — full page with small margin
    const padOuter = 18;
    doc.roundedRect(padOuter, padOuter, PAGE_SIZE - padOuter*2, PAGE_SIZE - padOuter*2, 28).fill('#FFFFFF');

    // Golden top strip
    doc.roundedRect(padOuter, padOuter, PAGE_SIZE - padOuter*2, 7, 4).fill(GOLDEN);
    // Golden bottom strip
    doc.roundedRect(padOuter, PAGE_SIZE - padOuter - 7, PAGE_SIZE - padOuter*2, 7, 4).fill(GOLDEN);

    // Text inside white area
    const padX = 42;
    const textTop = padOuter + 22;
    const textW = PAGE_SIZE - padX * 2;
    const textAvailH = PAGE_SIZE - padOuter*2 - 22 - 30;

    // Truncate manually to prevent overflow
    const fontSize = 21;
    const lineGap = 18;
    const lineH = fontSize + lineGap;
    const maxLines = Math.floor(textAvailH / lineH);
    const charsPerLine = Math.floor(textW / (fontSize * 0.5));
    const maxChars = maxLines * charsPerLine;
    const safeText = page.text && page.text.length > maxChars
      ? page.text.slice(0, maxChars - 1).trimEnd() + '…'
      : (page.text || '');

    doc.font('Nunito').fontSize(fontSize).fillColor(DARK)
      .text(safeText, padX, textTop, {
        width: textW,
        align: 'left',
        lineGap,
      });

    // Page number pill centered at bottom
    const pillW = 44;
    const pillX = PAGE_SIZE/2 - pillW/2;
    const pillY = PAGE_SIZE - padOuter - 20;
    doc.roundedRect(pillX, pillY, pillW, 18, 9).fill(GOLDEN);
    doc.font('Nunito-Bold').fontSize(10).fillColor('#FFFFFF')
      .text(String(pdfPageNum), pillX, pillY + 4, { width: pillW, align: 'center' });
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
