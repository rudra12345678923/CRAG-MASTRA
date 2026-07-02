/**
 * ingest.js
 * Loads a PDF into Upstash Vector using a three-stage pipeline:
 *
 *   Stage 1 — Structure Split:
 *     Detects section headings and splits at structural boundaries.
 *     Each section's full text is stored as a "parent" chunk.
 *
 *   Stage 2 — Semantic Chunking (Parent-Child):
 *     Within each section, embeds every sentence and measures cosine similarity.
 *     When similarity drops below a threshold a new child chunk begins.
 *     Child chunks carry the parent's full section text in metadata so the LLM
 *     gets broad context while retrieval stays precise.
 *
 *   Stage 3 — Image Extraction (optional):
 *     For PDF pages with low text density (image-heavy pages), renders the page
 *     to PNG, describes it with GPT-4o-mini Vision, and stores the description
 *     as a searchable chunk with a reference to the saved image file.
 *     Requires:  npm install pdfjs-dist canvas
 *
 * Usage:
 *   npm run ingest -- ./path/to/your-doc.pdf
 */

import 'dotenv/config';
import fs   from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { Index }         from '@upstash/vector';
import { getEmbeddings, getEmbedding } from './embeddings.js';
import { extractPageImages }           from './image-extractor.js';

const require   = createRequire(import.meta.url);
const pdfParse  = require('pdf-parse');

// ─── Config ──────────────────────────────────────────────────────────────────

// Semantic chunking: cosine sim below this = topic change → new child chunk
const SIMILARITY_THRESHOLD = parseFloat(process.env.SIMILARITY_THRESHOLD ?? '0.5');

// Max characters per child chunk (safety cap)
const MAX_CHUNK_CHARS = parseInt(process.env.MAX_CHUNK_CHARS ?? '800', 10);

// Min characters for a chunk to be worth storing
const MIN_CHUNK_CHARS = 60;

// Public images directory (served by Express at /images/)
const IMAGES_DIR = path.resolve('public', 'images');

// ─── Stage 0: Table Linearization ────────────────────────────────────────────
/**
 * PDF text extraction flattens tables. Two layouts appear in the wild:
 *   A) fused rows (pdf-parse):  "Blinkit₹1,156-12%46%"
 *   B) stacked cells (poppler): one cell per line
 * Without this pass, the chunker's length filter silently DROPS table data.
 * Tables are rewritten as single searchable lines:
 *   TABLE: Segment | Revenue/Q3 FY25 (Cr) | EBITDA Margin | ... | Blinkit | ₹1,156 | -12% | 46%
 */
function unfuseRow(s) {
  return s
    .replace(/(?<=[a-z)])(?=[A-Z])/g, ' | ')             // "MarginMarket" → "Margin | Market"
    .replace(/(?<=[a-zA-Z.)])(?=[₹$€])/g, ' | ')         // "Del.₹1,156" → "Del. | ₹1,156"
    .replace(/(?<=%)(?=\S)/g, ' | ')                     // "-12%46%" → "-12% | 46%"
    .replace(/(?<=\d)(?=-\d)/g, ' | ')                   // "1,156-12" → "1,156 | -12"
    .replace(/(?<=\d)(?=[A-Za-z₹$€])/g, ' | ');          // "46%NA" → "46% | NA"
}

/** Does this line look like a fused table data row? (2+ numeric/currency tokens, short) */
function isFusedRow(l) {
  if (l.length === 0 || l.length > 80) return false;
  const tokens = l.match(/[₹$€]?-?\d[\d,.]*%?|(?<![A-Za-z])NA(?![A-Za-z])/g) || [];
  return tokens.length >= 2 && !/[.!?]$/.test(l);
}

function linearizeTables(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n').map((l) => l.trim());
  const out = [];
  let i = 0;

  while (i < lines.length) {
    // ── Pattern A: consecutive fused data rows (pdf-parse style) ──
    if (isFusedRow(lines[i]) && isFusedRow(lines[i + 1] || '')) {
      const rows = [];
      // The line right before is usually the header row — pull it in.
      const prev = out.length ? out[out.length - 1] : '';
      if (prev && prev.length <= 90 && !/[.!?]$/.test(prev)) {
        out.pop();
        rows.push(prev);
      }
      while (i < lines.length && (isFusedRow(lines[i]) || lines[i] === '')) {
        if (lines[i]) rows.push(lines[i]);
        i++;
      }
      const table = 'TABLE: ' + rows.map(unfuseRow).join(' | ');
      out.push(table);
      console.log(`[TABLE] Linearized ${rows.length} row(s): "${table.slice(0, 110)}..."`);
      continue;
    }

    // ── Pattern B: stacked single cells (pdftotext style) ──
    const isCell = (l) =>
      l.length > 0 && l.length <= 45 &&
      !(/[.!?]$/.test(l) && l.split(/\s+/).length >= 4);
    if (isCell(lines[i])) {
      let j = i;
      const cells = [];
      while (j < lines.length && (isCell(lines[j]) || lines[j] === '')) {
        if (lines[j]) cells.push(lines[j]);
        j++;
      }
      if (cells.length >= 6) {
        const table = 'TABLE: ' + cells.join(' | ');
        out.push(table);
        console.log(`[TABLE] Linearized ${cells.length} cell(s): "${table.slice(0, 110)}..."`);
        i = j;
        continue;
      }
    }

    out.push(lines[i]);
    i++;
  }
  return out.join('\n');
}

