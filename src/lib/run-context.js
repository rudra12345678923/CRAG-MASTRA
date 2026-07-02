/**
 * run-context.js — per-run scratchpad shared between server and CRAG tools.
 *
 * With an agent-driven pipeline, the LLM must copy tool outputs into the
 * next tool's arguments (e.g. re-emit all retrieved documents as JSON).
 * Models truncate/mangle large payloads, so the evaluator would see broken
 * documents. The retriever caches its real output here; the evaluator and
 * refiner read from the cache instead of trusting the LLM's relayed args.
 */

let current = null;

export function startRun() {
  current = { documents: null, scoredDocuments: null, confidence: null };
  return current;
}

export function getRun() {
  return current;
}

export function endRun() {
  current = null;
}
