// Signals daemon: the decision plane for many repos.
// Each registered repo is a workspace. Its ideas live in <repo>/.signals/ideas/<idea>/:
//   idea.json   the meeting transcript, the go/no-go verdict, the stage, change requests
//   context/    the distilled context files (product, business, vocab, architecture, abstractions)
//
// A local Claude Code session per repo (the /signals skill) long-polls for jobs:
//   panel    you spoke last in a meeting -> the panel (CEO, PM, Architect) answers
//   distill  you committed an idea       -> the worker writes the context files
//   refine   you asked for a change to a context file -> the worker edits it
//
//   node server.js        (or: signals serve <repo>, which starts this in the background and registers the repo)
//
// Registry and log: $SIGNALS_HOME (default ~/.signals-daemon).
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3461;
const HOME = path.resolve(process.env.SIGNALS_HOME || path.join(os.homedir(), '.signals-daemon'));
const REGISTRY = path.join(HOME, 'workspaces.json');
const APP_DIR = path.join(HERE, 'app');

// The opinionated context set, in reading order. The worker writes exactly these.
const CONTEXT_FILES = ['product.md', 'business.md', 'vocab.md', 'architecture.md', 'abstractions.md'];
const STAGES = ['meeting', 'killed', 'distilling', 'distilled'];

const httpError = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const shortId = () => randomUUID().slice(0, 8);

// ---------- Live updates (SSE), shared by all workspaces ----------

const clients = new Set();
function broadcastAll(event, data) {
  const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(msg);
}

// ---------- A workspace: one repo's .signals folder ----------

