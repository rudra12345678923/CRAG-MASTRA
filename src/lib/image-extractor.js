/**
 * image-extractor.js  —  PDF Image Extraction + Vision Description
 *
 * Pipeline:
 *   1. Render each PDF page to a PNG using pdfjs-dist + canvas
 *   2. Detect image-rich pages (pages with low text density)
 *   3. Send each image-rich page to GPT-4o-mini Vision API
 *   4. Store description + image path as a searchable chunk
 *
 * Requirements (install once):
 *   npm install pdfjs-dist canvas
 *
 * If either package is missing, this module silently skips image extraction
 * and returns an empty array — the rest of the pipeline is unaffected.
 */

import fs   from 'fs';
import path from 'path';
import 'dotenv/config';

const GATEWAY_URL   = 'https://ai-gateway.vercel.sh/v1/chat/completions';
const VISION_MODEL  = 'gpt-4o-mini';

// Pages with fewer than this many characters are considered image-rich
const TEXT_DENSITY_THRESHOLD = 150;

/**
 * Describe an image using GPT-4o-mini Vision.
 * @param {string} base64 - PNG image as base64 string
 * @returns {Promise<string>} textual description
 */
async function describeImage(base64) {
  const response = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.AI_GATEWAY_API_KEY}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model: VISION_MODEL,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `Describe this image in detail. Focus on:
- Any text, labels, or captions visible
- Charts, graphs, tables, or diagrams and what data they show
- Key visual information relevant to a business or technical document
Be specific and factual. Write 3-5 sentences.`,
          },
          {
            type:      'image_url',
            image_url: { url: `data:image/png;base64,${base64}` },
          },
        ],
      }],
      max_tokens: 300,
    }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Vision API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.choices[0].message.content.trim();
}

/**
 * Extract image-rich pages from a PDF and describe them with GPT-4o-mini.
 *
 * @param {string} pdfPath   - absolute path to the PDF file
 * @param {string} outputDir - directory to save extracted PNG files
 * @param {string} docSource - document name (for chunk IDs)
 * @returns {Promise<Array<{ id, text, imagePath, pageNum, source }>>}
 */
export async function extractPageImages(pdfPath, outputDir, docSource) {
  // Dynamically import optional packages — skip gracefully if missing
  let pdfjs, createCanvas;
  try {
    const pdfjsModule    = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const canvasModule   = await import('canvas');
    pdfjs       = pdfjsModule;
    createCanvas = canvasModule.createCanvas;
  } catch {
    console.log('[IMAGE] pdfjs-dist or canvas not installed — skipping image extraction.');
    console.log('[IMAGE] To enable: npm install pdfjs-dist canvas');
    return [];
  }

  // Ensure output directory exists
  fs.mkdirSync(outputDir, { recursive: true });

  const pdfBuffer = fs.readFileSync(pdfPath);
  const pdfData   = new Uint8Array(pdfBuffer);
  const pdfDoc    = await pdfjs.getDocument({ data: pdfData }).promise;

  console.log(`\n[IMAGE] Scanning ${pdfDoc.numPages} pages for images...`);

  const imageChunks = [];

  for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
    const page        = await pdfDoc.getPage(pageNum);
    const textContent = await page.getTextContent();
    const textLength  = textContent.items.reduce((sum, item) => sum + (item.str?.length || 0), 0);

    // Skip text-heavy pages — they have already been chunked as text
    if (textLength > TEXT_DENSITY_THRESHOLD) continue;

    try {
      // Render page to canvas
      const viewport = page.getViewport({ scale: 1.5 });
      const canvas   = createCanvas(viewport.width, viewport.height);
      const ctx      = canvas.getContext('2d');

      await page.render({
        canvasContext: ctx,
        viewport,
        // node-canvas does not support all PDF rendering features;
        // background defaults to white which is fine for most docs
      }).promise;

      // Save PNG
      const filename  = `${docSource}_page_${String(pageNum).padStart(4, '0')}.png`;
      const imagePath = path.join(outputDir, filename);
      const buffer    = canvas.toBuffer('image/png');
      fs.writeFileSync(imagePath, buffer);

      const base64 = buffer.toString('base64');

      console.log(`[IMAGE] Page ${pageNum}: image-rich (text=${textLength} chars) → describing...`);
      const description = await describeImage(base64);
      console.log(`[IMAGE] Page ${pageNum}: "${description.substring(0, 100)}..."`);

      imageChunks.push({
        id:        `${docSource}_image_page_${String(pageNum).padStart(4, '0')}`,
        text:      `[Source: ${docSource}] [Page ${pageNum} — Visual Content]\n${description}`,
        imagePath: `/images/${filename}`,   // public URL served by Express
        pageNum,
        source:    docSource,
        type:      'image',
      });
    } catch (err) {
      console.warn(`[IMAGE] Page ${pageNum} render failed: ${err.message}`);
    }
  }

  console.log(`[IMAGE] Extracted ${imageChunks.length} image chunk(s) from "${docSource}"`);
  return imageChunks;
}
