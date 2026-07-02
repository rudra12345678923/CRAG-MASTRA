/* CRAG frontend — auth + per-user memory + streaming pipeline UI */

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const authView   = $('#authView');
const appView    = $('#appView');
const messagesEl = $('#messages');
const form       = $('#composerForm');
const input      = $('#input');
const sendBtn    = $('#sendBtn');
const demoToggle = $('#demoToggle');
const threadList = $('#threadList');

const STAGES = [
  { id: 'retrieve', name: 'Retrieve', n: '1' },
  { id: 'evaluate', name: 'Evaluate', n: '2' },
  { id: 'correct',  name: 'Correct',  n: '3' },
  { id: 'generate', name: 'Generate', n: '4' },
];

let busy = false;
let currentUser = null;
let currentThreadId = null;

/* ── Helpers ──────────────────────────────────────────────────────────────── */
function el(tag, cls, html) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html != null) node.innerHTML = html;
  return node;
}
function escapeHtml(s = '') {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function truncate(s = '', n = 160) { return s.length > n ? s.slice(0, n).trim() + '…' : s; }
function scrollDown() { messagesEl.scrollTop = messagesEl.scrollHeight; }
function hostOf(url) { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; } }
async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

/* ═══════════════════════════════ AUTH ═══════════════════════════════════── */

const authTabs   = $('.auth-tabs');
const tabSignin  = $('#tabSignin');
const tabSignup  = $('#tabSignup');
const authForm   = $('#authForm');
const authUser   = $('#authUser');
const authPass   = $('#authPass');
const authError  = $('#authError');
const authSubmit = $('#authSubmit');
let authMode = 'signin';

function setAuthMode(mode) {
  authMode = mode;
  authTabs.classList.toggle('signup', mode === 'signup');
  tabSignin.classList.toggle('active', mode === 'signin');
  tabSignup.classList.toggle('active', mode === 'signup');
  $('.btn-label', authSubmit).textContent = mode === 'signin' ? 'Sign in' : 'Create account';
  authPass.autocomplete = mode === 'signin' ? 'current-password' : 'new-password';
  authError.hidden = true;
}
tabSignin.addEventListener('click', () => setAuthMode('signin'));
tabSignup.addEventListener('click', () => setAuthMode('signup'));

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  authError.hidden = true;
  authSubmit.disabled = true;
  $('.btn-spinner', authSubmit).hidden = false;
  try {
    const { user } = await api(`/api/auth/${authMode}`, {
      method: 'POST',
      body: JSON.stringify({ username: authUser.value, password: authPass.value }),
    });
    enterApp(user);
  } catch (err) {
    authError.hidden = false;
    authError.textContent = err.message;
    authError.style.animation = 'none';
    void authError.offsetWidth;
    authError.style.animation = '';
  } finally {
    authSubmit.disabled = false;
    $('.btn-spinner', authSubmit).hidden = true;
  }
});

function showAuth() {
  currentUser = null;
  appView.hidden = true;
  authView.hidden = false;
  authPass.value = '';
  setTimeout(() => authUser.focus(), 150);
}

function enterApp(user) {
  currentUser = user;
  authView.hidden = true;
  appView.hidden = false;
  $('#userName').textContent = user.username;
  $('#userAvatar').textContent = user.username[0] || '?';
  startNewChat();
  loadThreads();
  checkHealth();
  input.focus();
}

$('#logoutBtn').addEventListener('click', async () => {
  await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
  showAuth();
});

/* ═══════════════════════════ CONVERSATIONS ══════════════════════════════── */

async function loadThreads() {
  try {
    const { threads } = await api('/api/threads');
    threadList.innerHTML = '';
    if (!threads.length) {
      threadList.appendChild(el('div', 'thread-empty', 'No conversations yet — ask something!'));
      return;
    }
    threads.forEach((t, i) => {
      const item = el('div', 'thread-item' + (t.id === currentThreadId ? ' active' : ''));
      item.style.animationDelay = `${Math.min(i * 40, 400)}ms`;
      item.innerHTML = `
        <span class="t-title">${escapeHtml(t.title)}</span>
        <button class="t-del" title="Delete">✕</button>`;
      item.addEventListener('click', () => openThread(t.id, item));
      $('.t-del', item).addEventListener('click', async (e) => {
        e.stopPropagation();
        await api(`/api/threads/${encodeURIComponent(t.id)}`, { method: 'DELETE' }).catch(() => {});
        if (t.id === currentThreadId) startNewChat();
        loadThreads();
      });
      threadList.appendChild(item);
    });
  } catch { /* signed out */ }
}

