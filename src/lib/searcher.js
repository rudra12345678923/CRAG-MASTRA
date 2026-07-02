/**
 * searcher.js
 * Web search via Tavily API — Section 4.5 of the CRAG paper.
 *
 * Flow:
 *   1. Search Tavily with the rewritten keyword query
 *   2. Prioritise Wikipedia results (authoritative, lower bias risk)
 *   3. Score each result with the lightweight evaluator
 *   4. Return concatenated external knowledge from the most relevant results
 */

import { generateObject } from './llm.js';

const TAVILY_API_URL = 'https://api.tavily.com/search';
const TOP_K_WEB_RESULTS = 5;   // how many results to fetch (Section B.3)
const RELEVANCE_THRESHOLD = -0.5;

/**
 * Call the Tavily Search API.
 * @param {string} query - keyword query string
 * @returns {Promise<Array<{ url: string, title: string, content: string, score: number }>>}
 */
async function tavilySearch(query) {
  const response = await fetch(TAVILY_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.TAVILY_API_KEY}`,
    },
    body: JSON.stringify({
      query,
      max_results: 10,
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
    }),
  });

  if (!response.ok) {
    throw new Error(`Tavily API error ${response.status}: ${response.statusText}`);
  }

  const data = await response.json();
  return data.results ?? [];
}

/**
 * Score a web snippet for relevance to the original question.
 * @param {string} question
 * @param {string} content
 * @returns {Promise<number>} score in [-1, 1]
 */
async function scoreWebResult(question, content) {
  if (!content || content.length < 20) return -1;
  try {
    const obj = await generateObject(
      `Does this text have exact information to answer the question?

Question: ${question}
Text: ${content.substring(0, 600)}

Return JSON: { "isRelevant": true or false }`
    );
    return obj.isRelevant ? 0.9 : -0.9;
  } catch {
    return 0;
  }
}

/**
 * Search the web and return relevant external knowledge.
 *
 * @param {string} question     - Original user question (for relevance scoring)
 * @param {string} searchQuery  - Rewritten keyword query
 * @returns {Promise<{ externalKnowledge: string, sourcesUsed: string[] }>}
 */
export async function searchWeb(question, searchQuery) {
  const results = await tavilySearch(searchQuery);

  if (results.length === 0) {
    return { externalKnowledge: '', sourcesUsed: [] };
  }

  // Score each result
  const scored = await Promise.all(
    results.map(async (r) => {
      const content = r.content ?? r.snippet ?? '';
      const relevanceScore = await scoreWebResult(question, content);
      return { ...r, content, relevanceScore };
    })
  );

  // Sort: Wikipedia first (authoritative), then by relevance score
  const sorted = scored
    .sort((a, b) => {
      const aWiki = a.url?.includes('wikipedia.org') ? 1 : 0;
      const bWiki = b.url?.includes('wikipedia.org') ? 1 : 0;
      if (aWiki !== bWiki) return bWiki - aWiki; // Wikipedia first
      return b.relevanceScore - a.relevanceScore;
    })
    .filter((r) => r.relevanceScore > RELEVANCE_THRESHOLD)
    .slice(0, TOP_K_WEB_RESULTS);

  const externalKnowledge = sorted
    .map((r) => r.content)
    .filter(Boolean)
    .join('\n\n');

  const sourcesUsed = sorted.map((r) => r.url).filter(Boolean);

  return { externalKnowledge, sourcesUsed };
}
