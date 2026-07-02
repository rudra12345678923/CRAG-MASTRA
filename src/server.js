import 'dotenv/config';
import express  from 'express';
import path     from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto   from 'node:crypto';

import { mastra }           from './mastra/index.js';
import { runMockPipeline }  from './lib/mock-pipeline.js';
import * as auth            from './lib/auth.js';
import { startRun, endRun } from './lib/run-context.js';

const __dirname  = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT       = process.env.PORT || 3000;

const REQUIRED_ENV = ['AI_GATEWAY_API_KEY', 'UPSTASH_VECTOR_REST_URL', 'UPSTASH_VECTOR_REST_TOKEN', 'TAVILY_API_KEY'];

// Agent tool name → UI pipeline stage
const TOOL_TO_STAGE = {
  'documentRetriever':   'retrieve',
  'document-retriever':  'retrieve',
  'retrievalEvaluator':  'evaluate',
  'retrieval-evaluator': 'evaluate',
  'knowledgeRefiner':    'correct',
  'knowledge-refiner':   'correct',
  'queryRewriter':       'correct',
  'query-rewriter':      'correct',
  'webSearcher':         'correct',
  'web-searcher':        'correct',
};

const app = express();
app.use(express.json());

const IMAGES_DIR = path.join(__dirname, '..', 'public', 'images');
app.use('/images', express.static(IMAGES_DIR));
app.use(express.static(PUBLIC_DIR));

/* ── Auth helpers ─────────────────────────────────────────────────────────── */

const COOKIE = (token) =>
  `crag_session=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 30}`;
const CLEAR_COOKIE = 'crag_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0';

async function requireUser(req, res) {
  const user = await auth.getUserByToken(auth.tokenFromRequest(req));
  if (!user) res.status(401).json({ error: 'Not signed in.' });
  return user;
}

/* ── Auth endpoints ───────────────────────────────────────────────────────── */

