import { createStep, createWorkflow } from '@mastra/core/workflows';
import { generateText }  from '../../lib/llm.js';
import { z }             from 'zod';

import { retrieveDocuments } from '../../lib/retriever.js';
import { evaluateDocuments } from '../../lib/evaluator.js';
import { refineKnowledge }   from '../../lib/refiner.js';
import { rewriteQuery }      from '../../lib/rewriter.js';
import { searchWeb }         from '../../lib/searcher.js';
import { classifyQuery }     from '../../lib/classifier.js';
import { checkFaithfulness } from '../../lib/faithfulness.js';

const documentSchema = z.object({
  id:        z.string(),
  text:      z.string(),
  score:     z.number(),
  source:    z.string(),
  type:      z.string().optional(),
  imagePath: z.string().nullable().optional(),
});

const scoredDocumentSchema = z.object({
  id:             z.string(),
  text:           z.string(),
  source:         z.string(),
  relevanceScore: z.number(),
  isRelevant:     z.boolean(),
});

const confidenceEnum = z.enum(['CORRECT', 'INCORRECT', 'AMBIGUOUS']);

// Step 1: Retrieve
// Classifies the query inline, then runs the full enhanced retrieval pipeline.
export const retrieveDocsStep = createStep({
  id: 'retrieve-docs',
  description: 'Classify query, then run HyDE + multi-query + re-ranking retrieval.',
  inputSchema: z.object({ query: z.string() }),
  outputSchema: z.object({
    query:        z.string(),
    queryType:    z.string(),
    documents:    z.array(documentSchema),
    imageResults: z.array(z.object({
      source:    z.string(),
      imagePath: z.string(),
      text:      z.string(),
    })),
  }),
  execute: async ({ inputData }) => {
    const { query } = inputData;
    const queryType = await classifyQuery(query);
    console.log(`\n[CRAG] Step 1 - Retrieving for: "${query}" [${queryType}]`);

    const documents = queryType === 'CURRENT_EVENTS'
      ? []
      : await retrieveDocuments(query, 8, queryType);

    console.log(`[CRAG]   Retrieved ${documents.length} documents`);

    const imageResults = documents
      .filter(d => d.type === 'image' && d.imagePath)
      .map(d => ({ source: d.source, imagePath: d.imagePath, text: d.text }));

    return { query, queryType, documents, imageResults };
  },
});

// Step 2: Evaluate
export const evaluateDocsStep = createStep({
  id: 'evaluate-docs',
  description: 'Score each retrieved document for relevance; determine confidence label.',
  inputSchema: z.object({
    query:        z.string(),
    queryType:    z.string(),
    documents:    z.array(documentSchema),
    imageResults: z.array(z.any()),
  }),
  outputSchema: z.object({
    query:           z.string(),
    queryType:       z.string(),
    confidence:      confidenceEnum,
    scoredDocuments: z.array(scoredDocumentSchema),
    maxScore:        z.number(),
    imageResults:    z.array(z.any()),
  }),
  execute: async ({ inputData }) => {
    const { query, queryType, documents, imageResults } = inputData;

    if (queryType === 'CURRENT_EVENTS' || documents.length === 0) {
      console.log('[CRAG] Step 2 - No docs or CURRENT_EVENTS, forcing web search');
      return { query, queryType, confidence: 'INCORRECT', scoredDocuments: [], maxScore: 0, imageResults };
    }

    console.log('[CRAG] Step 2 - Evaluating document relevance...');
    const result = await evaluateDocuments(query, documents);
    console.log(`[CRAG]   Confidence: ${result.confidence}  (max score: ${result.maxScore.toFixed(2)})`);

    return { query, queryType, imageResults, ...result };
  },
});

// Step 3: Collect Knowledge
export const collectKnowledgeStep = createStep({
  id: 'collect-knowledge',
  description: 'Refine internal docs (CORRECT/AMBIGUOUS) and/or web search (INCORRECT/AMBIGUOUS).',
  inputSchema: z.object({
    query:           z.string(),
    queryType:       z.string(),
    confidence:      confidenceEnum,
    scoredDocuments: z.array(scoredDocumentSchema),
    maxScore:        z.number(),
    imageResults:    z.array(z.any()),
  }),
  outputSchema: z.object({
    query:             z.string(),
    queryType:         z.string(),
    combinedKnowledge: z.string(),
    internalKnowledge: z.string(),
    externalKnowledge: z.string(),
    confidence:        confidenceEnum,
    sourcesUsed:       z.array(z.string()),
    imageResults:      z.array(z.any()),
    refineMeta: z.object({ stripsKept: z.number(), stripsTotal: z.number() }).nullable(),
    webMeta:    z.object({
      searchQuery: z.string(),
      keywords:    z.array(z.string()),
      sourcesUsed: z.array(z.string()),
    }).nullable(),
  }),
  execute: async ({ inputData }) => {
    const { query, queryType, confidence, scoredDocuments, imageResults } = inputData;
    console.log(`[CRAG] Step 3 - Collecting knowledge (action: ${confidence})`);

    let internalKnowledge = '';
    let externalKnowledge = '';
    let sourcesUsed       = [];
    let refineMeta        = null;
    let webMeta           = null;

    if (confidence === 'CORRECT' || confidence === 'AMBIGUOUS') {
      console.log('[CRAG]   Refining internal knowledge...');
      const refined     = await refineKnowledge(query, scoredDocuments);
      internalKnowledge = refined.refinedKnowledge;
      refineMeta        = { stripsKept: refined.stripsKept, stripsTotal: refined.stripsTotal };
      console.log(`[CRAG]   Kept ${refined.stripsKept}/${refined.stripsTotal} strips`);
    }

    if (confidence === 'INCORRECT' || confidence === 'AMBIGUOUS') {
      console.log('[CRAG]   Running web search...');
      const { searchQuery, keywords } = await rewriteQuery(query);
      const searched    = await searchWeb(query, searchQuery);
      externalKnowledge = searched.externalKnowledge;
      sourcesUsed       = searched.sourcesUsed;
      webMeta           = { searchQuery, keywords, sourcesUsed };
      console.log(`[CRAG]   Found ${sourcesUsed.length} web sources`);
    }

    let combinedKnowledge;
    if      (confidence === 'CORRECT')   combinedKnowledge = internalKnowledge;
    else if (confidence === 'INCORRECT') combinedKnowledge = externalKnowledge;
    else                                 combinedKnowledge = [internalKnowledge, externalKnowledge].filter(Boolean).join('\n\n---\n\n');

    return {
      query, queryType, combinedKnowledge, internalKnowledge,
      externalKnowledge, confidence, sourcesUsed, imageResults,
      refineMeta, webMeta,
    };
  },
});

