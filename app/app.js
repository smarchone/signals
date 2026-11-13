// Signals UI: meetings -> context -> PRDs -> exec. No build step; marked + DOMPurify are globals.
// Vibe mode (picked with the first pitch): meetings -> context (business, product, model; no review gate) -> builds.
// A repo has one living context and a series of meetings (M1, M2, …): the first sets the context up, each later one
// amends it. Only the latest meeting is active: you talk in it, resume it, or start the next one.

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
const isVibe = (i) => i?.mode === 'vibe';
// Vibe mode writes the first stage only (business, product, model), with no review gate
const stepsOf = (i) => (isVibe(i) ? STEPS.slice(0, 1) : STEPS);
const filesOf = (i) => stepsOf(i).flatMap((x) => x.files);
const reviewing = (i) => i.stage === 'distilling' && i.distill?.status === 'review';
const canRefine = (i) => i.stage === 'distilled' || reviewing(i);
const canRedistill = (i) => !i.working && canRefine(i) && !i.refinements.some((r) => r.status === 'pending');
// PRDs: the plan layer, cut from the distilled context. Named by relative path (prds/01-skeleton.md).
const isPrd = (name) => String(name).startsWith('prds/');
const reviewingPrds = (i) => i.stage === 'distilled' && i.prd?.status === 'review';
const LOG = 'meetings.md'; // the meetings log: read only, written by the daemon at each call
const cur = (i) => i.meetings.at(-1);
const canRefineDoc = (i, name) => name === LOG ? false : (isPrd(name) ? ['review', 'done'].includes(i.prd?.status) && !prdLocked(i, name) : canRefine(i));
// A PRD being executed, or complete, is what was built: it stays as it is (a stopped one can still change)
const prdLocked = (i, name) => ['building', 'blocked', 'built', 'gone', 'complete'].includes(i.executions?.[name]?.status);
const prdsPending = (i) => i.refinements.some((r) => r.status === 'pending' && isPrd(r.file));
// Draft comments (in the daemon's memory until you send them), on one file or all
const commentsOn = (i, file) => (i.comments || []).filter((t) => !file || t.file === file);
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
  verdictChoice: null,
  changePrds: { text: '', focus: [] }, // the Add or change PRDs form, kept across re-renders
  modePick: {}, // dev mode, switched on for a repo's first pitch (vibe is the default)
  hubDir: '~/signals_workspace',
  newProject: '', // the New project name box
  editingPitch: false, // the pitch: being edited (else shown rendered, like a context file)
  ask: '', // the vibe ask box
  activeThread: null, // the comment thread open in the margin ('new': the one being written)
  newComment: null, // { file, quote }: a comment being written (quote null: on the whole file)
  newCommentText: null,
  replyText: {}, // thread id -> reply being written, kept across live re-renders
  editMsg: null, // the draft message being edited, and its text so far
  editMsgText: null,
  showResolved: false, // the margin shows resolved comments instead of the open ones
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
  if (!res.ok) throw Object.assign(new Error(data.error || `HTTP ${res.status}`), { data });
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
const fail = (err) => (err.data?.trust ? showTrust(err.data.trust) : toast(err.message || String(err)));

