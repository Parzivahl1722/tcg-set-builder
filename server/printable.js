import fs from 'node:fs/promises';
import path from 'node:path';
import PDFDocument from 'pdfkit';
import sharp from 'sharp';

// US Letter, nine cards per page at true card size (2.5 x 3.5 in), in points.
const IN = 72;
const PAGE = { w: 8.5 * IN, h: 11 * IN };
const CARD = { w: 2.5 * IN, h: 3.5 * IN };
const COLS = 3;
const ROWS = 3;
const GAP = 0.06 * IN;
export const PER_PAGE = COLS * ROWS;

const PX_WIDTH = 600; // ~240 dpi at print size

async function download(url, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      last = err;
    }
  }
  throw new Error(`GET ${url} failed: ${last.message}`);
}

// Flatten onto white (the scans have transparent rounded corners), then drop the color.
export async function toGrayscaleJpeg(input) {
  return sharp(input)
    .flatten({ background: '#ffffff' })
    .resize({ width: PX_WIDTH, height: Math.round((PX_WIDTH * 7) / 5), fit: 'inside', withoutEnlargement: true })
    .grayscale()
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  }));
  return out;
}

// Grayscale JPEG for one card, cached on disk when cacheDir is given. null if it can't be had.
async function cardImage(card, { cacheDir, fetchImage }) {
  const url = card.imageLarge || card.image;
  if (!url) return null;
  const file = cacheDir ? path.join(cacheDir, `${card.id.replace(/[^\w.-]/g, '_')}.jpg`) : null;
  if (file) {
    try {
      return await fs.readFile(file);
    } catch { /* not cached yet */ }
  }
  try {
    const jpeg = await toGrayscaleJpeg(await fetchImage(url));
    if (file) {
      await fs.mkdir(cacheDir, { recursive: true });
      await fs.writeFile(file, jpeg);
    }
    return jpeg;
  } catch (err) {
    console.warn(`[printable] ${card.id}: ${err.message}`);
    return null;
  }
}

// Returns { doc, missing }: a PDFKit document (pipe it, it is already ended) and the cards whose
// image could not be loaded. Those get an outlined box with the name so the grid stays aligned.
export async function buildPrintable(cards, { title, cacheDir = null, fetchImage = download, concurrency = 8 } = {}) {
  const images = await mapLimit(cards, concurrency, (c) => cardImage(c, { cacheDir, fetchImage }));

  const doc = new PDFDocument({ size: [PAGE.w, PAGE.h], margin: 0, info: { Title: title ? `${title} printable grid` : 'Printable grid' } });
  const gridW = COLS * CARD.w + (COLS - 1) * GAP;
  const gridH = ROWS * CARD.h + (ROWS - 1) * GAP;
  const x0 = (PAGE.w - gridW) / 2;
  const y0 = (PAGE.h - gridH) / 2;

  const missing = [];
  cards.forEach((card, i) => {
    const slot = i % PER_PAGE;
    if (i && slot === 0) doc.addPage();
    const x = x0 + (slot % COLS) * (CARD.w + GAP);
    const y = y0 + Math.floor(slot / COLS) * (CARD.h + GAP);
    if (images[i]) {
      doc.image(images[i], x, y, { width: CARD.w, height: CARD.h });
    } else {
      missing.push(card);
      doc.roundedRect(x, y, CARD.w, CARD.h, 8).lineWidth(0.75).stroke('#888888');
      doc.fillColor('#555555').fontSize(14).text(`#${card.number}`, x, y + CARD.h / 2 - 16, { width: CARD.w, align: 'center' });
      doc.fontSize(10).text(card.name, x, y + CARD.h / 2 + 4, { width: CARD.w, align: 'center' });
    }
  });
  doc.end();
  return { doc, missing };
}
