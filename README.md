# CRAG — Corrective Retrieval-Augmented Generation (Mastra + JS)

An implementation of the **CRAG** paper (Corrective RAG) using the
[Mastra](https://mastra.ai) framework, in JavaScript.

**Pipeline:** `Retrieve → Evaluate → Correct → Generate`

| Stage | What happens |
|-------|--------------|
| **Retrieve** | Top-10 similar docs from PGVector (Google `text-embedding-004`) |
| **Evaluate** | Each doc scored for relevance → `CORRECT` / `AMBIGUOUS` / `INCORRECT` |
| **Correct**  | `CORRECT` → refine internal docs · `INCORRECT` → web search (Tavily) · `AMBIGUOUS` → both |
| **Generate** | Gemini 1.5 Pro composes a grounded answer from the collected knowledge |

## Setup

```bash
npm install
cp .env.example .env     # then fill in your keys
npm run ingest           # load the demo corpus into PGVector (one-time)
```

Required keys in `.env`:
- `GOOGLE_GENERATIVE_AI_API_KEY` — https://aistudio.google.com/app/apikey
- `DATABASE_URL` — Postgres with the `pgvector` extension (`CREATE EXTENSION vector;`)
- `TAVILY_API_KEY` — https://tavily.com (free tier)

## Run

### Chatbot UI (recommended)
```bash
npm run serve
```
Open **http://localhost:3000**. The chatbot streams every CRAG stage live so you
can *evaluate* the pipeline: retrieved docs + similarity scores, the relevance
verdict, the refined / web knowledge that was collected, and the final answer
with its sources.

### CLI (single query)
```bash
npm start
QUERY="your question here" npm start
```

## Architecture

```
src/
  lib/            # core CRAG functions (retriever, evaluator, refiner, rewriter, searcher)
  lib/pipeline.js # orchestrator that streams every stage to the UI
  mastra/         # Mastra workflow + agent + tool definitions
  server.js       # Express + SSE API that hosts the frontend
public/           # the chatbot frontend (vanilla JS, no build step)
```

The canonical pipeline is the **Mastra workflow** in
`src/mastra/workflows/crag-workflow.js`. `src/lib/pipeline.js` runs the exact same
four stages but emits a Server-Sent Event after each one, which is what powers the
live UI trace.

> **Swapping the LLM:** all model calls go through the `ai` SDK + `@ai-sdk/google`.
> To switch providers, install the relevant `@ai-sdk/*` package and replace the
> `google('gemini-1.5-pro')` calls in `src/lib/*.js` and `src/lib/pipeline.js`.