async function openThread(threadId, item) {
  if (busy) return;
  currentThreadId = threadId;
  $$('.thread-item', threadList).forEach((n) => n.classList.remove('active'));
  item?.classList.add('active');
  clearMessages();
  try {
    const { messages } = await api(`/api/threads/${encodeURIComponent(threadId)}/messages`);
    messages.forEach((m) => {
      if (m.role === 'user') addUserMessage(m.text, false);
      else addRestoredBotMessage(m.text);
    });
    scrollDown();
  } catch (err) {
    messagesEl.appendChild(el('div', 'error-box', escapeHtml(err.message)));
  }
}

function startNewChat() {
  currentThreadId = crypto.randomUUID();
  $$('.thread-item', threadList).forEach((n) => n.classList.remove('active'));
  clearMessages();
  showWelcome();
  input.focus();
}
$('#newChatBtn').addEventListener('click', startNewChat);

function clearMessages() { messagesEl.innerHTML = ''; }

function showWelcome() {
  const name = currentUser ? escapeHtml(currentUser.username) : 'there';
  const w = el('div', 'welcome');
  w.id = 'welcome';
  w.innerHTML = `
    <div class="logo-orb"><span>◈</span></div>
    <h3>Hey <em>${name}</em> — ask me anything</h3>
    <p>Every answer is traced through <b>Retrieve → Evaluate → Correct → Generate</b> so you
       can see exactly how the model corrected itself. I remember what matters to you across conversations.</p>
    <div class="examples">
      <button class="chip">What is retrieval-augmented generation and how does it work?</button>
      <button class="chip">Who designed and built the Eiffel Tower?</button>
      <button class="chip">What do you remember about me?</button>
      <button class="chip">What is the pgvector extension for PostgreSQL?</button>
    </div>`;
  messagesEl.appendChild(w);
  $$('.chip', w).forEach((chip) => {
    chip.addEventListener('click', () => {
      if (busy) return;
      runQuery(chip.textContent);
    });
  });
}

/* ═══════════════════════════ MEMORY MODAL ═══════════════════════════════── */

const memoryModal = $('#memoryModal');
$('#memoryBtn').addEventListener('click', async () => {
  memoryModal.hidden = false;
  const body = $('#memoryBody');
  body.innerHTML = '<div class="mem-loading">Reading memory…</div>';
  try {
    const { workingMemory } = await api('/api/memory-profile');
    body.innerHTML = workingMemory
      ? `<pre>${escapeHtml(String(workingMemory))}</pre>`
      : '<div class="mem-empty">Nothing yet — tell me about yourself in a conversation and I\'ll remember it here.</div>';
  } catch (err) {
    body.innerHTML = `<div class="mem-empty">${escapeHtml(err.message)}</div>`;
  }
});
$('#memoryClose').addEventListener('click', () => (memoryModal.hidden = true));
$('.modal-backdrop', memoryModal).addEventListener('click', () => (memoryModal.hidden = true));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') memoryModal.hidden = true; });

/* ═══════════════════════════ HEALTH ═════════════════════════════════════── */

async function checkHealth() {
  const pill = $('#statusPill');
  const text = $('#statusText');
  try {
    const data = await api('/api/health');
    if (data.ready) {
      pill.className = 'status-pill ready';
      text.textContent = 'Ready';
    } else {
      pill.className = 'status-pill missing';
      text.textContent = 'Missing keys · demo on';
      demoToggle.checked = true;
    }
  } catch {
    pill.className = 'status-pill missing';
    text.textContent = 'Server unreachable';
  }
}

/* ═══════════════════════════ MESSAGES ═══════════════════════════════════── */

function removeWelcome() { $('#welcome')?.remove(); }

function addUserMessage(text, scroll = true) {
  removeWelcome();
  const msg = el('div', 'msg user');
  msg.innerHTML = `<div class="bubble">${escapeHtml(text)}</div>`;
  messagesEl.appendChild(msg);
  if (scroll) scrollDown();
}