app.post('/api/auth/signup', async (req, res) => {
  try {
    const { user, token } = await auth.signup(req.body?.username, req.body?.password);
    res.setHeader('Set-Cookie', COOKIE(token));
    res.json({ user });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/auth/signin', async (req, res) => {
  try {
    const { user, token } = await auth.signin(req.body?.username, req.body?.password);
    res.setHeader('Set-Cookie', COOKIE(token));
    res.json({ user });
  } catch (err) {
    res.status(401).json({ error: err.message });
  }
});

app.post('/api/auth/logout', async (req, res) => {
  await auth.signout(auth.tokenFromRequest(req));
  res.setHeader('Set-Cookie', CLEAR_COOKIE);
  res.json({ ok: true });
});

app.get('/api/auth/me', async (req, res) => {
  const user = await auth.getUserByToken(auth.tokenFromRequest(req));
  res.json({ user: user ?? null });
});

/* ── Conversation endpoints (per-user, backed by Mastra memory) ──────────── */

async function getMemory() {
  return mastra.getAgent('cragAgent').getMemory();
}

// List this user's conversations
app.get('/api/threads', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const memory = await getMemory();
    const result = await memory.listThreads({
      filter: { resourceId: auth.resourceIdFor(user) },
      orderBy: { field: 'updatedAt', direction: 'DESC' },
      perPage: false,
    });
    const threads = (result?.threads ?? result ?? []).map((t) => ({
      id: t.id,
      title: t.title || 'New conversation',
      updatedAt: t.updatedAt,
      createdAt: t.createdAt,
    }));
    res.json({ threads });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Restore a conversation's messages
app.get('/api/threads/:id/messages', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const memory = await getMemory();
    const thread = await memory.getThreadById({ threadId: req.params.id });
    if (!thread || thread.resourceId !== auth.resourceIdFor(user)) {
      res.status(404).json({ error: 'Conversation not found.' });
      return;
    }
    const { messages } = await memory.recall({ threadId: req.params.id, perPage: false });
    const simplified = (messages || [])
      .map((m) => {
        let text = '';
        const content = m.content;
        if (typeof content === 'string') text = content;
        else if (Array.isArray(content)) {
          text = content.filter((p) => p?.type === 'text').map((p) => p.text).join('');
        } else if (Array.isArray(content?.parts)) {
          text = content.parts.filter((p) => p?.type === 'text').map((p) => p.text).join('');
        } else if (typeof content?.content === 'string') {
          text = content.content;
        }
        return { role: m.role, text, createdAt: m.createdAt };
      })
      .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim());
    res.json({ thread: { id: thread.id, title: thread.title }, messages: simplified });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a conversation
app.delete('/api/threads/:id', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const memory = await getMemory();
    const thread = await memory.getThreadById({ threadId: req.params.id });
    if (thread && thread.resourceId === auth.resourceIdFor(user)) {
      await memory.deleteThread(req.params.id);
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// What the agent remembers about this user (working-memory profile)
app.get('/api/memory-profile', async (req, res) => {
  const user = await requireUser(req, res);
  if (!user) return;
  try {
    const memory = await getMemory();
    const workingMemory = await memory?.getWorkingMemory?.({
      resourceId: auth.resourceIdFor(user),
      memoryConfig: { workingMemory: { scope: 'resource' } },
    });
    res.json({ workingMemory: workingMemory ?? null });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── Health & debug ───────────────────────────────────────────────────────── */

app.get('/api/health', (_req, res) => {
  const env   = Object.fromEntries(REQUIRED_ENV.map((k) => [k, Boolean(process.env[k])]));
  const ready = REQUIRED_ENV.every((k) => process.env[k]);
  res.json({ ok: true, ready, env });
});

app.get('/api/debug-sources', async (_req, res) => {
  try {
    const { Index }        = await import('@upstash/vector');
    const { getEmbedding } = await import('./lib/embeddings.js');

    const index = new Index({
      url:   process.env.UPSTASH_VECTOR_REST_URL,
      token: process.env.UPSTASH_VECTOR_REST_TOKEN,
    });

    const queries = [
      'submission deadline date',
      'addendum amendment update supersede',
      'budget cost price amount',
      'eligibility requirements scope',
    ];

    const allResults = new Map();
    for (const q of queries) {
      const emb     = await getEmbedding(q);
      const results = await index.query({ vector: emb, topK: 20, includeMetadata: true });
      for (const r of results) {
        if (!allResults.has(r.id)) allResults.set(r.id, r);
      }
    }

    const bySource = {};
    for (const r of allResults.values()) {
      const src = r.metadata?.source ?? 'UNKNOWN';
      if (!bySource[src]) bySource[src] = [];
      bySource[src].push((r.metadata?.text ?? '').substring(0, 150).replace(/\n/g, ' '));
    }

    const summary = Object.entries(bySource).map(([src, chunks]) => ({
      source:      src,
      chunkCount:  chunks.length,
      sampleChunk: chunks[0],
    }));

    res.json({
      totalUniqueChunks: allResults.size,
      sourceCount:       summary.length,
      sources:           summary,
      diagnosis: summary.length <= 1
        ? 'WARNING: Only 1 source found. Addendum was likely never ingested. Run: npm run ingest -- ./your-addendum.pdf'
        : 'OK: Multiple sources found in the database.',
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── CRAG pipeline (SSE streaming) ────────────────────────────────────────── */

app.get('/api/crag', async (req, res) => {
  const rawQuery = (req.query.query || '').toString().trim();
  if (!rawQuery) { res.status(400).json({ error: 'Missing ?query= parameter' }); return; }

  const mock = req.query.mock === '1' || req.query.mock === 'true';

  // Real queries require a signed-in user so memory is scoped per account.
  // (EventSource sends the httpOnly session cookie automatically.)
  let user = null;
  if (!mock) {
    user = await auth.getUserByToken(auth.tokenFromRequest(req));
    if (!user) { res.status(401).json({ error: 'Please sign in first.' }); return; }

    const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
    if (missing.length > 0) {
      res.status(503).json({ error: `Server not configured. Missing: ${missing.join(', ')}.` });
      return;
    }
  }

  const sessionId = (req.query.sessionId || '').toString() || crypto.randomUUID();

  res.writeHead(200, {
    'Content-Type':      'text/event-stream',
    'Cache-Control':     'no-cache',
    'Connection':        'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const send = (event, payload) => {
    res.write('event: ' + event + '\n');
    res.write('data: ' + JSON.stringify(payload) + '\n\n');
  };

  send('open', { query: rawQuery, sessionId, mock });
  const t0 = Date.now();

  try {
    if (mock) {
      const result = await runMockPipeline(rawQuery, (evt) => send('stage', evt));
      send('result', result);
      send('end', { elapsedMs: result.elapsedMs });
    } else {
      const agent  = mastra.getAgent('cragAgent');
      const memory = await agent.getMemory();

      // Title new conversations with the first question.
      let threadArg = sessionId;
      try {
        const existing = await memory.getThreadById({ threadId: sessionId });
        if (!existing) {
          threadArg = { id: sessionId, title: rawQuery.slice(0, 60) };
        }
      } catch { /* thread lookup is best-effort */ }

      console.log(`\n[CRAG] ══ New query from ${user.username}: "${rawQuery}"`);
      startRun(); // per-run cache shared with the CRAG tools

      // Send ONLY the new message — Mastra Memory injects history,
      // semantic recall, working memory, and observations automatically.
      const stream = await agent.stream(rawQuery, {
        memory: { thread: threadArg, resource: auth.resourceIdFor(user) },
      });

      let answer = '';
      const toolOutputs = {};
      const stagesStarted = new Set();
      let generateStarted = false;

      for await (const chunk of stream.fullStream) {
        const type    = chunk?.type;
        const payload = chunk?.payload ?? chunk ?? {};

        if (type === 'tool-call') {
          const toolName = payload.toolName ?? payload.name;
          const stage    = TOOL_TO_STAGE[toolName];
          if (stage && !stagesStarted.has(stage)) {
            stagesStarted.add(stage);
            const extra = stage === 'correct'
              ? { action: toolOutputs.evaluate?.confidence }
              : {};
            send('stage', { stage, status: 'start', data: extra });
          }
        }

        if (type === 'tool-result') {
          const toolName = payload.toolName ?? payload.name;
          const stage    = TOOL_TO_STAGE[toolName];
          const output   = payload.result ?? payload.output ?? {};
          if (stage) {
            toolOutputs[stage] = { ...(toolOutputs[stage] || {}), ...output };
            send('stage', { stage, status: 'done', data: toolOutputs[stage] });
          }
        }

        if (type === 'text-delta') {
          if (!generateStarted) {
            generateStarted = true;
            console.log('\n[CRAG] 4. GENERATE — streaming answer...');
            send('stage', { stage: 'generate', status: 'start', data: {} });
          }
          const delta = payload.text ?? payload.textDelta ?? '';
          answer += delta;
          if (delta) send('token', { text: delta });
        }
      }

      if (!answer) answer = await stream.text;

      send('stage', { stage: 'generate', status: 'done', data: { answer } });

      const retrieveOut = toolOutputs.retrieve || {};
      const evaluateOut = toolOutputs.evaluate || {};
      const correctOut  = toolOutputs.correct  || {};

      send('result', {
        query:       rawQuery,
        answer,
        confidence:  evaluateOut.confidence,
        sourcesUsed: correctOut.sourcesUsed || [],
        imageResults: (retrieveOut.documents || [])
          .filter((d) => d.type === 'image' && d.imagePath)
          .map((d) => ({ source: d.source, imagePath: d.imagePath, text: d.text })),
        retrieve:    { documents: retrieveOut.documents || [] },
        evaluate:    evaluateOut,
        correct:     correctOut,
        generate:    { answer },
        elapsedMs:   Date.now() - t0,
      });
      send('end', { elapsedMs: Date.now() - t0 });
      console.log(`[CRAG] 4. GENERATE done — ${((Date.now() - t0) / 1000).toFixed(1)}s total\n`);
    }
  } catch (err) {
    console.error('[server] pipeline error:', err);
    send('error', { message: err?.message || 'Pipeline failed' });
  } finally {
    endRun();
    res.end();
  }
});

app.listen(PORT, () => {
  console.log('\n  CRAG chatbot running ->  http://localhost:' + PORT + '\n');
  const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.warn('  Missing env vars: ' + missing.join(', '));
  }
});