// ─── Stage 1: Structure Splitting ────────────────────────────────────────────
/**
 * Splits raw text at structural boundaries.
 * Returns array of { heading, body } objects.
 */
function splitByStructure(text) {
  const cleaned = text.replace(/\r\n/g, '\n').replace(/[ \t]+/g, ' ').trim();

  const headingPattern =
    /\n(?=(?:\d+(?:\.\d+)*\.?\s+[A-Z]|Section\s+\d+|#{1,3}\s+\S|[A-Z][A-Z\s]{5,}[A-Z]\n))/g;

  const parts = cleaned.split(headingPattern).filter(p => p.trim().length > 0);

  const sections = parts.map(part => {
    const lines   = part.split('\n');
    const heading = lines[0].trim();
    const body    = lines.slice(1).join('\n').trim();
    return { heading, body: body || heading };
  });

  console.log(`[STRUCTURE] Found ${sections.length} sections`);
  return sections;
}

// ─── Stage 2: Semantic Chunking ───────────────────────────────────────────────

function cosineSimilarity(a, b) {
  let dot = 0, magA = 0, magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot  += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

/**
 * Split a section into semantic child chunks.
 * Returns array of plain chunk strings (WITHOUT the source prefix).
 */
async function semanticChunk(text, heading) {
  // TABLE: lines are atomic — never split them on inner punctuation.
  // Everything else is reflowed into paragraphs, then sentence-split.
  const sentences = [];
  let para = [];
  const flushPara = () => {
    if (!para.length) return;
    sentences.push(
      ...para.join(' ').split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 20)
    );
    para = [];
  };
  for (const line of text.split('\n')) {
    const t2 = line.trim();
    if (!t2) { flushPara(); continue; }
    if (t2.startsWith('TABLE:')) { flushPara(); sentences.push(t2); continue; }
    para.push(t2);
  }
  flushPara();

  if (sentences.length === 0) return [];
  if (sentences.length <= 2)  return [`${heading}\n${text.trim()}`];

  const embeddings = await getEmbeddings(sentences);

  const chunks = [];
  let currentSentences = [sentences[0]];
  let currentLength    = sentences[0].length;

  for (let i = 1; i < sentences.length; i++) {
    const sim            = cosineSimilarity(embeddings[i - 1], embeddings[i]);
    const wouldExceedMax = currentLength + sentences[i].length > MAX_CHUNK_CHARS;

    if (sim < SIMILARITY_THRESHOLD || wouldExceedMax) {
      const chunkText = currentSentences.join(' ').trim();
      if (chunkText.length >= MIN_CHUNK_CHARS) {
        chunks.push(`${heading}\n${chunkText}`);
      }
      currentSentences = [sentences[i]];
      currentLength    = sentences[i].length;

      console.log(
        `[SEMANTIC]  Split after sentence ${i}  sim=${sim.toFixed(3)}` +
        (wouldExceedMax ? '  (size cap)' : '  (topic change)')
      );
    } else {
      currentSentences.push(sentences[i]);
      currentLength += sentences[i].length;
    }
  }

  const last = currentSentences.join(' ').trim();
  if (last.length >= MIN_CHUNK_CHARS) chunks.push(`${heading}\n${last}`);

  return chunks;
}

// ─── Document Priority ────────────────────────────────────────────────────────
function getDocumentPriority(filename) {
  const lower = filename.toLowerCase();
  if (lower.includes('addendum') || lower.includes('amendment') || lower.includes('corrigendum')) return 2;
  if (lower.includes('question') || lower.includes('faq') || lower.includes('answer'))            return 1;
  return 0;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.UPSTASH_VECTOR_REST_URL || !process.env.UPSTASH_VECTOR_REST_TOKEN) {
    console.error('❌  UPSTASH_VECTOR_REST_URL or UPSTASH_VECTOR_REST_TOKEN is not set');
    process.exit(1);
  }
  if (!process.env.AI_GATEWAY_API_KEY) {
    console.error('❌  AI_GATEWAY_API_KEY is not set');
    process.exit(1);
  }

  const pdfPath = process.argv[2];
  if (!pdfPath) {
    console.error('❌  Please provide a PDF path:  npm run ingest -- ./your-doc.pdf');
    process.exit(1);
  }

  const resolvedPath = path.resolve(pdfPath);
  if (!fs.existsSync(resolvedPath)) {
    console.error(`❌  File not found: ${resolvedPath}`);
    process.exit(1);
  }

  // ── Parse PDF text ──
  console.log(`\n📖  Reading PDF: ${resolvedPath}`);
  const pdfBuffer = fs.readFileSync(resolvedPath);
  const pdfData   = await pdfParse(pdfBuffer);
  const docSource = path.basename(resolvedPath, '.pdf');
  const priority  = getDocumentPriority(docSource);
  const priorityLabel = ['original', 'questions/FAQ', 'addendum/amendment'][priority];

  console.log(`📄  Extracted ${pdfData.numpages} pages, ${pdfData.text.length} characters`);
  console.log(`🏷️   Document type: ${priorityLabel} (priority=${priority})`);

  // ── Stage 1: Structure Split ──
  console.log(`\n🏗️   Stage 1 — Structure splitting...`);
  // ── Stage 0: Table linearization ──
  console.log(`\n📊  Stage 0 — Table linearization...`);
  const fullText = linearizeTables(pdfData.text);

  const sections = splitByStructure(fullText);

  // ── Stage 2: Semantic Chunking with Parent-Child storage ──
  console.log(`\n🧠  Stage 2 — Semantic chunking + parent-child (threshold=${SIMILARITY_THRESHOLD})...`);

  const allDocuments = [];  // final list of { id, childText, parentText, source, priority, type, imagePath? }

  for (let s = 0; s < sections.length; s++) {
    const { heading, body } = sections[s];
    console.log(`\n[SECTION ${s + 1}/${sections.length}] "${heading.substring(0, 60)}"`);

    // Parent text = the full section (heading + body)
    const parentText = `${heading}\n${body}`.trim();

    const childChunks = await semanticChunk(body, heading);
    console.log(`[SECTION ${s + 1}] → ${childChunks.length} child chunk(s)`);

    childChunks.forEach((chunkText, c) => {
      allDocuments.push({
        id:         `${docSource}_s${String(s + 1).padStart(3, '0')}_c${String(c + 1).padStart(3, '0')}`,
        childText:  `[Source: ${docSource}]\n${chunkText}`,   // used for embedding precision
        parentText: `[Source: ${docSource}]\n${parentText}`,  // used for LLM context
        source:     docSource,
        priority,
        type:       'chunk',
      });
    });
  }

  console.log(`\n✂️   Total text chunks: ${allDocuments.length}`);

  // ── Stage 3: Image Extraction (optional) ──
  console.log(`\n🖼️   Stage 3 — Image extraction...`);
  const imageChunks = await extractPageImages(resolvedPath, IMAGES_DIR, docSource);

  const imageDocuments = imageChunks.map(img => ({
    id:         img.id,
    childText:  img.text,    // description IS the retrieval text
    parentText: img.text,    // same for images
    source:     img.source,
    priority,
    type:       'image',
    imagePath:  img.imagePath,
  }));

  const documents = [...allDocuments, ...imageDocuments];
  console.log(`\n📦  Total documents to upsert: ${documents.length} (${allDocuments.length} text + ${imageDocuments.length} image)`);

  // ── Embed and upsert in batches ──
  const index = new Index({
    url:   process.env.UPSTASH_VECTOR_REST_URL,
    token: process.env.UPSTASH_VECTOR_REST_TOKEN,
  });

  const BATCH_SIZE   = 50;
  let   total        = 0;
  const totalBatches = Math.ceil(documents.length / BATCH_SIZE);

  console.log(`\n🔢  Embedding and upserting...`);

  for (let i = 0; i < documents.length; i += BATCH_SIZE) {
    const batch    = documents.slice(i, i + BATCH_SIZE);
    const batchNum = Math.floor(i / BATCH_SIZE) + 1;

    console.log(`   Batch ${batchNum}/${totalBatches} (docs ${i + 1}–${Math.min(i + BATCH_SIZE, documents.length)})...`);

    // Embed the child text (precise) for the vector
    const embeddings = await getEmbeddings(batch.map(d => d.childText));

    const vectors = batch.map((doc, j) => ({
      id:     doc.id,
      vector: embeddings[j],
      metadata: {
        text:       doc.childText,   // what was indexed (retrieval text)
        parentText: doc.parentText,  // full section (LLM context)
        source:     doc.source,
        priority:   doc.priority,
        type:       doc.type,
        imagePath:  doc.imagePath ?? null,
      },
    }));

    await index.upsert(vectors);
    total += vectors.length;
  }

  console.log(`\n✅  Done! Ingested ${total} documents from "${docSource}" into Upstash Vector`);
  if (imageDocuments.length > 0) {
    console.log(`🖼️   Images saved to: ${IMAGES_DIR}`);
  }
}

main().catch(err => {
  console.error('Ingest failed:', err);
  process.exit(1);
});
