/**
 * reranker.js  —  Cross-Encoder Re-ranking
 *
 * Problem:
 *   Bi-encoder retrieval (embed query separately, embed doc separately,
 *   compare vectors) is fast but approximate. It can rank a vaguely
 *   similar chunk above a directly relevant one.
 *
 * Solution (Cross-Encoder):
 *   After hybrid search returns top-20 candidates, send each
 *   (query + chunk) PAIR to GPT-4o-mini and ask it to score relevance 1-10.
 *   The model sees both together → much more accurate judgment.
 *   Re-rank by these scores, keep top-K.
 *
 * Trade-off:
 *   Adds latency (N LLM calls for N candidates) but dramatically
 *   improves the precision of what reaches the final answer.
 */

import { generateObject } from './llm.js';

export async function rerankDocuments(query, documents, topK = 5) {
  if (documents.length <= topK) return documents;

  console.log(`\n[RERANKER] Scoring ${documents.length} candidates → keeping top ${topK}`);

  const scored = await Promise.all(
    documents.map(async (doc, i) => {
      try {
        const obj = await generateObject(
          `Rate how relevant this document chunk is for answering the query.

Query: ${query}
Document chunk:
${doc.text.substring(0, 500)}

Scoring guide:
10 = directly and completely answers the query
7-9 = highly relevant, contains key information needed
4-6 = partially relevant, related but incomplete
1-3 = barely relevant or off-topic

Return JSON: { "score": <integer 1-10> }`
        );

        const score = Math.min(10, Math.max(1, Number(obj.score) || 5)) / 10;
        console.log(
          `[RERANKER] Doc ${String(i + 1).padStart(2)}  score=${score.toFixed(2)}` +
          `  "${doc.text.substring(0, 70).replace(/\n/g, ' ')}..."`
        );
        return { ...doc, rerankerScore: score };
      } catch {
        return { ...doc, rerankerScore: doc.score }; // fallback to hybrid score
      }
    })
  );

  return scored
    .sort((a, b) => b.rerankerScore - a.rerankerScore)
    .slice(0, topK);
}