// Claude Code won't start a session in a folder you haven't trusted. Say how, until it's dismissed.
const shq = (p) => `'${String(p).replace(/'/g, `'\\''`)}'`;
function showTrust(dir) {
  document.querySelector('.trust-bar')?.remove();
  const cmd = `cd ${shq(dir)} && claude`;
  const bar = document.createElement('div');
  bar.className = 'trust-bar';
  bar.setAttribute('role', 'alert');
  bar.innerHTML = `<span class="grow"><b>Claude Code doesn't trust this folder yet.</b> Run <code>${esc(cmd)}</code> once, accept the trust prompt, exit, then try again.</span>
    <button class="btn sm" data-copy="${esc(cmd)}">Copy</button><button class="btn ghost sm" data-trust-close>✕</button>`;
  document.body.append(bar);
}

// ---------- Routing: #/<repo>/meeting[/<M2|new>], #/<repo>/context[/<file>] or #/<repo>/prds[/<file>] ----------

function parseRoute() {
  const [ws, rawTab, file] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  const tabs = ['meeting', 'context', 'prds', 'builds'];
  const tab = rawTab === 'asks' ? 'builds' : rawTab; // links from before the rename
  return { ws: ws || null, tab: tabs.includes(tab) ? tab : 'meeting', file: file || null, canonical: tabs.includes(tab) };
}
function goIndex() {
  if (location.hash === '#/' || location.hash === '') onRoute();
  else location.hash = '#/';
}
function go(r) {
  const next = { ...S.route, ...r };
  const parts = [next.ws, next.ws && next.tab, next.file].filter(Boolean);
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
    S.verdictChoice = null;
  }
  await loadIdeas();
  await loadIdea();
  renderMain();
}

// ---------- Data ----------

async function loadWorkspaces() {
  const { workspaces, hub_dir, hub } = await api('GET', '/api/workspaces');
  S.workspaces = workspaces;
  if (hub_dir) S.hubDir = hub_dir;
  S.hub = hub || { listening: false };
  for (const w of workspaces) S.presence[w.id] = w.presence;
}
async function loadIdeas() {
  if (!S.ws) return (S.ideas = []);
  S.ideas = (await wsApi('GET', '/api/ideas')).ideas;
}
// The repo's project: its meetings, context and PRDs
async function loadIdea() {
  const id = S.ideas[0]?.id;
  try {
    S.idea = id ? await wsApi('GET', `/api/idea?id=${encodeURIComponent(id)}`) : null;
  } catch {
    S.idea = null;
  }
}

// ---------- Sidebar ----------

// One row per repo, with where its latest meeting stands
function ideaStatus(i) {
  if (!i) return { text: 'No idea yet: start a meeting', cls: 'you' };
  if (i.working === 'panel') return { text: 'Panel is conferring…', busy: true };
  if (i.working === 'distill') return { text: 'Writing context…', busy: true };
  if (i.working === 'refine') return { text: 'Making a change…', busy: true };
  if (i.working === 'prd') return { text: 'Writing PRDs…', busy: true };
  if (i.asking) return { text: 'Building…', busy: true };
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
  const row = (w) => {
      const st = ideaStatus(w.idea);
      const [cls, label] = workerState(w.id);
      return `<li class="ws-row">
        <button class="ws-card" data-repo="${esc(w.id)}">
          ${FOLDER_ICON}
          <span class="ws-main"><span class="ws-card-name">${esc(w.name)}${isVibe(w.idea) ? '<span class="mode-tag">vibe</span>' : ''}</span><span class="ws-card-path">${esc(w.path || w.repo)}</span></span>
          <span class="ws-card-status ${st?.cls || ''}">${esc(st?.text || (w.idea?.prd?.status === 'done' ? 'PRDs ready to hand off' : w.idea?.stage === 'distilled' ? (isVibe(w.idea) ? 'Ready to build' : 'Context ready') : ''))}</span>
          <span class="worker ${cls}" title="${label}"></span>
        </button>
        <button class="btn ghost sm icon more" data-menu="${esc(w.id)}" title="Workspace actions" aria-haspopup="menu">⋯</button>
      </li>`;
  };
  const managed = S.workspaces.filter((w) => w.managed);
  const repos = S.workspaces.filter((w) => !w.managed);
  main.innerHTML = `<header class="idea-head"><div class="ws-title">${BRAND}</div></header>
    <div class="body"><div class="index">
      <div class="index-h"><h2 title="Repos Signals created in ${esc(S.hubDir)}, served by one hub worker">Managed projects</h2>${hubBadge()}</div>
      <div class="new-project">
        <input id="new-project" data-keep="newproj" placeholder="Project name" aria-label="Project name" value="${esc(S.newProject)}" autocomplete="off" spellcheck="false" />
        <button class="btn primary sm" id="create-project" ${S.newProject.trim() ? '' : 'disabled'}>New project</button>
      </div>
      <p class="np-where" id="np-where">${projectWhere()}</p>
      ${managed.length ? `<ul class="ws-list">${managed.map(row).join('')}</ul>` : '<p class="index-hint">A fresh git repo per idea, created here and served by one hub worker. Vibe or dev, your pick on its first pitch.</p>'}
      <h2 class="index-h2-gap">Workspaces</h2>
      ${repos.length ? `<ul class="ws-list">${repos.map(row).join('')}</ul>` : ''}
      <p class="index-hint">Add a repo: run <code>signals serve</code> in it, or <code>/signals</code> in Claude Code there.</p>
    </div></div>`;
}

// Where a new project goes: a fresh git repo in the hub folder, named like the server names it
const projectSlug = (name) => name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48);
function projectWhere() {
  const slug = projectSlug(S.newProject);
  return `Lives in <code>${esc(S.hubDir)}/${slug ? `<b>${esc(slug)}</b>` : '…'}</code>`;
}

// The hub: one worker for every managed project, which you run in the hub folder
function hubBadge() {
  if (S.hub?.listening) return '<span class="hub-state"><span class="worker on"></span>Hub worker connected</span>';
  return `<span class="hub-state"><span class="worker"></span>No hub worker: run <code>/signals</code> in <code>${esc(S.hubDir)}</code></span>`;
}

async function createProject() {
  const name = S.newProject.trim();
  if (!name) return;
  const b = $('#create-project');
  if (b) b.disabled = true;
  try {
    const w = await api('POST', '/api/workspaces/new', { name });
    S.newProject = '';
    await loadWorkspaces();
    toast(`Created ${w.path}${w.git ? '' : ' (git init failed: no git?)'}`, 4000);
    go({ ws: w.id, tab: 'meeting', file: null });
  } catch (err) {
    if (b) b.disabled = false;
    fail(err);
  }
}

const BRAND = '<a class="home" href="#/" title="All workspaces"><span class="logo" aria-hidden="true"></span>Signals</a>';

// Claude's connection to this repo, shown in the title before the folder path
function workerBadge() {
  const p = S.presence[S.ws];
  const w = S.workspaces.find((x) => x.id === S.ws);
  if (p?.job) return `<span class="worker busy" title="Claude is ${{ panel: 'answering as the panel', distill: 'writing context', refine: 'making a change', prd: 'writing PRDs' }[p.job.type]}"></span>`;
  if (p?.listening) return `<span class="worker on" title="${p.hub ? 'The hub worker is connected and listening' : 'Claude is connected and listening'}"></span>`;
  if (p?.worker) return `<span class="worker" title="A worker was started in the background"></span><span class="worker-hint">Worker starting… if it waits on a permission, <code>claude attach ${esc(p.worker.session)}</code></span><button class="btn ghost sm" data-copy="claude attach ${esc(p.worker.session)}">Copy</button>`;
  if (w?.managed) return `<span class="worker" title="No hub worker"></span><span class="worker-hint">No hub worker: run <code>/signals</code> in <code>${esc(S.hubDir)}</code></span>`;
  return `<span class="worker" title="Claude isn't running in ${esc(w?.name || 'this repo')}"></span><span class="worker-hint">Claude isn't running: run <code>/signals</code>, or</span><button class="btn sm" id="start-worker" title="Run /signals in a background Claude Code session in this repo">Start worker</button>`;
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
  if (!S.ws) return keepFocus(() => renderIndex(main)); // live updates re-render it while you type a name
  if (!S.ideas.length) return keepFocus(() => renderStart(main)); // live updates re-render it while you write
  if (!S.idea) {
    main.innerHTML = '<div class="empty">That idea is gone.</div>';
    return;
  }
  if (S.route.tab === 'meeting' && S.route.file === 'new') {
    keepFocus(() => (main.innerHTML = renderIdeaHead() + renderSubhead() + meetingLayout(S.idea, startBody())));
    main.dataset.view = '';
    growPitch($('#hunch'));
    if (!document.activeElement || document.activeElement === document.body) $('#hunch')?.focus();
    return;
  }
  const prevIdea = main.dataset.view;
  const prevTab = main.dataset.tab;
  const { nearBottom, top } = keepFocus(() => {
    const view = { context: renderContext, prds: renderPrds, builds: renderAsks }[S.route.tab] || renderMeeting;
    main.innerHTML = renderIdeaHead() + renderSubhead() + view();
    main.dataset.view = `${S.idea.id}:${S.route.file || ''}`;
    main.dataset.tab = S.route.tab;
  });
  const sameView = prevIdea === `${S.idea.id}:${S.route.file || ''}` && prevTab === S.route.tab;
  if (S.route.tab === 'meeting') {
    decoratePanel(main);
    const body = $('.ctx-doc');
    if (!sameView || nearBottom) body.scrollTop = body.scrollHeight;
    else body.scrollTop = top;
    autosize($('#composer'));
  } else {
    const doc = $('.ctx-doc');
    if (doc && sameView && top != null) doc.scrollTop = top;
    showChanges();
    markComments();
    document.querySelectorAll('.margin textarea').forEach(growArea);
    layoutThreads();
    autosize($('#prd-guidance'));
    const box = $('#change-prds-text') || $('#ask-text');
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

// The mode a repo's first pitch starts in: vibe, unless you switched dev mode on (for advanced users)
function startMode() {
  return S.modePick[S.ws] || 'vibe';
}

function renderStart(main) {
  const repo = S.workspaces.find((w) => w.id === S.ws)?.name || 'this repo';
  main.innerHTML = `<header class="idea-head"><div class="ws-title">${BRAND}<span class="crumb-sep">/</span>${FOLDER_ICON}<span class="ws-name">${esc(repo)}</span><span class="worker-slot">${workerBadge()}</span></div></header>${startBody()}`;
  growPitch($('#hunch'));
  $('#hunch')?.focus();
}

// Dev mode: a small switch for advanced users, on the repo's first pitch only. Off is vibe.
function modeSwitch() {
  const dev = startMode() === 'dev';
  return `<button class="mode-toggle ${dev ? 'on' : ''}" role="switch" aria-checked="${dev}" data-mode="${dev ? 'vibe' : 'dev'}" title="Advanced: a living context in reviewed stages, cut into PRDs, with more meetings later"><span class="knob"></span>Dev mode</button>`;
}

// The pitch: a markdown document that reads like a context file. It is the same pitch in both modes; vibe or dev
// only changes the flow after the call. A later meeting (M2, …) pitches a change to the context instead.
// Rendered once written; click it to edit the markdown in place; Esc, or clicking away, shows it rendered again.
function pitchKind() {
  if (S.idea) {
    const next = `M${S.idea.meetings.length + 1}`;
    return {
      next,
      file: 'pitch.md',
      flow: 'Meeting → Context → PRDs → Build',
      placeholder: "What's on your mind?", // no structure: the panel draws it out
    };
  }
  return {
    file: 'pitch.md',
    flow: startMode() === 'vibe' ? 'Meeting → Context → Build' : 'Meeting → Context → PRDs → Build',
    placeholder: "What's on your mind?", // no structure: the panel draws it out
  };
}
const pitchEditing = () => S.editingPitch || !(S.drafts.__new || '').trim();
function pitchDocBody() {
  const draft = S.drafts.__new || '';
  return pitchEditing()
    ? `<textarea id="hunch" data-keep="hunch" spellcheck="true" placeholder="${esc(pitchKind().placeholder)}">${esc(draft)}</textarea>`
    : `<article class="md pitch-rendered" id="pitch-rendered" tabindex="0" title="Click to edit">${md(draft)}</article>`;
}
function pitchDocMeta() {
  const draft = (S.drafts.__new || '').trim();
  const words = draft ? draft.split(/\s+/).length : 0;
  return `${words} word${words === 1 ? '' : 's'}${draft ? ` · ${pitchEditing() ? 'Esc to see it rendered' : 'Click to edit'}` : ''}`;
}
// Grow the editor with its text, so editing keeps the page's shape
function growPitch(ta) {
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
}
// Switch between rendered and editing without re-rendering the page (a click on Start mustn't be lost)
function setPitchEditing(on) {
  S.editingPitch = on;
  const body = $('#pitch-body');
  if (!body) return;
  body.innerHTML = pitchDocBody();
  $('#word-count').textContent = pitchDocMeta();
  const ta = $('#hunch');
  if (ta && on) {
    ta.focus();
    ta.setSelectionRange(ta.value.length, ta.value.length);
  }
  growPitch(ta);
}

const PANELISTS = `<div class="panelists">
  <span style="background:var(--ceo-soft);color:var(--ceo)">CEO</span>
  <span style="background:var(--pm-soft);color:var(--pm)">PM</span>
  <span style="background:var(--arch-soft);color:var(--arch)">Architect</span>
</div>`;

// The pitch page, the same in both modes: the mode (first meeting only), the document, then start
function startBody() {
  const k = pitchKind();
  const name = S.workspaces.find((w) => w.id === S.ws)?.name || 'this';
  return `<div class="body"><div class="start pitch">
    <h2 class="pitch-title">Let's ${(S.idea ? isVibe(S.idea) : startMode() === 'vibe') ? 'vibe' : 'build'} <span>${esc(name)}</span></h2>
    <div class="pitch-doc">
      <div class="pitch-doc-head"><span class="editor-file">${k.file}</span><span class="pitch-meta" id="word-count">${pitchDocMeta()}</span></div>
      <div id="pitch-body">${pitchDocBody()}</div>
    </div>
    <div class="row">
      ${PANELISTS}
      <div class="flow-hint">${k.flow}</div>
      <div class="grow"></div>
      ${k.next ? '<button class="btn ghost" data-tab="meeting">Cancel</button>' : modeSwitch()}
      <button class="btn primary" id="start">Start ${k.next || 'the meeting'} ⌘↵</button>
    </div>
  </div></div>`;
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

// Header: the workspace, and the flow every change goes through (a legend, not a status)
const FLOW = ['Meeting', 'Context', 'PRDs', 'Build'];
const VIBE_FLOW = ['Meeting', 'Context', 'Build'];
function renderIdeaHead() {
  const i = S.idea;
  const w = S.workspaces.find((x) => x.id === S.ws);
  return `<header class="idea-head">
    <div class="ws-title" title="${esc(w?.repo || '')}">${BRAND}<span class="crumb-sep">/</span>${FOLDER_ICON}<span class="ws-name">${esc(w?.name || '')}</span><span class="worker-slot">${workerBadge()}</span><span class="ws-path"><bdi>${esc(w?.path || w?.repo || '')}</bdi></span></div>
    <div class="rail" title="${isVibe(i) ? 'Vibe mode: meetings shape the context, builds come from it' : 'How work flows through Signals'}">${isVibe(i) ? '<span class="mode-tag">vibe</span>' : ''}${(isVibe(i) ? VIBE_FLOW : FLOW).map((label, n) => `${n ? '<span class="sep"></span>' : ''}<span class="step">${label}</span>`).join('')}</div>
  </header>`;
}

// Sub header: the two views, and on Context the distill chain across the row
function renderSubhead() {
  const i = S.idea;
  const tab = S.route.tab;
  const hasCtx = i.stage === 'distilling' || i.stage === 'distilled' || i.context.length || i.log;
  const meetingMeta = i.meetings.length > 1 ? i.meetings.length : cur(i).stage === 'killed' ? 'killed' : cur(i).messages.filter((m) => m.author === 'panel').length;
  const approved = filesOf(i).filter((f) => fileState(i, f) === 'done').length;
  const hasPrds = i.stage === 'distilled' || i.prds.length;
  if (isVibe(i)) {
    const asks = i.asks?.length || 0;
    return `<nav class="subhead">
    <div class="tabs">
      <button class="tab ${tab === 'meeting' ? 'active' : ''}" data-tab="meeting">Meeting<span class="count">${meetingMeta}</span></button>
      <button class="tab ${tab === 'context' ? 'active' : ''}" data-tab="context" ${hasCtx ? '' : 'disabled title="Commit the idea to distill its context"'}>Context<span class="count">${hasCtx ? `${approved}/${filesOf(i).length}` : 'after the call'}</span></button>
      <button class="tab ${tab === 'builds' ? 'active' : ''}" data-tab="builds" ${i.stage === 'distilled' ? '' : 'disabled title="Builds open once the context is written"'}>Builds<span class="count">${asks || (i.stage === 'distilled' ? 'go' : 'after context')}</span></button>
    </div>
  </nav>`;
  }
  return `<nav class="subhead">
    <div class="tabs">
      <button class="tab ${tab === 'meeting' ? 'active' : ''}" data-tab="meeting">${i.meetings.length > 1 ? 'Meetings' : 'Meeting'}<span class="count">${meetingMeta}</span></button>
      <button class="tab ${tab === 'context' ? 'active' : ''}" data-tab="context" ${hasCtx ? '' : 'disabled title="Commit the idea to distill its context"'}>Context<span class="count">${hasCtx ? `${approved}/${CONTEXT_FILES.length}` : 'after the call'}</span></button>
      <button class="tab ${tab === 'prds' ? 'active' : ''}" data-tab="prds" ${hasPrds ? '' : 'disabled title="Approve the context to plan PRDs"'}>PRDs<span class="count">${i.prds.length || (hasPrds ? 'plan' : 'after context')}</span></button>
    </div>
  </nav>`;
}

// The meetings on the left, like the context files: oldest first, older ones read only, the latest active.
// New meeting starts the next one.
function renderMeetingList(i) {
  const at = S.route.file === 'new' ? null : viewedMeeting(i)?.id;
  const ICON = {
    open: i.working === 'panel' ? STATE_ICON.working : STATE_ICON.review,
    committed: STATE_ICON.done,
    killed: '<span class="st dead">✕</span>',
  };
  const rows = i.meetings
    .map((m) => `<button class="ctx-file ${m.id === at ? 'active' : ''}" data-meeting="${esc(m.id)}" title="${esc(m.title)} · ${m.stage}">${ICON[m.stage]}<span class="prd-num">${esc(m.id)}</span><span class="prd-title">${esc(m.title)}</span></button>`)
    .join('');
  const canNew = cur(i).stage !== 'open' && i.stage !== 'distilling';
  const why = cur(i).stage === 'open' ? `${cur(i).id} is still open: commit or kill it first` : 'Finish reviewing the context first';
  return `${rows}<div class="ctx-sep"></div>
    <button class="ctx-file new-prd ${S.route.file === 'new' ? 'active' : ''}" data-meeting="new" ${canNew ? 'title="Start the next meeting"' : `disabled title="${why}"`}><span class="st plus">+</span>New meeting</button>`;
}
// The meetings list beside a pane (a transcript and its dock, or the pitch box)
const meetingLayout = (i, pane) =>
  `<div class="body" style="overflow:hidden"><div class="ctx"><div class="ctx-files">${renderMeetingList(i)}</div><div class="mtg-pane">${pane}</div></div></div>`;
const viewedMeeting = (i) => i.meetings.find((m) => m.id === S.route.file) || cur(i);

// ---------- Meeting ----------

function workerHint() {
  const p = S.presence[S.ws];
  if (p?.listening || p?.job) return '';
  const w = S.workspaces.find((x) => x.id === S.ws);
  if (w?.managed) return `<div class="notice">No hub worker is listening, so nothing will answer yet. Open Claude Code in <code>${esc(S.hubDir)}</code> and run <code>/signals</code>: one worker for every managed project.</div>`;
  return `<div class="notice">No worker is listening, so nothing will answer yet. Start one from the header, or open Claude Code in <b>${esc(w?.name)}</b> and run <code>/signals</code>.</div>`;
}

function renderMeeting() {
  const i = S.idea;
  const mt = viewedMeeting(i);
  const latest = mt === cur(i);
  const panelBusy = latest && i.working === 'panel';
  // A resume shows as a divider where it picked up, with the context files edited in between
  const resumedAt = new Map((mt.resumes || []).map((r) => [r.from, r]));
  const divider = (r) => `<div class="resumed"><span>Resumed ${esc(r.at.slice(0, 10))}${r.changed?.length ? ` · context changed since: ${esc(r.changed.join(', '))}` : ''}</span></div>`;
  const msgs = mt.messages
    .map((m, n) =>
      (resumedAt.has(n) ? divider(resumedAt.get(n)) : '') +
      (m.author === 'you'
        ? n === 0
          ? `<section class="turn turn-you"><span class="who">Pitch</span><div class="said md">${md(m.text)}</div></section>` // written in the pitch editor, as markdown
          : `<section class="turn turn-you"><span class="who">You</span><div class="said">${esc(m.text)}</div></section>`
        : `<section class="turn turn-panel"><div class="msg-panel md">${md(m.text)}</div></section>`),
    )
    .join('') + (resumedAt.has(mt.messages.length) ? divider(resumedAt.get(mt.messages.length)) : '');
  const pending = (text) => `<section class="turn turn-wait"><span class="who">Panel</span><div class="said"><span class="wait-bar"></span>${text}</div></section>`;
  let tail = '';
  if (panelBusy) tail = pending('Deliberating');
  else if (latest && i.waiting_on === 'claude' && mt.stage === 'open' && mt.messages.at(-1)?.author === 'you') tail = workerHint() || pending('Waiting for the panel');

  let dock = '';
  const why = mt.verdict?.note ? `<span class="note">— ${esc(mt.verdict.note)}</span>` : '';
  if (!latest) {
    dock = `<div class="dock"><div class="dock-inner"><div class="banner ${mt.stage}">
      <span class="grow"><b>${esc(mt.id)} · ${mt.stage === 'killed' ? 'Killed' : 'Committed'}</b> ${why}</span>
      <button class="btn ghost sm" data-meeting="${esc(cur(i).id)}" title="Earlier meetings are read only">${esc(cur(i).id)} →</button></div></div></div>`;
  } else if (mt.stage === 'open') {
    const turns = mt.messages.filter((m) => m.author === 'panel').length;
    const off = panelBusy || !turns ? `disabled title="${panelBusy ? 'Wait for the panel' : 'Hear the panel first'}"` : '';
    dock = `<div class="dock"><div class="dock-inner">
      ${S.verdictChoice ? renderVerdict() : `<div class="composer">
        <textarea id="composer" data-keep="composer" rows="1" placeholder="${panelBusy ? 'The panel is answering' : 'Reply to the panel'}">${esc(S.drafts[i.id] || '')}</textarea>
        <button class="btn primary" id="send" ${panelBusy ? 'disabled' : ''}>Send</button>
      </div>
      <div class="dock-meta">
        <span>↵ send · ⇧↵ new line</span>
        <span class="call-btns">
          <button class="btn ghost sm call-kill" data-choice="kill" ${off}>Kill</button>
          <button class="btn sm call-commit" data-choice="commit" ${off}>Commit</button>
        </span>
      </div>`}
    </div></div>`;
  } else {
    const busy = i.working || i.stage === 'distilling';
    const off = busy ? `disabled title="${i.stage === 'distilling' ? (isVibe(i) ? 'Wait for the context to land' : 'Finish reviewing the context first') : 'Wait for the worker'}"` : '';
    const killed = mt.stage === 'killed';
    dock = `<div class="dock"><div class="dock-inner"><div class="banner ${mt.stage}">
      <span class="grow"><b>${esc(mt.id)} · ${killed ? 'Killed' : 'Committed'}</b> ${why}</span>
      <button class="btn ghost sm" id="resume" ${off || `title="${killed ? 'A second hearing' : 'Keep talking: the new turns amend the context'}"`}>Resume</button>
      <button class="btn ghost sm" data-meeting="new" ${off || 'title="A different change"'}>New meeting</button>
      ${killed ? '' : isVibe(i) ? `<button class="btn ghost sm" data-tab="${i.stage === 'distilled' ? 'builds' : 'context'}">${i.stage === 'distilled' ? 'Build →' : 'Context →'}</button>` : `<button class="btn ghost sm" data-tab="${i.prd ? 'prds' : 'context'}">${i.prd ? 'PRDs →' : 'Context →'}</button>`}</div></div></div>`;
  }
  return meetingLayout(i, `<div class="ctx-doc"><div class="transcript">${msgs}${tail}</div></div>${dock}`);
}

// The call, confirmed in one line: an optional why, then commit or kill
function renderVerdict() {
  const c = S.verdictChoice;
  return `<div class="verdict ${c}">
    <b>${c === 'commit' ? 'Commit' : 'Kill'}</b>
    <input id="verdict-note" data-keep="vnote" autocomplete="off" placeholder="${c === 'commit' ? 'Why it\u2019s worth building (optional)' : 'Why not (optional)'}" />
    <button class="btn ghost sm" id="close-verdict">Cancel</button>
    <button class="btn sm ${c === 'commit' ? 'good' : 'bad'}" id="submit-verdict">${c === 'commit' ? 'Commit' : 'Kill'} ↵</button>
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
    const m = i.meetings.find((x) => x.id === i.distill.meeting) || cur(i);
    const all = (k) => STEPS.flatMap((x) => i.distill.log?.[x.id]?.[k] || []);
    const part = (title, lines) => (lines.length ? `<p class="gate-log-h">${title}</p><ul>${lines.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>` : '');
    const logLine = next ? '' : `<div class="gate-log"><p>Approving logs the call: <b>${esc(m.id)}${m.resumes?.length ? ' (resumed)' : ''} · ${esc(m.title)} · ${i.distill.revised ? 'context redone' : 'committed'}</b>${m.verdict?.note ? ` — ${esc(m.verdict.note)}` : ''}</p>${part('Decided', all('decided'))}${part('Ruled out', all('ruled_out'))}${part('Context', all('context'))}</div>`;
    return `<div class="gate review">
      <div class="gate-top"><b>${esc(step.what)} are ready for your review</b></div>
      <p>${esc(step.gate)}</p>
      ${i.distill.note ? `<div class="gate-note md">${DOMPurify.sanitize(marked.parse(i.distill.note, { gfm: true, breaks: true }))}</div>` : ''}
      ${logLine}
      <div class="gate-row">
        <span class="gate-hint">Select any text to comment. Send your comments together.</span>
        <button class="btn ghost sm" id="redo-step">Redo…</button>
        <button class="btn good sm" id="approve-step" ${pend ? 'disabled title="Wait for your change requests to land"' : draftsIn(i) ? 'disabled title="Send or discard your draft comments first"' : ''}>${next ? `Approve → ${esc(next.what.toLowerCase())}` : 'Approve'}</button>
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
  if (S.route.file === LOG && i.log) return LOG;
  const current = STEPS[stepIndex(i.distill?.step)];
  if (i.stage === 'distilling' && current) {
    const mine = current.files.filter((f) => have.has(f));
    const f = i.working === 'distill' ? mine.at(-1) : mine[0];
    if (f) return f;
  }
  return CONTEXT_FILES.find((n) => have.has(n)) || i.context[0]?.name || (i.log ? LOG : null);
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
    const drafts = draftsIn(i, f);
    const right = pend ? `<span class="pend">${pend} pending</span>` : drafts ? `<span class="pend draft" title="Draft comments, not sent yet">${drafts} draft${drafts === 1 ? '' : 's'}</span>` : i.changes?.[f] != null ? '<span class="chg-dot" title="Changed since you last reviewed it"></span>' : '';
    return `<button class="ctx-file ${f === open ? 'active' : ''}" ${has(f) ? `data-file="${esc(f)}"` : 'disabled'}>${icon}${esc(FILE_LABEL[f] || f)}${right}</button>`;
  };
  const live = (step) => (i.working === 'distill' && stepState(i, step.id) === 'working' ? writing(step) : null);
  const files = stepsOf(i).map((step) => step.files.map((f) => row(f, live(step))).join('')).join('<div class="ctx-sep" title="Your approval"></div>');
  const log = i.log ? `<div class="ctx-sep"></div><button class="ctx-file ${open === LOG ? 'active' : ''}" data-file="${LOG}" title="Every call on this repo. The panel reads it with the context."><span class="st log">≡</span>Meetings log</button>` : '';
  return files + log;
}

function renderContext() {
  const i = S.idea;
  const have = new Map(i.context.map((f) => [f.name, f]));
  const file = openFile(i);
  const gate = renderGate(i);
  let doc;
  if (file === LOG) {
    doc = `<div class="ctx-doc-inner">${gate}<article class="md" id="doc" data-file="${LOG}">${md(i.log)}</article></div>`;
  } else if (!file) {
    doc = i.stage === 'distilled'
      ? `<div class="ctx-doc-inner"><div class="distill-wait"><h2>No current context</h2><p>The context folder is empty. Distill it again from the meeting.</p>${canRedistill(i) ? '<button class="btn primary" id="redistill">Distill from the meeting</button>' : ''}</div></div>`
      : `<div class="ctx-doc-inner">${gate}<div class="distill-wait"><h2>Nothing written yet</h2><p>${isVibe(i) ? 'The context appears here: business, product and model.' : 'The brief appears here first: product and business, the must-read. You review each step before the next one starts.'}</p></div></div>`;
  } else {
    // Only what needs attention: changes still being made, and questions the worker asked back
    // A request from a comment thread shows in the margin instead
    const inMargin = new Set(commentsOn(i).map((t) => t.id));
    const pending = i.refinements.filter((r) => r.file === file && r.status === 'pending' && !inMargin.has(r.thread));
    const asked = i.refinements.filter((r) => r.file === file && r.status === 'asked' && !inMargin.has(r.thread));
    const quote = (r) => esc((r.quote || r.text).replace(/\s+/g, ' ').slice(0, 80));
    const notes = [
      ...pending.map((r) => `<div class="note-line"><span class="dot busy"></span>${i.working === 'refine' ? 'Changing' : 'Queued'} · <span class="q">${quote(r)}</span></div>`),
      ...asked.map((r) => `<div class="note-line ask"><b>The worker asks:</b> ${esc(r.reply)}<span class="q">on “${quote(r)}”</span><button class="btn ghost sm" data-dismiss="${esc(r.id)}" title="Dismiss">×</button></div>`),
    ].join('');
    // The latest committed meeting has no PRDs yet: its work is next
    const lc = [...i.meetings].reverse().find((m) => m.stage === 'committed');
    const hasOwn = lc && Object.values(i.prd_origin || {}).includes(lc.id);
    const next = isVibe(i)
      ? i.stage === 'distilled' && !i.asks?.length ? '<div class="note-line next-line">The context is written. Next: say what to build.<button class="btn primary sm" data-tab="builds">Build →</button></div>' : ''
      : i.stage === 'distilled' && lc && !hasOwn && (!i.prd || (i.prd.status === 'done' && i.prd_stale))
      ? `<div class="note-line next-line">Context approved. Next: cut ${i.prd ? `${esc(lc.id)}'s change` : 'the work'} into PRDs for your executor.<button class="btn primary sm" data-tab="prds">${i.prd ? 'Add its PRDs →' : 'Plan PRDs →'}</button></div>`
      : '';
    doc = withMargin(i, file, `
      ${gate}${next}
      ${notes ? `<div class="notes">${notes}</div>` : ''}
      <div id="changes-line"></div>
      <article class="md" id="doc" data-file="${esc(file)}">${md(have.get(file).content)}</article>`);
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
      return line('', `<span class="grow">Complete.${e.summarized ? ' The executor’s summary is under <b>Build summary</b> at the end.' : e.summarized === false ? ' No executor summary was found to add.' : ''}${resumeCmd}</span>`, resumeCopy);
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
    const drafts = draftsIn(i, f.name);
    const right = pend ? `<span class="pend">${pend} pending</span>` : drafts ? `<span class="pend draft" title="Draft comments, not sent yet">${drafts} draft${drafts === 1 ? '' : 's'}</span>` : fresh ? '<span class="pend">new</span>' : i.changes?.[f.name] != null ? '<span class="chg-dot" title="Changed since you last reviewed it"></span>' : '';
    return `<button class="ctx-file ${f.name === open ? 'active' : ''}" data-prd="${esc(f.name.slice(5))}" title="${esc(f.name)}">${icon}${num ? `<span class="prd-num">${esc(num)}</span>` : ''}<span class="prd-title">${esc(title)}</span>${right}</button>`;
  });
  // Grouped by the meeting each PRD builds, once there is more than one
  const origin = (f) => i.prd_origin?.[f.name] || '';
  if (new Set(i.prds.map(origin)).size > 1) {
    for (let n = i.prds.length - 1; n >= 0; n--) {
      const o = origin(i.prds[n]);
      if (n === 0 || origin(i.prds[n - 1]) !== o) {
        const m = i.meetings.find((x) => x.id === o);
        rows.splice(n, 0, `<div class="prd-group" title="${esc(m?.title || '')}">${esc(o || 'Earlier')}${m ? ` · ${esc(m.title)}` : ''}</div>`);
      }
    }
  }
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
  const approve = `<button class="btn good sm" id="approve-prds" ${prdsPending(i) || i.working ? 'disabled title="Wait for your change requests to land"' : commentsOn(i).some((t) => isPrd(t.file) && threadHasDraft(t)) ? 'disabled title="Send or discard your draft comments first"' : ''}>Approve → ready to hand off</button>`;
  if (p.status === 'review' && p.updated) {
    const added = (p.added || []).filter((n) => i.prds.some((f) => f.name === n)).length;
    const changed = i.prds.filter((f) => !isNewPrd(i, f.name) && i.changes?.[f.name] != null).length;
    const what = [added && `${added} new`, changed && `${changed} changed`].filter(Boolean).join(' · ') || 'nothing changed';
    return `<div class="gate review">
      <div class="gate-top"><b>PRDs updated: ${what}</b></div>
      <p>Review what moved (marked in the list); the rest is as you approved it.</p>
      ${note}
      <div class="gate-row">
        <span class="gate-hint">Select any text to comment. Send your comments together.</span>
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
        <span class="gate-hint">Select any text to comment. Send your comments together.</span>
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
    const lc = [...i.meetings].reverse().find((m) => m.stage === 'committed');
    const fresh = lc && !Object.values(i.prd_origin || {}).includes(lc.id);
    return `<div class="note-line chg-line"><span class="chg-dot"></span>${fresh ? `${esc(lc.id)} amended the context since these PRDs were written. Update them to add its work.` : 'The context changed since these PRDs were written.'}
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
    // A request from a comment thread shows in the margin instead
    const inMargin = new Set(commentsOn(i).map((t) => t.id));
    const pending = i.refinements.filter((r) => r.file === file && r.status === 'pending' && !inMargin.has(r.thread));
    const asked = i.refinements.filter((r) => r.file === file && r.status === 'asked' && !inMargin.has(r.thread));
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
      ready && !isExecOpen(ex) && ex?.status !== 'complete' ? `<button class="btn sm" data-handoff="${esc(file)}" title="Copy a prompt for your own coding agent and mark this PRD handed off">Copy prompt</button>` : '',
      canExec ? `<button class="btn primary sm" data-execute="${esc(file)}" ${execOff}>${ex ? 'Build again' : 'Build'}</button>` : '',
    ].join('');
    doc = withMargin(i, file, `
      ${gate}
      ${tools ? `<div class="ctx-tools">${tools}</div>` : ''}
      ${renderExecution(file, ex)}
      ${notes ? `<div class="notes">${notes}</div>` : ''}
      <div id="changes-line"></div>
      <article class="md" id="doc" data-file="${esc(file)}">${md(f.content)}</article>`);
  }
  return `<div class="body" style="overflow:hidden"><div class="ctx"><div class="ctx-files">${renderPrdList(i, file)}</div><div class="ctx-doc">${doc}</div></div></div>`;
}

