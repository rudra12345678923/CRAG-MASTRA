import { generateObject } from './llm.js';

const FILTER_THRESHOLD = -0.5;   // keep strip unless clearly useless
const TOP_K_STRIPS     = 20;     // raised from 5 -- enough room for every source
const EVAL_MODEL       = 'gpt-4o-mini';

function decomposeIntoStrips(text) {
  // TABLE: lines are atomic — splitting them on sentence punctuation would
  // sever rows from their column headers (e.g. at "Food Del.").
  const tableStrips = [];
  const prose = [];
  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('TABLE:')) tableStrips.push(t);
    else if (t) prose.push(t);
  }

  const sentences = prose
    .join(' ')
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 15);

  const strips = [...tableStrips];
  if (sentences.length <= 2) {
    const joined = sentences.join(' ').trim();
    if (joined) strips.push(joined);
    return strips.length ? strips : [text.trim()];
  }
  for (let i = 0; i < sentences.length; i += 2) {
    const strip = sentences.slice(i, i + 2).join(' ').trim();
    if (strip) strips.push(strip);
  }
  return strips;
}

async function scoreStrip(question, strip) {
  try {
    const obj = await generateObject(
      `Does this text contain useful information to answer the question?

Question: ${question}
Text: ${strip}

Return JSON: { "isUseful": true or false }`,
      EVAL_MODEL
    );
    return obj.isUseful ? 0.9 : -0.9;
  } catch {
    return 0;
  }
}

export async function refineKnowledge(query, scoredDocuments) {
  // Use ALL documents, not just isRelevant ones.
  // The evaluator's relevance threshold is calibrated for CORRECT/INCORRECT routing,
  // not for deciding what knowledge the LLM sees.  An addendum chunk that scores
  // just below the isRelevant cutoff still contains critical superseding information.
  const docs = scoredDocuments.length > 0 ? scoredDocuments : [];

  if (docs.length === 0) {
    return { refinedKnowledge: '', stripsKept: 0, stripsTotal: 0 };
  }

  const allStrips = docs.flatMap((doc) =>
    decomposeIntoStrips(doc.text).map((s) => ({ text: s, source: doc.source }))
  );

  console.log('[REFINER] Decomposed ' + docs.length + ' docs into ' + allStrips.length + ' strips');

  const scored = await Promise.all(
    allStrips.map(async (strip, i) => {
      const score = await scoreStrip(query, strip.text);
      const label = score > FILTER_THRESHOLD ? 'KEEP' : 'DROP';
      console.log(
        '[REFINER] Strip ' + String(i + 1).padStart(2) + ' ' + label +
        ' (' + score.toFixed(2) + ')  [' + strip.source + ']  "' +
        strip.text.substring(0, 70) + '..."'
      );
      return { ...strip, score };
    })
  );

  const kept = scored
    .filter((s) => s.score > FILTER_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, TOP_K_STRIPS);

  console.log('[REFINER] Kept ' + kept.length + '/' + allStrips.length + ' strips');

  // CRITICAL: include [Source: ...] tags so the generate step can detect conflicts.
  // Without these tags the LLM cannot compare what different documents say.
  const refinedKnowledge = kept
    .map((s) => '[Source: ' + s.source + ']\n' + s.text)
    .join('\n\n');

  return {
    refinedKnowledge,
    stripsKept:  kept.length,
    stripsTotal: allStrips.length,
  };
}
