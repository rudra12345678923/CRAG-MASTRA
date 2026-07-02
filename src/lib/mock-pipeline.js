const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DOC_BANK = [
  { id: 'doc_001', source: 'wikipedia', text: 'The Eiffel Tower is a wrought-iron lattice tower on the Champ de Mars in Paris, France. It is named after the engineer Gustave Eiffel, whose company designed and built the tower from 1887 to 1889.' },
  { id: 'doc_003', source: 'ai-paper', text: 'Retrieval-Augmented Generation (RAG) is a technique that enhances LLM responses by retrieving relevant documents from a knowledge base and including them in the prompt context, grounding the model in external facts.' },
  { id: 'doc_006', source: 'ai-paper', text: 'Corrective RAG (CRAG) adds a lightweight retrieval evaluator that scores retrieved documents and triggers corrective actions — refining good documents or falling back to web search — before generation.' },
  { id: 'doc_004', source: 'postgres-docs', text: 'PostgreSQL is a powerful, open-source object-relational database system. The pgvector extension adds vector similarity search, enabling efficient nearest-neighbour queries on embedding vectors using cosine, L2, or inner-product distance.' },
  { id: 'doc_002', source: 'mastra-docs', text: 'Mastra is an open-source TypeScript framework for building AI agents and workflows. It provides primitives for tools, memory, workflows, and RAG, making it easy to connect LLMs to real-world data and actions.' },
  { id: 'doc_005', source: 'google-ai-docs', text: 'Google Gemini is a family of multimodal AI models developed by Google DeepMind. Gemini 1.5 Pro features a 1M-token context window and strong reasoning across text, code, and images.' },
  { id: 'doc_007', source: 'ai-paper', text: 'A text embedding maps a piece of text to a dense vector of floating-point numbers, so that semantically similar texts lie close together in vector space. Retrieval finds the nearest vectors to a query embedding.' },
  { id: 'doc_008', source: 'tool-docs', text: 'Tavily is a search API built for LLM agents. It returns clean, ranked snippets for a query and is commonly used as the external-knowledge fallback in corrective RAG pipelines.' },
];

const STOP = new Set('the a an and or of to in is are was for what who how does it work on with as by from into your you this that their its at be can will which'.split(' '));

function tokenize(s) {
  return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
}


function similarity(queryTokens, doc) {
  const docTokens = new Set(tokenize(doc.text));
  if (queryTokens.length === 0) return 0;
  let hits = 0;
  for (const t of queryTokens) if (docTokens.has(t)) hits++;
  
  return Math.min(0.95, hits / queryTokens.length);
}

function splitStrips(text) {
  const sents = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter((s) => s.length > 15);
  if (sents.length <= 2) return [text.trim()];
  const strips = [];
  for (let i = 0; i < sents.length; i += 2) strips.push(sents.slice(i, i + 2).join(' '));
  return strips;
}


const WEB_SCENARIOS = [
  {
    test: /(capital|population).*australia|australia.*(capital|population)|canberra/i,
    keywords: ['capital', 'Australia', 'population'],
    sources: ['https://en.wikipedia.org/wiki/Canberra', 'https://en.wikipedia.org/wiki/Australia'],
    knowledge:
      'Canberra is the capital city of Australia. Located in the Australian Capital Territory, it was purpose-built as the capital following a compromise between Sydney and Melbourne. As of 2024 its estimated population is roughly 470,000, making it the largest inland city in Australia.',
    answer:
      "The capital of Australia is Canberra, located in the Australian Capital Territory. It was purpose-built as the nation's capital as a compromise between Sydney and Melbourne. As of 2024, Canberra's population is approximately 470,000.",
  },
  {
    test: /tallest|highest|mount everest|everest/i,
    keywords: ['tallest', 'mountain', 'Everest'],
    sources: ['https://en.wikipedia.org/wiki/Mount_Everest'],
    knowledge:
      "Mount Everest, on the China–Nepal border in the Himalayas, is Earth's highest mountain above sea level, with a summit at 8,849 metres (29,032 ft).",
    answer:
      "The tallest mountain on Earth above sea level is Mount Everest, on the China–Nepal border, with a summit elevation of about 8,849 metres (29,032 ft).",
  },
];

function genericWeb(query, keywords) {
  return {
    keywords,
    sources: [`https://en.wikipedia.org/wiki/${encodeURIComponent(keywords[0] || 'Search')}`, 'https://www.britannica.com'],
    knowledge:
      `(Demo) Simulated web results for "${query}". In live mode, Tavily would return ranked snippets here — Wikipedia first — which the evaluator scores before they are passed to the answer model.`,
    answer:
      `(Demo answer) This question wasn't well covered by the local corpus, so CRAG fell back to web search. With live keys, the model would answer "${query}" using the retrieved web snippets shown in the Correct stage.`,
  };
}

/** Build a keyword query the way rewriter.js would. */
function fakeKeywords(query) {
  const toks = tokenize(query);
  return toks.slice(0, 3);
}

/**
 * Run the mock CRAG pipeline. Same signature as runCragPipeline.
 */
