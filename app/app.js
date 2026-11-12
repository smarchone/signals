// Signals UI: meeting -> verdict -> distill -> context review -> PRDs. No build step; marked + DOMPurify are globals.

const CONTEXT_FILES = ['business.md', 'product.md', 'model.md', 'vocab.md', 'architecture.md'];
const FILE_LABEL = { 'product.md': 'Product', 'business.md': 'Business', 'model.md': 'Model', 'vocab.md': 'Vocabulary', 'architecture.md': 'Architecture' };
// Distill runs high level first, with your review gate after each step (mirrors the daemon)
const STEPS = [
  { id: 'brief', what: 'Business, product and model', files: ['business.md', 'product.md', 'model.md'], gate: 'The must-read: why it wins, what we are building, and the core abstractions it is made of.' },
  { id: 'design', what: 'Vocabulary and architecture', files: ['vocab.md', 'architecture.md'], gate: 'The exact terms by domain, and an initial direction for the system: how its domains compose, and its seams.' },
];
// One group per stage in the file list
const GROUPS = STEPS.map((x) => ({ steps: [x.id], files: x.files }));
const stepIndex = (id) => STEPS.findIndex((x) => x.id === id);
const groupOf = (stepId) => GROUPS.findIndex((g) => g.steps.includes(stepId));
const reviewing = (i) => i.stage === 'distilling' && i.distill?.status === 'review';
const canRefine = (i) => i.stage === 'distilled' || reviewing(i);
const canRedistill = (i) => !i.working && canRefine(i) && !i.refinements.some((r) => r.status === 'pending');
// PRDs: the plan layer, cut from the distilled context. Named by relative path (prds/01-skeleton.md).
const isPrd = (name) => String(name).startsWith('prds/');
const reviewingPrds = (i) => i.stage === 'distilled' && i.prd?.status === 'review';
const canRefineDoc = (i, name) => (isPrd(name) ? ['review', 'done'].includes(i.prd?.status) && !prdLocked(i, name) : canRefine(i));
// A PRD being executed, or complete, is what was built: it stays as it is (a stopped one can still change)
const prdLocked = (i, name) => ['building', 'blocked', 'built', 'gone', 'complete'].includes(i.executions?.[name]?.status);
const prdsPending = (i) => i.refinements.some((r) => r.status === 'pending' && isPrd(r.file));
// "# PRD 01: Walking skeleton" -> { num: '01', title: 'Walking skeleton' }
function prdLabel(f) {
  const base = f.name.slice(5).replace(/\.md$/, '');
  const h1 = (f.content || '').match(/^#\s+(.+)$/m)?.[1] || '';
  const m = h1.match(/^(?:PRD\s*)?(\d+)\s*[:.·—-]\s*(.+)$/i);
  return { num: m?.[1] || base.match(/^\d+/)?.[0] || '', title: m?.[2] || h1 || base };
}

const S = {
  workspaces: [],
  ws: null,
  ideas: [],
  idea: null, // full idea (with context)
  route: { ws: null, tab: 'meeting', file: null },
  presence: {},
  drafts: {}, // per-idea composer text
  verdictOpen: false,
  verdictChoice: null,
  changePrds: { text: '', focus: [] }, // the Add or change PRDs form, kept across re-renders
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const md = (s) => DOMPurify.sanitize(marked.parse(String(s ?? ''), { gfm: true, breaks: false }));

async function api(method, route, body) {
  const res = await fetch(route, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}
const wsApi = (method, route, body) => api(method, `/api/w/${encodeURIComponent(S.ws)}${route.replace(/^\/api/, "")}`, body);

function toast(text, ms = 2600) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}
const fail = (err) => toast(err.message || String(err));

// ---------- Routing: #/<repo>/meeting, #/<repo>/context[/<file>] or #/<repo>/prds[/<file>] — a repo has one idea, so the repo is the address ----------

function parseRoute() {
  const [ws, tab, file] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const tabs = ['meeting', 'context', 'prds'];
  return { ws: ws || null, tab: tabs.includes(tab) ? tab : 'meeting', file: file || null, canonical: tabs.includes(tab) };
}
function goIndex() {
  if (location.hash === '#/' || location.hash === '') onRoute();
  else location.hash = '#/';
}
function go(r) {
  const next = { ...S.route, ...r };
  const parts = [next.ws, next.ws && next.tab, next.tab !== 'meeting' && next.file].filter(Boolean);
  const hash = `#/${parts.map(encodeURIComponent).join('/')}`;
  if (location.hash === hash) onRoute(); // same address: re-render instead of waiting for a hashchange
  else location.hash = hash;
}

async function onRoute() {
  const r = parseRoute();
  if (r.ws && !S.workspaces.some((w) => w.id === r.ws)) return goIndex(); // a removed or unknown repo
  if (r.ws && !r.canonical) return go({ ws: r.ws, tab: 'meeting', file: null }); // #/<repo> -> #/<repo>/meeting
  const wsChanged = r.ws !== S.ws;
  S.route = r;
  S.ws = r.ws;
  if (wsChanged) {
    S.verdictOpen = false;
    S.verdictChoice = null;
  }
  await loadIdeas();
  await loadIdea();
  renderMain();
}

// ---------- Data ----------

async function loadWorkspaces() {
  const { workspaces } = await api('GET', '/api/workspaces');
  S.workspaces = workspaces;
  for (const w of workspaces) S.presence[w.id] = w.presence;
}
async function loadIdeas() {
  if (!S.ws) return (S.ideas = []);
  S.ideas = (await wsApi('GET', '/api/ideas')).ideas;
}
// The repo's one idea, if it has one
async function loadIdea() {
  const id = S.ideas[0]?.id;
  try {
    S.idea = id ? await wsApi('GET', `/api/idea?id=${encodeURIComponent(id)}`) : null;
  } catch {
    S.idea = null;
  }
}

// ---------- Sidebar ----------

// One row per repo, each with its one idea (or none yet)
function ideaStatus(i) {
  if (!i) return { text: 'No idea yet: start a meeting', cls: 'you' };
  if (i.working === 'panel') return { text: 'Panel is conferring…', busy: true };
  if (i.working === 'distill') return { text: 'Writing context…', busy: true };
  if (i.working === 'refine') return { text: 'Making a change…', busy: true };
  if (i.working === 'prd') return { text: 'Writing PRDs…', busy: true };
  if (reviewing(i)) return { text: 'Ready for your review', cls: 'you' };
  if (reviewingPrds(i)) return { text: 'PRDs ready for your review', cls: 'you' };
  if (i.waiting_on === 'you') return { text: 'Your move', cls: 'you' };
  if (i.waiting_on === 'claude') return { text: 'Waiting for the worker' };
  return i.stage === 'killed' ? { text: 'Killed' } : null; // a distilled idea needs nothing from you: say nothing
}

const FOLDER_ICON = '<svg class="folder" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.5a1 1 0 0 1 1-1h3.2l1.5 1.5h6.3a1 1 0 0 1 1 1v7.5a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';

// Under the active workspace: the meeting, then the context's stages and files
// The index: every workspace, its Claude connection and where its idea stands
function workerState(wsId) {
  const p = S.presence[wsId];
  return p?.job ? ['busy', 'Claude is working'] : p?.listening ? ['on', 'Claude is connected'] : ['', "Claude isn't running"];
}
function renderIndex(main) {
  const rows = S.workspaces
    .map((w) => {
      const st = ideaStatus(w.idea);
      const [cls, label] = workerState(w.id);
      return `<li class="ws-row">
        <button class="ws-card" data-repo="${esc(w.id)}">
          ${FOLDER_ICON}
          <span class="ws-main"><span class="ws-card-name">${esc(w.name)}</span><span class="ws-card-path">${esc(w.path || w.repo)}</span></span>
          <span class="ws-idea">${w.idea ? esc(w.idea.title) : ''}</span>
          <span class="ws-card-status ${st?.cls || ''}">${esc(st?.text || (w.idea?.prd?.status === 'done' ? 'PRDs ready to hand off' : w.idea?.stage === 'distilled' ? 'Context ready' : ''))}</span>
          <span class="worker ${cls}" title="${label}"></span>
        </button>
        <button class="btn ghost sm icon more" data-menu="${esc(w.id)}" title="Workspace actions" aria-haspopup="menu">⋯</button>
      </li>`;
    })
    .join('');
  main.innerHTML = `<header class="idea-head"><div class="ws-title">${BRAND}</div></header>
    <div class="body"><div class="index">
      <h2>Workspaces</h2>
      ${S.workspaces.length ? `<ul class="ws-list">${rows}</ul>` : ''}
      <p class="index-hint">Add a repo: run <code>signals serve</code> in it, or <code>/signals</code> in Claude Code there.</p>
    </div></div>`;
}

const BRAND = '<a class="home" href="#/" title="All workspaces"><span class="logo" aria-hidden="true"></span>Signals</a>';

// Claude's connection to this repo, shown in the title before the folder path
function workerBadge() {
  const p = S.presence[S.ws];
  const w = S.workspaces.find((x) => x.id === S.ws);
  if (p?.job) return `<span class="worker busy" title="Claude is ${{ panel: 'answering as the panel', distill: 'writing context', refine: 'making a change', prd: 'writing PRDs' }[p.job.type]}"></span>`;
  if (p?.listening) return '<span class="worker on" title="Claude is connected and listening"></span>';
  return `<span class="worker" title="Claude isn't running in ${esc(w?.name || 'this repo')}"></span><span class="worker-hint">Claude isn't running: run <code>/signals</code></span>`;
}
function renderPresence() {
  const el = $('.ws-title .worker-slot');
  if (el) el.innerHTML = workerBadge();
}

// ---------- Main ----------

function keepFocus(fn) {
  const a = document.activeElement;
  const key = a?.dataset?.keep;
  const sel = key && 'selectionStart' in a ? [a.selectionStart, a.selectionEnd] : null;
  const scroller = $('.ctx-doc') || $('.body');
  const nearBottom = scroller && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  const top = scroller?.scrollTop;
  fn();
  if (key) {
    const b = document.querySelector(`[data-keep="${key}"]`);
    if (b) {
      b.focus();
      if (sel) b.setSelectionRange(...sel);
    }
  }
  return { nearBottom, top };
}

function renderMain() {
  const main = $('#main');
  if (!S.ws) return renderIndex(main);
  if (!S.ideas.length) return renderStart(main);
  if (!S.idea) {
    main.innerHTML = '<div class="empty">That idea is gone.</div>';
    return;
  }
  const prevIdea = main.dataset.view;
  const prevTab = main.dataset.tab;
  const { nearBottom, top } = keepFocus(() => {
    const view = { context: renderContext, prds: renderPrds }[S.route.tab] || renderMeeting;
    main.innerHTML = renderIdeaHead() + renderSubhead() + view();
    main.dataset.view = S.idea.id;
    main.dataset.tab = S.route.tab;
  });
  const sameView = prevIdea === S.idea.id && prevTab === S.route.tab;
  if (S.route.tab === 'meeting') {
    decoratePanel(main);
    const body = $('.body');
    if (!sameView || nearBottom) body.scrollTop = body.scrollHeight;
    else body.scrollTop = top;
    autosize($('#composer'));
  } else {
    const doc = $('.ctx-doc');
    if (doc && sameView && top != null) doc.scrollTop = top;
    showChanges();
    autosize($('#prd-guidance'));
    const box = $('#change-prds-text');
    if (box && document.activeElement !== box) box.focus();
  }
}

function showChanges() {
  const art = $('#doc');
  const reviewedMd = art && S.idea?.changes?.[art.dataset.file];
  if (reviewedMd == null) return;
  const { changed, removed } = markChanges(art, reviewedMd);
  const parts = [changed && `${changed} new or changed`, removed && `${removed} removed`].filter(Boolean).join(' · ') || 'Changed';
  $('#changes-line').innerHTML = `<div class="note-line chg-line"><span class="chg-dot"></span>${parts} since you last reviewed this file
    <button class="btn ghost sm" data-reviewed="${esc(art.dataset.file)}">Mark reviewed</button></div>`;
}

function renderStart(main) {
  const draft = S.drafts.__new || '';
  const repo = S.workspaces.find((w) => w.id === S.ws)?.name || 'this repo';
  main.innerHTML = `<header class="idea-head"><div class="ws-title">${BRAND}<span class="crumb-sep">/</span>${FOLDER_ICON}<span class="ws-name">${esc(repo)}</span><span class="worker-slot">${workerBadge()}</span></div></header>
    <div class="body"><div class="start">
    <h2>What's the hunch for ${esc(repo)}?</h2>
    <p>Pitch it raw. The panel will push on the vision, the loop and the hard constraints, quickly. You make the call.</p>
    <textarea class="field" id="hunch" data-keep="hunch" placeholder="e.g. A context workspace where humans vet ideas and agents build from the distilled mental model…">${esc(draft)}</textarea>
    <div class="row">
      <div class="panelists">
        <span style="background:var(--ceo-soft);color:var(--ceo)">CEO</span>
        <span style="background:var(--pm-soft);color:var(--pm)">PM</span>
        <span style="background:var(--arch-soft);color:var(--arch)">Architect</span>
      </div>
      <button class="btn primary" id="start">Start the meeting ⌘↵</button>
    </div>
  </div></div>`;
  $('#hunch').focus();
}

// Per-file progress: approved, waiting for your review, being written, queued, not yet, or stale
function fileState(i, f) {
  const has = i.context.some((x) => x.name === f);
  const st = stepState(i, STEPS.find((x) => x.files.includes(f)).id);
  if (st === 'todo') return has ? 'stale' : 'todo';
  if (st === 'working' && !has) return 'working';
  if (st === 'queued') return has ? 'stale' : 'queued';
  return st; // done | review | working (rewriting an existing file)
}

// Header: the workspace and the next step
function renderIdeaHead() {
  const i = S.idea;
  const w = S.workspaces.find((x) => x.id === S.ws);
  const killed = i.stage === 'killed';
  const steps = killed ? ['Meeting', 'Killed'] : ['Meeting', 'Context', 'PRDs', 'Exec'];
  const executing = Object.keys(i.executions || {}).length > 0;
  const at = killed ? 1 : { meeting: 0, distilling: 1, distilled: executing ? 3 : i.prd ? 2 : 1 }[i.stage];
  return `<header class="idea-head">
    <div class="ws-title" title="${esc(w?.repo || '')}">${BRAND}<span class="crumb-sep">/</span>${FOLDER_ICON}<span class="ws-name">${esc(w?.name || '')}</span><span class="worker-slot">${workerBadge()}</span><span class="ws-path"><bdi>${esc(w?.path || w?.repo || '')}</bdi></span></div>
    <div class="rail">${steps
      .map((label, n) => {
        const cls = killed && n === 1 ? 'dead' : n === at ? 'now' : n < at ? 'done' : '';
        return `${n ? '<span class="sep"></span>' : ''}<span class="step ${cls}">${n < at && !killed ? '✓ ' : ''}${esc(label)}</span>`;
      })
      .join('')}</div>
  </header>`;
}

// Sub header: the two views, and on Context the distill chain across the row
function renderSubhead() {
  const i = S.idea;
  const tab = S.route.tab;
  const hasCtx = i.stage === 'distilling' || i.stage === 'distilled' || i.context.length;
  const turns = i.messages.filter((m) => m.author === 'panel').length;
  const meetingMeta = i.stage === 'killed' ? 'killed' : turns;
  const approved = CONTEXT_FILES.filter((f) => fileState(i, f) === 'done').length;
  const hasPrds = i.stage === 'distilled' || i.prds.length;
  return `<nav class="subhead">
    <div class="tabs">
      <button class="tab ${tab === 'meeting' ? 'active' : ''}" data-tab="meeting">Meeting<span class="count">${meetingMeta}</span></button>
      <button class="tab ${tab === 'context' ? 'active' : ''}" data-tab="context" ${hasCtx ? '' : 'disabled title="Commit the idea to distill its context"'}>Context<span class="count">${hasCtx ? `${approved}/${CONTEXT_FILES.length}` : 'after the call'}</span></button>
      <button class="tab ${tab === 'prds' ? 'active' : ''}" data-tab="prds" ${hasPrds ? '' : 'disabled title="Approve the context to plan PRDs"'}>PRDs<span class="count">${i.prds.length || (hasPrds ? 'plan' : 'after context')}</span></button>
    </div>
  </nav>`;
}

// ---------- Meeting ----------

function workerHint() {
  const p = S.presence[S.ws];
  if (p?.listening || p?.job) return '';
  const w = S.workspaces.find((x) => x.id === S.ws);
  return `<div class="notice">No worker is listening, so nothing will answer yet. Open Claude Code in <b>${esc(w?.name)}</b> and run <code>/signals</code>.</div>`;
}

function renderMeeting() {
  const i = S.idea;
  const panelBusy = i.working === 'panel';
  const msgs = i.messages
    .map((m) =>
      m.author === 'you'
        ? `<section class="turn turn-you"><span class="who">You</span><div class="said">${esc(m.text)}</div></section>`
        : `<section class="turn turn-panel"><div class="msg-panel md">${md(m.text)}</div></section>`,
    )
    .join('');
  const pending = (text) => `<section class="turn turn-wait"><span class="who">Panel</span><div class="said"><span class="wait-bar"></span>${text}</div></section>`;
  let tail = '';
  if (panelBusy) tail = pending('Deliberating');
  else if (i.waiting_on === 'claude' && i.stage === 'meeting') tail = workerHint() || pending('Waiting for the panel');

  let dock = '';
  if (i.stage === 'meeting') {
    const turns = i.messages.filter((m) => m.author === 'panel').length;
    dock = `<div class="dock"><div class="dock-inner">
      ${S.verdictOpen ? renderVerdict() : ''}
      <div class="composer">
        <textarea id="composer" data-keep="composer" rows="1" placeholder="${panelBusy ? 'The panel is answering' : 'Respond to the panel, or answer the open question'}">${esc(S.drafts[i.id] || '')}</textarea>
        <button class="btn primary" id="send" ${panelBusy ? 'disabled' : ''}>Send</button>
      </div>
      <div class="dock-meta">
        <span>↵ send · ⇧↵ new line</span>
        ${S.verdictOpen ? '' : `<button class="btn ${turns >= 2 ? 'primary' : ''} sm" id="open-verdict" ${panelBusy || !turns ? 'disabled' : ''}>Make the call</button>`}
      </div>
    </div></div>`;
  } else if (i.stage === 'killed') {
    dock = `<div class="dock"><div class="dock-inner"><div class="banner killed">
      <span class="grow"><b>Killed</b> ${i.verdict?.note ? `<span class="note">— ${esc(i.verdict.note)}</span>` : ''}<br><small>Time and tokens saved. It stays here with your reasoning; delete it to start another idea in this repo.</small></span>
      <button class="btn sm" id="reopen">Reopen meeting</button>
      <button class="btn ghost sm" id="delete-idea" title="Delete this idea so the repo can take a new one">Delete idea</button></div></div></div>`;
  } else {
    dock = `<div class="dock"><div class="dock-inner"><div class="banner committed">
      <span class="grow"><b>Committed</b> ${i.verdict?.note ? `<span class="note">— ${esc(i.verdict.note)}</span>` : ''}
        <br><small>Thinking moved on? Reopen the meeting: what you change flows into the context as edits.</small></span>
      <button class="btn sm" id="reopen" ${i.working ? 'disabled' : ''}>Reopen meeting</button>
      <button class="btn sm good" data-tab="${i.prd ? 'prds' : 'context'}">${i.prd ? 'Go to PRDs →' : 'Go to context →'}</button></div></div></div>`;
  }
  return `<div class="body"><div class="transcript">${msgs}${tail}</div></div>${dock}`;
}

function renderVerdict() {
  const c = S.verdictChoice;
  return `<div class="verdict">
    <h3>Your call</h3>
    <p class="hint">The panel advises. You decide. Commit distills the meeting into context files${S.idea.context.length ? ', updating the current ones with what changed' : ''}. Kill keeps it here with your reasoning.</p>
    <div class="choices">
      <button class="choice commit ${c === 'commit' ? 'sel' : ''}" data-choice="commit"><b>Commit</b><span>The shape is right. Distill the mental model.</span></button>
      <button class="choice kill ${c === 'kill' ? 'sel' : ''}" data-choice="kill"><b>Kill</b><span>Not worth building. Keep the why.</span></button>
    </div>
    ${c ? `<textarea class="field" id="verdict-note" data-keep="vnote" rows="2" placeholder="${c === 'commit' ? 'Why this is worth building (one line)' : 'Why it dies (one line), for future you'}"></textarea>` : ''}
    ${c === 'commit' ? `<textarea class="field" id="verdict-guidance" data-keep="vguide" rows="2" placeholder="Optional: anything the context should emphasise or assume"></textarea>` : ''}
    <div class="row">
      <button class="btn ghost sm" id="close-verdict">Keep talking</button>
      ${c ? `<button class="btn ${c === 'commit' ? 'good' : 'bad'} sm" id="submit-verdict">${c === 'commit' ? 'Commit & distill' : 'Kill it'}</button>` : ''}
    </div>
  </div>`;
}

// Turn "**CEO:** …" paragraphs into labelled voices, and the sharpest question into a callout
function decoratePanel(root) {
  for (const box of root.querySelectorAll('.msg-panel')) {
    let last = null;
    for (const p of box.children) {
      const s = p.tagName === 'P' ? p.firstElementChild : null;
      const label = s && p.firstChild === s && s.tagName === 'STRONG' ? s.textContent.trim() : '';
      const m = label.match(/^(CEO|PM|Architect)\s*:?$/i);
      if (m) {
        const who = m[1].toLowerCase();
        s.remove();
        p.classList.add('voice', `voice-${who}`);
        p.insertAdjacentHTML('afterbegin', `<span class="chip">${who === 'ceo' ? 'CEO' : who === 'pm' ? 'PM' : 'Architect'}</span>`);
        last = who;
      } else if (/^Sharpest question/i.test(label)) {
        p.classList.add('sharpest');
        last = null;
      } else if (last && p.tagName === 'P') {
        p.classList.add('voice', `voice-${last}`, 'cont');
      } else {
        last = null;
      }
    }
  }
}

// ---------- Context ----------

// Highlight blocks that are new or changed since you last reviewed the file. Compares rendered blocks
// (paragraphs, list items, table rows, headings, code), so a highlight is always a whole readable unit.
const BLOCKS = 'p, li, tr, pre, h1, h2, h3, h4';
function blockText(el) {
  const c = el.cloneNode(true);
  c.querySelectorAll('ul, ol').forEach((x) => x.remove()); // a list item is its own text, not its sub-list
  return c.textContent.replace(/\s+/g, ' ').trim();
}
function markChanges(article, reviewedMd) {
  const before = document.createElement('div');
  before.innerHTML = md(reviewedMd);
  const old = new Map();
  for (const el of before.querySelectorAll(BLOCKS)) old.set(blockText(el), (old.get(blockText(el)) || 0) + 1);
  let changed = 0;
  for (const el of article.querySelectorAll(BLOCKS)) {
    if (el.closest('pre') && el.tagName !== 'PRE') continue;
    const t = blockText(el);
    if (!t) continue;
    if (old.get(t)) old.set(t, old.get(t) - 1);
    else (el.classList.add('chg'), changed++);
  }
  // Old blocks left unmatched were either edited (they show up as changed) or truly removed
  const unmatched = [...old.values()].reduce((a, n) => a + n, 0);
  return { changed, removed: Math.max(0, unmatched - changed) };
}

function stepState(i, id) {
  if (i.stage === 'distilled') return 'done';
  if (!i.distill) return 'todo';
  const at = stepIndex(i.distill.step);
  const n = stepIndex(id);
  if (n < at) return 'done';
  if (n > at) return 'todo';
  if (i.distill.status === 'review') return 'review';
  return i.working === 'distill' ? 'working' : 'queued';
}

function groupState(i, g) {
  const states = g.steps.map((id) => stepState(i, id));
  const live = states.find((x) => x !== 'done' && x !== 'todo');
  if (live) return live;
  return states.every((x) => x === 'done') ? 'done' : states.includes('done') ? 'review' : 'todo';
}

const STATE_ICON = {
  done: '<span class="st ok">✓</span>',
  review: '<span class="st rev"></span>',
  working: '<span class="st wip"></span>',
  queued: '<span class="st q"></span>',
  todo: '<span class="st"></span>',
  stale: '<span class="st stale" title="From an earlier pass. It is updated when its stage comes up."></span>',
};

function renderGate(i) {
  const step = STEPS[stepIndex(i.distill?.step)];
  if (!step || i.stage !== 'distilling') return '';
  const n = stepIndex(step.id);
  const state = stepState(i, step.id);
  if (state === 'review') {
    const next = STEPS[n + 1];
    const pend = i.refinements.some((r) => r.status === 'pending');
    return `<div class="gate review">
      <div class="gate-top"><b>${esc(step.what)} are ready for your review</b></div>
      <p>${esc(step.gate)}</p>
      ${i.distill.note ? `<div class="gate-note md">${DOMPurify.sanitize(marked.parse(i.distill.note, { gfm: true, breaks: true }))}</div>` : ''}
      <div class="gate-row">
        <span class="gate-hint">Select any text to ask for a change.</span>
        <button class="btn ghost sm" id="redo-step">Redo…</button>
        <button class="btn good sm" id="approve-step" ${pend ? 'disabled title="Wait for your change requests to land"' : ''}>${next ? `Approve → ${esc(next.what.toLowerCase())}` : 'Approve'}</button>
      </div>
    </div>`;
  }
  return `<div class="gate">
    <div class="gate-top">
      ${state === 'working' ? `<span class="thinking"><span class="bubbles"><i></i><i></i><i></i></span></span><b>Writing ${esc(step.what.toLowerCase())}…</b>` : `<b>${esc(step.what)}: queued</b>`}</div>
    ${i.distill.guidance ? `<p>Your direction: ${esc(i.distill.guidance)}</p>` : ''}
    ${state === 'queued' ? workerHint() : ''}
  </div>`;
}

// Which context file is open: the one in the URL, else the one being written or reviewed, else the first
function openFile(i) {
  const have = new Set(i.context.map((f) => f.name));
  if (S.route.file && have.has(S.route.file)) return S.route.file;
  const current = STEPS[stepIndex(i.distill?.step)];
  if (i.stage === 'distilling' && current) {
    const mine = current.files.filter((f) => have.has(f));
    const f = i.working === 'distill' ? mine.at(-1) : mine[0];
    if (f) return f;
  }
  return CONTEXT_FILES.find((n) => have.has(n)) || i.context[0]?.name || null;
}

// The context files on the left of the document, with their progress. Files are written in order, so
// while a group is being written, what's on disk is done, the first missing file is being written, and the
// rest are next. A thin line after the first group marks your approval.
function renderFileList(i, open) {
  const has = (f) => i.context.some((x) => x.name === f);
  const writing = (step) => {
    const missing = step.files.filter((f) => !has(f));
    if (!missing.length) return Object.fromEntries(step.files.map((f) => [f, 'working']));
    return Object.fromEntries(step.files.map((f) => [f, has(f) ? 'done' : f === missing[0] ? 'working' : 'todo']));
  };
  const row = (f, live) => {
    let st = live?.[f] || fileState(i, f);
    const pend = i.refinements.filter((r) => r.file === f && r.status === 'pending').length;
    if (pend) st = 'working';
    const icon = STATE_ICON[st === 'written' ? 'done' : st] || STATE_ICON.todo;
    const right = pend ? `<span class="pend">${pend} pending</span>` : i.changes?.[f] != null ? '<span class="chg-dot" title="Changed since you last reviewed it"></span>' : '';
    return `<button class="ctx-file ${f === open ? 'active' : ''}" ${has(f) ? `data-file="${esc(f)}"` : 'disabled'}>${icon}${esc(FILE_LABEL[f] || f)}${right}</button>`;
  };
  const live = (step) => (i.working === 'distill' && stepState(i, step.id) === 'working' ? writing(step) : null);
  return STEPS.map((step) => step.files.map((f) => row(f, live(step))).join('')).join('<div class="ctx-sep" title="Your approval"></div>');
}

function renderContext() {
  const i = S.idea;
  const have = new Map(i.context.map((f) => [f.name, f]));
  const file = openFile(i);
  const gate = renderGate(i);
  let doc;
  if (!file) {
    doc = i.stage === 'distilled'
      ? `<div class="ctx-doc-inner"><div class="distill-wait"><h2>No current context</h2><p>The context folder is empty. Distill it again from the meeting.</p>${canRedistill(i) ? '<button class="btn primary" id="redistill">Distill from the meeting</button>' : ''}</div></div>`
      : `<div class="ctx-doc-inner">${gate}<div class="distill-wait"><h2>Nothing written yet</h2><p>The brief appears here first: product and business, the must-read. You review each step before the next one starts.</p></div></div>`;
  } else {
    // Only what needs attention: changes still being made, and questions the worker asked back
    const pending = i.refinements.filter((r) => r.file === file && r.status === 'pending');
    const asked = i.refinements.filter((r) => r.file === file && r.status === 'asked');
    const quote = (r) => esc((r.quote || r.text).replace(/\s+/g, ' ').slice(0, 80));
    const notes = [
      ...pending.map((r) => `<div class="note-line"><span class="dot busy"></span>${i.working === 'refine' ? 'Changing' : 'Queued'} · <span class="q">${quote(r)}</span></div>`),
      ...asked.map((r) => `<div class="note-line ask"><b>The worker asks:</b> ${esc(r.reply)}<span class="q">on “${quote(r)}”</span><button class="btn ghost sm" data-dismiss="${esc(r.id)}" title="Dismiss">×</button></div>`),
    ].join('');
    const next = i.stage === 'distilled' && !i.prd ? `<div class="note-line next-line">Context approved. Next: cut the work into PRDs for your executor.<button class="btn primary sm" data-tab="prds">Plan PRDs →</button></div>` : '';
    doc = `<div class="ctx-doc-inner">
      ${gate}${next}
      <div class="ctx-tools">${canRefine(i) ? '<button class="btn sm" id="ask-file">Ask for a change</button>' : ''}</div>
      ${notes ? `<div class="notes">${notes}</div>` : ''}
      <div id="changes-line"></div>
      <article class="md" id="doc" data-file="${esc(file)}">${md(have.get(file).content)}</article>
    </div>`;
  }
  return `<div class="body" style="overflow:hidden"><div class="ctx"><div class="ctx-files">${renderFileList(i, file)}</div><div class="ctx-doc">${doc}</div></div></div>`;
}

// ---------- PRDs ----------

// The prompt you paste into your executor: the PRD is the unit of work, the context is the why and the shape
function handoffPrompt(f) {
  const { num, title } = prdLabel(f);
  return `Implement PRD ${num ? `${num}: ` : ''}${title}, as one pull request.

The PRD is .signals/${f.name}. Deliver its Outcome and meet every Acceptance check, within its Scope, Constraints and Decisions.
Read .signals/context/ first (product.md, model.md, vocab.md, architecture.md) for the why and the shape, and use the terms in vocab.md exactly.
Make local decisions yourself. If the PRD or the context looks wrong, don't work around it: say so in the PR description.`;
}

// ---------- Executions: a PRD built by a background Claude Code session on this checkout ----------

const isExecOpen = (e) => Boolean(e) && !['complete', 'stopped'].includes(e.status);
const openExecution = (i) => Object.entries(i.executions || {}).find(([, e]) => isExecOpen(e))?.[0] || null;

function renderExecution(file, e) {
  if (!e) return '';
  const attach = `claude attach ${e.session}`;
  const copy = `<button class="btn ghost sm" data-copy="${esc(attach)}" title="Copy, then run it in a terminal to steer the session">Copy</button>`;
  const stop = '<button class="btn ghost sm danger" data-exec="stop" title="End the session. Its changes stay in your working tree.">Stop</button>';
  const done = '<button class="btn good sm" data-exec="complete" title="You tested and committed it: the executor’s summary is added to the PRD, and the next PRD can start">Mark complete</button>';
  const line = (cls, body, btns) => `<div class="notes"><div class="note-line exec ${cls}" data-file="${esc(file)}">${body}<span class="exec-btns">${btns}</span></div></div>`;
  const cmd = `<code>${esc(attach)}</code>`;
  // The Claude session id outlives the background agent: resume the run from it once the agent is gone
  const resume = e.session_id ? `claude --resume ${e.session_id}` : '';
  const resumeCmd = resume ? ` <span class="exec-session" title="Claude session id">Session <code>${esc(resume)}</code></span>` : '';
  const resumeCopy = resume ? `<button class="btn ghost sm" data-copy="${esc(resume)}" title="Copy, then run it in this repo to reopen the session">Copy</button>` : '';
  switch (e.status) {
    case 'building':
      return line('', `<span class="dot busy"></span><span class="grow">Building in the background · ${cmd}</span>`, copy + stop);
    case 'blocked':
      return line('ask', `<span class="grow"><b>The session is waiting on you.</b> Answer it with ${cmd}</span>`, copy + stop);
    case 'built':
      return line('ask', `<span class="grow"><b>Built.</b> Test it, steer it with ${cmd}, commit, then mark it complete.</span>`, copy + stop + done);
    case 'gone':
      return line('', `<span class="grow">The session is gone. Its changes are in your working tree.${resumeCmd}</span>`, resumeCopy + done + stop);
    case 'complete':
      return line('', `<span class="grow">Complete.${e.summarized ? ' The executor’s summary is under <b>Execution summary</b> at the end.' : e.summarized === false ? ' No executor summary was found to add.' : ''}${resumeCmd}</span>`, resumeCopy);
    case 'stopped':
      return line('', `<span class="grow">Stopped. Its changes stay in your working tree for you to keep or discard. Finished it yourself? Mark it complete.${resumeCmd}</span>`, resumeCopy + done);
  }
  return '';
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
}

const canChangePrds = (i) => i.prd?.status === 'done' && !i.working && i.prds.length > 0;
// An update rewrites PRDs you have seen (a first pass writes them from nothing)
const updatingPrds = (i) => i.prd?.status === 'queued' && i.prd.basis != null;
const isNewPrd = (i, name) => i.prd?.status === 'review' && (i.prd.added || []).includes(name);

function openPrd(i) {
  if (S.route.file === 'change' && canChangePrds(i)) return 'change';
  const have = new Set(i.prds.map((f) => f.name));
  const want = S.route.file && `prds/${S.route.file}`;
  if (want && have.has(want)) return want;
  if (i.working === 'prd' && !updatingPrds(i)) return i.prds.at(-1)?.name || null; // follow the one being written
  // After an update: what moved first, new PRDs before changed ones
  if (i.prd?.status === 'review' && i.prd.updated) {
    const moved = i.prds.find((f) => isNewPrd(i, f.name)) || i.prds.find((f) => i.changes?.[f.name] != null);
    if (moved) return moved.name;
  }
  return i.prds[0]?.name || null;
}

function renderPrdList(i, open) {
  const p = i.prd || {};
  const writing = i.working === 'prd';
  const updating = updatingPrds(i);
  const rows = i.prds.map((f) => {
    const { num, title } = prdLabel(f);
    const pend = i.refinements.filter((r) => r.file === f.name && r.status === 'pending').length;
    const handed = i.handoffs?.[f.name];
    const ex = i.executions?.[f.name]?.status;
    const fresh = isNewPrd(i, f.name);
    let st = 'done';
    if (pend) st = 'working';
    else if (ex === 'building' || ex === 'blocked') st = 'working';
    else if (ex === 'built' || ex === 'gone') st = 'review';
    else if (ex === 'complete') st = 'done';
    else if (handed) st = 'handed';
    else if (p.status === 'review' && (!p.updated || fresh || i.changes?.[f.name] != null)) st = 'review'; // after an update, only what moved
    else if (p.status === 'queued' && !updating) st = writing ? (f.name === i.prds.at(-1)?.name ? 'working' : 'done') : 'queued';
    const icon = st === 'handed' ? '<span class="st handed" title="Handed off">↗</span>' : STATE_ICON[st];
    const right = pend ? `<span class="pend">${pend} pending</span>` : fresh ? '<span class="pend">new</span>' : i.changes?.[f.name] != null ? '<span class="chg-dot" title="Changed since you last reviewed it"></span>' : '';
    return `<button class="ctx-file ${f.name === open ? 'active' : ''}" data-prd="${esc(f.name.slice(5))}" title="${esc(f.name)}">${icon}${num ? `<span class="prd-num">${esc(num)}</span>` : ''}<span class="prd-title">${esc(title)}</span>${right}</button>`;
  });
  if (writing) rows.push(`<button class="ctx-file" disabled>${STATE_ICON.working}${updating ? 'Updating…' : 'Writing…'}</button>`);
  if (!rows.length) return '<div class="ctx-empty">No PRDs yet</div>';
  const off = canChangePrds(i) ? '' : `disabled title="${p.status === 'review' ? 'Approve the PRDs under review first' : 'Wait for the worker'}"`;
  return `${rows.join('')}<div class="ctx-sep"></div>
    <button class="ctx-file new-prd ${open === 'change' ? 'active' : ''}" data-compose="change" ${off}><span class="st plus">+</span>Add or change PRDs</button>`;
}

function renderPrdGate(i) {
  const p = i.prd;
  if (!p) return '';
  const note = p.note ? `<div class="gate-note md">${DOMPurify.sanitize(marked.parse(p.note, { gfm: true, breaks: true }))}</div>` : '';
  const approve = `<button class="btn good sm" id="approve-prds" ${prdsPending(i) || i.working ? 'disabled title="Wait for your change requests to land"' : ''}>Approve → ready to hand off</button>`;
  if (p.status === 'review' && p.updated) {
    const added = (p.added || []).filter((n) => i.prds.some((f) => f.name === n)).length;
    const changed = i.prds.filter((f) => !isNewPrd(i, f.name) && i.changes?.[f.name] != null).length;
    const what = [added && `${added} new`, changed && `${changed} changed`].filter(Boolean).join(' · ') || 'nothing changed';
    return `<div class="gate review">
      <div class="gate-top"><b>PRDs updated: ${what}</b></div>
      <p>Review what moved (marked in the list); the rest is as you approved it.</p>
      ${note}
      <div class="gate-row">
        <span class="gate-hint">Select any text to ask for a change.</span>
        <button class="btn ghost sm" id="redo-prds">Redo…</button>
        ${approve}
      </div>
    </div>`;
  }
  if (p.status === 'review') {
    return `<div class="gate review">
      <div class="gate-top"><b>${i.prds.length} PRD${i.prds.length === 1 ? ' is' : 's are'} ready for your review</b></div>
      <p>The work, cut into PRs in build order. Check the breakdown first (is 01 a thin slice of the whole loop?), then each PRD's acceptance checks.</p>
      ${note}
      <div class="gate-row">
        <span class="gate-hint">Select any text to ask for a change.</span>
        <button class="btn ghost sm" id="redo-prds">Redo…</button>
        ${approve}
      </div>
    </div>`;
  }
  if (p.status === 'queued') {
    const writing = i.working === 'prd';
    const verb = updatingPrds(i) ? 'Updating' : 'Writing';
    return `<div class="gate">
      <div class="gate-top">${writing ? `<span class="thinking"><span class="bubbles"><i></i><i></i><i></i></span></span><b>${verb} the PRDs…</b>` : '<b>PRDs: queued</b>'}</div>
      ${p.guidance ? `<p class="np-quote">${esc(p.guidance)}</p>` : ''}
      ${writing ? '' : workerHint()}
    </div>`;
  }
  if (i.prd_stale) {
    return `<div class="note-line chg-line"><span class="chg-dot"></span>The context changed since these PRDs were written.
      <button class="btn sm" id="update-prds" ${i.working || prdsPending(i) ? 'disabled' : ''}>Update the PRDs</button></div>`;
  }
  return '';
}

// One prompt for any change to the set: add a PRD, split, merge, reorder or rewrite
function renderComposer(i) {
  const c = S.changePrds;
  const picked = new Set(c.focus);
  const chips = i.prds
    .map((f) => {
      const { num, title } = prdLabel(f);
      const handed = i.handoffs?.[f.name];
      const on = picked.has(f.name);
      return `<button class="dep ${on ? 'on' : ''}" data-focus="${esc(f.name)}" aria-pressed="${on}" ${handed ? 'disabled title="Handed off: it stays as it is"' : ''}><span class="prd-num">${esc(num)}</span>${esc(title)}${handed ? ' ↗' : ''}</button>`;
    })
    .join('');
  return `<div class="ctx-doc-inner"><div class="new-prd-form">
    <div class="np-head"><span class="np-num np-icon">✎</span><div><h2>Add or change PRDs</h2><p>Say what you want: a new PRD, or a split, merge, reorder or rewrite. The worker edits the set, and you review only what moved. Handed-off PRDs stay as they are.</p></div></div>
    <textarea class="field" id="change-prds-text" data-keep="changeprds" rows="5" placeholder="e.g. “Add a PRD for streaks, after the Reveal”, “split 02 into the Reveal and the Score”, “merge 04 into 02”">${esc(c.text)}</textarea>
    <div class="np-deps"><span class="np-label">About <small>optional: the PRDs this touches or builds on</small></span><div class="dep-list">${chips}</div></div>
    <div class="np-row">
      <span class="gate-hint">⌘↵ to send · Esc to cancel</span>
      <button class="btn ghost sm" id="cancel-new-prd">Cancel</button>
      <button class="btn primary" id="submit-change-prds" ${c.text.trim() ? '' : 'disabled'}>Update the PRDs</button>
    </div>
  </div></div>`;
}

function renderPrds() {
  const i = S.idea;
  const file = openPrd(i);
  const gate = renderPrdGate(i);
  let doc;
  if (!i.prd && !i.prds.length) {
    doc = i.stage === 'distilled'
      ? `<div class="ctx-doc-inner"><div class="distill-wait plan">
          <h2>Cut the work into PRDs</h2>
          <p>Each PRD is one unit of work: a PR's worth, in build order, with its constraints, decisions and acceptance checks. The first is a thin slice of the whole loop. You review them, then hand each one to your executor.</p>
          <textarea class="field" id="prd-guidance" data-keep="prdguide" rows="2" placeholder="Optional: how to cut it (e.g. “web only first”, “keep 01 tiny”)"></textarea>
          <button class="btn primary" id="plan-prds">Write the PRDs</button>
        </div></div>`
      : `<div class="ctx-doc-inner"><div class="distill-wait"><h2>Context first</h2><p>PRDs are cut from the approved context. Finish the distill, then plan the work here.</p></div></div>`;
  } else if (file === 'change') {
    doc = renderComposer(i);
  } else if (!file) {
    doc = `<div class="ctx-doc-inner">${gate}<div class="distill-wait"><h2>Nothing written yet</h2><p>The PRDs appear here one by one, in build order.</p></div></div>`;
  } else {
    const f = i.prds.find((x) => x.name === file);
    const pending = i.refinements.filter((r) => r.file === file && r.status === 'pending');
    const asked = i.refinements.filter((r) => r.file === file && r.status === 'asked');
    const quote = (r) => esc((r.quote || r.text).replace(/\s+/g, ' ').slice(0, 80));
    const notes = [
      ...pending.map((r) => `<div class="note-line"><span class="dot busy"></span>${i.working === 'refine' ? 'Changing' : 'Queued'} · <span class="q">${quote(r)}</span></div>`),
      ...asked.map((r) => `<div class="note-line ask"><b>The worker asks:</b> ${esc(r.reply)}<span class="q">on “${quote(r)}”</span><button class="btn ghost sm" data-dismiss="${esc(r.id)}" title="Dismiss">×</button></div>`),
    ].join('');
    const ready = i.prd?.status === 'done';
    const ex = i.executions?.[file];
    const open = openExecution(i);
    const canExec = ready && (!ex || ex.status === 'stopped');
    const execOff = open ? `disabled title="${esc(prdLabel(i.prds.find((x) => x.name === open) || { name: open, content: '' }).title)} is still open: mark it complete or stop it first"` : 'title="Build it now in a background Claude Code session, right on this checkout"';
    const tools = [
      canRefineDoc(i, file) && !i.working ? `<button class="btn ghost sm danger" data-remove-prd="${esc(file)}" title="Delete this PRD">Remove</button>` : '',
      canRefineDoc(i, file) ? '<button class="btn sm" id="ask-file">Ask for a change</button>' : '',
      ready && !isExecOpen(ex) && ex?.status !== 'complete' ? `<button class="btn sm" data-handoff="${esc(file)}" title="Copy a prompt for your own coding agent and mark this PRD handed off">Copy prompt</button>` : '',
      canExec ? `<button class="btn primary sm" data-execute="${esc(file)}" ${execOff}>${ex ? 'Execute again' : 'Execute'}</button>` : '',
    ].join('');
    doc = `<div class="ctx-doc-inner">
      ${gate}
      <div class="ctx-tools">${tools}</div>
      ${renderExecution(file, ex)}
      ${notes ? `<div class="notes">${notes}</div>` : ''}
      <div id="changes-line"></div>
      <article class="md" id="doc" data-file="${esc(file)}">${md(f.content)}</article>
    </div>`;
  }
  return `<div class="body" style="overflow:hidden"><div class="ctx"><div class="ctx-files">${renderPrdList(i, file)}</div><div class="ctx-doc">${doc}</div></div></div>`;
}

// ---------- Ask for a change (on a selection or the whole file) ----------

function closeAsk() {
  document.querySelectorAll('.ask-btn, .ask-pop').forEach((e) => e.remove());
}

function openAsk(quote, rect) {
  closeAsk();
  const pop = document.createElement('div');
  pop.className = 'ask-pop';
  pop.innerHTML = `${quote ? `<div class="quote">${esc(quote)}</div>` : '<div class="quote">Whole file</div>'}
    <textarea class="field" placeholder="What should change? e.g. “Rename this to Signal”, “too vague, make it a rule”"></textarea>
    <div class="row"><button class="btn ghost sm" data-act="cancel">Cancel</button><button class="btn primary sm" data-act="send">Ask ⌘↵</button></div>`;
  document.body.append(pop);
  const x = Math.min(Math.max(12, rect.left), innerWidth - 372);
  const y = rect.bottom + 8 + 200 > innerHeight ? rect.top - 8 - pop.offsetHeight : rect.bottom + 8;
  Object.assign(pop.style, { left: `${x}px`, top: `${Math.max(12, y)}px` });
  const ta = $('textarea', pop);
  ta.focus();
  const send = async () => {
    const text = ta.value.trim();
    if (!text) return;
    try {
      await wsApi('POST', '/api/ideas/refine', { id: S.idea.id, file: $('#doc').dataset.file, quote, text });
      closeAsk();
      window.getSelection()?.removeAllRanges();
      toast('Change requested');
    } catch (err) {
      fail(err);
    }
  };
  pop.addEventListener('click', (e) => {
    const act = e.target.dataset.act;
    if (act === 'cancel') closeAsk();
    if (act === 'send') send();
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send();
    if (e.key === 'Escape') closeAsk();
  });
}

document.addEventListener('mouseup', (e) => {
  if (e.target.closest('.ask-pop, .ask-btn')) return;
  setTimeout(() => {
    const sel = window.getSelection();
    const doc = $('#doc');
    if (!doc || !S.idea || !canRefineDoc(S.idea, doc.dataset.file) || !sel || sel.isCollapsed || !doc.contains(sel.anchorNode)) {
      if (!$('.ask-pop')) closeAsk();
      return;
    }
    const quote = sel.toString().trim();
    if (!quote) return;
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    closeAsk();
    const b = document.createElement('button');
    b.className = 'btn primary sm ask-btn';
    b.textContent = 'Ask for a change';
    Object.assign(b.style, { left: `${rect.left}px`, top: `${rect.bottom + 6}px` });
    b.onclick = () => openAsk(quote.slice(0, 600), rect);
    document.body.append(b);
  }, 0);
});

// ---------- Actions ----------

function autosize(ta) {
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
}

async function startMeeting() {
  const text = $('#hunch').value.trim();
  if (!text) return;
  try {
    await wsApi('POST', '/api/ideas', { text });
    S.drafts.__new = '';
    await loadWorkspaces();
    go({ tab: 'meeting', file: null });
  } catch (err) {
    fail(err);
  }
}

async function send() {
  const ta = $('#composer');
  const text = ta.value.trim();
  if (!text) return;
  try {
    await wsApi('POST', '/api/ideas/message', { id: S.idea.id, text });
    S.drafts[S.idea.id] = '';
    await refreshIdea();
  } catch (err) {
    fail(err);
  }
}

async function submitVerdict() {
  const note = $('#verdict-note')?.value.trim();
  const guidance = $('#verdict-guidance')?.value.trim();
  try {
    await wsApi('POST', '/api/ideas/verdict', { id: S.idea.id, decision: S.verdictChoice, note, guidance });
    const committed = S.verdictChoice === 'commit';
    S.verdictOpen = false;
    S.verdictChoice = null;
    await refreshIdea();
    if (committed) go({ tab: 'context', file: null });
  } catch (err) {
    fail(err);
  }
}

async function submitChangePrds() {
  const text = S.changePrds.text.trim();
  if (!text) return;
  const focus = S.changePrds.focus.map((n) => n.slice(5));
  try {
    await wsApi('POST', '/api/prds/plan', { id: S.idea.id, guidance: focus.length ? `${text}\n\nAbout: ${focus.join(', ')}` : text });
    S.changePrds = { text: '', focus: [] };
    toast('Sent. The worker is updating the PRDs.');
    go({ tab: 'prds', file: null });
  } catch (err) {
    fail(err);
  }
}

async function refreshIdea() {
  const was = new Map((S.idea?.refinements || []).map((r) => [r.id, r.status]));
  const sameIdea = S.idea?.id;
  await Promise.all([loadWorkspaces(), loadIdeas()]);
  await loadIdea();
  // A change that just landed: say so once, instead of keeping a list of finished requests
  if (S.idea && S.idea.id === sameIdea) {
    for (const r of S.idea.refinements) {
      if (was.get(r.id) !== 'pending' || r.status === 'pending') continue;
      toast(r.status === 'asked' ? `The worker has a question about ${r.file}` : `✓ ${r.file}: ${r.reply}`, 6000);
    }
  }
  renderMain();
}

// A small menu of workspace actions, anchored to the ⋯ button
function closeMenu() {
  document.querySelector('.menu')?.remove();
  document.querySelectorAll('.more[aria-expanded="true"]').forEach((b) => b.setAttribute('aria-expanded', 'false'));
}
function openMenu(btn, wsId) {
  closeMenu();
  const w = S.workspaces.find((x) => x.id === wsId);
  const m = document.createElement('div');
  m.className = 'menu';
  m.setAttribute('role', 'menu');
  m.innerHTML = `<button role="menuitem" class="menu-item danger" data-unregister="${esc(w.id)}">Remove from Signals</button>`;
  document.body.append(m);
  btn.setAttribute('aria-expanded', 'true');
  const r = btn.getBoundingClientRect();
  Object.assign(m.style, { top: `${r.bottom + 4}px`, left: `${Math.min(r.left, innerWidth - m.offsetWidth - 8)}px` });
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t || !t.closest('.menu')) closeMenu();
  if (!t) return;
  try {
    if (t.dataset.menu) return openMenu(t, t.dataset.menu);
    if (t.dataset.repo) {
      const w = S.workspaces.find((x) => x.id === t.dataset.repo);
      return go({ ws: w.id, tab: 'meeting', file: null });
    }
    if (t.dataset.unregister) {
      closeMenu();
      const w = S.workspaces.find((x) => x.id === t.dataset.unregister);
      if (!w || !confirm(`Remove “${w.name}” from Signals?\n${w.repo}\n\nIts .signals/ folder stays on disk. Add it back with: signals serve`)) return;
      await api('POST', '/api/workspaces/remove', { id: w.id });
      await loadWorkspaces();
      toast(`Removed ${w.name} from Signals`);
      S.ws = null;
      return goIndex();
    }
    if (t.dataset.tab && !t.disabled) return go({ tab: t.dataset.tab, file: null });
    if (t.dataset.file) return go({ tab: 'context', file: t.dataset.file });
    if (t.dataset.prd) return go({ tab: 'prds', file: t.dataset.prd });
    if (t.dataset.compose) return go({ tab: 'prds', file: 'change' });
    if (t.dataset.focus) {
      const d = new Set(S.changePrds.focus);
      d.has(t.dataset.focus) ? d.delete(t.dataset.focus) : d.add(t.dataset.focus);
      S.changePrds.focus = [...d];
      return renderMain();
    }
    if (t.dataset.execute) {
      const f = S.idea.prds.find((x) => x.name === t.dataset.execute);
      const { num, title } = prdLabel(f);
      if (!confirm(`Execute PRD ${num ? `${num}: ` : ''}${title}?\n\nA background Claude Code session builds it right in this repo's working tree, on the current branch. You test it, commit, and mark it complete.`)) return;
      t.disabled = true;
      try {
        await wsApi('POST', '/api/prds/execute', { id: S.idea.id, file: f.name });
        toast('Building in the background.');
      } catch (err) {
        t.disabled = false;
        throw err;
      }
      return refreshIdea();
    }
    if (t.dataset.exec) {
      const file = t.closest('[data-file]').dataset.file;
      if (t.dataset.exec === 'stop' && !confirm('Stop this session? Its changes stay in your working tree.')) return;
      await wsApi('POST', '/api/prds/execution', { id: S.idea.id, file, action: t.dataset.exec });
      return refreshIdea();
    }
    if (t.dataset.copy) {
      await copyText(t.dataset.copy);
      return toast('Copied. Run it in a terminal in this repo.');
    }
    if (t.dataset.handoff) {
      const f = S.idea.prds.find((x) => x.name === t.dataset.handoff);
      await copyText(handoffPrompt(f));
      if (!S.idea.handoffs?.[f.name]) await wsApi('POST', '/api/prds/handoff', { id: S.idea.id, file: f.name });
      toast('Handoff prompt copied. Paste it into your coding agent in this repo.', 4000);
      return refreshIdea();
    }
    if (t.dataset.removePrd) {
      const f = S.idea.prds.find((x) => x.name === t.dataset.removePrd);
      const { num, title } = prdLabel(f);
      const warn = S.idea.handoffs?.[f.name] ? '\n\nIt has been handed off: an executor may be building it.' : '';
      if (!confirm(`Remove PRD ${num ? `${num}: ` : ''}${title}?\nThe file is deleted; the other PRDs keep their numbers.${warn}`)) return;
      await wsApi('POST', '/api/prds/remove', { id: S.idea.id, file: f.name });
      S.route.file = null;
      toast(`Removed ${f.name.slice(5)}`);
      return refreshIdea();
    }
    if (t.dataset.reviewed) {
      await wsApi('POST', '/api/ideas/reviewed', { id: S.idea.id, file: t.dataset.reviewed });
      return refreshIdea();
    }
    if (t.dataset.dismiss) {
      await wsApi('POST', '/api/ideas/refine/dismiss', { id: S.idea.id, refinement: t.dataset.dismiss });
      return refreshIdea();
    }
    if (t.dataset.choice) {
      S.verdictChoice = t.dataset.choice;
      renderMain();
      $('#verdict-note')?.focus();
      return;
    }
    switch (t.id) {
      case 'start':
        return startMeeting();
      case 'send':
        return send();
      case 'open-verdict':
        S.verdictOpen = true;
        return renderMain();
      case 'close-verdict':
        S.verdictOpen = false;
        S.verdictChoice = null;
        return renderMain();
      case 'submit-verdict':
        return submitVerdict();
      case 'reopen':
        if (S.idea.stage !== 'killed' && !confirm('Reopen the meeting?\nThe current context stays as it is until you commit again, which updates the context with what the new turns changed.')) return;
        await wsApi('POST', '/api/ideas/reopen', { id: S.idea.id });
        await refreshIdea();
        return go({ tab: 'meeting' });
      case 'redistill': {
        // Only offered when a distilled idea's context folder is empty: write it again from the meeting
        await wsApi('POST', '/api/ideas/redo', { id: S.idea.id, step: 'brief' });
        await refreshIdea();
        return go({ tab: 'context', file: null });
      }
      case 'redo-step': {
        const step = STEPS[stepIndex(S.idea.distill.step)];
        const guidance = prompt(`Redo ${step.what.toLowerCase()}. What should change?`);
        if (guidance === null) return;
        await wsApi('POST', '/api/ideas/redo', { id: S.idea.id, guidance });
        return refreshIdea();
      }
      case 'approve-step': {
        const was = S.idea.distill.step;
        await wsApi('POST', '/api/ideas/approve', { id: S.idea.id });
        const next = STEPS[stepIndex(was) + 1];
        toast(next ? `Approved. Writing ${next.what.toLowerCase()}…` : 'Distilled. Next: cut the work into PRDs.');
        S.route.file = null;
        return refreshIdea();
      }
      case 'ask-file':
        return openAsk(null, t.getBoundingClientRect());
      case 'plan-prds':
        await wsApi('POST', '/api/prds/plan', { id: S.idea.id, guidance: $('#prd-guidance')?.value.trim() });
        S.route.file = null;
        return refreshIdea();
      case 'cancel-new-prd':
        return go({ tab: 'prds', file: null });
      case 'submit-change-prds':
        return submitChangePrds();
      case 'update-prds':
        await wsApi('POST', '/api/prds/plan', { id: S.idea.id, guidance: null });
        return refreshIdea();
      case 'redo-prds': {
        const guidance = prompt('Redo the PRDs. What should change?');
        if (guidance === null) return;
        await wsApi('POST', '/api/prds/plan', { id: S.idea.id, guidance });
        return refreshIdea();
      }
      case 'approve-prds':
        await wsApi('POST', '/api/prds/approve', { id: S.idea.id });
        toast('Approved. Hand each PRD to your executor, in order.');
        return refreshIdea();
      case 'delete-idea':
        if (!confirm(`Delete “${S.idea.title}” and its context files? This can't be undone.`)) return;
        await wsApi('POST', '/api/ideas/delete', { id: S.idea.id });
        await loadWorkspaces();
        return go({ tab: 'meeting', file: null });
    }
  } catch (err) {
    fail(err);
  }
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'composer') {
    S.drafts[S.idea.id] = e.target.value;
    autosize(e.target);
  }
  if (e.target.id === 'hunch') S.drafts.__new = e.target.value;
  if (e.target.id === 'change-prds-text') {
    S.changePrds.text = e.target.value;
    const b = $('#submit-change-prds');
    if (b) b.disabled = !e.target.value.trim();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.target.id === 'composer' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!$('#send').disabled) send();
  }
  if (e.target.id === 'hunch' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) startMeeting();
  if (e.target.id === 'change-prds-text' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitChangePrds();
  if (e.target.id === 'change-prds-text' && e.key === 'Escape') go({ tab: 'prds', file: null });
  if (e.key === 'Escape') (closeAsk(), closeMenu());
});


