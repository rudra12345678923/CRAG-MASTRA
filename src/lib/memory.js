/**
 * memory.js  —  Conversation Memory
 *
 * Problem:
 *   Every query is independent. If user asks "What is the deadline?"
 *   then follows up with "What about the budget?" — the system has
 *   no idea what "it" refers to and retrieves irrelevant chunks.
 *
 * Solution:
 *   1. Store last N question-answer pairs per session (in-memory).
 *   2. Before retrieval, rewrite the current query using history so
 *      it becomes fully self-contained.
 *
 * Example:
 *   History: Q: "What is the deadline?"  A: "June 26th..."
 *   New query: "What about the budget?"
 *   Rewritten: "What is the budget for the NYCEDC RFP?"
 *              ↑ now retrieves the right chunks
 */

import { generateText } from './llm.js';

// sessionId → [{ role: 'user'|'assistant', content: string }, ...]
const store = new Map();
const MAX_TURNS = 5; // keep last 5 Q&A pairs (10 messages)

export function getHistory(sessionId) {
  return store.get(sessionId) || [];
}

export function addToHistory(sessionId, userQuery, assistantAnswer) {
  if (!store.has(sessionId)) store.set(sessionId, []);
  const history = store.get(sessionId);

  history.push({ role: 'user',      content: userQuery });
  history.push({ role: 'assistant', content: assistantAnswer });

  // Trim oldest exchanges when over limit
  while (history.length > MAX_TURNS * 2) history.splice(0, 2);
}

export function clearHistory(sessionId) {
  store.delete(sessionId);
}

/**
 * Rewrite a follow-up query to be fully self-contained using session history.
 * If the query already makes sense standalone, it is returned unchanged.
 */
export async function rewriteWithHistory(query, sessionId) {
  const history = getHistory(sessionId);
  if (history.length === 0) return query;

  const historyText = history
    .map(m => `${m.role === 'user' ? 'Q' : 'A'}: ${m.content.substring(0, 200)}`)
    .join('\n');

  try {
    const rewritten = await generateText(
      `Given this conversation history, rewrite the latest query so it is
fully self-contained and can be understood without any prior context.
If the query already makes complete sense on its own, return it unchanged.

Conversation history:
${historyText}

Latest query: "${query}"

Return the rewritten query only — no explanation, no quotes:`,
      'gpt-4o-mini'
    );

    const cleaned = rewritten.trim().replace(/^["']|["']$/g, '');

    if (cleaned && cleaned !== query) {
      console.log(`[MEMORY] Rewritten: "${query}"\n         → "${cleaned}"`);
    }

    return cleaned || query;
  } catch {
    return query;
  }
}