function addRestoredBotMessage(text) {
  removeWelcome();
  const msg = el('div', 'msg bot');
  msg.innerHTML = `
    <div class="bot-orb">◈</div>
    <div class="bot-col">
      <div class="answer-card">
        <div class="answer-head"><span class="label">CRAG ANSWER</span></div>
        <div class="answer-body">${escapeHtml(text).replace(/\n/g, '<br>')}</div>
      </div>
    </div>`;
  messagesEl.appendChild(msg);
}

function addBotMessage(mock = false) {
  removeWelcome();
  const msg = el('div', 'msg bot thinking');
  const pips = STAGES.map((s, i) =>
    `<div class="pip" data-pip="${s.id}">${s.n}</div>${i < STAGES.length - 1 ? '<div class="pip-line" data-line="' + i + '"></div>' : ''}`
  ).join('');
  const stages = STAGES.map((s) => `
    <div class="stage collapsed" data-stage="${s.id}">
      <div class="stage-head">
        <span class="stage-name">${s.name}</span>
        <span class="stage-status"></span>
      </div>
      <div class="stage-detail"></div>
    </div>`).join('');

  msg.innerHTML = `
    <div class="bot-orb">◈</div>
    <div class="bot-col">
      <div class="answer-card">
        <div class="answer-head">
          <span class="label">CRAG ANSWER</span>
          ${mock ? '<span class="demo-tag">DEMO</span>' : ''}
          <span class="conf-slot"></span>
          <span class="spacer"></span>
          <span class="elapsed"></span>
        </div>
        <div class="answer-body pending"><span class="typing"><span></span><span></span><span></span></span></div>
        <div class="sources" hidden></div>
      </div>
      <div class="pipeline collapsed">
        <div class="pipeline-head">
          <span class="title">PIPELINE TRACE</span>
          <span class="caret">▾</span>
        </div>
        <div class="pip-rail">${pips}</div>
        <div class="pipeline-body">${stages}</div>
      </div>
    </div>`;
  messagesEl.appendChild(msg);

  $('.pipeline-head', msg).addEventListener('click', () => $('.pipeline', msg).classList.toggle('collapsed'));
  $$('.stage-head', msg).forEach((h) =>
    h.addEventListener('click', () => h.closest('.stage').classList.toggle('collapsed')));
  scrollDown();
  return msg;
}

/* ── Stage state ──────────────────────────────────────────────────────────── */
function setPip(root, stageId, state) {
  const pip = $(`[data-pip="${stageId}"]`, root);
  if (!pip) return;
  pip.classList.remove('active', 'done');
  if (state) pip.classList.add(state);
  const idx = STAGES.findIndex((s) => s.id === stageId);
  if (state === 'done' && idx < STAGES.length - 1) {
    $(`[data-line="${idx}"]`, root)?.classList.add('filled');
  }
}
function markStageStart(root, stageId) {
  const stage = $(`.stage[data-stage="${stageId}"]`, root);
  if (!stage) return;
  setPip(root, stageId, 'active');
  $('.stage-status', stage).innerHTML = '<span class="stage-spin"></span>';
}
function markStageDone(root, stageId, metaText) {
  const stage = $(`.stage[data-stage="${stageId}"]`, root);
  if (!stage) return;
  setPip(root, stageId, 'done');
  $('.stage-status', stage).innerHTML = (metaText ? `<span class="stage-meta">${escapeHtml(metaText)}</span>` : '') +
    '<span class="stage-check">✓</span>';
}
function setStageDetail(root, stageId, html) {
  const stage = $(`.stage[data-stage="${stageId}"]`, root);
  if (!stage) return;
  $('.stage-detail', stage).innerHTML = html;
}

