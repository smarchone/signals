#!/usr/bin/env node
// signals serve [repo]   start the daemon if it isn't running, then register <repo> (default: current folder).
//                        In the hub folder (~/signals_workspace) it registers nothing: a worker there is the hub.
// signals status         list the workspaces the daemon serves
// signals remove [repo]  unregister <repo> (default: current folder) or a workspace id; its .signals/ stays on disk
// signals stop           stop the daemon
// signals restart        stop and start the daemon (picks up a new server.js); registered repos come back
//                        and listening workers reconnect on their own. Refuses mid-job unless --force.
//
// The daemon runs detached from whoever started it (its own session, output to $SIGNALS_HOME/daemon.log),
// so closing the terminal or Claude session that ran `signals serve` doesn't stop it.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'server.js');
const PORT = Number(process.env.PORT) || 3461;
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = path.resolve(process.env.SIGNALS_HOME || path.join(os.homedir(), '.signals-daemon'));
const LOG = path.join(HOME, 'daemon.log');

async function call(method, route, body) {
  const res = await fetch(BASE + route, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const running = () => call('GET', '/api/health').then(() => true, () => false);

async function startDaemon() {
  fs.mkdirSync(HOME, { recursive: true });
  const log = fs.openSync(LOG, 'a');
  const child = spawn(process.execPath, [SERVER], { detached: true, stdio: ['ignore', log, log], env: process.env });
  child.unref();
  for (let i = 0; i < 50; i++) {
    if (await running()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`The daemon didn't start. See ${LOG}`);
}

async function stopDaemon() {
  await call('POST', '/api/shutdown', {});
  for (let i = 0; i < 50; i++) {
    if (!(await running())) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("The daemon didn't stop. See " + LOG);
}

async function printStatus() {
  const { workspaces } = await call('GET', '/api/workspaces');
  console.log(`Signals daemon at ${BASE}`);
  for (const w of workspaces) {
    const p = w.presence;
    const state = p.job ? 'working' : p.listening ? 'listening' : 'offline';
    console.log(`  ${w.id.padEnd(24)} ${state.padEnd(10)} ${w.root}`);
  }
}

const args = process.argv.slice(2);
const force = args.includes('--force');
const [cmd, arg] = args.filter((a) => a !== '--force');
try {
  if (cmd === 'serve') {
    const repo = path.resolve(arg || '.');
    const started = !(await running());
    if (started) await startDaemon();
    const w = await call('POST', '/api/workspaces', { repo });
    if (w.hub) {
      // The hub folder: one worker here serves every managed project in it
      console.log(`${started ? 'Started the signals daemon. ' : ''}This is the hub folder (${w.root}): a worker here is the hub for every managed project in it.`);
      console.log('hub: yes');
    } else {
      console.log(`${started ? 'Started the signals daemon. ' : ''}Serving ${w.root}`);
      console.log(`workspace: ${w.id}`);
    }
    console.log(`url: ${w.url}`);
  } else if (cmd === 'status') {
    if (!(await running())) {
      console.log('The signals daemon is not running.');
    } else {
      await printStatus();
    }
  } else if (cmd === 'remove') {
    if (!(await running())) {
      console.log('The signals daemon is not running.');
    } else {
      const { workspaces } = await call('GET', '/api/workspaces');
      const repo = path.resolve(arg || '.');
      const w = workspaces.find((x) => x.repo === repo || x.id === arg);
      if (!w) throw new Error(`Not registered: ${arg || repo}. See: signals status`);
      await call('POST', '/api/workspaces/remove', { id: w.id });
      console.log(`Unregistered ${w.repo}. Its ideas stay in ${w.root}`);
    }
  } else if (cmd === 'restart') {
    if (await running()) {
      const { workspaces } = await call('GET', '/api/workspaces');
      const busy = workspaces.filter((w) => w.presence.job);
      if (busy.length && !force) {
        throw new Error(`A worker is mid-job in ${busy.map((w) => w.name).join(', ')}; restarting would drop it. Wait, or run: signals restart --force`);
      }
      await stopDaemon();
    }
    await startDaemon();
    console.log('Restarted the signals daemon. Listening workers reconnect within a few seconds.');
    await new Promise((r) => setTimeout(r, 2500)); // give pollers their retry, so status shows them
    await printStatus();
  } else if (cmd === 'stop') {
    if (await running()) {
      await stopDaemon();
      console.log('Stopped the signals daemon.');
    } else {
      console.log('The signals daemon is not running.');
    }
  } else {
    console.log('Usage: signals serve [repo] | signals status | signals remove [repo|id] | signals restart [--force] | signals stop');
    process.exit(cmd ? 1 : 0);
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