function makeWorkspace(id, repo) {
  const ROOT = path.join(repo, '.signals');
  const IDEAS = path.join(ROOT, 'ideas');
  fs.mkdirSync(IDEAS, { recursive: true });
  const broadcast = (event, data) => broadcastAll(event, { ...data, workspace: id });

  // ---------- Ideas, cached in memory, one JSON file each ----------

  const ideas = new Map(); // id -> idea
  const ideaDir = (iid) => path.join(IDEAS, iid);
  const contextDir = (iid) => path.join(ideaDir(iid), 'context');

  function loadAll() {
    for (const e of fs.readdirSync(IDEAS, { withFileTypes: true })) {
      if (!e.isDirectory()) continue;
      try {
        const idea = JSON.parse(fs.readFileSync(path.join(IDEAS, e.name, 'idea.json'), 'utf8'));
        if (idea.stage === 'committed') idea.stage = 'distilling';
        ideas.set(idea.id, idea);
      } catch {}
    }
  }

  async function save(idea) {
    idea.updated_at = now();
    await mkdir(ideaDir(idea.id), { recursive: true });
    await writeFile(path.join(ideaDir(idea.id), 'idea.json'), JSON.stringify(idea, null, 2));
    broadcast('idea_changed', { idea: idea.id });
  }

  function getIdea(iid) {
    const idea = ideas.get(iid);
    if (!idea) throw httpError(404, `No idea ${iid}`);
    return idea;
  }

  function ideaSlug(title) {
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'idea';
    return `${slug}-${randomUUID().slice(0, 4)}`;
  }

  async function contextFiles(iid) {
    const dir = contextDir(iid);
    const names = await readdir(dir).catch(() => []);
    const order = (n) => (CONTEXT_FILES.includes(n) ? CONTEXT_FILES.indexOf(n) : 99);
    const files = names.filter((n) => n.endsWith('.md')).sort((a, b) => order(a) - order(b) || a.localeCompare(b));
    return Promise.all(files.map(async (name) => ({ name, content: await readFile(path.join(dir, name), 'utf8') })));
  }

  function contextFile(iid, name) {
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]*\.md$/i.test(name)) throw httpError(400, 'file must be a context file name like vocab.md');
    return path.join(contextDir(iid), name);
  }

  function summary(idea) {
    const pending = needs(idea);
    return {
      id: idea.id,
      title: idea.title,
      stage: idea.stage,
      verdict: idea.verdict,
      created_at: idea.created_at,
      updated_at: idea.updated_at,
      message_count: idea.messages.length,
      waiting_on: pending ? 'claude' : idea.stage === 'meeting' ? 'you' : null,
      working: job?.idea === idea.id ? job.type : null,
    };
  }

  // ---------- Jobs: derived from idea state, one at a time per workspace ----------
  //
  // GET  /api/jobs/next?timeout=300  long-poll; claims the oldest waiting work
  // POST /api/jobs/complete          { job_id, text } posts the panel reply / distill summary / refine reply
  // POST /api/jobs/release           { job_id } gives the work back without an answer

  // What an idea is waiting on Claude for, if anything (and since when)
  function needs(idea) {
    if (idea.stage === 'meeting' && idea.messages.at(-1)?.author === 'you') return { type: 'panel', at: idea.messages.at(-1).at };
    if (idea.stage === 'distilling') return { type: 'distill', at: idea.verdict?.at || idea.updated_at };
    if (idea.stage === 'distilled') {
      const r = idea.refinements.find((x) => x.status === 'pending');
      if (r) return { type: 'refine', at: r.at, refinement: r.id };
    }
    return null;
  }

  let job = null; // { id, type, idea, refinement?, claimed_at }
  let waiters = [];
  let lastClaudeActivity = 0;

  function presence() {
    return {
      workspace: id,
      listening: waiters.length > 0,
      last_claude_at: lastClaudeActivity || null,
      job: job && { id: job.id, type: job.type, idea: job.idea },
    };
  }
  const broadcastPresence = () => broadcast('presence', presence());
  function claudeActed() {
    lastClaudeActivity = Date.now();
    broadcastPresence();
  }
  function wake() {
    for (const w of waiters.slice()) w();
  }

  function claimJob() {
    if (job) return job;
    const pending = [...ideas.values()]
      .map((idea) => ({ idea, need: needs(idea) }))
      .filter((x) => x.need)
      .sort((a, b) => Date.parse(a.need.at) - Date.parse(b.need.at));
    if (!pending.length) return null;
    const { idea, need } = pending[0];
    job = { id: shortId(), type: need.type, idea: idea.id, refinement: need.refinement, claimed_at: now() };
    broadcast('idea_changed', { idea: idea.id });
    broadcastPresence();
    return job;
  }

  function transcript(idea) {
    return idea.messages.map((m) => ({ author: m.author === 'you' ? 'user' : 'panel', text: m.text }));
  }

  function jobView(j) {
    const idea = getIdea(j.idea);
    const base = { id: j.id, type: j.type, idea: { id: idea.id, title: idea.title } };
    if (j.type === 'panel') return { job: { ...base, transcript: transcript(idea) } };
    if (j.type === 'distill') {
      return {
        job: {
          ...base,
          transcript: transcript(idea),
          verdict: idea.verdict,
          guidance: idea.distill_guidance || null,
          context_dir: contextDir(idea.id),
          files: CONTEXT_FILES,
        },
      };
    }
    const r = idea.refinements.find((x) => x.id === j.refinement);
    return {
      job: {
        ...base,
        file: contextFile(idea.id, r.file),
        context_dir: contextDir(idea.id),
        highlighted_text: r.quote || null,
        request: r.text,
      },
    };
  }

  function waitForWake(timeoutSec, signal) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        waiters = waiters.filter((w) => w !== done);
        broadcastPresence();
        resolve();
      };
      const timer = setTimeout(done, Math.min(timeoutSec, 300) * 1000);
      waiters.push(done);
      signal?.addEventListener('abort', done, { once: true });
      broadcastPresence();
    });
  }

  function pollerGone() {
    if (!job) lastClaudeActivity = 0;
    broadcastPresence();
  }

  async function nextJob(timeoutSec, signal) {
    if (signal?.aborted) return pollerGone();
    claudeActed();
    let j = claimJob();
    if (!j && timeoutSec > 0) {
      await waitForWake(timeoutSec, signal);
      if (signal?.aborted) return pollerGone();
      j = claimJob();
    }
    if (j && signal?.aborted) {
      if (job?.id === j.id) endJob();
      return pollerGone();
    }
    claudeActed();
    return j ? jobView(j) : { job: null };
  }

  function currentJob(jid) {
    if (!job) throw httpError(409, 'No job in progress. Poll /api/jobs/next for the next one.');
    if (jid && jid !== job.id) throw httpError(409, `Job ${jid} is no longer active (it was released). Poll /api/jobs/next again.`);
    return job;
  }

  function endJob() {
    const iid = job?.idea;
    job = null;
    if (iid) broadcast('idea_changed', { idea: iid });
    claudeActed();
  }

  async function completeJob(j, text) {
    const idea = getIdea(j.idea);
    const reply = String(text || '').trim();
    if (j.type === 'panel') {
      if (!reply) throw httpError(400, 'text (the panel reply) is required');
      idea.messages.push({ id: shortId(), author: 'panel', text: reply, at: now() });
    } else if (j.type === 'distill') {
      const have = (await contextFiles(idea.id)).map((f) => f.name);
      const missing = CONTEXT_FILES.filter((f) => !have.includes(f));
      if (missing.length) throw httpError(409, `Write these context files first: ${missing.join(', ')} (in ${contextDir(idea.id)})`);
      idea.stage = 'distilled';
      idea.distilled = { at: now(), note: reply || null };
    } else {
      const r = idea.refinements.find((x) => x.id === j.refinement);
      if (r) Object.assign(r, { status: 'done', reply: reply || 'Done.', done_at: now() });
    }
    endJob();
    await save(idea);
    wake(); // more work may be waiting
  }

  // ---------- Watch context files, so the UI shows the distill as it happens ----------

  const watchTimers = new Map();
  let watcher = null;
  try {
    watcher = fs.watch(IDEAS, { recursive: true }, (_type, filename) => {
      if (!filename) return;
      const parts = filename.split(path.sep);
      if (parts[1] !== 'context' || !filename.endsWith('.md')) return;
      const iid = parts[0];
      clearTimeout(watchTimers.get(iid));
      watchTimers.set(iid, setTimeout(() => broadcast('context_changed', { idea: iid }), 150));
      if (job?.idea === iid) claudeActed();
    });
  } catch (err) {
    console.warn('File watching unavailable:', err.message);
  }

  // ---------- Routes (served under /api/w/<workspace>/...) ----------

  const userText = (b) => {
    const t = String(b.text || '').trim();
    if (!t) throw httpError(400, 'text is required');
    return t;
  };

  const routes = {
    'GET /api/ideas': async () => ({
      workspace: id,
      ideas: [...ideas.values()].map(summary).sort((a, b) => b.updated_at.localeCompare(a.updated_at)),
    }),

    'GET /api/idea': async (q) => {
      const idea = getIdea(q.get('id'));
      return { ...idea, ...summary(idea), context: await contextFiles(idea.id) };
    },

    // Start a meeting: the first message is the raw hunch
    'POST /api/ideas': async (_q, b) => {
      const text = userText(b);
      const title = String(b.title || '').trim() || text.split('\n')[0].slice(0, 60);
      const idea = {
        id: ideaSlug(title),
        title,
        stage: 'meeting',
        created_at: now(),
        updated_at: now(),
        messages: [{ id: shortId(), author: 'you', text, at: now() }],
        verdict: null,
        refinements: [],
      };
      ideas.set(idea.id, idea);
      await save(idea);
      broadcast('ideas_changed', {});
      wake();
      return summary(idea);
    },

    'POST /api/ideas/message': async (_q, b) => {
      const idea = getIdea(b.id);
      if (idea.stage !== 'meeting') throw httpError(409, 'The meeting is closed. Reopen it to keep talking.');
      if (job?.idea === idea.id) throw httpError(409, 'The panel is still answering. Wait for it, then reply.');
      idea.messages.push({ id: shortId(), author: 'you', text: userText(b), at: now() });
      await save(idea);
      wake();
      return summary(idea);
    },

    'POST /api/ideas/rename': async (_q, b) => {
      const idea = getIdea(b.id);
      idea.title = userText({ text: b.title });
      await save(idea);
      broadcast('ideas_changed', {});
      return summary(idea);
    },

    // The go / no-go call. Only you make it.
    'POST /api/ideas/verdict': async (_q, b) => {
      const idea = getIdea(b.id);
      if (!['commit', 'kill'].includes(b.decision)) throw httpError(400, 'decision must be commit or kill');
      if (idea.stage !== 'meeting') throw httpError(409, `The idea is already ${idea.stage}.`);
      if (job?.idea === idea.id) throw httpError(409, 'The panel is still answering. Wait for it first.');
      idea.verdict = { decision: b.decision, note: String(b.note || '').trim() || null, at: now() };
      idea.stage = b.decision === 'commit' ? 'distilling' : 'killed';
      if (b.decision === 'commit') idea.distill_guidance = String(b.guidance || '').trim() || null;
      await save(idea);
      broadcast('ideas_changed', {});
      wake();
      return summary(idea);
    },

    // Back to the table: a killed idea gets a second hearing, or a distilled one gets rethought
    'POST /api/ideas/reopen': async (_q, b) => {
      const idea = getIdea(b.id);
      if (job?.idea === idea.id) throw httpError(409, 'Claude is working on this idea. Wait for it first.');
      idea.stage = 'meeting';
      idea.verdict = null;
      await save(idea);
      broadcast('ideas_changed', {});
      return summary(idea);
    },

    // Distill again from the transcript (overwrites the context files)
    'POST /api/ideas/redistill': async (_q, b) => {
      const idea = getIdea(b.id);
      if (idea.stage !== 'distilled') throw httpError(409, 'Only a distilled idea can be distilled again.');
      if (job?.idea === idea.id) throw httpError(409, 'Claude is working on this idea. Wait for it first.');
      idea.stage = 'distilling';
      idea.distill_guidance = String(b.guidance || '').trim() || null;
      await save(idea);
      wake();
      return summary(idea);
    },

    // Ask for a change to one context file, optionally anchored to a quote
    'POST /api/ideas/refine': async (_q, b) => {
      const idea = getIdea(b.id);
      if (idea.stage !== 'distilled') throw httpError(409, 'Context files can be refined once the idea is distilled.');
      const abs = contextFile(idea.id, b.file);
      if (!fs.existsSync(abs)) throw httpError(404, `No context file ${b.file}`);
      const r = { id: shortId(), file: path.basename(abs), quote: String(b.quote || '').trim() || null, text: userText(b), status: 'pending', at: now() };
      idea.refinements.push(r);
      await save(idea);
      wake();
      return r;
    },

    'POST /api/ideas/delete': async (_q, b) => {
      const idea = getIdea(b.id);
      if (job?.idea === idea.id) throw httpError(409, 'Claude is working on this idea. Wait for it first.');
      ideas.delete(idea.id);
      await rm(ideaDir(idea.id), { recursive: true, force: true });
      broadcast('ideas_changed', {});
      return { ok: true };
    },

    'GET /api/jobs/next': async (q, _b, signal) => nextJob(Number(q.get('timeout') ?? 300), signal),
    'GET /api/jobs/current': async () => (job ? jobView(job) : { job: null }),
    'POST /api/jobs/complete': async (_q, b) => {
      await completeJob(currentJob(b.job_id), b.text);
      return { ok: true };
    },
    'POST /api/jobs/release': async (_q, b) => {
      if (job) {
        currentJob(b.job_id);
        endJob();
      }
      return { ok: true };
    },
    'GET /api/presence': async () => presence(),
  };

  loadAll();
  return {
    id,
    repo,
    root: ROOT,
    routes,
    presence,
    counts: () => {
      const c = Object.fromEntries(STAGES.map((s) => [s, 0]));
      for (const i of ideas.values()) c[i.stage] = (c[i.stage] || 0) + 1;
      return c;
    },
    close: () => watcher?.close(),
  };
}