// ---------- Builds (vibe mode; "asks" in the API): each one a background Claude Code session, from the context ----------

const ASK_ICON = {
  building: STATE_ICON.working,
  blocked: STATE_ICON.review,
  done: STATE_ICON.done,
  gone: '<span class="st stale" title="The session is gone"></span>',
  stopped: '<span class="st dead">■</span>',
};
const isAskOpen = (a) => ['building', 'blocked'].includes(a?.status);
const openAskOf = (i) => (i.asks || []).find(isAskOpen) || null;

function viewedAsk(i) {
  if (S.route.file === 'new') return null;
  return (i.asks || []).find((a) => a.id === S.route.file) || (S.route.file ? null : openAskOf(i));
}

function renderAskList(i, open) {
  const rows = (i.asks || [])
    .map((a) => `<button class="ctx-file ${a.id === open?.id ? 'active' : ''}" data-ask="${esc(a.id)}" title="${esc(a.text)}">${ASK_ICON[a.status] || STATE_ICON.todo}<span class="prd-num">${esc(a.id)}</span><span class="prd-title">${esc(a.text.split('\n')[0])}</span></button>`)
    .reverse()
    .join('');
  return `<button class="ctx-file new-prd ${open ? '' : 'active'}" data-ask="new"><span class="st plus">+</span>New build</button>${rows ? `<div class="ctx-sep"></div>${rows}` : ''}`;
}

