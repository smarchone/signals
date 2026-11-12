// Signals daemon: the human operating plane for many repos.
// Each registered repo is a workspace with one living context, in <repo>/.signals/:
//   idea.json    the meetings (transcripts, go/no-go verdicts), the distill state, change requests, executions
//   meetings.md  the meetings log: one entry per call (committed or killed), added to, never rewritten
//   context/     the distilled context files (business, product, model, vocab, architecture)
//   prds/        the plan layer: PRDs (01-<slug>.md, …), units of work to hand to an executor
//
// Meetings: M1 sets up the context; each later meeting proposes a change to it. One is active at a time: you
// resume the latest one, or start the next. The panel reads only the context and the meetings log (plus the
// meeting it is in), never older transcripts; a PRD only when you pull one in. Committing a meeting amends the
// context, through the same reviewed stages, and adds its log entry when you approve the last one.
//
// Distilling is staged, high level first, with your review gate after each step:
//   brief (product + business + model) -> design (vocab + architecture)
// Once distilled, you ask for PRDs; they get their own review gate, then each one can be handed off: copied as a
// prompt for your own agent, or executed here in a background Claude Code session (claude --bg), one at a time.
//
// A local Claude Code session per repo (the /signals skill) long-polls for jobs:
//   panel    you spoke last in a meeting       -> the panel (CEO, PM, Architect) answers
//   distill  a distill step is queued          -> the worker writes that step's files
//   prd      you asked for PRDs                 -> the worker cuts the context into PRDs
//   refine   you asked for a change in a file  -> the worker edits it (context file or PRD)
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
import { spawn } from 'node:child_process';

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
const PRD_DIR = 'prds'; // relative names of PRDs carry this prefix (prds/01-skeleton.md); context files are bare
const isPrd = (name) => name.startsWith(`${PRD_DIR}/`);
// Ideas distilled under the earlier four-step flow map onto the two stages
const LEGACY_STEP = { outline: 'brief', model: 'design', architecture: 'design' };
const stepOf = (sid) => DISTILL_STEPS.find((x) => x.id === sid);

const httpError = (status, message) => Object.assign(new Error(message), { status });
const now = () => new Date().toISOString();
const shortId = () => randomUUID().slice(0, 8);

// ---------- Claude Code background sessions (claude --bg), which build PRDs ----------

const CLAUDE = process.env.SIGNALS_CLAUDE || 'claude';
function runClaude(args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(CLAUDE, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const timer = setTimeout(() => child.kill(), 60000);
    child.on('error', (err) => (clearTimeout(timer), resolve({ code: -1, out: err.message })));
    child.on('close', (code) => (clearTimeout(timer), resolve({ code, out })));
  });
}
// A session's state in `claude agents --json`, as an execution status
const SESSION_STATUS = { working: 'building', blocked: 'blocked', done: 'built' };