// ---------- Registry: which repos the daemon serves ----------

const workspaces = new Map();

function workspaceId(repo) {
  const slug = path.basename(repo).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'repo';
  return `${slug}-${createHash('sha1').update(repo).digest('hex').slice(0, 4)}`;
}

async function saveRegistry() {
  await mkdir(HOME, { recursive: true });
  await writeFile(REGISTRY, JSON.stringify([...workspaces.values()].map((w) => ({ id: w.id, repo: w.repo })), null, 2));
}

function addWorkspace(repo) {
  const id = workspaceId(repo);
  if (!workspaces.has(id)) workspaces.set(id, makeWorkspace(id, repo));
  return workspaces.get(id);
}

async function loadRegistry() {
  let list = [];
  try {
    list = JSON.parse(await readFile(REGISTRY, 'utf8'));
  } catch {}
  for (const { repo } of list) {
    if (fs.existsSync(repo)) addWorkspace(repo);
    else console.warn(`Skipping ${repo}: folder no longer exists`);
  }
}

const describe = (w) => ({ id: w.id, name: path.basename(w.repo), repo: w.repo, root: w.root, presence: w.presence(), counts: w.counts() });

const globalRoutes = {
  'GET /api/workspaces': async () => ({ workspaces: [...workspaces.values()].map(describe) }),

  'POST /api/workspaces': async (_q, b) => {
    if (typeof b.repo !== 'string' || !path.isAbsolute(b.repo)) throw httpError(400, 'repo must be an absolute path');
    const repo = path.resolve(b.repo);
    if (!fs.statSync(repo, { throwIfNoEntry: false })?.isDirectory()) throw httpError(400, `Not a folder: ${repo}`);
    const isNew = !workspaces.has(workspaceId(repo));
    const w = addWorkspace(repo);
    if (isNew) {
      await saveRegistry();
      broadcastAll('workspaces_changed', {});
    }
    return { id: w.id, repo: w.repo, root: w.root, url: `http://127.0.0.1:${PORT}/#/${w.id}` };
  },

  'POST /api/workspaces/remove': async (_q, b) => {
    const w = workspaces.get(b.id);
    if (!w) throw httpError(404, `No workspace ${b.id}`);
    w.close();
    workspaces.delete(b.id);
    await saveRegistry();
    broadcastAll('workspaces_changed', {});
    return { ok: true };
  },

  'POST /api/shutdown': async () => {
    setTimeout(() => process.exit(0), 50);
    return { ok: true };
  },
};

