/**
 * classifier.js
 * Detects what kind of question the user is asking so the pipeline
 * can adapt its behaviour accordingly.
 *
 * Types:
 *   FACTUAL        – specific fact, date, number, name  → fast path, docs only
 *   COMPARATIVE    – compare / contrast across sources  → retrieve all docs
 *   PROCEDURAL     – how-to, steps, process             → ordered retrieval
 *   CURRENT_EVENTS – real-time / recent news            → skip docs, web only
 *   CONVERSATIONAL – vague follow-up needing history    → rewrite first
 */

import { generateObject } from './llm.js';

const VALID_TYPES = ['FACTUAL', 'COMPARATIVE', 'PROCEDURAL', 'CURRENT_EVENTS', 'CONVERSATIONAL'];

export async function classifyQuery(query) {
  try {
    const obj = await generateObject(
      `Classify this search query into exactly one of these categories:

FACTUAL        – user wants a specific fact, date, number, name, or definition
COMPARATIVE    – user wants to compare / contrast multiple things or sources
PROCEDURAL     – user wants steps, a process, or how-to instructions
CURRENT_EVENTS – user wants real-time or very recent news / live information
CONVERSATIONAL – vague short follow-up that clearly needs prior conversation context

Query: "${query}"

Return JSON: { "type": "<one of the five types above>", "reason": "<one short sentence>" }`
    );

    const type = VALID_TYPES.includes(obj.type) ? obj.type : 'FACTUAL';
    console.log(`\n[CLASSIFY] Type: ${type} — ${obj.reason}`);
    return type;
  } catch {
    return 'FACTUAL';
  }
}