function renderAskStatus(a) {
  const attach = `claude attach ${a.session}`;
  const copy = (cmd) => `<button class="btn ghost sm" data-copy="${esc(cmd)}" title="Copy, then run it in a terminal in this repo">Copy</button>`;
  const stop = `<button class="btn ghost sm danger" data-stop-ask="${esc(a.id)}" title="End the session. Its changes stay in your working tree.">Stop</button>`;
  const resume = a.session_id ? `claude --resume ${a.session_id}` : '';
  const line = (cls, body, btns = '') => `<div class="notes"><div class="note-line exec ${cls}">${body}<span class="exec-btns">${btns}</span></div></div>`;
  switch (a.status) {
    case 'building':
      return line('', `<span class="dot busy"></span><span class="grow">Building in the background · <code>${esc(attach)}</code></span>`, copy(attach) + stop);
    case 'blocked':
      return line('ask', `<span class="grow"><b>It is waiting on you.</b> Answer it with <code>${esc(attach)}</code></span>`, copy(attach) + stop);
    case 'done':
      return line('', `<span class="grow">Built${resume ? ` · <code>${esc(resume)}</code>` : ''}</span>`, resume ? copy(resume) : '');
    case 'gone':
      return line('', `<span class="grow">The session is gone. Its changes are in your working tree.${resume ? ` <code>${esc(resume)}</code>` : ''}</span>`, resume ? copy(resume) : '');
    case 'stopped':
      return line('', `<span class="grow">Stopped. Its changes stay in your working tree to keep or discard.${resume ? ` <code>${esc(resume)}</code>` : ''}</span>`, resume ? copy(resume) : '');
  }
  return '';
}