export async function runMockPipeline(query, onStage = () => {}) {
  const t0 = Date.now();
  const result = { query, demo: true };
  const qTokens = tokenize(query);

  // ── Stage 1: Retrieve ──────────────────────────────────────────────────────
  onStage({ stage: 'retrieve', status: 'start' });
  await sleep(450);
  const ranked = DOC_BANK
    .map((d) => ({ ...d, score: Number((0.25 + similarity(qTokens, d) * 0.7).toFixed(3)) }))
    .sort((a, b) => b.score - a.score);
  const documents = ranked.slice(0, 6).map((d) => ({ id: d.id, text: d.text, score: d.score, source: d.source }));
  result.retrieve = { documents };
  onStage({ stage: 'retrieve', status: 'done', data: { documents } });

  // ── Stage 2: Evaluate ──────────────────────────────────────────────────────
  onStage({ stage: 'evaluate', status: 'start' });
  await sleep(850);
  const topSim = ranked.length ? similarity(qTokens, ranked[0]) : 0;
  const scoredDocuments = documents.map((d, i) => {
    const sim = similarity(qTokens, d);
    const isRelevant = sim >= 0.34 && i < 3;
    return { id: d.id, text: d.text, source: d.source, relevanceScore: isRelevant ? 0.9 : -0.9, isRelevant };
  });
  const anyRelevant = scoredDocuments.some((d) => d.isRelevant);
  const maxScore = scoredDocuments.reduce((m, d) => Math.max(m, d.relevanceScore), -1);

  let confidence;
  if (topSim >= 0.5 && anyRelevant) confidence = 'CORRECT';
  else if (topSim >= 0.22 || anyRelevant) confidence = 'AMBIGUOUS';
  else confidence = 'INCORRECT';

  const evaluation = { confidence, scoredDocuments, maxScore };
  result.evaluate = evaluation;
  onStage({ stage: 'evaluate', status: 'done', data: evaluation });

  // ── Stage 3: Correct ───────────────────────────────────────────────────────
  onStage({ stage: 'correct', status: 'start', data: { action: confidence } });
  await sleep(1000);

  let internalKnowledge = '';
  let externalKnowledge = '';
  let sourcesUsed = [];
  let refineMeta = null;
  let webMeta = null;

  if (confidence === 'CORRECT' || confidence === 'AMBIGUOUS') {
    const relevant = scoredDocuments.filter((d) => d.isRelevant);
    const strips = relevant.flatMap((d) => splitStrips(d.text)).slice(0, 5);
    internalKnowledge = strips.join('\n\n');
    refineMeta = { stripsKept: strips.length, stripsTotal: relevant.flatMap((d) => splitStrips(d.text)).length };
  }

  let webAnswer = null;
  if (confidence === 'INCORRECT' || confidence === 'AMBIGUOUS') {
    const keywords = fakeKeywords(query);
    const scenario = WEB_SCENARIOS.find((s) => s.test.test(query)) || genericWeb(query, keywords);
    externalKnowledge = scenario.knowledge;
    sourcesUsed = scenario.sources;
    webMeta = { searchQuery: (scenario.keywords || keywords).join(', '), keywords: scenario.keywords || keywords, sourcesUsed };
    webAnswer = scenario.answer;
  }

  let combinedKnowledge;
  if (confidence === 'CORRECT') combinedKnowledge = internalKnowledge;
  else if (confidence === 'INCORRECT') combinedKnowledge = externalKnowledge;
  else combinedKnowledge = [internalKnowledge, externalKnowledge].filter(Boolean).join('\n\n---\n\n');

  result.correct = { confidence, internalKnowledge, externalKnowledge, combinedKnowledge, sourcesUsed, refineMeta, webMeta };
  onStage({ stage: 'correct', status: 'done', data: result.correct });

  // ── Stage 4: Generate ──────────────────────────────────────────────────────
  onStage({ stage: 'generate', status: 'start' });
  await sleep(800);

  const answer = synthesizeAnswer(query, confidence, internalKnowledge, webAnswer);

  result.generate = { answer };
  result.answer = answer;
  result.confidence = confidence;
  result.sourcesUsed = sourcesUsed;
  result.elapsedMs = Date.now() - t0;
  onStage({ stage: 'generate', status: 'done', data: { answer } });

  return result;
}

/** Compose a grounded-sounding answer from the collected knowledge. */
function synthesizeAnswer(query, confidence, internal, webAnswer) {
  if (confidence === 'INCORRECT') return webAnswer;

  // CORRECT / AMBIGUOUS: answer from the refined internal strips, like the real
  // model would. Use the first 1–2 strips as the grounded answer.
  const firstStrips = (internal || '').split('\n\n').filter(Boolean).slice(0, 2).join(' ');
  let answer = firstStrips || webAnswer || `(Demo) I could not find enough grounded knowledge to answer "${query}".`;

  if (confidence === 'AMBIGUOUS' && webAnswer) {
    answer += `\n\nAdditional context from web search: ${webAnswer}`;
  }
  return answer;
}
