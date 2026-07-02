import { generateObject } from './llm.js';

/**
 * expandQuery
 *
 * Generates 3 alternative phrasings of the query, PLUS one variation
 * that always targets addendum/amendment content.
 *
 * The addendum variation is the key fix for the "wrong date" bug:
 * even if the user asks a simple question like "what is the deadline",
 * we always run one search specifically designed to surface override /
 * update content that lives in addendum or amendment documents.
 */
export async function expandQuery(query) {
  let variations = [];

  try {
    const obj = await generateObject(
      `Generate 3 alternative phrasings of this query.
Use different vocabulary, synonyms, and sentence structure.
Each variation must seek the same information but be worded differently.

Original query: "${query}"

Return JSON: { "queries": ["variation1", "variation2", "variation3"] }`
    );

    variations = (obj.queries || []).slice(0, 3).filter(Boolean);
    console.log(`[MULTIQUERY] ${variations.length} variations generated:`);
    variations.forEach((v, i) => console.log(`  ${i + 1}. "${v}"`));
  } catch {
    console.warn('[MULTIQUERY] variation generation failed, using original only');
  }

  // Always emit one addendum-targeted variation regardless of LLM success.
  // This guarantees superseding content (e.g. a changed date in Addendum 3)
  // is ALWAYS present in the candidate pool, no matter the original query.
  const addendumVar = query + ' addendum amendment update correction supersede override';
  console.log(`[MULTIQUERY] Addendum variation: "${addendumVar}"`);

  return [query, ...variations, addendumVar];
}