function renderAskComposer(i) {
  const busy = openAskOf(i);
  const first = !i.asks?.length;
  return `<div class="ctx-doc-inner"><div class="new-prd-form">
    <div class="np-head"><span class="np-num np-icon">↯</span><div><h2>${first ? 'What should it build first?' : 'What next?'}</h2><p>Say what you want. A background Claude Code session builds it right in this repo, from the context, and commits it as a checkpoint.</p></div></div>
    ${busy ? `<div class="note-line"><span class="dot busy"></span>${esc(busy.id)} is still building. The next build starts once it finishes.<button class="btn ghost sm" data-ask="${esc(busy.id)}">Watch it</button></div>` : ''}
    <textarea class="field" id="ask-text" data-keep="ask" rows="5" placeholder="${first ? 'e.g. “Build the first version: the core loop, end to end”' : 'e.g. “Make the reveal feel snappier”, “add a share button”, “dark mode”'}">${esc(S.ask)}</textarea>
    ${first ? '<div class="dep-list"><button class="dep" data-ask-fill="Build the first version: the whole core loop from the context, end to end, as simply as possible.">Build the whole thing from the context</button></div>' : ''}
    <div class="np-row">
      <span class="gate-hint">⌘↵ to build</span>
      <div class="grow"></div>
      <button class="btn primary" id="submit-ask" ${busy || !S.ask.trim() ? 'disabled' : ''}>Build it</button>
    </div>
  </div></div>`;
}

function renderAsks() {
  const i = S.idea;
  const a = viewedAsk(i);
  let doc;
  if (i.stage !== 'distilled') {
    doc = '<div class="ctx-doc-inner"><div class="distill-wait"><h2>Context first</h2><p>Builds come from the context. It is being written now.</p></div></div>';
  } else if (!a) {
    doc = renderAskComposer(i);
  } else {
    doc = `<div class="ctx-doc-inner">
      <div class="ask-head"><span class="prd-num">${esc(a.id)}</span><span class="ask-at">${esc((a.started_at || '').slice(0, 16).replace('T', ' '))}</span></div>
      <div class="np-quote ask-text">${esc(a.text)}</div>
      ${renderAskStatus(a)}
      ${a.result ? `<article class="md" id="ask-result">${md(a.result)}</article>` : a.status === 'done' ? '<p class="muted">No summary was found in the session.</p>' : ''}
    </div>`;
  }
  return `<div class="body" style="overflow:hidden"><div class="ctx"><div class="ctx-files">${renderAskList(i, a)}</div><div class="ctx-doc">${doc}</div></div></div>`;
}

async function submitAsk() {
  const text = S.ask.trim();
  if (!text || openAskOf(S.idea)) return;
  const b = $('#submit-ask');
  if (b) b.disabled = true;
  try {
    const a = await wsApi('POST', '/api/asks', { id: S.idea.id, text });
    S.ask = '';
    toast(`${a.id} is building in the background.`);
    go({ tab: 'builds', file: a.id });
  } catch (err) {
    if (b) b.disabled = false;
    fail(err);
  }
}

// ---------- Comments: threads in the right margin, drafted as you read, sent together ----------
//
// A comment and its replies are a thread, kept in the daemon's memory. What you write is a draft until you send
// the batch; the worker then takes every thread with drafts in one job, and its answer (done, or a question)
// lands back in the thread. A question stays open for your answer; a done thread resolves, leaving the margin
// for the resolved list, so the margin only holds what still needs you.

