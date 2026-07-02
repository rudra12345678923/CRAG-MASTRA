import { generateObject } from './llm.js';

const UPPER_THRESHOLD = 0.7;
const LOWER_THRESHOLD = 0.3;
const EVAL_MODEL = 'gpt-4o-mini';

const FEW_SHOT_EXAMPLES = `
Question: In what country is Wilcza Jama, Sokółka County?
Document: Wilcza Jama is a village in the administrative district of Gmina Sokółka, within Sokółka County, Podlaskie Voivodeship, in north-eastern Poland, close to the border with Belarus.
Answer: Yes

Question: Who is the author of Skin?
Document: The Skin We're In: A Year of Black Resistance and Power is a book by Desmond Cole published by Doubleday Canada in 2020.
Answer: No

Question: What sport does the 2004 Legg Mason Tennis Classic feature?
Document: The 2004 Legg Mason Tennis Classic was the 36th edition of this tennis tournament and was played on outdoor hard courts.
Answer: Yes

Question: In what city was Abraham Raimbach born?
Document: Bancroft was born on November 25, 1839 in New Ipswich, New Hampshire to James Bancroft and Sarah Kimball.
Answer: No
`.trim();

async function scoreDocumentRelevance(question, document) {
  const prompt = `Given a question, rate how relevant the following document is for answering the question.

${FEW_SHOT_EXAMPLES}

Question: ${question}
Document: ${document.substring(0, 1200)}

Rate relevance on a scale from 0.0 to 1.0:
- 1.0 = document directly and completely answers the question
- 0.7-0.9 = document has strong relevant information
- 0.4-0.6 = document is partially relevant or tangentially related
- 0.1-0.3 = document has little relevance
- 0.0 = document is completely irrelevant

Return JSON: { "relevanceScore": <number between 0.0 and 1.0> }`;

  try {
    const obj = await generateObject(prompt, EVAL_MODEL);
    const score = parseFloat(obj.relevanceScore);
    if (isNaN(score)) return 0;
    return Math.max(-1, Math.min(1, (score * 2) - 1)); // map [0,1] → [-1,1]
  } catch (err) {
    console.warn('[evaluator] Scoring error, defaulting to 0:', err.message);
    return 0;
  }
}

export async function evaluateDocuments(query, documents) {
  const scoredDocuments = await Promise.all(
    documents.map(async (doc) => {
      // Score the CHILD chunk that actually matched during retrieval
      // (doc.text is the full parent section — the relevant sentence may sit
      // past the truncation window and be invisible to the scorer).
      const scoringText = doc.retrievalText || doc.text;
      const relevanceScore = await scoreDocumentRelevance(query, scoringText);
      return {
        id: doc.id,
        text: doc.text,
        source: doc.source ?? 'unknown',
        relevanceScore,
        isRelevant: relevanceScore > LOWER_THRESHOLD,
      };
    })
  );

  const maxScore = scoredDocuments.reduce((max, d) => Math.max(max, d.relevanceScore), -Infinity);

  let confidence;
  if (maxScore > UPPER_THRESHOLD) {
    confidence = 'CORRECT';
  } else if (maxScore < LOWER_THRESHOLD) {
    confidence = 'INCORRECT';
  } else {
    confidence = 'AMBIGUOUS';
  }

  return { confidence, scoredDocuments, maxScore };
}
