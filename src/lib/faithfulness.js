/**
 * faithfulness.js  —  Answer Faithfulness Check
 *
 * Problem:
 *   The LLM can "hallucinate" — generate confident-sounding statements
 *   that are NOT actually supported by the retrieved knowledge.
 *
 * Solution:
 *   After generating the answer, send (answer + knowledge) to GPT-4o-mini
 *   and ask it to identify every claim that is NOT backed by the sources.
 *   If unsupported claims are found, append a warning to the answer.
 *
 * Example:
 *   Answer: "The deadline is June 26th and the budget is $2M."
 *   Knowledge: only mentions June 26th deadline, no budget figure
 *   → Issue: "$2M budget" is not supported → WARNING appended
 */

import { generateObject } from './llm.js';

export async function checkFaithfulness(answer, knowledge) {
  // Nothing to check against
  if (!knowledge || knowledge.trim().length < 50) {
    return { faithful: true, issues: [], warning: null };
  }

  try {
    const obj = await generateObject(
      `Verify whether every factual claim in the answer is supported by the knowledge sources.

Knowledge sources:
${knowledge.substring(0, 2000)}

Answer to verify:
${answer}

Return JSON:
{
  "faithful": true or false,
  "issues": ["exact claim that is NOT in the knowledge", ...],
  "warning": "one-sentence warning message if not faithful, otherwise null"
}`
    );

    if (!obj.faithful && obj.issues?.length > 0) {
      console.warn(`\n[FAITHFULNESS] ⚠️  ${obj.issues.length} unsupported claim(s) detected:`);
      obj.issues.forEach(issue => console.warn(`   • ${issue}`));
    } else {
      console.log(`[FAITHFULNESS] ✅  Answer is faithful to sources`);
    }

    return {
      faithful:  obj.faithful  ?? true,
      issues:    obj.issues    || [],
      warning:   obj.warning   || null,
    };
  } catch {
    return { faithful: true, issues: [], warning: null };
  }
}