const draftsIn = (i, file) => commentsOn(i, file).reduce((n, t) => n + t.messages.filter((m) => m.draft).length, 0);
const threadHasDraft = (t) => t.messages.some((m) => m.draft);
const openThreads = (i, file) => commentsOn(i, file).filter((t) => !t.resolved);
const resolvedThreads = (i, file) => commentsOn(i, file).filter((t) => t.resolved);
const oneLine = (s) => esc(String(s).replace(/\s+/g, ' '));

// The document with its comment margin, when the file can take comments or has any
function withMargin(i, file, inner) {
  const margin = renderMargin(i, file);
  return margin
    ? `<div class="ctx-doc-inner wide"><div class="sheet"><div class="page">${inner}</div>${margin}</div></div>`
    : `<div class="ctx-doc-inner">${inner}</div>`;
}

function renderMargin(i, file) {
  const can = canRefineDoc(i, file);
  const mine = openThreads(i, file);
  const done = resolvedThreads(i, file);
  if (!can && !mine.length && !done.length) return '';
  const resolvedView = S.showResolved && done.length > 0;
  const total = draftsIn(i);
  const files = new Set(commentsOn(i).filter(threadHasDraft).map((t) => t.file)).size;
  const batch = total
    ? `<div class="m-batch" title="${total} draft${total === 1 ? '' : 's'}${files > 1 ? ` across ${files} files` : ''}. The worker sees them when you send."><span class="m-n">${total} draft${total === 1 ? '' : 's'}${files > 1 ? ` · ${files} files` : ''}</span><button class="link" id="discard-comments">Discard</button><button class="m-send" id="send-comments" title="Send all drafts to the worker (⌘⇧↵)">Send</button></div>`
    : '';
  // Open and resolved are two views of the margin, never both at once
  const views = done.length
    ? `<span class="m-views"><button class="${resolvedView ? '' : 'on'}" data-margin-view="open">Open${mine.length ? ` ${mine.length}` : ''}</button><button class="${resolvedView ? 'on' : ''}" data-margin-view="resolved">Resolved ${done.length}</button></span>`
    : '<span></span>';
  // The head stays in view as you scroll: the views, the batch, and the resolved list
  const top = (extra = '') => `<div class="m-top"><div class="margin-head">${views}${can && !resolvedView ? '<button class="link" id="ask-file" title="A comment on the whole file">+ File comment</button>' : ''}</div>${batch}${extra}</div>`;
  if (resolvedView) return `<aside class="margin">${top(resolvedList(done))}</aside>`;
  const fresh = S.newComment?.file === file ? newCommentCard(S.newComment) : '';
  const cards = mine.map((t) => threadCard(i, t)).join('');
  const empty = !fresh && !cards && can ? '<p class="m-empty">Select text to comment <kbd>⌘⌥M</kbd></p>' : '';
  return `<aside class="margin">${top()}${empty}<div class="threads" id="threads">${fresh}${cards}</div></aside>`;
}

// Resolved threads: what you asked, and what the worker did; newest first
function resolvedList(done) {
  return `<div class="r-list">${done
    .slice()
    .reverse()
    .map((t) => {
      const last = t.messages.at(-1);
      return `<div class="r-item">
        <div class="r-quote">${t.quote ? oneLine(t.quote) : '<i>Whole file</i>'}</div>
        <div class="r-ask">${oneLine(t.messages[0].text)}</div>
        ${last.author === 'claude' ? `<div class="r-ans">↳ ${oneLine(last.text)}</div>` : ''}
        <button class="link" data-thread-reopen="${esc(t.id)}">Reopen</button>
      </div>`;
    })
    .join('')}</div>`;
}

// One slim line: the text, and a small round button that sends it (↵ does too; ⇧↵ is a new line, Esc lets go)
const SEND_ICON = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
function composerBox(attrs, text, placeholder, button) {
  return `<div class="t-composer${(text || '').trim() ? ' has-text' : ''}"><textarea rows="1" ${attrs} placeholder="${placeholder}">${esc(text || '')}</textarea>${button}</div>`;
}

function newCommentCard(n) {
  return `<div class="thread active is-draft" data-id="new">
    <div class="t-quote ${n.quote ? '' : 'whole'}">${n.quote ? oneLine(n.quote) : 'Whole file'}</div>
    ${composerBox('id="new-comment" data-keep="new-comment"', S.newCommentText, 'Comment…', `<button class="t-send" data-new-add title="Add (↵)">${SEND_ICON}</button>`)}
  </div>`;
}

// One status per thread, only when it says something: queued or being changed, or the worker asks
function threadChip(i, t) {
  if (t.pending) return `<span class="chip working">${i.working === 'refine' ? 'Changing' : 'Queued'}</span>`;
  if (!threadHasDraft(t) && t.messages.at(-1).question) return '<span class="chip ask">Question</span>';
  return '';
}

function messageView(t, m, active) {
  const who = m.author === 'claude' ? 'Worker' : 'You';
  const editing = active && S.editMsg === m.id;
  const body = editing
    ? composerBox(`data-edit-msg="${esc(m.id)}" data-thread="${esc(t.id)}" data-keep="edit-${esc(m.id)}"`, S.editMsgText ?? m.text, 'Empty deletes it', `<button class="t-send" data-edit-save="${esc(m.id)}" data-thread="${esc(t.id)}" title="Save (↵) · Esc cancels">${SEND_ICON}</button>`)
    : `<div class="t-body">${esc(m.text)}</div>`;
  const edit = active && m.draft && !editing ? `<button class="link t-edit" data-edit-start="${esc(m.id)}">Edit</button>` : '';
  return `<div class="t-msg${m.draft ? ' draft' : ''}"><div class="t-head"><span class="name">${who}</span>${m.draft ? '<span class="t-draft">draft</span>' : ''}${edit}</div>${body}</div>`;
}

function threadCard(i, t) {
  const active = S.activeThread === t.id;
  const msgs = active || t.messages.length < 3 ? t.messages : [t.messages[0], t.messages.at(-1)];
  const more = !active && t.messages.length > 2 ? `<div class="t-more">${t.messages.length - 2} more</div>` : '';
  let controls = '';
  if (active) {
    const reply = t.pending
      ? '<div class="t-wait">With the worker. Reply once it answers.</div>'
      : composerBox(`data-reply="${esc(t.id)}" data-keep="reply-${esc(t.id)}"`, S.replyText[t.id], t.messages.at(-1).question ? 'Answer…' : 'Reply…', `<button class="t-send" data-thread-reply="${esc(t.id)}" title="Reply (↵)">${SEND_ICON}</button>`);
    const acts = [
      threadHasDraft(t) ? `<button class="link" data-thread-discard="${esc(t.id)}">${t.messages[0].draft ? 'Delete' : 'Discard draft'}</button>` : '',
      !threadHasDraft(t) && !t.pending ? `<button class="link" data-thread-resolve="${esc(t.id)}">✓ Resolve</button>` : '',
    ].join('');
    controls = reply + (acts ? `<div class="t-actions">${acts}</div>` : '');
  }
  const chip = threadChip(i, t);
  const cls = ['thread', active && 'active', threadHasDraft(t) && 'is-draft', !t.quote && 'page-level'].filter(Boolean).join(' ');
  return `<div class="${cls}" data-id="${esc(t.id)}">
    ${chip ? `<div class="t-status">${chip}</div>` : ''}
    <div class="t-quote ${t.quote ? '' : 'whole'}">${t.quote ? oneLine(t.quote) : 'Whole file'}</div>
    ${msgs.map((m) => messageView(t, m, active)).join('')}${more}${controls}</div>`;
}

// The document's text with whitespace dropped, each character mapped to its text node and offset, so a quote
// matches however the selection broke its lines
function textIndex(el) {
  const chars = [];
  const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const t = n.nodeValue;
    for (let k = 0; k < t.length; k++) if (!/\s/.test(t[k])) chars.push([n, k]);
  }
  return { text: chars.map(([n, k]) => n.nodeValue[k]).join(''), chars };
}

function markQuote(art, quote, id, nth = 0) {
  const needle = quote.replace(/\s+/g, '');
  const { text, chars } = textIndex(art);
  let at = needle ? text.indexOf(needle) : -1;
  for (let k = 0, next = at; k < nth && next > -1; k++) if ((next = text.indexOf(needle, next + 1)) > -1) at = next;
  if (at < 0) return false;
  const [sn, so] = chars[at];
  const [en, eo] = chars[at + needle.length - 1];
  // One mark per text node, so the highlight never breaks the document's structure
  const nodes = [];
  const walk = document.createTreeWalker(art, NodeFilter.SHOW_TEXT);
  let on = false;
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    if (n === sn) on = true;
    if (on) nodes.push(n);
    if (n === en) break;
  }
  for (const n of nodes) {
    const from = n === sn ? so : 0;
    const to = n === en ? eo + 1 : n.nodeValue.length;
    if (!n.nodeValue.slice(from, to).trim()) continue;
    const r = document.createRange();
    r.setStart(n, from);
    r.setEnd(n, to);
    const m = document.createElement('mark');
    m.className = `cm-hl${S.activeThread === id ? ' active' : ''}`;
    m.dataset.comment = id;
    r.surroundContents(m);
  }
  return true;
}

