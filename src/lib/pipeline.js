/**
 * pipeline.js
 * A thin orchestrator over the CRAG lib functions that exposes EVERY
 * intermediate stage via a progress callback.
 *
 * The canonical pipeline lives in src/mastra/workflows/crag-workflow.js
 * (built with the Mastra Workflow/Step primitives). That version only returns
 * the final answer, which is perfect for the CLI but not for a UI that wants to
 * *visualise* the corrective-RAG process.
 *
 * This module runs the exact same four stages — Retrieve → Evaluate →
 * Correct → Generate — but emits a structured event after each stage so the
 * frontend can render the pipeline live (and the user can evaluate it).
 */

import { generateText } from 'ai';
import { gateway } from './gateway.js';

import { retrieveDocuments } from './retriever.js';
import { evaluateDocuments } from './evaluator.js';
import { refineKnowledge } from './refiner.js';
import { rewriteQuery } from './rewriter.js';
import { searchWeb } from './searcher.js';

const ANSWER_MODEL = 'google/gemini-1.5-pro';

/**
 * Run the full CRAG pipeline.
 *
 * @param {string} query
 * @param {(event: { stage: string, status: 'start'|'done', data?: object }) => void} [onStage]
 *        Optional callback fired at the start and end of every stage.
 * @returns {Promise<object>} the full structured result (all stages + answer)
 */
export async function runCragPipeline(query, onStage = () => {}) {
  const t0 = Date.now();
  const result = { query };

  // ── Stage 1: Retrieve ──────────────────────────────────────────────────────
  onStage({ stage: 'retrieve', status: 'start' });
  const documents = await retrieveDocuments(query, 10);
  result.retrieve = { documents };
  onStage({ stage: 'retrieve', status: 'done', data: { documents } });

  // ── Stage 2: Evaluate ──────────────────────────────────────────────────────
  onStage({ stage: 'evaluate', status: 'start' });
  const evaluation = await evaluateDocuments(query, documents);
  result.evaluate = evaluation; // { confidence, scoredDocuments, maxScore }
  onStage({ stage: 'evaluate', status: 'done', data: evaluation });

  const { confidence, scoredDocuments } = evaluation;

  // ── Stage 3: Correct (collect knowledge) ───────────────────────────────────
  onStage({ stage: 'correct', status: 'start', data: { action: confidence } });

  let internalKnowledge = '';
  let externalKnowledge = '';
  let sourcesUsed = [];
  let refineMeta = null;
  let webMeta = null;

  // CORRECT or AMBIGUOUS → refine internal knowledge
  if (confidence === 'CORRECT' || confidence === 'AMBIGUOUS') {
    const refined = await refineKnowledge(query, scoredDocuments);
    internalKnowledge = refined.refinedKnowledge;
    refineMeta = { stripsKept: refined.stripsKept, stripsTotal: refined.stripsTotal };
  }

  // INCORRECT or AMBIGUOUS → search the web
  if (confidence === 'INCORRECT' || confidence === 'AMBIGUOUS') {
    const { searchQuery, keywords } = await rewriteQuery(query);
    const searched = await searchWeb(query, searchQuery);
    externalKnowledge = searched.externalKnowledge;
    sourcesUsed = searched.sourcesUsed;
    webMeta = { searchQuery, keywords, sourcesUsed };
  }

  // Combine according to confidence
  let combinedKnowledge;
  if (confidence === 'CORRECT') {
    combinedKnowledge = internalKnowledge;
  } else if (confidence === 'INCORRECT') {
    combinedKnowledge = externalKnowledge;
  } else {
    combinedKnowledge = [internalKnowledge, externalKnowledge].filter(Boolean).join('\n\n---\n\n');
  }

  result.correct = {
    confidence,
    internalKnowledge,
    externalKnowledge,
    combinedKnowledge,
    sourcesUsed,
    refineMeta,
    webMeta,
  };
  onStage({ stage: 'correct', status: 'done', data: result.correct });

  // ── Stage 4: Generate ──────────────────────────────────────────────────────
  onStage({ stage: 'generate', status: 'start' });

  const knowledgeBlock = combinedKnowledge ? `\n\nRelevant Knowledge:\n${combinedKnowledge}` : '';

  const { text } = await generateText({
    model: gateway(ANSWER_MODEL),
    prompt: `You are a factual question-answering assistant. Answer the question accurately and concisely based on the provided knowledge. If the knowledge is insufficient, say so clearly — do not fabricate information.

Question: ${query}${knowledgeBlock}

Answer:`,
  });

  result.generate = { answer: text };
  result.answer = text;
  result.confidence = confidence;
  result.sourcesUsed = sourcesUsed;
  result.elapsedMs = Date.now() - t0;

  onStage({ stage: 'generate', status: 'done', data: { answer: text } });

  return result;
}
