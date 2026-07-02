/**
 * llm.js
 * Direct fetch wrappers for the Vercel AI Gateway.
 * Bypasses @ai-sdk version conflicts entirely.
 */

import 'dotenv/config';

const GATEWAY_URL = 'https://ai-gateway.vercel.sh/v1/chat/completions';
export const DEFAULT_MODEL = 'gpt-4o-mini';

async function chatComplete(messages, { model = DEFAULT_MODEL, json = false } = {}) {
  const body = {
    model,
    messages,
  };

  const response = await fetch(GATEWAY_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.AI_GATEWAY_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`LLM API error ${response.status}: ${err}`);
  }

  const data = await response.json();
  return data.choices[0].message.content;
}

/**
 * Generate plain text from a prompt.
 */
export async function generateText(prompt, model = DEFAULT_MODEL) {
  return chatComplete([{ role: 'user', content: prompt }], { model });
}

/**
 * Generate a JSON object from a prompt.
 * Instructs the model to return only valid JSON.
 */
export async function generateObject(prompt, model = DEFAULT_MODEL) {
  const content = await chatComplete(
    [
      { role: 'system', content: 'Respond with valid JSON only. No markdown, no code blocks, no explanation.' },
      { role: 'user', content: prompt },
    ],
    { model, json: true }
  );

  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (match) return JSON.parse(match[0]);
    throw new Error(`Failed to parse JSON: ${content}`);
  }
}