// Highlight each open thread's quote in the document (the occurrence you selected), and the comment being written
function markComments() {
  const art = $('#doc');
  if (!art || !S.idea) return;
  const file = art.dataset.file;
  if (S.newComment?.file === file && S.newComment.quote) markQuote(art, S.newComment.quote, 'new', S.newComment.nth);
  for (const t of openThreads(S.idea, file)) {
    const anchored = t.quote && markQuote(art, t.quote, t.id, t.nth);
    document.querySelector(`.thread[data-id="${CSS.escape(t.id)}"]`)?.classList.toggle('orphan', Boolean(t.quote) && !anchored);
  }
}

// Place each card beside its highlight, pushing overlapping cards apart; the active card wins its spot.
// Whole-file and detached threads stack at the top. On a narrow pane the margin sits below the document.
function layoutThreads() {
  const sheet = $('.sheet');
  const box = $('#threads');
  if (!sheet || !box) return;
  const narrow = $('.ctx-doc').clientWidth < 880;
  sheet.classList.toggle('narrow', narrow);
  const cards = [...box.querySelectorAll('.thread')];
  if (narrow) {
    box.style.height = '';
    for (const c of cards) c.style.top = '';
    return;
  }
  const base = box.getBoundingClientRect().top;
  const items = cards.map((card) => {
    const id = card.dataset.id;
    const mark = $(`#doc mark[data-comment="${CSS.escape(id)}"]`);
    return { card, id, want: mark ? mark.getBoundingClientRect().top - base : 0, h: card.offsetHeight, pinned: !mark };
  });
  items.sort((a, b) => (a.pinned === b.pinned ? a.want - b.want : a.pinned ? -1 : 1));
  const GAP = 8;
  let y = 0;
  for (const it of items) {
    it.top = it.pinned ? y : Math.max(it.want, y);
    y = it.top + it.h + GAP;
  }
  const ai = items.findIndex((it) => it.id === S.activeThread && !it.pinned);
  if (ai > -1) {
    const floor = items.filter((it) => it.pinned).reduce((m, it) => Math.max(m, it.top + it.h + GAP), 0);
    items[ai].top = Math.max(items[ai].want, floor);
    for (let k = ai + 1; k < items.length; k++) items[k].top = Math.max(items[k].want, items[k - 1].top + items[k - 1].h + GAP);
    for (let k = ai - 1; k >= 0 && !items[k].pinned; k--) items[k].top = Math.max(floor, Math.min(items[k].want, items[k + 1].top - items[k].h - GAP));
  }
  // However the active card moved things, no two cards overlap
  for (let k = 1; k < items.length; k++) items[k].top = Math.max(items[k].top, items[k - 1].top + items[k - 1].h + GAP);
  for (const it of items) it.card.style.top = `${it.top}px`;
  box.style.height = `${items.reduce((m, it) => Math.max(m, it.top + it.h), 0)}px`;
}
window.addEventListener('resize', () => layoutThreads());

