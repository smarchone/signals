// Signals daemon: the human operating plane for many repos.
// Each registered repo is a workspace with at most one idea, in <repo>/.signals/:
//   idea.json   the meeting transcript, the go/no-go verdict, the stage, change requests
//   context/    the distilled context files (business, product, model, vocab, architecture)
//
// Distilling is staged, high level first, with your review gate after each step:
//   brief (product + business + model) -> design (vocab + architecture)
//
// A local Claude Code session per repo (the /signals skill) long-polls for jobs:
//   panel    you spoke last in a meeting       -> the panel (CEO, PM, Architect) answers
//   distill  a distill step is queued          -> the worker writes that step's files
//   refine   you asked for a change in a file  -> the worker edits it
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

// The opinionated context set, in reading order, and the steps that write it.
const CONTEXT_FILES = ['business.md', 'product.md', 'model.md', 'vocab.md', 'architecture.md'];
const DISTILL_STEPS = [
  { id: 'brief', label: 'Brief', files: ['business.md', 'product.md', 'model.md'] },
  { id: 'design', label: 'Design', files: ['vocab.md', 'architecture.md'] },
];
// Ideas distilled under the earlier four-step flow map onto the two stages
const LEGACY_STEP = { outline: 'brief', model: 'design', architecture: 'design' };
const stepOf = (sid) => DISTILL_STEPS.find((x) => x.id === sid);

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
  const IDEA_FILE = path.join(ROOT, 'idea.json');
  fs.mkdirSync(ROOT, { recursive: true });
  const broadcast = (event, data) => broadcastAll(event, { ...data, workspace: id });

  // ---------- The repo's one idea, cached in memory ----------
  // `ideas` holds at most one entry; it stays a map so routes and jobs keep addressing the idea by id.

  const ideas = new Map(); // id -> idea
  const contextDir = () => path.join(ROOT, 'context');

  // Earlier layout: .signals/ideas/<id>/{idea.json,context/}. Move the most recent idea up, once.
  function migrateLegacy() {
    const legacy = path.join(ROOT, 'ideas');
    if (fs.existsSync(IDEA_FILE) || !fs.existsSync(legacy)) return;
    const found = fs
      .readdirSync(legacy, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(legacy, e.name, 'idea.json')))
      .map((e) => ({ dir: path.join(legacy, e.name), at: fs.statSync(path.join(legacy, e.name, 'idea.json')).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    if (!found.length) return;
    fs.renameSync(path.join(found[0].dir, 'idea.json'), IDEA_FILE);
    if (fs.existsSync(path.join(found[0].dir, 'context')) && !fs.existsSync(contextDir())) fs.renameSync(path.join(found[0].dir, 'context'), contextDir());
    console.log(`${id}: moved ${path.basename(found[0].dir)} to .signals/ (one idea per repo)${found.length > 1 ? `; ${found.length - 1} older idea(s) left in .signals/ideas/` : ''}`);
  }

  function loadAll() {
    migrateLegacy();
    try {
      const idea = JSON.parse(fs.readFileSync(IDEA_FILE, 'utf8'));
      if (idea.stage === 'committed') idea.stage = 'distilling';
      if (idea.stage === 'distilling' && !idea.distill) idea.distill = { step: 'brief', status: 'queued', guidance: idea.distill_guidance || null, at: now() };
      if (idea.distill && LEGACY_STEP[idea.distill.step]) {
        idea.distill.step = LEGACY_STEP[idea.distill.step];
        idea.distill.approved = [...new Set((idea.distill.approved || []).map((x) => LEGACY_STEP[x] || x))].filter((x) => x !== idea.distill.step);
      }
      ideas.set(idea.id, idea);
    } catch {}
  }

  async function save(idea) {
    idea.updated_at = now();
    await writeFile(IDEA_FILE, JSON.stringify(idea, null, 2));
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
    if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]*\.md$/i.test(name)) throw httpError(400, 'file must be a context file name like model.md');
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
      distill: idea.distill || null,
      waiting_on: pending ? 'claude' : idea.stage === 'meeting' || reviewing(idea) ? 'you' : null,
      working: job?.idea === idea.id ? job.type : null,
    };
  }

  // ---------- Jobs: derived from idea state, one at a time per workspace ----------
  //
  // GET  /api/jobs/next?timeout=300  long-poll; claims the oldest waiting work
  // POST /api/jobs/complete          { job_id, text } posts the panel reply / distill summary / refine reply
  // POST /api/jobs/release           { job_id } gives the work back without an answer

  // A distill step is written and waiting at your review gate
  const reviewing = (idea) => idea.stage === 'distilling' && idea.distill?.status === 'review';
  const canRefine = (idea) => idea.stage === 'distilled' || reviewing(idea);
  // Finished change requests are iteration noise once their stage moves on: drop them (pending ones stay)
  function clearRefinements(idea, files) {
    idea.refinements = idea.refinements.filter((r) => r.status === 'pending' || !files.includes(r.file));
  }

  // What an idea is waiting on Claude for, if anything (and since when)
  function needs(idea) {
    if (idea.stage === 'meeting' && idea.messages.at(-1)?.author === 'you') return { type: 'panel', at: idea.messages.at(-1).at };
    if (idea.stage === 'distilling' && idea.distill?.status === 'queued') return { type: 'distill', at: idea.distill.at };
    if (canRefine(idea)) {
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
    job = { id: shortId(), type: need.type, idea: idea.id, refinement: need.refinement, claimed_at: now(), claimed_ms: Date.now() };
    // Before the worker changes files you've seen, remember them as you last reviewed them (a refine can ripple)
    rememberReviewed(need.type === 'refine' ? CONTEXT_FILES : need.type === 'distill' ? stepOf(idea.distill.step).files : []);
    broadcast('idea_changed', { idea: idea.id });
    broadcastPresence();
    return job;
  }

  // ---------- What you last reviewed, in memory only, so the UI can highlight what changed since ----------
  // Several changes accumulate against the same baseline until you approve the stage or mark the file reviewed.

  const reviewed = new Map(); // file name -> content as last reviewed
  function rememberReviewed(files) {
    for (const f of files) {
      if (reviewed.has(f)) continue;
      try {
        reviewed.set(f, fs.readFileSync(path.join(contextDir(), f), 'utf8'));
      } catch {} // a file that doesn't exist yet has nothing to compare against
    }
  }
  function forgetReviewed(files) {
    for (const f of files) reviewed.delete(f);
  }

  function transcript(idea) {
    return idea.messages.map((m) => ({ author: m.author === 'you' ? 'user' : 'panel', text: m.text }));
  }

  function jobView(j) {
    const idea = getIdea(j.idea);
    const base = { id: j.id, type: j.type, idea: { id: idea.id, title: idea.title } };
    if (j.type === 'panel') return { job: { ...base, transcript: transcript(idea) } };
    if (j.type === 'distill') {
      const step = stepOf(idea.distill.step);
      const n = DISTILL_STEPS.indexOf(step);
      // update: the stage's files exist from an earlier pass, so edit them rather than start over
      j.mode ??= step.files.every((f) => fs.existsSync(contextFile(idea.id, f))) ? 'update' : 'create';
      const since = idea.distill.since;
      return {
        job: {
          ...base,
          step: step.id,
          step_number: `${n + 1} of ${DISTILL_STEPS.length}`,
          mode: j.mode,
          new_turns: j.mode === 'update' && since != null && since < idea.messages.length ? transcript(idea).slice(since) : null,
          files: step.files,
          approved: [...new Set(DISTILL_STEPS.slice(0, n).flatMap((x) => x.files))].filter((f) => !step.files.includes(f)),
          context_dir: contextDir(idea.id),
          guidance: idea.distill.guidance || null,
          verdict: idea.verdict,
          transcript: transcript(idea),
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

  async function completeJob(j, text, question = false) {
    const idea = getIdea(j.idea);
    const reply = String(text || '').trim();
    if (j.type === 'panel') {
      if (!reply) throw httpError(400, 'text (the panel reply) is required');
      idea.messages.push({ id: shortId(), author: 'panel', text: reply, at: now() });
    } else if (j.type === 'distill') {
      // A fresh pass must write every file of the stage; an update may leave a file that needed no change
      const step = stepOf(idea.distill.step);
      const stale = j.mode === 'update' ? [] : step.files.filter((f) => (fs.statSync(contextFile(idea.id, f), { throwIfNoEntry: false })?.mtimeMs ?? 0) < j.claimed_ms - 1000);
      if (stale.length) throw httpError(409, `Write ${stale.join(', ')} for the ${step.label} step first (in ${contextDir(idea.id)})`);
      Object.assign(idea.distill, { status: 'review', note: reply || null, at: now() });
    } else {
      // A request the worker couldn't act on comes back as a question, which stays visible until dismissed
      const r = idea.refinements.find((x) => x.id === j.refinement);
      if (r) Object.assign(r, { status: question ? 'asked' : 'done', reply: reply || 'Done.', done_at: now() });
    }
    endJob();
    await save(idea);
    wake(); // more work may be waiting
  }

  // ---------- Watch context files, so the UI shows the distill as it happens ----------

  const watchTimers = new Map();
  let watcher = null;
  try {
    watcher = fs.watch(ROOT, { recursive: true }, (_type, filename) => {
      if (!filename) return;
      const parts = filename.split(path.sep);
      if (parts[0] !== 'context' || parts.length !== 2 || !filename.endsWith('.md')) return;
      const iid = [...ideas.keys()][0];
      if (!iid) return;
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
      const context = await contextFiles(idea.id);
      // For each file changed since you last reviewed it: the content you reviewed
      const changes = Object.fromEntries(context.filter((f) => reviewed.has(f.name) && reviewed.get(f.name) !== f.content).map((f) => [f.name, reviewed.get(f.name)]));
      return { ...idea, ...summary(idea), context, changes };
    },

    // You've looked at the changes: stop highlighting them (one file, or all)
    'POST /api/ideas/reviewed': async (_q, b) => {
      const idea = getIdea(b.id);
      forgetReviewed(b.file ? [path.basename(contextFile(idea.id, b.file))] : CONTEXT_FILES);
      broadcast('idea_changed', { idea: idea.id });
      return { ok: true };
    },

    // Start a meeting: the first message is the raw hunch. One idea per repo.
    'POST /api/ideas': async (_q, b) => {
      const existing = [...ideas.values()][0];
      if (existing) throw httpError(409, `This repo already has an idea ("${existing.title}"). Delete it to start another.`);
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
      if (b.decision === 'commit') {
        // since: where the meeting stood at the last commit, so a re-distill knows which turns are new
        idea.distill = { step: 'brief', status: 'queued', guidance: String(b.guidance || '').trim() || null, at: now(), since: idea.distill_basis ?? null };
        idea.distill_basis = idea.messages.length;
      }
      await save(idea);
      broadcast('ideas_changed', {});
      wake();
      return summary(idea);
    },

    // Back to the table: a killed idea gets a second hearing, or a committed one gets rethought.
    // Its context stays until you commit again, which distills it afresh, rewriting the files in place.
    'POST /api/ideas/reopen': async (_q, b) => {
      const idea = getIdea(b.id);
      if (job?.idea === idea.id) throw httpError(409, 'Claude is working on this idea. Wait for it first.');
      if (idea.refinements.some((r) => r.status === 'pending')) throw httpError(409, 'Changes you asked for are still being made. Reopen once they land.');
      idea.stage = 'meeting';
      idea.verdict = null;
      await save(idea);
      broadcast('ideas_changed', {});
      return summary(idea);
    },

    // Pass the review gate: the next distill step starts, or the idea is distilled
    'POST /api/ideas/approve': async (_q, b) => {
      const idea = getIdea(b.id);
      if (!reviewing(idea)) throw httpError(409, 'Nothing is waiting for your review.');
      if (job?.idea === idea.id || idea.refinements.some((r) => r.status === 'pending')) throw httpError(409, 'Changes you asked for are still being made. Approve once they land.');
      const n = DISTILL_STEPS.findIndex((x) => x.id === idea.distill.step);
      clearRefinements(idea, DISTILL_STEPS[n].files);
      forgetReviewed(DISTILL_STEPS[n].files);
      (idea.distill.approved ||= []).push(idea.distill.step);
      if (n === DISTILL_STEPS.length - 1) {
        idea.stage = 'distilled';
        idea.distilled = { at: now() };
        idea.distill.status = 'done';
      } else {
        Object.assign(idea.distill, { step: DISTILL_STEPS[n + 1].id, status: 'queued', guidance: String(b.guidance || '').trim() || null, note: null, at: now() });
      }
      await save(idea);
      broadcast('ideas_changed', {});
      wake();
      return summary(idea);
    },

    // Redo. With step, restart the distill from that step; without, redo the step under review. Existing files
    // are updated in place (job mode 'update'). Guidance is the human's direction for the change.
    'POST /api/ideas/redo': async (_q, b) => {
      const idea = getIdea(b.id);
      if (job?.idea === idea.id) throw httpError(409, 'Claude is working on this idea. Wait for it first.');
      if (idea.refinements.some((r) => r.status === 'pending')) throw httpError(409, 'Changes you asked for are still being made. Redo once they land.');
      const guidance = String(b.guidance || '').trim() || null;
      if (b.step && (idea.stage === 'distilled' || reviewing(idea))) {
        const step = stepOf(b.step);
        if (!step) throw httpError(400, `step must be one of ${DISTILL_STEPS.map((x) => x.id).join(', ')}`);
        idea.stage = 'distilling';
        idea.distill = { step: step.id, status: 'queued', guidance, at: now(), since: idea.distill_basis ?? null, approved: DISTILL_STEPS.slice(0, DISTILL_STEPS.indexOf(step)).map((x) => x.id) };
      } else if (reviewing(idea)) {
        clearRefinements(idea, stepOf(idea.distill.step).files);
        Object.assign(idea.distill, { status: 'queued', guidance, note: null, at: now() });
      } else {
        throw httpError(409, 'Only a step under review, or a distilled idea, can be redone.');
      }
      await save(idea);
      broadcast('ideas_changed', {});
      wake();
      return summary(idea);
    },

    // Ask for a change to one context file, optionally anchored to a quote
    'POST /api/ideas/refine': async (_q, b) => {
      const idea = getIdea(b.id);
      if (!canRefine(idea)) throw httpError(409, 'Context files can be changed while a step is under review, or once the idea is distilled.');
      const abs = contextFile(idea.id, b.file);
      if (!fs.existsSync(abs)) throw httpError(404, `No context file ${b.file}`);
      const r = { id: shortId(), file: path.basename(abs), quote: String(b.quote || '').trim() || null, text: userText(b), status: 'pending', at: now() };
      idea.refinements.push(r);
      await save(idea);
      wake();
      return r;
    },

    // Close a question the worker asked about a change request
    'POST /api/ideas/refine/dismiss': async (_q, b) => {
      const idea = getIdea(b.id);
      const before = idea.refinements.length;
      idea.refinements = idea.refinements.filter((r) => !(r.id === b.refinement && r.status !== 'pending'));
      if (idea.refinements.length === before) throw httpError(404, `No finished change request ${b.refinement}`);
      await save(idea);
      return { ok: true };
    },

    'POST /api/ideas/delete': async (_q, b) => {
      const idea = getIdea(b.id);
      if (job?.idea === idea.id) throw httpError(409, 'Claude is working on this idea. Wait for it first.');
      ideas.delete(idea.id);
      forgetReviewed(CONTEXT_FILES);
      await rm(IDEA_FILE, { force: true });
      await rm(contextDir(), { recursive: true, force: true });
      broadcast('ideas_changed', {});
      return { ok: true };
    },

    'GET /api/jobs/next': async (q, _b, signal) => nextJob(Number(q.get('timeout') ?? 300), signal),
    'GET /api/jobs/current': async () => (job ? jobView(job) : { job: null }),
    'POST /api/jobs/complete': async (_q, b) => {
      await completeJob(currentJob(b.job_id), b.text, Boolean(b.question));
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
    idea: () => {
      const i = [...ideas.values()][0];
      return i ? summary(i) : null;
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

// path: the repo folder shown with ~ for the home directory
const describe = (w) => ({
  id: w.id,
  name: path.basename(w.repo),
  repo: w.repo,
  path: w.repo.startsWith(os.homedir()) ? `~${w.repo.slice(os.homedir().length)}` : w.repo,
  root: w.root,
  presence: w.presence(),
  idea: w.idea(),
});

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