// Step 4: Generate Answer
// Adapts the prompt by query type and runs a faithfulness check after generation.
export const generateAnswerStep = createStep({
  id: 'generate-answer',
  description: 'Generate a grounded answer, verify faithfulness against sources.',
  inputSchema: z.object({
    query:             z.string(),
    queryType:         z.string(),
    combinedKnowledge: z.string(),
    confidence:        confidenceEnum,
    sourcesUsed:       z.array(z.string()),
    imageResults:      z.array(z.any()),
    internalKnowledge: z.string().optional(),
    externalKnowledge: z.string().optional(),
    refineMeta:        z.any().optional(),
    webMeta:           z.any().optional(),
  }),
  outputSchema: z.object({
    answer:              z.string(),
    confidence:          confidenceEnum,
    sourcesUsed:         z.array(z.string()),
    imageResults:        z.array(z.any()),
    faithful:            z.boolean(),
    faithfulnessIssues:  z.array(z.string()),
    faithfulnessWarning: z.string().nullable(),
  }),
  execute: async ({ inputData }) => {
    const { query, queryType, combinedKnowledge, confidence, sourcesUsed, imageResults } = inputData;
    console.log(`[CRAG] Step 4 - Generating answer (type: ${queryType})...`);

    const knowledgeBlock = combinedKnowledge
      ? `\n\nRelevant Knowledge:\n${combinedKnowledge}`
      : '';

    let typeInstruction = '';
    if (queryType === 'COMPARATIVE') {
      typeInstruction = '\n6. COMPARATIVE query: compare and contrast across ALL sources explicitly.';
    } else if (queryType === 'PROCEDURAL') {
      typeInstruction = '\n6. PROCEDURAL query: present as numbered steps.';
    } else if (queryType === 'CURRENT_EVENTS') {
      typeInstruction = '\n6. CURRENT EVENTS query: rely on web results, cite URLs.';
    }

    const prompt = `You are a factual question-answering assistant.

STEP 1 - CONFLICT CHECK (do this before writing anything):
Look at ALL [Source: ...] tags in the knowledge. Note every unique source name.
For the specific fact being asked, check what EACH source says.
If any two sources give DIFFERENT values (different dates, numbers, names) that is a CONFLICT.

STEP 2 - ANSWER RULES:
1. Cite the [Source: ...] for every fact you state.
2. If sources CONFLICT: list ALL values with their sources. Never silently pick one.
3. If a source name contains "Addendum", "Amendment", or "Corrigendum" it SUPERSEDES the original. Say so explicitly.
4. NEVER say "information is consistent" unless every source truly says the same thing.
5. If knowledge is insufficient, say so clearly - do not fabricate.${typeInstruction}

Question: ${query}${knowledgeBlock}

Answer:`;

    const text = await generateText(prompt, 'gpt-4o-mini');

    console.log('[CRAG]   Running faithfulness check...');
    const faith = await checkFaithfulness(text, combinedKnowledge);

    let finalAnswer = text;
    if (!faith.faithful && faith.warning) {
      finalAnswer = text + '\n\nFaithfulness Note: ' + faith.warning;
    }

    return {
      answer:              finalAnswer,
      confidence,
      sourcesUsed,
      imageResults,
      faithful:            faith.faithful,
      faithfulnessIssues:  faith.issues,
      faithfulnessWarning: faith.warning,
    };
  },
});

export const cragWorkflow = createWorkflow({
  id: 'crag-workflow',
  inputSchema: z.object({
    query: z.string().describe('The question to answer'),
  }),
  outputSchema: z.object({
    answer:             z.string(),
    confidence:         confidenceEnum,
    sourcesUsed:        z.array(z.string()),
    imageResults:       z.array(z.any()),
    faithful:           z.boolean(),
    faithfulnessIssues: z.array(z.string()),
  }),
});

cragWorkflow
  .then(retrieveDocsStep)
  .then(evaluateDocsStep)
  .then(collectKnowledgeStep)
  .then(generateAnswerStep)
  .commit();
