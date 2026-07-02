import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import { retrieveDocuments } from '../../lib/retriever.js';
import { evaluateDocuments } from '../../lib/evaluator.js';
import { refineKnowledge } from '../../lib/refiner.js';
import { rewriteQuery } from '../../lib/rewriter.js';
import { searchWeb } from '../../lib/searcher.js';
import { getRun } from '../../lib/run-context.js';

//1. Document Retriever
export const documentRetrieverTool = createTool({
  id: 'document-retriever',
  description:
    'Retrieve the top-K most semantically similar documents from the vector knowledge base for a given query.',
  inputSchema: z.object({
    query: z.string().describe('The user question to search for'),
    topK: z.number().optional().default(10).describe('Number of documents to retrieve'),
  }),
  outputSchema: z.object({
    documents: z.array(
      z.object({
        id: z.string(),
        text: z.string(),
        score: z.number(),
        source: z.string(),
      })
    ),
  }),
  execute: async (input) => {
    console.log(`\n[CRAG] 1. RETRIEVE — "${input.query}"`);
    const documents = await retrieveDocuments(input.query, input.topK ?? 10);

    // Cache the full-fidelity result so downstream tools don't depend on
    // the LLM re-emitting these documents in its next tool call.
    const run = getRun();
    if (run) run.documents = documents;

    const sources = [...new Set(documents.map((d) => d.source))];
    console.log(`[CRAG] 1. RETRIEVE done — ${documents.length} docs from: ${sources.join(', ') || 'none'}`);

    // Return only short previews to the agent model — the full documents are
    // cached server-side (run-context) for the evaluator and refiner. This
    // keeps the model's context small and fast.
    return {
      documents: documents.map((d) => ({
        id: d.id,
        text: (d.text || '').slice(0, 240),
        score: d.score,
        source: d.source,
      })),
    };
  },
});

//2. Retrieval Evaluator
export const retrievalEvaluatorTool = createTool({
  id: 'retrieval-evaluator',
  description:
    'Evaluate the relevance of the documents retrieved by document-retriever. Returns a confidence label (CORRECT / INCORRECT / AMBIGUOUS) and per-document scores. The retrieved documents are cached server-side — you may omit the documents argument.',
  inputSchema: z.object({
    query: z.string(),
    documents: z
      .array(
        z.object({
          id: z.string(),
          text: z.string(),
          source: z.string().optional(),
        })
      )
      .optional()
      .describe('Optional — the server already has the retrieved documents cached.'),
  }),
  outputSchema: z.object({
    confidence: z.enum(['CORRECT', 'INCORRECT', 'AMBIGUOUS']),
    scoredDocuments: z.array(
      z.object({
        id: z.string(),
        text: z.string(),
        source: z.string(),
        relevanceScore: z.number(),
        isRelevant: z.boolean(),
      })
    ),
    maxScore: z.number(),
  }),
  execute: async (input) => {
    const run = getRun();
    let documents = input.documents ?? [];
    // Always prefer the cached, full-fidelity retrieval output.
    if (run?.documents?.length) documents = run.documents;

    console.log(`\n[CRAG] 2. EVALUATE — scoring ${documents.length} documents...`);
    const result = await evaluateDocuments(input.query, documents);

    if (run) {
      run.scoredDocuments = result.scoredDocuments;
      run.confidence = result.confidence;
    }
    console.log(`[CRAG] 2. EVALUATE done — confidence: ${result.confidence} (max score: ${result.maxScore.toFixed(2)})`);
    result.scoredDocuments.forEach((d) =>
      console.log(`         ${d.relevanceScore >= 0 ? '+' : ''}${d.relevanceScore.toFixed(2)}  [${d.source}] ${d.isRelevant ? '✓ relevant' : '✗ irrelevant'}`)
    );

    // Trim document text in the model-facing result (full versions are cached).
    return {
      ...result,
      scoredDocuments: result.scoredDocuments.map((d) => ({
        ...d,
        text: (d.text || '').slice(0, 200),
      })),
    };
  },
});

//3. Knowledge Refiner
export const knowledgeRefinerTool = createTool({
  id: 'knowledge-refiner',
  description:
    'Apply decompose-then-recompose refinement to the relevant documents scored by retrieval-evaluator: split into strips, score each strip, discard noise. The scored documents are cached server-side — you may omit the scoredDocuments argument.',
  inputSchema: z.object({
    query: z.string(),
    scoredDocuments: z
      .array(
        z.object({
          id: z.string(),
          text: z.string(),
          source: z.string().optional(),
          relevanceScore: z.number(),
          isRelevant: z.boolean(),
        })
      )
      .optional()
      .describe('Optional — the server already has the scored documents cached.'),
  }),
  outputSchema: z.object({
    refinedKnowledge: z.string(),
    stripsKept: z.number(),
    stripsTotal: z.number(),
  }),
  execute: async (input) => {
    const run = getRun();
    let scored = input.scoredDocuments ?? [];
    if (run?.scoredDocuments?.length) scored = run.scoredDocuments;

    console.log(`\n[CRAG] 3. CORRECT (refine) — ${scored.length} scored documents...`);
    const result = await refineKnowledge(input.query, scored);
    console.log(`[CRAG] 3. CORRECT (refine) done — kept ${result.stripsKept}/${result.stripsTotal} strips`);
    return result;
  },
});

//4. Query Rewriter
export const queryRewriterTool = createTool({
  id: 'query-rewriter',
  description:
    'Rewrite a natural-language question into a compact keyword query suitable for web search engines.',
  inputSchema: z.object({
    query: z.string().describe('The original user question'),
  }),
  outputSchema: z.object({
    searchQuery: z.string(),
    keywords: z.array(z.string()),
  }),
  execute: async (input) => {
    const result = await rewriteQuery(input.query);
    console.log(`\n[CRAG] 3. CORRECT (web) — search query: "${result.searchQuery}"`);
    return result;
  },
});

//5. Web Searcher
export const webSearcherTool = createTool({
  id: 'web-searcher',
  description:
    'Search the web via Tavily, preferring Wikipedia sources. Scores results and returns the most relevant external knowledge.',
  inputSchema: z.object({
    question: z.string().describe('The original user question (for relevance scoring)'),
    searchQuery: z.string().describe('The rewritten keyword query to send to Tavily'),
  }),
  outputSchema: z.object({
    externalKnowledge: z.string(),
    sourcesUsed: z.array(z.string()),
  }),
  execute: async (input) => {
    const result = await searchWeb(input.question, input.searchQuery);
    console.log(`[CRAG] 3. CORRECT (web) done — ${result.sourcesUsed.length} web source(s)`);
    return result;
  },
});