/* ── Stage renderers ──────────────────────────────────────────────────────── */
function renderRetrieve(data) {
  const docs = data?.documents || [];
  if (!docs.length) return '<span style="color:var(--text-faint)">No documents found in the vector store.</span>';
  const rows = docs.map((d) => `
    <div class="doc">
      <span class="doc-score" style="color:var(--retrieve);background:rgba(56,189,248,0.1)">${(d.score ?? 0).toFixed(3)}</span>
      <div>
        <div class="doc-text">${escapeHtml(truncate(d.text, 170))}</div>
        <div class="doc-src">${escapeHtml(d.source || 'unknown')}</div>
      </div>
    </div>`).join('');
  return `<div class="sub-label">${docs.length} documents</div>${rows}`;
}
function renderEvaluate(ev) {
  if (!ev.confidence) return '';
  const docs = ev.scoredDocuments || [];
  const rows = docs.map((d) => `
    <div class="doc">
      <span class="doc-score ${d.isRelevant ? 'rel' : 'irrel'}">${d.relevanceScore > 0 ? '+' : ''}${(d.relevanceScore ?? 0).toFixed(1)}</span>
      <div><div class="doc-text">${escapeHtml(truncate(d.text, 150))}</div>
      <div class="doc-src">${d.isRelevant ? 'relevant' : 'not relevant'} · ${escapeHtml(d.source || 'unknown')}</div></div>
    </div>`).join('');
  return `
    <div class="kv"><span class="k">Max score</span><span class="v">${(ev.maxScore ?? 0).toFixed(2)}</span></div>
    <div class="kv"><span class="k">Verdict</span><span class="v"><span class="badge ${ev.confidence.toLowerCase()}">${ev.confidence}</span></span></div>
    ${rows ? '<div class="sub-label">Per-document relevance</div>' + rows : ''}`;
}
function renderCorrect(c) {
  let html = '';
  if (c.refinedKnowledge) {
    html += `<div class="kv"><span class="k">Strips kept</span><span class="v">${c.stripsKept ?? '—'} / ${c.stripsTotal ?? '—'}</span></div>
      <div class="sub-label">Refined internal knowledge</div><div class="knowledge-block">${escapeHtml(truncate(c.refinedKnowledge, 1200))}</div>`;
  }
  if (c.searchQuery) {
    html += `<div class="kv"><span class="k">Search query</span><span class="v">${escapeHtml(c.searchQuery)}</span></div>`;
    if (c.keywords?.length) html += `<div class="keywords">${c.keywords.map((k) => `<span class="keyword">${escapeHtml(k)}</span>`).join('')}</div>`;
  }
  if (c.externalKnowledge) {
    html += `<div class="sub-label">External (web) knowledge</div><div class="knowledge-block">${escapeHtml(truncate(c.externalKnowledge, 1200))}</div>`;
  }
  return html || '<span style="color:var(--text-faint)">Collecting knowledge…</span>';
}
function renderSources(root, sources) {
  const box = $('.sources', root);
  if (!sources?.length) { box.hidden = true; return; }
  box.hidden = false;
  box.innerHTML = sources.map((u) =>
    `<a class="source-link" href="${escapeHtml(u)}" target="_blank" rel="noopener">🔗 ${escapeHtml(hostOf(u))}</a>`).join('');
}

/* ═══════════════════════════ MAIN RUN ═══════════════════════════════════── */