// The executor's last reply in a Claude session (its summary of the build), read from the session transcript
// (<config>/projects/<project>/<session_id>.jsonl). Null if the transcript or a reply can't be found.
async function lastReply(sessionId) {
  if (!sessionId) return null;
  const projects = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'projects');
  let dirs = [];
  try {
    dirs = await readdir(projects);
  } catch {
    return null;
  }
  for (const d of dirs) {
    let lines;
    try {
      lines = (await readFile(path.join(projects, d, `${sessionId}.jsonl`), 'utf8')).split('\n');
    } catch {
      continue;
    }
    for (const line of lines.reverse()) {
      if (!line.includes('"assistant"')) continue;
      try {
        const m = JSON.parse(line);
        if (m.type !== 'assistant' || !Array.isArray(m.message?.content)) continue;
        const text = m.message.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n\n').trim();
        if (text) return text;
      } catch {}
    }
    return null;
  }
  return null;
}
// The section a PRD gets when you mark its execution complete: the executor's own summary of what it changed
const SUMMARY_HEADING = '## Execution summary';

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

  // ---------- The repo's project (meetings, distill state, PRD bookkeeping), cached in memory ----------
  // `ideas` holds at most one entry; it stays a map so routes and jobs keep addressing the idea by id.

  const ideas = new Map(); // id -> idea
  const contextDir = () => path.join(ROOT, 'context');
  const LOG_FILE = path.join(ROOT, 'meetings.md');
  const LOG_HEAD = '# Meetings log\n\n> Every go / no-go call on this repo, oldest first. The context holds what stands; this is how it got there.\n';

  // ---------- Meetings ----------
  const cur = (idea) => idea.meetings.at(-1); // the active meeting: the only one you can talk in or resume
  const meetingOf = (idea, mid) => idea.meetings.find((m) => m.id === mid) || cur(idea);
  const lastCommitted = (idea) => [...idea.meetings].reverse().find((m) => m.stage === 'committed') || null;
  // The pipeline stage, derived: a distill in progress, else distilled context, else where the meeting stands
  function syncStage(idea) {
    const busy = idea.distill && idea.distill.status !== 'done';
    idea.stage = busy ? 'distilling' : idea.distilled ? 'distilled' : cur(idea).stage === 'killed' ? 'killed' : 'meeting';
  }
  const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);
  const fileHashes = () => Object.fromEntries(contextNow().map((f) => [f.name, sha(f.content)]));
  const changedBetween = (before = {}, after = {}) => CONTEXT_FILES.filter((f) => before[f] !== after[f]);

  // One log entry per call. A call after a resume says so; the earlier entry stays as it was.
  // log: { decided, ruled_out, context } in the worker's words; null for a kill (its why is the entry)
  function appendLog(m, decision, log, at = now()) {
    let entry = `## ${m.id}${m.resumes?.length ? ' (resumed)' : ''} · ${m.title} · ${decision} ${at.slice(0, 10)}\n`;
    if (m.verdict?.note) entry += `\nWhy: ${m.verdict.note}\n`;
    const section = (title, lines) => (lines?.length ? `\n**${title}**\n\n${lines.map((l) => `- ${l}`).join('\n')}\n` : '');
    if (log) {
      entry += section('Decided', log.decided) + section('Ruled out', log.ruled_out);
      entry += section('Context', log.context.length ? log.context : ['No change.']);
    }
    const head = fs.existsSync(LOG_FILE) ? '' : LOG_HEAD;
    fs.appendFileSync(LOG_FILE, `${head}\n${entry}`);
  }
  // The distill's log, gathered across stages in order. A changed file the worker said nothing about still gets a line.
  function logEntry(idea, changed) {
    const all = (k) => DISTILL_STEPS.flatMap((x) => idea.distill.log?.[x.id]?.[k] || []);
    const context = all('context');
    const missed = changed.filter((f) => !context.some((l) => l.startsWith(f)));
    return { decided: all('decided'), ruled_out: all('ruled_out'), context: [...context, ...missed.map((f) => `${f}: edited (no summary)`)] };
  }
  // The worker's log for one stage: { decided, ruled_out, context }, or a bare array of context lines
  const stageLog = (v) => {
    const o = Array.isArray(v) || typeof v === 'string' ? { context: v } : v || {};
    return { decided: logLines(o.decided), ruled_out: logLines(o.ruled_out), context: logLines(o.context) };
  };
  // Lines: an array, or one per line; bullets stripped
  const logLines = (v) =>
    (Array.isArray(v) ? v : String(v || '').split('\n'))
      .map((l) => String(l).replace(/^\s*[-*•]\s*/, '').trim())
      .filter(Boolean)
      .slice(0, 8);

  // Earlier layout: one meeting at the top level of idea.json. It becomes M1.
  function migrateMeetings(idea) {
    if (idea.meetings) return;
    const stage = { meeting: 'open', killed: 'killed' }[idea.stage] || 'committed';
    idea.meetings = [{ id: 'M1', title: idea.title, stage, created_at: idea.created_at, messages: idea.messages || [], verdict: idea.verdict || null, distill_basis: idea.distill_basis ?? null, resumes: [] }];
    if (idea.stage === 'distilled' && !idea.distilled) idea.distilled = { at: idea.updated_at };
    if (idea.distill) idea.distill.meeting = 'M1';
    if (idea.prd) idea.prd.meeting = 'M1';
    idea.prd_origin = Object.fromEntries(prdNames().map((n) => [n, 'M1']));
    if (idea.distilled) idea.context_basis = fileHashes();
    delete idea.messages;
    delete idea.verdict;
    delete idea.distill_basis;
    const m = idea.meetings[0];
    if (fs.existsSync(LOG_FILE)) return;
    // Backfill the log with M1's call. An open M1 with distilled context was committed, then reopened: log the
    // commit, and mark where it resumed.
    if (stage === 'killed') appendLog(m, 'killed', null, m.verdict?.at || idea.updated_at);
    else if (idea.distilled) {
      appendLog({ ...m, resumes: [] }, 'committed', { context: ['Set up the context: business, product, model, vocab and architecture.'] }, idea.distilled.at);
      if (stage === 'open') m.resumes.push({ at: idea.updated_at, from: m.distill_basis ?? m.messages.length, changed: [] });
    }
  }

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
      const legacy = !idea.meetings;
      migrateMeetings(idea);
      syncStage(idea);
      if (legacy) fs.writeFileSync(IDEA_FILE, JSON.stringify(idea, null, 2)); // keep the migration with the log it backfilled
      ideas.set(idea.id, idea);
    } catch {}
  }

  async function save(idea) {
    syncStage(idea);
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

  // PRDs: .signals/prds/*.md, named by their relative path (prds/01-skeleton.md) so they never clash with context
  const prdDir = () => path.join(ROOT, PRD_DIR);
  async function prdFiles() {
    const names = (await readdir(prdDir()).catch(() => [])).filter((n) => n.endsWith('.md')).sort();
    return Promise.all(names.map(async (n) => ({ name: `${PRD_DIR}/${n}`, content: await readFile(path.join(prdDir(), n), 'utf8') })));
  }
  const prdNames = () => (fs.existsSync(prdDir()) ? fs.readdirSync(prdDir()).filter((n) => n.endsWith('.md')).sort().map((n) => `${PRD_DIR}/${n}`) : []);
  // Any reviewable document by its relative name: a context file (model.md) or a PRD (prds/01-skeleton.md)
  function docFile(name) {
    if (typeof name === 'string' && isPrd(name)) {
      const base = name.slice(PRD_DIR.length + 1);
      if (!/^[a-z0-9][a-z0-9._-]*\.md$/i.test(base)) throw httpError(400, 'file must be a PRD name like prds/01-skeleton.md');
      return path.join(prdDir(), base);
    }
    return contextFile(null, name);
  }
  const docName = (abs) => (path.dirname(abs) === prdDir() ? `${PRD_DIR}/${path.basename(abs)}` : path.basename(abs));
  // The context the PRDs were cut from, so the UI can say when it has moved on since
  const contextHash = (context) => createHash('sha1').update(context.map((f) => `${f.name}\0${f.content}`).join('\0')).digest('hex').slice(0, 12);
  const contextNow = () =>
    CONTEXT_FILES.filter((f) => fs.existsSync(contextFile(null, f))).map((f) => ({ name: f, content: fs.readFileSync(contextFile(null, f), 'utf8') }));

  function summary(idea) {
    const pending = needs(idea);
    return {
      id: idea.id,
      title: idea.title,
      stage: idea.stage,
      meeting: { id: cur(idea).id, title: cur(idea).title, stage: cur(idea).stage },
      meeting_count: idea.meetings.length,
      verdict: cur(idea).verdict,
      created_at: idea.created_at,
      updated_at: idea.updated_at,
      message_count: cur(idea).messages.length,
      distill: idea.distill || null,
      prd: idea.prd || null,
      waiting_on: pending ? 'claude' : cur(idea).stage === 'open' || reviewing(idea) || reviewingPrds(idea) ? 'you' : null,
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
  // PRDs are written and waiting at their review gate; once approved, they can be changed or handed off
  const reviewingPrds = (idea) => idea.stage === 'distilled' && idea.prd?.status === 'review';
  const canRefineDoc = (idea, name) => (isPrd(name) ? ['review', 'done'].includes(idea.prd?.status) && !prdLocked(idea, name) : canRefine(idea));
  // A PRD being executed, or complete, is what was built: it stays as it is (a stopped one can still change)
  const prdLocked = (idea, name) => ['building', 'blocked', 'built', 'gone', 'complete'].includes(idea.executions?.[name]?.status);
  // Finished change requests are iteration noise once their stage moves on: drop them (pending ones stay)
  function clearRefinements(idea, files) {
    idea.refinements = idea.refinements.filter((r) => r.status === 'pending' || !files.includes(r.file));
  }

  // What an idea is waiting on Claude for, if anything (and since when)
  function needs(idea) {
    const m = cur(idea);
    if (m.stage === 'open' && m.messages.at(-1)?.author === 'you') return { type: 'panel', at: m.messages.at(-1).at };
    if (idea.stage === 'distilling' && idea.distill?.status === 'queued') return { type: 'distill', at: idea.distill.at };
    if (idea.stage === 'distilled' && idea.prd?.status === 'queued') return { type: 'prd', at: idea.prd.at };
    {
      const r = idea.refinements.find((x) => x.status === 'pending' && canRefineDoc(idea, x.file));
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
    const touches = { refine: [...CONTEXT_FILES, ...prdNames()], distill: idea.distill && stepOf(idea.distill.step)?.files, prd: prdNames() };
    rememberReviewed(touches[need.type] || []);
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
        reviewed.set(f, fs.readFileSync(docFile(f), 'utf8'));
      } catch {} // a file that doesn't exist yet has nothing to compare against
    }
  }
  function forgetReviewed(files) {
    for (const f of files) reviewed.delete(f);
  }

  function transcript(m) {
    return m.messages.map((m) => ({ author: m.author === 'you' ? 'user' : 'panel', text: m.text }));
  }

  function jobView(j) {
    const idea = getIdea(j.idea);
    const base = { id: j.id, type: j.type, idea: { id: idea.id, title: idea.title } };
    const present = () => CONTEXT_FILES.filter((f) => fs.existsSync(contextFile(idea.id, f)));
    const log = fs.existsSync(LOG_FILE) ? LOG_FILE : null;
    if (j.type === 'panel') {
      // The panel works from the context and the meetings log, plus this meeting; never older transcripts
      const m = cur(idea);
      const context = present();
      return {
        job: {
          ...base,
          meeting: { id: m.id, title: m.title, resumed: m.resumes?.at(-1) || null },
          context_dir: contextDir(),
          context,
          context_version: context.length ? contextHash(contextNow()) : null,
          meetings_log: log,
          prds_dir: prdDir(),
          transcript: transcript(m),
        },
      };
    }
    if (j.type === 'distill') {
      const m = meetingOf(idea, idea.distill.meeting);
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
          meeting: { id: m.id, title: m.title, resumed: Boolean(m.resumes?.length) },
          meetings_log: log,
          new_turns: j.mode === 'update' && since != null && since < m.messages.length ? transcript(m).slice(since) : null,
          files: step.files,
          approved: [...new Set(DISTILL_STEPS.slice(0, n).flatMap((x) => x.files))].filter((f) => !step.files.includes(f)),
          context_dir: contextDir(idea.id),
          guidance: idea.distill.guidance || null,
          verdict: m.verdict,
          transcript: transcript(m),
        },
      };
    }
    if (j.type === 'prd') {
      const m = meetingOf(idea, idea.prd.meeting);
      const existing = prdNames();
      j.before ??= existing; // to tell which PRDs an update added
      // update: PRDs exist from an earlier pass, so edit them (and add or drop some) rather than start over
      j.mode ??= existing.length ? 'update' : 'create';
      return {
        job: {
          ...base,
          mode: j.mode,
          prds_dir: prdDir(),
          context_dir: contextDir(),
          context: CONTEXT_FILES.filter((f) => fs.existsSync(contextFile(idea.id, f))),
          existing: existing.map((n) => path.basename(n)),
          handed_off: existing.filter((n) => idea.handoffs?.[n]).map((n) => path.basename(n)),
          context_changed: j.mode === 'update' && idea.prd.basis != null && idea.prd.basis !== contextHash(contextNow()),
          guidance: idea.prd.guidance || null,
          meeting: { id: m.id, title: m.title },
          verdict: m.verdict,
          transcript: transcript(m),
        },
      };
    }
    const r = idea.refinements.find((x) => x.id === j.refinement);
    return {
      job: {
        ...base,
        file: docFile(r.file),
        kind: isPrd(r.file) ? 'prd' : 'context',
        context_dir: contextDir(idea.id),
        prds_dir: prdDir(),
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

  async function completeJob(j, text, question = false, log = null) {
    const idea = getIdea(j.idea);
    const reply = String(text || '').trim();
    if (j.type === 'panel') {
      if (!reply) throw httpError(400, 'text (the panel reply) is required');
      cur(idea).messages.push({ id: shortId(), author: 'panel', text: reply, at: now() });
    } else if (j.type === 'distill') {
      // A fresh pass must write every file of the stage; an update may leave a file that needed no change
      const step = stepOf(idea.distill.step);
      const stale = j.mode === 'update' ? [] : step.files.filter((f) => (fs.statSync(contextFile(idea.id, f), { throwIfNoEntry: false })?.mtimeMs ?? 0) < j.claimed_ms - 1000);
      if (stale.length) throw httpError(409, `Write ${stale.join(', ')} for the ${step.label} step first (in ${contextDir(idea.id)})`);
      Object.assign(idea.distill, { status: 'review', note: reply || null, at: now() });
      (idea.distill.log ||= {})[step.id] = stageLog(log); // this stage's part of the meetings log; a redo replaces it
    } else if (j.type === 'prd') {
      const fresh = prdNames().filter((n) => fs.statSync(docFile(n)).mtimeMs >= j.claimed_ms - 1000);
      if (j.mode === 'create' && !fresh.length) throw httpError(409, `Write the PRDs first (01-<slug>.md, … in ${prdDir()})`);
      if (!prdNames().length) throw httpError(409, `No PRDs in ${prdDir()}. Write at least one.`);
      // PRDs an update added are new to you: the UI marks them, since there is no earlier version to compare
      const added = j.mode === 'update' ? prdNames().filter((n) => !(j.before || []).includes(n)) : [];
      // Each PRD belongs to the meeting whose change it builds
      const origin = (idea.prd_origin ||= {});
      for (const n of Object.keys(origin)) if (!prdNames().includes(n)) delete origin[n];
      for (const n of prdNames()) origin[n] ||= idea.prd.meeting || cur(idea).id;
      Object.assign(idea.prd, { status: 'review', note: reply || null, at: now(), basis: contextHash(contextNow()), updated: j.mode === 'update', added });
    } else {
      // A request the worker couldn't act on comes back as a question, which stays visible until dismissed
      const r = idea.refinements.find((x) => x.id === j.refinement);
      if (r) Object.assign(r, { status: question ? 'asked' : 'done', reply: reply || 'Done.', done_at: now() });
    }
    endJob();
    await save(idea);
    wake(); // more work may be waiting
  }

  // ---------- Executions: a PRD built by a background Claude Code session, right on this checkout ----------
  //
  // One at a time per workspace: the changes land uncommitted on the current branch, and you test them, steer
  // the session (claude attach <session>), commit, and mark the PRD complete before the next one can start.
  //   building -> built (the session finished its turn) · blocked (it waits on you) · gone (the session was removed)
  //   then complete (you marked it) or stopped (you ended it; its changes stay for you to keep or discard)
  const execOpen = (e) => Boolean(e) && !['complete', 'stopped'].includes(e.status);
  const openExecution = (idea) => Object.entries(idea?.executions || {}).find(([, e]) => execOpen(e)) || null;

  function prdHeading(name) {
    const head = fs.readFileSync(docFile(name), 'utf8').match(/^#\s+(.+)$/m)?.[1] || path.basename(name, '.md');
    return head.replace(/^PRD\s+/i, '').trim();
  }

  function execPrompt(name) {
    return `Implement PRD ${prdHeading(name)}.

The PRD is .signals/${name}. Deliver its Outcome and meet every Acceptance check, within its Scope, Constraints and Decisions.
Read .signals/context/ first (product.md, model.md, vocab.md, architecture.md) for the why and the shape, and use the terms in vocab.md exactly.

Work directly in this checkout, on the current branch. Don't create a branch, commit, push or open a pull request: the human tests your change, steers you in this session, and commits it. Don't edit anything under .signals/.
Make local decisions yourself. If the PRD or the context looks wrong, don't work around it: say so.
End with a short summary: what changed, how to try it, and how to check each Acceptance item.`;
  }

  // Bring open executions in line with their sessions (the daemon polls `claude agents --json --all`)
  async function syncExecutions(sessions) {
    const idea = [...ideas.values()][0];
    let moved = false;
    for (const e of Object.values(idea?.executions || {})) {
      if (!execOpen(e)) continue;
      const s = sessions.find((x) => x.id === e.session);
      const status = s ? SESSION_STATUS[s.state] || 'built' : 'gone';
      if (status !== e.status) {
        Object.assign(e, { status, at: now() });
        moved = true;
      }
      // Keep the Claude session id: it outlives the background agent, so the run can be resumed later
      if (s?.sessionId && s.sessionId !== e.session_id) {
        e.session_id = s.sessionId;
        moved = true;
      }
    }
    if (moved) await save(idea);
  }

  // ---------- Watch context files, so the UI shows the distill as it happens ----------

  const watchTimers = new Map();
  let watcher = null;
  try {
    watcher = fs.watch(ROOT, { recursive: true }, (_type, filename) => {
      if (!filename) return;
      const parts = filename.split(path.sep);
      if (!['context', PRD_DIR].includes(parts[0]) || parts.length !== 2 || !filename.endsWith('.md')) return;
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
      const prds = await prdFiles();
      // For each file changed since you last reviewed it: the content you reviewed
      const changes = Object.fromEntries([...context, ...prds].filter((f) => reviewed.has(f.name) && reviewed.get(f.name) !== f.content).map((f) => [f.name, reviewed.get(f.name)]));
      // The PRDs were cut from context that has changed since (a re-distill or a change request)
      const prd_stale = Boolean(prds.length && idea.prd?.basis && ['review', 'done'].includes(idea.prd.status) && idea.prd.basis !== contextHash(contextNow()));
      const log = await readFile(LOG_FILE, 'utf8').catch(() => null);
      return { ...idea, ...summary(idea), context, prds, changes, prd_stale, log };
    },

    // You've looked at the changes: stop highlighting them (one file, or all)
    'POST /api/ideas/reviewed': async (_q, b) => {
      const idea = getIdea(b.id);
      forgetReviewed(b.file ? [docName(docFile(b.file))] : [...CONTEXT_FILES, ...prdNames()]);
      broadcast('idea_changed', { idea: idea.id });
      return { ok: true };
    },

    // Start a meeting: the first message is the raw hunch. The first meeting creates the repo's context;
    // each later one proposes a change to it. One meeting is active at a time.
    'POST /api/ideas': async (_q, b) => {
      const text = userText(b);
      const title = String(b.title || '').trim() || text.split('\n')[0].slice(0, 60);
      const meeting = { id: 'M1', title, stage: 'open', created_at: now(), messages: [{ id: shortId(), author: 'you', text, at: now() }], verdict: null, resumes: [] };
      let idea = [...ideas.values()][0];
      if (idea) {
        const m = cur(idea);
        if (m.stage === 'open') throw httpError(409, `${m.id} is still open. Commit or kill it before starting another meeting.`);
        if (idea.stage === 'distilling') throw httpError(409, `Finish reviewing the context from ${idea.distill.meeting || m.id} first.`);
        if (job?.idea === idea.id) throw httpError(409, 'Claude is working on this repo. Wait for it first.');
        meeting.id = `M${idea.meetings.length + 1}`;
        idea.meetings.push(meeting);
      } else {
        idea = { id: ideaSlug(title), title, created_at: now(), updated_at: now(), meetings: [meeting], refinements: [] };
        ideas.set(idea.id, idea);
      }
      await save(idea);
      broadcast('ideas_changed', {});
      wake();
      return summary(idea);
    },

    'POST /api/ideas/message': async (_q, b) => {
      const idea = getIdea(b.id);
      if (cur(idea).stage !== 'open') throw httpError(409, 'The meeting is closed. Resume it to keep talking.');
      if (job?.idea === idea.id) throw httpError(409, 'The panel is still answering. Wait for it, then reply.');
      cur(idea).messages.push({ id: shortId(), author: 'you', text: userText(b), at: now() });
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
      const m = cur(idea);
      if (m.stage !== 'open') throw httpError(409, `${m.id} is already ${m.stage}.`);
      if (job?.idea === idea.id) throw httpError(409, 'The panel is still answering. Wait for it first.');
      if (idea.stage === 'distilling') throw httpError(409, 'Earlier context is still under review. Approve it first.');
      m.verdict = { decision: b.decision, note: String(b.note || '').trim() || null, at: now() };
      m.stage = b.decision === 'commit' ? 'committed' : 'killed';
      if (b.decision === 'commit') {
        // since: the turns this commit adds (a new meeting: all of them; a resumed one: those since its last commit).
        // before: the context as it stood, so the log can say which files the meeting changed.
        idea.distill = { step: 'brief', status: 'queued', guidance: String(b.guidance || '').trim() || null, at: now(), since: m.distill_basis ?? 0, meeting: m.id, before: fileHashes() };
        m.distill_basis = m.messages.length;
      } else {
        appendLog(m, 'killed', null);
      }
      await save(idea);
      broadcast('ideas_changed', {});
      wake();
      return summary(idea);
    },

    // Resume the latest meeting: a killed one gets a second hearing, or a committed one gets rethought.
    // The context stays until you commit again, which amends it with the new turns. Older meetings stay closed.
    'POST /api/ideas/resume': async (_q, b) => {
      const idea = getIdea(b.id);
      const m = cur(idea);
      if (m.stage === 'open') throw httpError(409, `${m.id} is already open.`);
      if (job?.idea === idea.id) throw httpError(409, 'Claude is working on this idea. Wait for it first.');
      if (idea.stage === 'distilling') throw httpError(409, `The context from ${m.id} is still under review. Approve or redo it first.`);
      if (idea.refinements.some((r) => r.status === 'pending')) throw httpError(409, 'Changes you asked for are still being made. Resume once they land.');
      // changed: context files edited since the last call, so the panel (and you) know what moved meanwhile
      (m.resumes ||= []).push({ at: now(), from: m.messages.length, changed: idea.context_basis ? changedBetween(idea.context_basis, fileHashes()) : [] });
      m.stage = 'open';
      m.verdict = null;
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
        idea.distilled = { at: now() };
        idea.distill.status = 'done';
        // Your approval of the last stage is the call landing: log it, with the files the meeting changed
        const after = fileHashes();
        appendLog(meetingOf(idea, idea.distill.meeting), idea.distill.revised ? 'context redone' : 'committed', logEntry(idea, changedBetween(idea.distill.before, after)));
        idea.context_basis = after;
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
        const m = idea.distill?.meeting ? meetingOf(idea, idea.distill.meeting) : lastCommitted(idea) || cur(idea);
        const done = idea.stage === 'distilled';
        idea.distill = {
          step: step.id,
          status: 'queued',
          guidance,
          at: now(),
          since: done ? (m.distill_basis ?? 0) : idea.distill.since,
          meeting: m.id,
          before: done ? fileHashes() : idea.distill.before,
          revised: done || idea.distill.revised || undefined,
          approved: DISTILL_STEPS.slice(0, DISTILL_STEPS.indexOf(step)).map((x) => x.id),
        };
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
      const abs = docFile(b.file);
      const name = docName(abs);
      if (isPrd(name) && prdLocked(idea, name)) throw httpError(409, 'This PRD has been executed: it stays as it is. Ask for a follow-up PRD instead.');
      if (!canRefineDoc(idea, name)) throw httpError(409, isPrd(name) ? 'PRDs can be changed once they are written.' : 'Context files can be changed while a step is under review, or once the idea is distilled.');
      if (!fs.existsSync(abs)) throw httpError(404, `No file ${b.file}`);
      const r = { id: shortId(), file: name, quote: String(b.quote || '').trim() || null, text: userText(b), status: 'pending', at: now() };
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

    // ---------- PRDs: the plan layer, cut from the distilled context ----------

    // Write the PRDs, or update them (with guidance: what to change; after a context change: catch up)
    'POST /api/prds/plan': async (_q, b) => {
      const idea = getIdea(b.id);
      if (idea.stage !== 'distilled') throw httpError(409, 'Approve the context first: PRDs are cut from the distilled context.');
      if (job?.idea === idea.id) throw httpError(409, 'Claude is working on this idea. Wait for it first.');
      if (idea.prd?.status === 'queued') throw httpError(409, 'The PRDs are already queued.');
      if (idea.refinements.some((r) => r.status === 'pending' && isPrd(r.file))) throw httpError(409, 'Changes you asked for are still being made. Try again once they land.');
      clearRefinements(idea, prdNames());
      // meeting: whose change these PRDs build (new PRDs are grouped under it)
      idea.prd = { status: 'queued', guidance: String(b.guidance || '').trim() || null, note: null, at: now(), basis: idea.prd?.basis ?? null, meeting: lastCommitted(idea)?.id || cur(idea).id };
      await save(idea);
      broadcast('ideas_changed', {});
      wake();
      return summary(idea);
    },

    // Pass the PRD review gate: each PRD is now ready to hand off
    'POST /api/prds/approve': async (_q, b) => {
      const idea = getIdea(b.id);
      if (!reviewingPrds(idea)) throw httpError(409, 'No PRDs are waiting for your review.');
      if (job?.idea === idea.id || idea.refinements.some((r) => r.status === 'pending' && isPrd(r.file))) throw httpError(409, 'Changes you asked for are still being made. Approve once they land.');
      clearRefinements(idea, prdNames());
      forgetReviewed(prdNames());
      Object.assign(idea.prd, { status: 'done', approved_at: now() });
      delete idea.prd.added;
      await save(idea);
      broadcast('ideas_changed', {});
      return summary(idea);
    },

    // Mark a PRD as handed to an executor. Handed-off PRDs aren't rewritten by later updates.
    'POST /api/prds/handoff': async (_q, b) => {
      const idea = getIdea(b.id);
      const name = docName(docFile(b.file));
      if (!isPrd(name) || !fs.existsSync(docFile(name))) throw httpError(404, `No PRD ${b.file}`);
      if (idea.prd?.status !== 'done') throw httpError(409, 'Approve the PRDs before handing one off.');
      (idea.handoffs ||= {})[name] = true;
      await save(idea);
      return { ok: true };
    },

    // Build a PRD now, in a background Claude Code session on this checkout. One open execution per workspace.
    'POST /api/prds/execute': async (_q, b) => {
      const idea = getIdea(b.id);
      const name = docName(docFile(b.file));
      if (!isPrd(name) || !fs.existsSync(docFile(name))) throw httpError(404, `No PRD ${b.file}`);
      if (idea.prd?.status !== 'done') throw httpError(409, 'Approve the PRDs before executing one.');
      if (idea.refinements.some((r) => r.status === 'pending' && r.file === name)) throw httpError(409, 'A change you asked for on this PRD is still being made.');
      const open = openExecution(idea);
      if (open) throw httpError(409, `${open[0]} is still open. Test it, commit, and mark it complete (or stop it) first.`);
      if (idea.executions?.[name]?.status === 'complete') throw httpError(409, `${name} is already complete.`);
      const label = `signals · PRD ${prdHeading(name)}`.slice(0, 60);
      const { code, out } = await runClaude(['--bg', '-n', label, execPrompt(name)], repo);
      const session = out.match(/backgrounded\s+·\s+([0-9a-f]+)/)?.[1];
      if (code !== 0 || !session) throw httpError(502, `Couldn't start a background Claude session: ${out.trim().split('\n').at(-1) || `exit ${code}`}`);
      const session_id = out.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
      // Executing again keeps the earlier runs' sessions, newest first
      const prev = idea.executions?.[name];
      const runs = prev ? [{ session: prev.session, session_id: prev.session_id, status: prev.status, started_at: prev.started_at, at: prev.at }, ...(prev.runs || [])] : undefined;
      (idea.executions ||= {})[name] = { session, ...(session_id && { session_id }), status: 'building', started_at: now(), at: now(), ...(runs && { runs }) };
      (idea.handoffs ||= {})[name] = true; // an executor is building it: later PRD updates leave it alone
      await save(idea);
      return idea.executions[name];
    },

    // Close out an execution: complete (you tested and committed it; the executor's last reply is appended to the
    // PRD as its Execution summary) or stop (end the session)
    'POST /api/prds/execution': async (_q, b) => {
      const idea = getIdea(b.id);
      const name = docName(docFile(b.file));
      const e = idea.executions?.[name];
      // A stopped execution can still be completed: you may have finished it yourself
      if (!execOpen(e) && !(e?.status === 'stopped' && b.action === 'complete')) throw httpError(409, `${name} has no open execution.`);
      if (b.action === 'stop') {
        if (['building', 'blocked', 'built'].includes(e.status)) await runClaude(['stop', e.session], repo);
        Object.assign(e, { status: 'stopped', at: now() });
      } else if (b.action === 'complete') {
        const reply = await lastReply(e.session_id);
        if (reply) {
          // Shift the reply's own headings below the section's, and replace a summary from an earlier completion
          const body = reply.replace(/^(#{1,5})(\s)/gm, '$1##$2');
          const prd = (await readFile(docFile(name), 'utf8')).split(`\n${SUMMARY_HEADING}\n`)[0].trimEnd();
          await writeFile(docFile(name), `${prd}\n\n${SUMMARY_HEADING}\n\n${body}\n`);
        }
        Object.assign(e, { status: 'complete', summarized: Boolean(reply), at: now() });
      } else throw httpError(400, 'action must be complete or stop');
      await save(idea);
      return e;
    },

    // Drop one PRD. Numbers aren't reused or shifted, so the others keep their names (and their handoffs).
    'POST /api/prds/remove': async (_q, b) => {
      const idea = getIdea(b.id);
      const name = docName(docFile(b.file));
      if (!isPrd(name) || !fs.existsSync(docFile(name))) throw httpError(404, `No PRD ${b.file}`);
      if (prdLocked(idea, name)) throw httpError(409, 'This PRD has been executed: it stays as it is.');
      if (!['review', 'done'].includes(idea.prd?.status)) throw httpError(409, 'PRDs can be removed once they are written.');
      if (job?.idea === idea.id) throw httpError(409, 'Claude is working on this idea. Wait for it first.');
      if (idea.refinements.some((r) => r.status === 'pending' && r.file === name)) throw httpError(409, 'A change you asked for on this PRD is still being made.');
      await rm(docFile(name));
      forgetReviewed([name]);
      idea.refinements = idea.refinements.filter((r) => r.file !== name);
      if (idea.handoffs) delete idea.handoffs[name];
      if (idea.executions) delete idea.executions[name];
      if (idea.prd_origin) delete idea.prd_origin[name];
      if (idea.prd.added) idea.prd.added = idea.prd.added.filter((n) => n !== name);
      if (!prdNames().length) delete idea.prd; // nothing left: back to planning from scratch
      await save(idea);
      broadcast('ideas_changed', {});
      return { ok: true };
    },

    'POST /api/ideas/delete': async (_q, b) => {
      const idea = getIdea(b.id);
      if (job?.idea === idea.id) throw httpError(409, 'Claude is working on this idea. Wait for it first.');
      ideas.delete(idea.id);
      forgetReviewed([...CONTEXT_FILES, ...prdNames()]);
      await rm(IDEA_FILE, { force: true });
      await rm(contextDir(), { recursive: true, force: true });
      await rm(prdDir(), { recursive: true, force: true });
      await rm(LOG_FILE, { force: true });
      broadcast('ideas_changed', {});
      return { ok: true };
    },

    'GET /api/jobs/next': async (q, _b, signal) => nextJob(Number(q.get('timeout') ?? 300), signal),
    'GET /api/jobs/current': async () => (job ? jobView(job) : { job: null }),
    'POST /api/jobs/complete': async (_q, b) => {
      await completeJob(currentJob(b.job_id), b.text, Boolean(b.question), b.log);
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
    executing: () => Boolean(openExecution([...ideas.values()][0])),
    syncExecutions,
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

// Follow the background sessions building PRDs, only while some workspace has one open
let syncing = false;
setInterval(async () => {
  const live = [...workspaces.values()].filter((w) => w.executing());
  if (!live.length || syncing) return;
  syncing = true;
  try {
    const { code, out } = await runClaude(['agents', '--json', '--all'], HOME);
    if (code === 0) for (const w of live) await w.syncExecutions(JSON.parse(out));
  } catch (err) {
    console.warn('Session sync failed:', err.message);
  } finally {
    syncing = false;
  }
}, 5000);

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
