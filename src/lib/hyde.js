/**
 * hyde.js  —  Hypothetical Document Embeddings
 *
 * Problem:
 *   Embedding "What is the submission deadline?" and comparing it to
 *   "Deadline for submission, June 26th, 2023 – 11:59PM" gives a weak
 *   match because questions and answers are phrased very differently.
 *
 * Solution (HyDE):
 *   1. Ask the LLM to write a SHORT hypothetical answer (2-3 sentences)
 *      as if it already found it in a document.
 *   2. Embed THAT hypothetical answer instead of the raw query.
 *   3. The hypothetical uses document-like language → much stronger match.
 *
 * Example:
 *   Query:       "What is the submission deadline?"
 *   Hypothetical: "The submission deadline for the RFP is June 26th, 2023
 *                  at 11:59 PM EDT as per the Addendum."
 *   → Embedding of hypothetical matches real document chunks far better.
 */

import { generateText } from './llm.js';
import { getEmbedding } from './embeddings.js';

export async function hydeEmbed(query) {
  try {
    const hypothetical = await generateText(
      `Write a short passage (2-3 sentences) that directly answers this question,
as if extracted from an official document or report.
Do NOT add any preamble — just write the answer passage itself.

Question: ${query}`,
      'gpt-4o-mini'
    );

    console.log(`[HyDE] Hypothetical: "${hypothetical.substring(0, 120).replace(/\n/g, ' ')}..."`);

    // Embed the hypothetical — it uses document-style language
    return await getEmbedding(hypothetical);
  } catch (err) {
    console.warn('[HyDE] Failed, falling back to direct query embedding:', err.message);
    return await getEmbedding(query);
  }
}
