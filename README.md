# CRAG-MASTRA — A RAG Chatbot That Knows When It's Wrong

A self-correcting **Corrective Retrieval-Augmented Generation (CRAG)** chatbot with persistent, per-user memory. Instead of answering confidently from bad retrievals, the agent **grades its own retrieval quality** and dynamically decides whether to trust the documents, fall back to live web search, or blend both.

Built with **Mastra** (agents, tools, 4-layer memory), **GPT-4o-mini** via Vercel AI Gateway, **Upstash Vector**, **Tavily**, and **libSQL**.

![Answer with CORRECT verdict](docs/answer-correct.png)

## How it works

Every question runs through a 4-stage agentic pipeline:

```
RETRIEVE  →  EVALUATE  →  CORRECT  →  GENERATE
```

1. **Retrieve** — 5-stage retrieval: HyDE hypothetical-answer embeddings, multi-query expansion, hybrid semantic + keyword scoring, source-diverse selection, and LLM cross-encoder re-ranking.
2. **Evaluate** — an LLM judge scores every document's relevance and emits a confidence verdict:
   - `CORRECT` → refine internal documents and answer
   - `INCORRECT` → rewrite the query and search the web (Tavily)
   - `AMBIGUOUS` → do both and present sources for each claim
3. **Correct** — decompose-then-recompose refinement: documents are split into strips, each strip is scored for usefulness, noise is discarded.
4. **Generate** — a grounded answer with source citations, checked for faithfulness against the refined knowledge.

The live pipeline trace is streamed to the UI over SSE — you can watch the agent retrieve, self-evaluate, and correct in real time:

![Pipeline self-correcting after an INCORRECT verdict](docs/pipeline-correcting.png)

## Memory — the agent remembers you

Four layers via Mastra, isolated per user account:

| Layer | What it does |
|---|---|
| Message history | Recent conversation injected every turn |
| Working memory | Persistent user profile (name, preferences, goals) the agent maintains itself, shared across all conversations |
| Semantic recall | Vector search over all past messages — relevant history resurfaces per-query |
| Observational memory | Background summarization of long conversations (5–40x compression) |

Users sign up / sign in (scrypt hashing, httpOnly sessions); conversations, embeddings, and memory are scoped to the account.

![Welcome screen](docs/welcome.png)

## Engineering highlights

- **Server-side run cache** — tool outputs flow between pipeline stages at full fidelity server-side instead of being relayed (and truncated) through the LLM's tool-call arguments. Fixed systematic evaluation corruption and cut latency ~50%.
- **Table-aware PDF ingestion** — extractors fuse table rows into strings like `Blinkit₹1,156-12%46%` that naive chunkers silently drop. A linearization pass reconstructs rows against their headers into atomic, searchable `TABLE:` chunks.
- **Memory re-verification** — remembered answers are re-checked against fresh retrieval before reuse, and document/web conflicts are presented explicitly with both sources.

## Quickstart

```bash
npm install
cp .env.example .env   # add your keys
npm run ingest -- ./your-document.pdf
npm run serve          # → http://localhost:3000
```

Requires: `AI_GATEWAY_API_KEY` (Vercel AI Gateway), `UPSTASH_VECTOR_REST_URL` + `UPSTASH_VECTOR_REST_TOKEN`, `TAVILY_API_KEY`.

## Project structure

```
src/
├── mastra/
│   ├── agents/crag-agent.js    # the CRAG agent (pipeline rules, memory policy)
│   ├── tools/index.js          # 5 tools: retrieve, evaluate, refine, rewrite, web-search
│   ├── memory.js               # 4-layer Mastra memory configuration
│   └── workflows/              # deterministic workflow variant
├── lib/
│   ├── retriever.js            # 5-stage retrieval engine
│   ├── evaluator.js            # relevance scoring → confidence verdict
│   ├── refiner.js              # strip-level knowledge refinement
│   ├── ingest.js               # PDF ingestion + table linearization
│   ├── auth.js                 # accounts, sessions, per-user scoping
│   └── run-context.js          # server-side run cache between tools
└── server.js                   # Express + SSE streaming + auth API
public/                         # zero-dependency frontend (auth, chat, pipeline trace)
```
