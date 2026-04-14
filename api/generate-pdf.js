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

  // Dark overlay at bottom for title readability
  doc.save();
  doc.fillOpacity(0.62);
  doc.rect(0, PAGE_SIZE * 0.54, PAGE_SIZE, PAGE_SIZE * 0.46).fill('#000000');
  doc.restore();

  // Title
  doc.font('Nunito-Bold').fontSize(27).fillColor('white')
    .text(story.title || `L'histoire de ${childName}`, MARGIN, PAGE_SIZE * 0.57, {
      width: PAGE_SIZE - MARGIN * 2,
      align: 'center',
      lineGap: 4,
    });

  // Subtitle
  doc.font('Nunito').fontSize(13).fillColor('#FFD980')
    .text(`Un livre créé rien que pour ${childName} ✨`, MARGIN, PAGE_SIZE * 0.76, {
      width: PAGE_SIZE - MARGIN * 2,
      align: 'center',
    });

  // Branding
  doc.font('Nunito').fontSize(9).fillColor('#BBBBBB')
    .text('Lorinizi — Des livres uniques pour des enfants uniques', MARGIN, PAGE_SIZE - 22, {
      width: PAGE_SIZE - MARGIN * 2,
      align: 'center',
    });

  // ── STORY PAGES (2 pages per story page: illustration + text) ──
  for (const page of storyPages) {

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

    // Page number badge (bottom right)
    doc.circle(PAGE_SIZE - 28, PAGE_SIZE - 28, 16).fill(GOLDEN);
    doc.font('Nunito-Bold').fontSize(10).fillColor('white')
      .text(String(page.pageNumber), PAGE_SIZE - 44, PAGE_SIZE - 34, { width: 32, align: 'center' });

    // ─── Page B: Full-page text, story feel ───
    doc.addPage();
    doc.rect(0, 0, PAGE_SIZE, PAGE_SIZE).fill(CREAM);

    // Thin golden lines top and bottom
    doc.rect(0, 0, PAGE_SIZE, 5).fill(GOLDEN);
    doc.rect(0, PAGE_SIZE - 5, PAGE_SIZE, 5).fill(GOLDEN);

    // Small decorative diamond top center
    const dX = PAGE_SIZE / 2;
    const dY = 22;
    doc.save();
    doc.translate(dX, dY).rotate(45);
    doc.rect(-7, -7, 14, 14).fill(GOLDEN);
    doc.restore();

    // Drop cap
    const firstLetter = (page.text || 'I').charAt(0).toUpperCase();
    const restText = page.text ? page.text.slice(1) : '';

    const padX = 44;
    const textTop = 48;
    const textW = PAGE_SIZE - padX * 2;
    const textAvailH = PAGE_SIZE - textTop - 44;

    doc.font('Nunito-Bold').fontSize(72).fillColor(GOLDEN)
      .text(firstLetter, padX, textTop - 8, { lineBreak: false });

    // Line 1 alongside drop cap
    doc.font('Nunito').fontSize(22).fillColor(DARK)
      .text(restText, padX + 56, textTop + 10, {
        width: textW - 56,
        height: 60,
        lineGap: 16,
        ellipsis: false,
      });

    // Rest of text below drop cap
    doc.font('Nunito').fontSize(22).fillColor(DARK)
      .text(page.text, padX, textTop + 84, {
        width: textW,
        height: textAvailH - 84,
        lineGap: 16,
        align: 'left',
        ellipsis: true,
      });

    // Page number bottom center
    doc.font('Nunito-Bold').fontSize(13).fillColor(GOLDEN)
      .text(`✦  ${page.pageNumber}  ✦`, 0, PAGE_SIZE - 30, {
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