// ---------- Live updates ----------

function listen() {
  const es = new EventSource('/api/events');
  let pending = null;
  const schedule = (fn) => {
    clearTimeout(pending);
    pending = setTimeout(fn, 60);
  };
  es.addEventListener('presence', (e) => {
    const p = JSON.parse(e.data);
    S.presence[p.workspace] = p;
    if (p.workspace === S.ws) {
      renderPresence();
      if (S.idea && !document.activeElement?.closest?.('.verdict')) schedule(refreshIdea);
    }
  });
  for (const ev of ['idea_changed', 'ideas_changed', 'context_changed']) {
    es.addEventListener(ev, (e) => {
      const d = JSON.parse(e.data);
      if (d.workspace !== S.ws) return schedule(async () => (await loadWorkspaces(), S.ws ? null : renderMain()));
      if (ev === 'context_changed' && d.idea === S.idea?.id && S.route.tab === 'context' && S.idea?.working === 'distill') S.route.file = null;
      if (ev === 'context_changed' && d.idea === S.idea?.id && S.route.tab === 'prds' && S.idea?.working === 'prd') S.route.file = null;
      schedule(refreshIdea);
    });
  }
  es.addEventListener('workspaces_changed', async () => {
    await loadWorkspaces();
    onRoute();
  });
}

window.addEventListener('hashchange', onRoute);
await loadWorkspaces();
listen();
onRoute();
