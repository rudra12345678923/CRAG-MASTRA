import 'dotenv/config';
import { Index }           from '@upstash/vector';
import { getEmbedding }    from './embeddings.js';
import { hydeEmbed }       from './hyde.js';
import { expandQuery }     from './multiquery.js';
import { rerankDocuments } from './reranker.js';

/**
 * retriever.js  -  5-stage retrieval pipeline
 *
 * Stage 1  HyDE         - embed a hypothetical answer, not the raw query
 * Stage 2  Multi-Query  - 3 variations + forced addendum variation
 * Stage 3  Fetch pool   - retrieve for each variation, deduplicate
 * Stage 4  Hybrid score - 0.7 * semantic + 0.3 * keyword, then source-diverse selection
 * Stage 5  Re-rank      - GPT-4o-mini scores (query, chunk) pairs, sort by score
 *
 * Source-Diverse Selection (stage 4b)
 *   After scoring, guarantee TOP_PER_SOURCE chunks from EVERY ingested document.
 *   This ensures addendum chunks are always in the re-ranker pool even when
 *   the original RFP has many more chunks and would otherwise dominate the top-K.
 *   No priority boost, no manual config - works for any document you upload.
 *
 * Re-ranker does NOT cut the pool
 *   We pass rerankerInput.length (not a fixed topK) so the re-ranker only
 *   sorts - it never drops the diversity-added addendum chunks.
 *   The evaluator + refiner downstream handle pruning irrelevant content.
 */

const SEMANTIC_WEIGHT = 0.7;
const KEYWORD_WEIGHT  = 0.3;
const TOP_PER_SOURCE  = 2;

function keywordScore(text, query) {
  const queryWords = query.toLowerCase().split(/\W+/).filter(w => w.length > 2);
  if (queryWords.length === 0) return 0;
  const textLower = text.toLowerCase();
  const matches   = queryWords.filter(word => textLower.includes(word)).length;
  return matches / queryWords.length;
}

async function searchWithEmbedding(index, embedding, topK) {
  return index.query({ vector: embedding, topK, includeMetadata: true });
}

function sourceDiversePool(candidates, globalTopK) {
  const globalTopIds = new Set(candidates.slice(0, globalTopK).map(c => c.id));
  const seenIds      = new Set(globalTopIds);
  const pool         = candidates.filter(c => globalTopIds.has(c.id));

  const bySource = new Map();
  for (const c of candidates) {
    if (!bySource.has(c.source)) bySource.set(c.source, []);
    bySource.get(c.source).push(c);
  }

  for (const [source, docs] of bySource) {
    let added = 0;
    for (const doc of docs) {
      if (added >= TOP_PER_SOURCE) break;
      if (!seenIds.has(doc.id)) {
        seenIds.add(doc.id);
        pool.push(doc);
        added++;
      }
    }
    if (added > 0) {
      console.log(`[RETRIEVER] Diversity: +${added} chunk(s) guaranteed from "${source}"`);
    }
  }

  console.log(
    `[RETRIEVER] Pool = ${globalTopK} global-top + ${pool.length - globalTopK} diversity = ${pool.length} total`
  );
  return pool;
}

export async function retrieveDocuments(query, topK = 8, queryType = 'FACTUAL') {
  const index = new Index({
    url:   process.env.UPSTASH_VECTOR_REST_URL,
    token: process.env.UPSTASH_VECTOR_REST_TOKEN,
  });

  // Stage 1: HyDE
  console.log('\n[RETRIEVER] Stage 1 - HyDE embedding...');
  const hydeEmbedding = await hydeEmbed(query);

  // Stage 2: Multi-query expansion (includes forced addendum variation)
  console.log('\n[RETRIEVER] Stage 2 - Multi-query expansion...');
  const queryVariations = await expandQuery(query);

  // Stage 3: Fetch candidates for each variation
  const perQueryK  = topK * 5;
  const resultPool = new Map();

  console.log(`\n[RETRIEVER] Stage 3 - Fetching (${queryVariations.length} queries x ${perQueryK})...`);
  const hydeResults = await searchWithEmbedding(index, hydeEmbedding, perQueryK);
  for (const r of hydeResults) resultPool.set(r.id, r);

  for (let i = 1; i < queryVariations.length; i++) {
    const varEmb     = await getEmbedding(queryVariations[i]);
    const varResults = await searchWithEmbedding(index, varEmb, perQueryK);
    for (const r of varResults) {
      if (!resultPool.has(r.id)) resultPool.set(r.id, r);
    }
  }

  console.log(`[RETRIEVER] Raw pool: ${resultPool.size} unique chunks`);

  // Stage 4: Hybrid scoring
  const candidates = Array.from(resultPool.values()).map(r => {
    const childText  = r.metadata?.text      ?? '';
    const parentText = r.metadata?.parentText ?? childText;
    const semantic   = r.score;
    const keyword    = keywordScore(childText, query);
    const hybrid     = SEMANTIC_WEIGHT * semantic + KEYWORD_WEIGHT * keyword;
    return {
      id:            r.id,
      text:          parentText,
      retrievalText: childText,
      score:         hybrid,
      semanticScore: semantic,
      keywordScore:  keyword,
      source:        r.metadata?.source    ?? 'unknown',
      type:          r.metadata?.type      ?? 'chunk',
      imagePath:     r.metadata?.imagePath ?? null,
    };
  });

  candidates.sort((a, b) => b.score - a.score);

  // Stage 4b: Source-diverse selection
  console.log('\n[RETRIEVER] Stage 4b - Source-diverse selection...');
  const rerankerInput = sourceDiversePool(candidates, topK);

  console.log('\n[RETRIEVER] Pre-rerank pool:');
  rerankerInput.forEach((c, i) =>
    console.log(
      `  ${String(i + 1).padStart(2)}.  hybrid=${c.score.toFixed(3)}` +
      `  [${c.source}]  "${c.retrievalText.substring(0, 60).replace(/\n/g, ' ')}..."`
    )
  );

  // Stage 5: Re-rank - sort only, do NOT cut to topK
  // Cutting here would drop diversity-added addendum chunks
  console.log('\n[RETRIEVER] Stage 5 - Cross-encoder re-ranking (no cut)...');
  const reranked = await rerankDocuments(query, rerankerInput, rerankerInput.length);

  console.log(`\n[RETRIEVER] Final ${reranked.length} documents passed to evaluator`);
  return reranked;
}
