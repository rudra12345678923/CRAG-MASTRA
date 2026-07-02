/**
 * memory.js — Mastra Memory configuration for the CRAG agent
 *
 * Four layers, each answering "what is relevant?" differently:
 *
 * 1. MESSAGE HISTORY (lastMessages)
 *    The last N raw messages — always relevant because they're recent.
 *
 * 2. WORKING MEMORY (user profile)
 *    Persistent, structured facts about the user, shared across ALL
 *    conversations (scope: 'resource'). Relevance is defined by the
 *    template below: the LLM only extracts facts that fit these slots.
 *
 * 3. SEMANTIC RECALL
 *    Every message is embedded and stored in a vector DB. On each new
 *    query, the most semantically similar past messages are retrieved.
 *    Relevance = similarity to the CURRENT question, computed per query.
 *
 * 4. OBSERVATIONAL MEMORY (summarization)
 *    When a conversation grows past ~30k tokens, a background Observer
 *    agent compresses old messages into dense observation notes
 *    (5–40x compression), and a Reflector condenses those further.
 */

import { Memory } from '@mastra/memory';
import { LibSQLStore, LibSQLVector } from '@mastra/libsql';
import { gateway } from '../lib/gateway.js';

// Single local SQLite file holds messages, profiles, and embeddings.
const DB_URL = 'file:./mastra-memory.db';

const storage = new LibSQLStore({ id: 'crag-storage', url: DB_URL });
const vector = new LibSQLVector({ id: 'crag-vector', url: DB_URL });

// Embeddings via the existing Vercel AI Gateway key.
const embedder = gateway.textEmbeddingModel('openai/text-embedding-3-small');

export const memory = new Memory({
  storage,
  vector,
  embedder,

  options: {
    // Layer 1 — recent raw history
    lastMessages: 15,

    // Layer 2 — persistent user profile (shared across threads)
    workingMemory: {
      enabled: true,
      scope: 'resource',
      template: `# User Profile

## Identity

- Name:
- Role / Organization:

## Preferences

- Answer style: [e.g., concise, detailed, bullet points]
- Topics of interest:

## Ongoing Context

- Current project / document focus:
- Key deadlines:
  - [Deadline]: [Date]
- Recurring questions or concerns:
`,
    },

    // Layer 3 — vector search over all past messages of this user
    semanticRecall: {
      topK: 3,          // 3 most relevant past messages
      messageRange: 2,  // plus 2 messages of surrounding context each
      scope: 'resource' // search across all of the user's conversations
    },

    // Layer 4 — background summarization of long conversations
    observationalMemory: {
      model: gateway('openai/gpt-4o-mini'),
      observation: {
        messageTokens: 30_000,      // summarize once history passes this
        manageWorkingMemory: true,  // Observer also maintains the profile above
      },
      reflection: {
        observationTokens: 40_000,  // re-condense summaries past this
      },
    },
  },
});