function runQuery(query) {
  if (busy) return;
  busy = true;
  sendBtn.disabled = true;

  const mock = demoToggle.checked;
  if (!currentThreadId) currentThreadId = crypto.randomUUID();
  const isFirstInThread = !$$('.msg', messagesEl).length;

  addUserMessage(query);
  const botMsg = addBotMessage(mock);
  const answerBody = $('.answer-body', botMsg);
  let streamedText = '';

  const url = '/api/crag?query=' + encodeURIComponent(query)
    + (mock ? '&mock=1' : '')
    + '&sessionId=' + encodeURIComponent(currentThreadId);
  const es = new EventSource(url);

  es.addEventListener('stage', (e) => {
    const { stage, status, data } = JSON.parse(e.data);
    if (status === 'start') {
      markStageStart(botMsg, stage);
      if (stage === 'correct' && data?.action) {
        setStageDetail(botMsg, 'correct',
          `<div class="kv"><span class="k">Action</span><span class="v"><span class="badge ${data.action.toLowerCase()}">${data.action}</span></span></div>`);
      }
    } else if (status === 'done') {
      let meta = '';
      if (stage === 'retrieve') { meta = `${(data.documents || []).length} docs`; setStageDetail(botMsg, 'retrieve', renderRetrieve(data)); }
      if (stage === 'evaluate') {
        meta = data.confidence || '';
        setStageDetail(botMsg, 'evaluate', renderEvaluate(data));
        if (data.confidence) $('.conf-slot', botMsg).innerHTML = `<span class="badge ${data.confidence.toLowerCase()}">${data.confidence}</span>`;
      }
      if (stage === 'correct')  { meta = data.sourcesUsed?.length ? `${data.sourcesUsed.length} web src` : 'refined'; setStageDetail(botMsg, 'correct', renderCorrect(data)); }
      if (stage === 'generate') { meta = 'done'; }
      markStageDone(botMsg, stage, meta);
    }
    scrollDown();
  });

  // Live token streaming
  es.addEventListener('token', (e) => {
    const { text } = JSON.parse(e.data);
    if (!text) return;
    if (answerBody.classList.contains('pending')) {
      answerBody.classList.remove('pending');
      answerBody.innerHTML = '<span class="stream-text"></span><span class="caret"></span>';
    }
    streamedText += text;
    $('.stream-text', answerBody).innerHTML = escapeHtml(streamedText).replace(/\n/g, '<br>');
    scrollDown();
  });

  es.addEventListener('result', (e) => {
    const result = JSON.parse(e.data);
    answerBody.classList.remove('pending');
    answerBody.innerHTML = escapeHtml(result.answer || streamedText || '(no answer produced)').replace(/\n/g, '<br>');

    if (!result.faithful && result.faithfulnessIssues?.length) {
      answerBody.innerHTML += `<div class="error-box" style="margin-top:10px">⚠ <b>Faithfulness:</b> ${escapeHtml(result.faithfulnessIssues[0])}</div>`;
    }
    if (result.imageResults?.length) {
      const wrap = el('div');
      wrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;margin-top:12px';
      result.imageResults.forEach((img) => {
        wrap.innerHTML += `<img src="${escapeHtml(img.imagePath)}" style="max-width:300px;max-height:220px;border-radius:10px;border:1px solid var(--border)" loading="lazy" alt="">`;
      });
      answerBody.appendChild(wrap);
    }
    if (result.elapsedMs != null) $('.elapsed', botMsg).textContent = (result.elapsedMs / 1000).toFixed(1) + 's';
    renderSources(botMsg, result.sourcesUsed);
    scrollDown();
  });

  es.addEventListener('error', (e) => {
    if (e.data) {
      try {
        const { message } = JSON.parse(e.data);
        answerBody.classList.remove('pending');
        answerBody.innerHTML = `<div class="error-box">⚠ ${escapeHtml(message)}</div>`;
        finish();
      } catch { /* ignore */ }
    }
  });

  es.addEventListener('end', () => {
    finish();
    if (isFirstInThread && !mock) setTimeout(loadThreads, 600); // pick up the new thread title
  });

  es.onerror = () => {
    if (answerBody.classList.contains('pending')) {
      fetch(url)
        .then((r) => (r.ok ? null : r.json()))
        .then((j) => {
          if (j?.error) {
            answerBody.classList.remove('pending');
            answerBody.innerHTML = `<div class="error-box">⚠ ${escapeHtml(j.error)}</div>`;
            if (j.error.includes('sign in')) setTimeout(showAuth, 1200);
          }
        })
        .catch(() => {})
        .finally(finish);
    } else {
      finish();
    }
  };

  function finish() {
    es.close();
    botMsg.classList.remove('thinking');
    $('.caret', answerBody)?.remove();
    busy = false;
    sendBtn.disabled = false;
    input.focus();
  }
}

/* ── Input handling ───────────────────────────────────────────────────────── */
function autoGrow() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 160) + 'px';
}
input.addEventListener('input', autoGrow);
input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    form.requestSubmit();
  }
});
form.addEventListener('submit', (e) => {
  e.preventDefault();
  const q = input.value.trim();
  if (!q || busy) return;
  input.value = '';
  autoGrow();
  runQuery(q);
});

/* ── Boot: restore session if the cookie is still valid ───────────────────── */
(async function boot() {
  try {
    const { user } = await api('/api/auth/me');
    if (user) { enterApp(user); return; }
  } catch { /* fall through */ }
  showAuth();
})();