function growArea(ta) {
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 200)}px`;
}

function setActiveThread(id) {
  if (S.activeThread === id) return;
  if (id !== 'new' && S.newComment && !(S.newCommentText || '').trim()) S.newComment = null; // an empty new comment goes
  S.activeThread = id;
  S.editMsg = S.editMsgText = null;
  if (id) S.showResolved = false;
  renderMain();
  // Opening a thread puts you in its reply box
  if (id && id !== 'new') document.querySelector(`[data-reply="${CSS.escape(id)}"]`)?.focus();
}

function startComment(quote, nth = 0) {
  closeAsk();
  S.newComment = { file: $('#doc').dataset.file, quote, nth };
  S.newCommentText = '';
  S.activeThread = 'new';
  S.showResolved = false;
  window.getSelection()?.removeAllRanges();
  renderMain();
  $('#new-comment')?.focus();
}

function cancelComment() {
  S.newComment = S.newCommentText = null;
  if (S.activeThread === 'new') S.activeThread = null;
  renderMain();
}

// Add the comment as a draft, then get out of the way: you keep reading
async function addComment() {
  const text = (S.newCommentText || '').trim();
  if (!text || !S.newComment) return;
  await wsApi('POST', '/api/ideas/comments', { id: S.idea.id, file: S.newComment.file, quote: S.newComment.quote, nth: S.newComment.nth, text });
  S.newComment = S.newCommentText = null;
  S.activeThread = null;
  return refreshIdea();
}

async function addReply(tid) {
  const text = (S.replyText[tid] || '').trim();
  if (!text) return;
  await wsApi('POST', '/api/ideas/comments/reply', { id: S.idea.id, comment: tid, text });
  delete S.replyText[tid];
  S.activeThread = null;
  return refreshIdea();
}

async function saveEdit(tid, mid) {
  const text = (S.editMsgText ?? '').trim();
  await wsApi('POST', '/api/ideas/comments/edit', { id: S.idea.id, comment: tid, message: mid, text });
  S.editMsg = S.editMsgText = null;
  return refreshIdea();
}

async function sendComments() {
  if (!draftsIn(S.idea)) return;
  const r = await wsApi('POST', '/api/ideas/comments/send', { id: S.idea.id });
  toast(`Sent ${r.sent} comment${r.sent === 1 ? '' : 's'} to the worker${r.dropped ? ` (${r.dropped} on files that can't change any more were dropped)` : ''}`);
  return refreshIdea();
}

function closeAsk() {
  document.querySelectorAll('.ask-btn').forEach((e) => e.remove());
}

// The selection in a document you can comment on, if any
function commentableSelection() {
  const sel = window.getSelection();
  const doc = $('#doc');
  if (!doc || !S.idea || !canRefineDoc(S.idea, doc.dataset.file) || !sel || sel.isCollapsed || !doc.contains(sel.anchorNode)) return null;
  const quote = sel.toString().trim();
  if (!quote) return null;
  // Which occurrence of the text you selected, so a repeated phrase highlights where you meant it
  const range = sel.getRangeAt(0);
  const before = document.createRange();
  before.setStart(doc, 0);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().replace(/\s+/g, '').length;
  const needle = quote.replace(/\s+/g, '');
  const text = textIndex(doc).text;
  let nth = 0;
  for (let at = text.indexOf(needle), k = 0; at > -1 && at <= start; at = text.indexOf(needle, at + 1), k++) nth = k;
  return { quote: quote.slice(0, 8000), nth, rect: range.getBoundingClientRect() };
}

// Select text: a small Comment button appears under it (or press ⌘⌥M)
document.addEventListener('mouseup', (e) => {
  if (e.target.closest('.ask-btn, .margin')) return;
  setTimeout(() => {
    const at = commentableSelection();
    closeAsk();
    if (!at) return;
    const b = document.createElement('button');
    b.className = 'ask-btn';
    b.innerHTML = 'Comment <kbd>⌘⌥M</kbd>';
    Object.assign(b.style, { left: `${at.rect.left + at.rect.width / 2}px`, top: `${at.rect.bottom + 6}px` });
    b.onclick = () => startComment(at.quote, at.nth);
    document.body.append(b);
  }, 0);
});

document.addEventListener('click', (e) => {
  if (e.target.closest('button, textarea, a, .r-list')) return;
  const hl = e.target.closest('mark.cm-hl[data-comment]');
  if (hl && window.getSelection().isCollapsed) return setActiveThread(hl.dataset.comment);
  const card = e.target.closest('.thread[data-id]');
  if (card) return setActiveThread(card.dataset.id);
  // A click anywhere else (not a selection) lets the open thread go; a new comment you've written stays
  if (!window.getSelection().isCollapsed || !S.activeThread) return;
  if (S.activeThread === 'new') return (S.newCommentText || '').trim() ? null : cancelComment();
  if (e.target.closest('#doc, .margin, .ctx-doc')) setActiveThread(null);
});

document.addEventListener('input', (e) => {
  const ta = e.target;
  if (ta.id === 'new-comment') S.newCommentText = ta.value;
  else if (ta.dataset?.reply) S.replyText[ta.dataset.reply] = ta.value;
  else if (ta.dataset?.editMsg) S.editMsgText = ta.value;
  else return;
  ta.closest('.t-composer')?.classList.toggle('has-text', Boolean(ta.value.trim()));
  growArea(ta);
  layoutThreads();
});

document.addEventListener('keydown', (e) => {
  const ta = e.target;
  // ⌘⌥M: comment on the selection
  if ((e.metaKey || e.ctrlKey) && e.altKey && e.code === 'KeyM') {
    const at = commentableSelection();
    if (at) return (e.preventDefault(), startComment(at.quote, at.nth));
  }
  // ⌘⇧↵: add what's in the box you're in, then send the batch
  if (e.key === 'Enter' && e.shiftKey && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    const add = ta.id === 'new-comment' ? addComment() : ta.dataset?.reply ? addReply(ta.dataset.reply) : Promise.resolve();
    return add.then(sendComments).catch(fail);
  }
  if (!ta.closest?.('.margin')) return;
  // In a comment box: ↵ adds, ⇧↵ is a new line, Esc lets go
  const enter = e.key === 'Enter' && !e.shiftKey && !e.isComposing;
  if (ta.id === 'new-comment') {
    if (enter) return (e.preventDefault(), addComment().catch(fail));
    if (e.key === 'Escape') return cancelComment();
  }
  if (ta.dataset?.reply) {
    if (enter) return (e.preventDefault(), addReply(ta.dataset.reply).catch(fail));
    if (e.key === 'Escape') return setActiveThread(null);
  }
  if (ta.dataset?.editMsg) {
    if (enter) return (e.preventDefault(), saveEdit(ta.dataset.thread, ta.dataset.editMsg).catch(fail));
    if (e.key === 'Escape') return ((S.editMsg = S.editMsgText = null), renderMain());
  }
});

// ---------- Actions ----------

function autosize(ta) {
  if (!ta) return;
  ta.style.height = 'auto';
  ta.style.height = `${Math.min(ta.scrollHeight, 220)}px`;
}

async function startMeeting() {
  const text = (S.drafts.__new || '').trim();
  if (!text) return;
  try {
    await wsApi('POST', '/api/ideas', { text, mode: S.idea ? undefined : startMode() });
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
  try {
    await wsApi('POST', '/api/ideas/verdict', { id: S.idea.id, decision: S.verdictChoice, note });
    const committed = S.verdictChoice === 'commit';
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
    const landed = S.idea.refinements.filter((r) => was.get(r.id) === 'pending' && r.status !== 'pending');
    const asked = landed.filter((r) => r.status === 'asked').length;
    const done = landed.length - asked;
    if (landed.length === 1) toast(asked ? `The worker has a question about ${landed[0].file}` : `✓ ${landed[0].file}: ${landed[0].reply}`, 6000);
    else if (landed.length) toast(`✓ ${done} comment${done === 1 ? '' : 's'} done${asked ? ` · ${asked} question${asked === 1 ? '' : 's'} for you` : ''}`, 6000);
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
    if (t.dataset.mode) {
      S.modePick[S.ws] = t.dataset.mode;
      return renderMain();
    }
    if (t.dataset.ask) return go({ tab: 'builds', file: t.dataset.ask });
    if (t.dataset.askFill) {
      S.ask = t.dataset.askFill;
      renderMain();
      return $('#ask-text')?.focus();
    }
    if (t.dataset.stopAsk) {
      if (!confirm(`Stop ${t.dataset.stopAsk}? Its changes stay in your working tree.`)) return;
      await wsApi('POST', '/api/asks/stop', { id: S.idea.id, ask: t.dataset.stopAsk });
      return refreshIdea();
    }
    if (t.dataset.meeting && !t.disabled) return go({ tab: 'meeting', file: t.dataset.meeting === cur(S.idea).id ? null : t.dataset.meeting });
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
      if (!confirm(`Build PRD ${num ? `${num}: ` : ''}${title}?\n\nA background Claude Code session builds it right in this repo's working tree, on the current branch. You test it, commit, and mark it complete.`)) return;
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
    if (t.dataset.trustClose !== undefined) return t.closest('.trust-bar')?.remove();
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
    if (t.dataset.newAdd !== undefined) return addComment();
    if (t.dataset.newCancel !== undefined) return cancelComment();
    if (t.dataset.threadReply) return addReply(t.dataset.threadReply);
    if (t.dataset.threadDiscard) {
      const th = commentsOn(S.idea).find((x) => x.id === t.dataset.threadDiscard);
      if (th?.messages[0].draft) S.activeThread = null;
      await wsApi('POST', '/api/ideas/comments/discard', { id: S.idea.id, comment: t.dataset.threadDiscard });
      return refreshIdea();
    }
    if (t.dataset.threadResolve) {
      await wsApi('POST', '/api/ideas/comments/resolve', { id: S.idea.id, comment: t.dataset.threadResolve });
      S.activeThread = null;
      return refreshIdea();
    }
    if (t.dataset.marginView) {
      S.showResolved = t.dataset.marginView === 'resolved';
      return renderMain();
    }
    if (t.dataset.threadReopen) {
      await wsApi('POST', '/api/ideas/comments/resolve', { id: S.idea.id, comment: t.dataset.threadReopen, resolved: false });
      S.activeThread = t.dataset.threadReopen;
      S.showResolved = false;
      return refreshIdea();
    }
    if (t.dataset.editStart) {
      S.editMsg = t.dataset.editStart;
      S.editMsgText = null;
      renderMain();
      const ta = $('[data-edit-msg]');
      ta?.focus();
      return ta?.setSelectionRange(ta.value.length, ta.value.length);
    }
    if (t.dataset.editSave) return saveEdit(t.dataset.thread, t.dataset.editSave);
    if (t.dataset.editCancel !== undefined) {
      S.editMsg = S.editMsgText = null;
      return renderMain();
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
      case 'close-verdict':
        S.verdictChoice = null;
        return renderMain();
      case 'submit-verdict':
        return submitVerdict();
      case 'resume': {
        const m = cur(S.idea);
        if (m.stage === 'committed' && !confirm(`Resume ${m.id}?\nThe context stays as it is until you commit again, which amends it with the new turns.`)) return;
        await wsApi('POST', '/api/ideas/resume', { id: S.idea.id });
        await refreshIdea();
        return go({ tab: 'meeting', file: null });
      }
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
        return startComment(null);
      case 'send-comments':
        return sendComments();

      case 'discard-comments': {
        const n = draftsIn(S.idea);
        if (!confirm(`Discard ${n} draft${n === 1 ? '' : 's'}?`)) return;
        await wsApi('POST', '/api/ideas/comments/discard', { id: S.idea.id });
        return refreshIdea();
      }
      case 'plan-prds':
        await wsApi('POST', '/api/prds/plan', { id: S.idea.id, guidance: $('#prd-guidance')?.value.trim() });
        S.route.file = null;
        return refreshIdea();
      case 'cancel-new-prd':
        return go({ tab: 'prds', file: null });
      case 'submit-change-prds':
        return submitChangePrds();
      case 'submit-ask':
        return submitAsk();
      case 'create-project':
        return createProject();
      case 'start-worker':
        t.disabled = true;
        await wsApi('POST', '/api/worker/start', {});
        return toast('Starting the worker in the background. It connects in a few seconds.', 4000);
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
        S.drafts.__new = '';
        await wsApi('POST', '/api/ideas/delete', { id: S.idea.id });
        await loadWorkspaces();
        return go({ tab: 'meeting', file: null });
    }
  } catch (err) {
    fail(err);
  }
});

document.addEventListener('click', (e) => {
  if (e.target.closest('#pitch-rendered') && !e.target.closest('a') && !window.getSelection()?.toString()) setPitchEditing(true);
});
document.addEventListener('focusout', (e) => {
  if (e.target.id !== 'hunch' || !$('#pitch-body')) return;
  // A live re-render puts focus straight back on the new editor: only a real move away shows it rendered
  setTimeout(() => {
    if (document.activeElement?.id !== 'hunch' && (S.drafts.__new || '').trim() && $('#pitch-body')) setPitchEditing(false);
  }, 0);
});

document.addEventListener('input', (e) => {
  if (e.target.id === 'composer') {
    S.drafts[S.idea.id] = e.target.value;
    autosize(e.target);
  }
  if (e.target.id === 'hunch') {
    S.drafts.__new = e.target.value;
    const wc = $('#word-count');
    if (wc) {
      S.editingPitch = true; // typing keeps it in the editor, even from empty
      wc.textContent = pitchDocMeta();
      growPitch(e.target);
    }
  }
  if (e.target.id === 'new-project') {
    S.newProject = e.target.value;
    const b = $('#create-project');
    if (b) b.disabled = !projectSlug(e.target.value);
    const where = $('#np-where');
    if (where) where.innerHTML = projectWhere();
  }
  if (e.target.id === 'ask-text') {
    S.ask = e.target.value;
    const b = $('#submit-ask');
    if (b) b.disabled = !e.target.value.trim() || Boolean(openAskOf(S.idea));
  }
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
  if (e.target.id === 'verdict-note' && e.key === 'Enter' && !e.isComposing) submitVerdict();
  if (e.target.id === 'verdict-note' && e.key === 'Escape') {
    S.verdictChoice = null;
    renderMain();
  }
  if (e.target.id === 'change-prds-text' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitChangePrds();
  if (e.target.id === 'ask-text' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submitAsk();
  if (e.target.id === 'new-project' && e.key === 'Enter') createProject();
  if (e.target.id === 'hunch' && e.key === 'Escape' && $('#pitch-body') && e.target.value.trim()) setPitchEditing(false);
  if (e.target.id === 'pitch-rendered' && e.key === 'Enter') {
    e.preventDefault();
    setPitchEditing(true);
  }
  // The pitch editor: Tab indents instead of leaving the field
  if (e.target.id === 'hunch' && e.key === 'Tab' && !e.shiftKey && $('#pitch-body')) {
    e.preventDefault();
    e.target.setRangeText('  ', e.target.selectionStart, e.target.selectionEnd, 'end');
    S.drafts.__new = e.target.value;
  }
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
    if (!S.ws && p.hub) schedule(async () => (await loadWorkspaces(), S.ws ? null : renderMain())); // the hub badge on the index
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