// ---------- HTTP ----------

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };

async function readBody(req) {
  let raw = '';
  for await (const chunk of req) raw += chunk;
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw httpError(400, 'Body is not valid JSON');
  }
}

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Only talk to local tools: a localhost Host header (no DNS rebinding) and JSON bodies (no simple cross-site POSTs)
const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/;

function findRoute(method, pathname) {
  const m = pathname.match(/^\/api\/w\/([^/]+)(\/.*)$/);
  if (!m) return globalRoutes[`${method} ${pathname}`];
  const w = workspaces.get(decodeURIComponent(m[1]));
  if (!w) throw httpError(404, `No workspace ${m[1]}. Register it with: signals serve <repo>`);
  return w.routes[`${method} /api${m[2]}`];
}

await loadRegistry();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (!LOCAL_HOST.test(req.headers.host || '')) return send(res, 403, { error: 'Forbidden host' });
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      for (const w of workspaces.values()) res.write(`event: presence\ndata: ${JSON.stringify(w.presence())}\n\n`);
      clients.add(res);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }
    if (url.pathname === '/api/health') return send(res, 200, { ok: true, pid: process.pid, workspaces: workspaces.size });
    if (url.pathname.startsWith('/api/')) {
      const route = findRoute(req.method, url.pathname);
      if (!route) return send(res, 404, { error: 'Not found' });
      if (req.method !== 'GET' && !String(req.headers['content-type'] || '').startsWith('application/json')) {
        return send(res, 415, { error: 'Send JSON (Content-Type: application/json)' });
      }
      const body = req.method === 'GET' ? {} : await readBody(req);
      const hangup = new AbortController();
      res.on('close', () => res.writableFinished || hangup.abort());
      const result = await route(url.searchParams, body, hangup.signal);
      if (hangup.signal.aborted) return;
      return send(res, 200, result);
    }
    if (req.method !== 'GET') return send(res, 404, { error: 'Not found' });
    const file = path.normalize(path.join(APP_DIR, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(APP_DIR + path.sep)) return send(res, 403, { error: 'Forbidden' });
    const data = await readFile(file).catch(() => null);
    if (!data) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': `${MIME[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch (err) {
    send(res, err.status || 500, { error: err.message });
  }
});

server.on('error', (err) => {
  console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is already in use (is the daemon already running?)` : err.message);
  process.exit(1);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Signals daemon at http://127.0.0.1:${PORT} (pid ${process.pid})`);
  console.log(`Serving ${workspaces.size} workspace(s). Add one with: signals serve <repo>`);
});
