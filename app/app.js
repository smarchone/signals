// Signals UI: meeting -> verdict -> distill -> context review. No build step; marked + DOMPurify are globals.

const CONTEXT_FILES = ['product.md', 'business.md', 'vocab.md', 'architecture.md', 'abstractions.md'];
const FILE_LABEL = { 'product.md': 'Product', 'business.md': 'Business', 'vocab.md': 'Vocabulary', 'architecture.md': 'Architecture', 'abstractions.md': 'Abstractions' };
const STAGE_LABEL = { meeting: 'In meeting', killed: 'Killed', distilling: 'Distilling', distilled: 'Distilled' };

const S = {
  workspaces: [],
  ws: null,
  ideas: [],
  idea: null, // full idea (with context)
  route: { ws: null, idea: null, tab: 'meeting', file: null },
  presence: {},
  drafts: {}, // per-idea composer text
  verdictOpen: false,
  verdictChoice: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const md = (s) => DOMPurify.sanitize(marked.parse(String(s ?? ''), { gfm: true, breaks: false }));
const ago = (iso) => {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
};

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

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2600);
}
const fail = (err) => toast(err.message || String(err));

// ---------- Routing: #/<ws>/<idea>/<tab>/<file> ----------

function parseRoute() {
  const [ws, idea, tab, file] = location.hash.replace(/^#\/?/, '').split('/').map(decodeURIComponent);
  return { ws: ws || null, idea: idea || null, tab: tab || 'meeting', file: file || null };
}
function go(r) {
  const next = { ...S.route, ...r };
  const parts = [next.ws, next.idea, next.idea && next.tab, next.idea && next.tab === 'context' && next.file].filter(Boolean);
  location.hash = `#/${parts.map(encodeURIComponent).join('/')}`;
}

async function onRoute() {
  const r = parseRoute();
  if (!r.ws || !S.workspaces.some((w) => w.id === r.ws)) {
    if (S.workspaces.length) return go({ ws: (S.workspaces.find((w) => w.id === S.ws) || S.workspaces[0]).id, idea: null });
  }
  const wsChanged = r.ws !== S.ws;
  const ideaChanged = r.idea !== S.route.idea;
  S.route = r;
  S.ws = r.ws;
  if (ideaChanged) {
    S.verdictOpen = false;
    S.verdictChoice = null;
  }
  if (wsChanged) await loadIdeas();
  if (r.idea) await loadIdea();
  else S.idea = null;
  renderSide();
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
async function loadIdea() {
  try {
    S.idea = await wsApi('GET', `/api/idea?id=${encodeURIComponent(S.route.idea)}`);
  } catch {
    S.idea = null;
  }
}

// ---------- Sidebar ----------

function renderSide() {
  const sel = $('#ws');
  sel.innerHTML = S.workspaces.length
    ? S.workspaces.map((w) => `<option value="${esc(w.id)}" ${w.id === S.ws ? 'selected' : ''}>${esc(w.name)}</option>`).join('')
    : '<option>No repos yet</option>';
  sel.title = S.workspaces.find((w) => w.id === S.ws)?.repo || '';
  $('#remove-ws').hidden = !S.workspaces.length;
  renderPresence();

  const groups = [
    ['Meetings', S.ideas.filter((i) => i.stage === 'meeting')],
    ['Context', S.ideas.filter((i) => i.stage === 'distilling' || i.stage === 'distilled')],
    ['Graveyard', S.ideas.filter((i) => i.stage === 'killed')],
  ];
  $('#ideas').innerHTML = groups
    .filter(([, list]) => list.length)
    .map(
      ([label, list]) => `<div><div class="group-label">${label}</div>${list
        .map((i) => {
          let status = STAGE_LABEL[i.stage];
          let cls = '';
          if (i.working === 'panel') status = 'Panel is conferring…';
          else if (i.working === 'distill') status = 'Distilling…';
          else if (i.working === 'refine') status = 'Refining…';
          else if (i.waiting_on === 'you') (status = 'Your move'), (cls = 'you');
          else if (i.waiting_on === 'claude') status = 'Waiting for worker';
          const dot = i.working ? '<span class="dot busy"></span>' : '';
          return `<button class="idea-link ${i.id === S.route.idea ? 'active' : ''} ${i.stage}" data-idea="${esc(i.id)}">
            <span class="t">${esc(i.title)}</span><span class="s ${cls}">${dot}${esc(status)} · ${ago(i.updated_at)}</span></button>`;
        })
        .join('')}</div>`,
    )
    .join('');
}

function renderPresence() {
  const p = S.presence[S.ws];
  const w = S.workspaces.find((x) => x.id === S.ws);
  const el = $('#presence');
  if (!w) return (el.innerHTML = '<span class="dot"></span><span>Register a repo: <code>signals serve</code></span>');
  if (p?.job) el.innerHTML = `<span class="dot busy"></span><span>Worker is ${{ panel: 'answering as the panel', distill: 'distilling context', refine: 'refining context' }[p.job.type]}</span>`;
  else if (p?.listening) el.innerHTML = '<span class="dot on"></span><span>Worker listening</span>';
  else el.innerHTML = `<span class="dot"></span><span>No worker. Run <code>/signals</code> in Claude Code in <b>${esc(w.name)}</b></span>`;
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
  if (!S.workspaces.length) {
    main.innerHTML = `<div class="empty"><h2>No repos registered</h2><p>In a repo, run <code>signals serve</code>, or open Claude Code there and run <code>/signals</code>.</p></div>`;
    return;
  }
  if (!S.route.idea) return renderStart(main);
  if (!S.idea) {
    main.innerHTML = '<div class="empty">That idea is gone.</div>';
    return;
  }
  const prevIdea = main.dataset.view;
  const prevTab = main.dataset.tab;
  const { nearBottom, top } = keepFocus(() => {
    main.innerHTML = renderIdeaHead() + renderTabs() + (S.route.tab === 'context' ? renderContext() : renderMeeting());
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
  }
}

function renderStart(main) {
  const draft = S.drafts.__new || '';
  main.innerHTML = `<div class="body"><div class="start">
    <h2>What's the hunch?</h2>
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

function renderIdeaHead() {
  const i = S.idea;
  const steps = [
    ['meeting', 'Meeting'],
    ['verdict', i.stage === 'killed' ? 'Killed' : 'Verdict'],
    ['distill', 'Distill'],
    ['context', 'Context'],
  ];
  const at = { meeting: 0, killed: 1, distilling: 2, distilled: 3 }[i.stage];
  return `<header class="idea-head">
    <h1 title="${esc(i.title)}">${esc(i.title)}</h1>
    <div class="rail">${steps
      .map(([, label], n) => {
        const cls = i.stage === 'killed' && n === 1 ? 'dead' : n === at ? 'now' : n < at ? 'done' : '';
        return `${n ? '<span class="sep"></span>' : ''}<span class="step ${cls}">${n < at && !(i.stage === 'killed') ? '✓ ' : ''}${label}</span>`;
      })
      .join('')}</div>
    <button class="btn ghost sm" id="delete-idea" title="Delete this idea">Delete</button>
  </header>`;
}

function renderTabs() {
  const i = S.idea;
  const hasCtx = i.stage === 'distilling' || i.stage === 'distilled' || i.context.length;
  const turns = i.messages.filter((m) => m.author === 'panel').length;
  return `<nav class="tabs">
    <button class="tab ${S.route.tab === 'meeting' ? 'active' : ''}" data-tab="meeting">Meeting<span class="count">${turns}</span></button>
    <button class="tab ${S.route.tab === 'context' ? 'active' : ''}" data-tab="context" ${hasCtx ? '' : 'disabled title="Commit the idea to distill its context"'}>Context<span class="count">${i.context.length}/${CONTEXT_FILES.length}</span></button>
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
    .map((m) => (m.author === 'you' ? `<div class="msg-you">${esc(m.text)}</div>` : `<div class="msg-panel md">${md(m.text)}</div>`))
    .join('');
  let tail = '';
  if (panelBusy) tail = `<div class="thinking"><span class="bubbles"><i></i><i></i><i></i></span>The panel is conferring…</div>`;
  else if (i.waiting_on === 'claude' && i.stage === 'meeting') tail = workerHint() || `<div class="thinking"><span class="bubbles"><i></i><i></i><i></i></span>Waiting for the panel…</div>`;

  let dock = '';
  if (i.stage === 'meeting') {
    const turns = i.messages.filter((m) => m.author === 'panel').length;
    dock = `<div class="dock"><div class="dock-inner">
      ${S.verdictOpen ? renderVerdict() : ''}
      <div class="composer">
        <textarea id="composer" data-keep="composer" rows="1" placeholder="${panelBusy ? 'The panel is answering…' : 'React, adjust, or answer the sharpest question…'}">${esc(S.drafts[i.id] || '')}</textarea>
        <button class="btn primary" id="send" ${panelBusy ? 'disabled' : ''}>Send</button>
      </div>
      <div class="dock-meta">
        <span>↵ send · ⇧↵ new line</span>
        ${S.verdictOpen ? '' : `<button class="btn ${turns >= 2 ? 'primary' : ''} sm" id="open-verdict" ${panelBusy || !turns ? 'disabled' : ''}>Make the call</button>`}
      </div>
    </div></div>`;
  } else if (i.stage === 'killed') {
    dock = `<div class="dock"><div class="dock-inner"><div class="banner killed">
      <span class="grow"><b>Killed</b> ${i.verdict?.note ? `<span class="note">— ${esc(i.verdict.note)}</span>` : ''}<br><small>Time and tokens saved. It stays in the graveyard with the reasoning.</small></span>
      <button class="btn sm" id="reopen">Reopen meeting</button></div></div></div>`;
  } else {
    dock = `<div class="dock"><div class="dock-inner"><div class="banner committed">
      <span class="grow"><b>Committed</b> ${i.verdict?.note ? `<span class="note">— ${esc(i.verdict.note)}</span>` : ''}</span>
      <button class="btn sm" data-tab="context">View context →</button></div></div></div>`;
  }
  return `<div class="body"><div class="transcript">${msgs}${tail}</div></div>${dock}`;
}

function renderVerdict() {
  const c = S.verdictChoice;
  return `<div class="verdict">
    <h3>Your call</h3>
    <p class="hint">The panel advises. You decide. Commit distills the meeting into context files. Kill sends it to the graveyard with your reasoning.</p>
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

function renderContext() {
  const i = S.idea;
  const have = new Map(i.context.map((f) => [f.name, f]));
  const names = [...CONTEXT_FILES, ...i.context.map((f) => f.name).filter((n) => !CONTEXT_FILES.includes(n))];
  const distilling = i.stage === 'distilling';
  const working = i.working === 'distill';
  let file = S.route.file && have.has(S.route.file) ? S.route.file : null;
  if (!file) file = distilling ? [...have.keys()].at(-1) : names.find((n) => have.has(n));
  const pendingFor = (n) => i.refinements.filter((r) => r.file === n && r.status === 'pending').length;

  const list = names
    .map((n) => {
      const ok = have.has(n);
      const nextUp = distilling && working && !ok && names.find((x) => !have.has(x)) === n;
      const st = ok && !(distilling && working && n === [...have.keys()].at(-1)) ? '<span class="st ok">✓</span>' : nextUp || (ok && distilling) ? '<span class="st wip"></span>' : '<span class="st"></span>';
      const pend = pendingFor(n);
      return `<button class="ctx-file ${n === file ? 'active' : ''}" data-file="${esc(n)}" ${ok ? '' : 'disabled'}>${st}${esc(FILE_LABEL[n] || n)}${pend ? `<span class="pend">${pend} pending</span>` : ''}</button>`;
    })
    .join('');

  const ws = S.workspaces.find((w) => w.id === S.ws);
  const foot = `<div class="ctx-side-foot">
    ${i.stage === 'distilled' ? '<button class="btn sm" id="redistill">Re-distill from meeting</button>' : ''}
    <button class="btn ghost sm" data-tab="meeting">← Back to the meeting</button>
    <div class="path">${esc(ws?.root || '')}/ideas/${esc(i.id)}/context</div>
  </div>`;

  let doc;
  if (!file) {
    doc = `<div class="distill-wait">
      <div class="thinking"><span class="bubbles"><i></i><i></i><i></i></span></div>
      <h2>${working ? 'Distilling the meeting' : 'Queued to distill'}</h2>
      <p>${working ? 'The worker is turning the meeting into five context files. They appear on the left as they are written.' : 'Waiting for the worker to pick this up.'}</p>
      ${working ? '' : workerHint()}
    </div>`;
  } else {
    const refs = i.refinements.filter((r) => r.file === file);
    doc = `<div class="ctx-doc-inner">
      <div class="ctx-tools">${i.stage === 'distilled' ? '<button class="btn sm" id="ask-file">Ask for a change</button>' : ''}</div>
      <article class="md" id="doc" data-file="${esc(file)}">${md(have.get(file).content)}</article>
      ${
        refs.length
          ? `<section class="refines"><h4>Change requests</h4>${refs
              .slice()
              .reverse()
              .map(
                (r) => `<div class="refine">${r.quote ? `<div class="q">${esc(r.quote)}</div>` : ''}<div>${esc(r.text)}</div>
                  ${r.status === 'pending' ? `<div class="r">${i.working === 'refine' ? 'Working on it…' : 'Queued'}</div>` : `<div class="r">${esc(r.reply)}</div>`}</div>`,
              )
              .join('')}</section>`
          : ''
      }
    </div>`;
  }
  return `<div class="body" style="overflow:hidden"><div class="ctx"><div class="ctx-files">${list}${foot}</div><div class="ctx-doc">${doc}</div></div></div>`;
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
    if (!doc || S.idea?.stage !== 'distilled' || !sel || sel.isCollapsed || !doc.contains(sel.anchorNode)) {
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
    const idea = await wsApi('POST', '/api/ideas', { text });
    S.drafts.__new = '';
    await loadIdeas();
    go({ idea: idea.id, tab: 'meeting' });
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

async function refreshIdea() {
  await Promise.all([loadIdeas(), S.route.idea ? loadIdea() : null]);
  renderSide();
  renderMain();
}

document.addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  try {
    if (t.dataset.idea) return go({ idea: t.dataset.idea, tab: 'meeting', file: null });
    if (t.dataset.tab && !t.disabled) return go({ tab: t.dataset.tab, file: null });
    if (t.dataset.file) return go({ tab: 'context', file: t.dataset.file });
    if (t.dataset.choice) {
      S.verdictChoice = t.dataset.choice;
      renderMain();
      $('#verdict-note')?.focus();
      return;
    }
    switch (t.id) {
      case 'remove-ws': {
        const w = S.workspaces.find((x) => x.id === S.ws);
        if (!w || !confirm(`Unregister “${w.name}”?\n${w.repo}\n\nIts .signals/ folder (ideas and context files) stays on disk. Register it again with: signals serve`)) return;
        await api('POST', '/api/workspaces/remove', { id: w.id });
        S.ws = null;
        await loadWorkspaces();
        toast(`Unregistered ${w.name}`);
        return go({ ws: S.workspaces[0]?.id || '', idea: null });
      }
      case 'new-idea':
        return go({ idea: null });
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
        await wsApi('POST', '/api/ideas/reopen', { id: S.idea.id });
        return refreshIdea();
      case 'redistill': {
        const guidance = prompt('Re-distill from the meeting. This rewrites the context files.\nAnything to emphasise? (optional)');
        if (guidance === null) return;
        await wsApi('POST', '/api/ideas/redistill', { id: S.idea.id, guidance });
        return refreshIdea();
      }
      case 'ask-file':
        return openAsk(null, t.getBoundingClientRect());
      case 'delete-idea':
        if (!confirm(`Delete “${S.idea.title}” and its context files? This can't be undone.`)) return;
        await wsApi('POST', '/api/ideas/delete', { id: S.idea.id });
        await loadIdeas();
        return go({ idea: null });
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
});

document.addEventListener('keydown', (e) => {
  if (e.target.id === 'composer' && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!$('#send').disabled) send();
  }
  if (e.target.id === 'hunch' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) startMeeting();
  if (e.key === 'Escape') closeAsk();
});

$('#ws').addEventListener('change', (e) => go({ ws: e.target.value, idea: null }));

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
      if (d.workspace !== S.ws) return;
      if (ev === 'context_changed' && d.idea === S.route.idea && S.route.tab === 'context' && S.idea?.stage === 'distilling') S.route.file = null;
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
