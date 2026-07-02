import { generateObject } from './llm.js';

const FEW_SHOT_EXAMPLES = `
question: What is Henry Feilden's occupation?
keywords: Henry Feilden, occupation

question: In what city was Billy Carlson born?
keywords: city, Billy Carlson, born

question: What is the religion of John Gwynn?
keywords: religion of John Gwynn

question: What sport does Kiribati men's national basketball team play?
keywords: sport, Kiribati men's national basketball team play
`.trim();

export async function rewriteQuery(question) {
  const obj = await generateObject(
    `Extract at most three keywords from the following question for use as a web search query.

${FEW_SHOT_EXAMPLES}

question: ${question}

Return JSON: { "keywords": ["keyword1", "keyword2", "keyword3"] }`
  );

  const keywords = (obj.keywords || []).slice(0, 3);
  const searchQuery = keywords.join(', ');
  return { searchQuery, keywords };
}
