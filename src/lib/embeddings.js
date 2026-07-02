/**
 * embeddings.js
 * Calls the Vercel AI Gateway REST API directly via fetch.
 * Bypasses @ai-sdk version conflicts entirely.
 */

import 'dotenv/config';

const GATEWAY_URL = 'https://ai-gateway.vercel.sh/v1/embeddings';
const MODEL = 'text-embedding-3-small';

async function fetchEmbeddings(input) {
  const response = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.AI_GATEWAY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model: MODEL, input, dimensions: 768 }),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Embedding API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  // OpenAI-compatible response: { data: [{ embedding: [...], index: 0 }] }
  return data.data
    .sort((a, b) => a.index - b.index)
    .map((d) => d.embedding);
}

/**
 * Generate an embedding vector for a single text string.
 * @param {string} text
 * @returns {Promise<number[]>}
 */
export async function getEmbedding(text) {
  const [embedding] = await fetchEmbeddings(text);
  return embedding;
}

/**
 * Generate embedding vectors for multiple texts in one batch call.
 * @param {string[]} texts
 * @returns {Promise<number[][]>}
 */
export async function getEmbeddings(texts) {
  return fetchEmbeddings(texts);
}
