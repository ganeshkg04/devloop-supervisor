'use strict';
// devloop-supervisor: keeps a local dev loop running -- build watches and dev
// servers, each restarted when it exits -- with a status page showing live logs
// and Watch / Build once / Restart / Stop controls, and an MCP endpoint so
// coding agents can read build errors and restart processes.
//
// Why: a watch (`ng build --watch`, `tsc --watch`, ...) survives a compile
// error but not a crash -- the Node heap running out, its output folder deleted
// by a concurrent build, a locked file on Windows -- and nothing restarts it.
// This builds before it serves, can give the processes a larger heap, and
// restarts whatever dies, backing off on repeated crashes until the next save.

const { spawn, spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const path = require('node:path');
const { ConfigError, findConfigFile, loadConfig, CONFIG_NAME } = require('./config');
const { APP_ID, request, findRunning, remoteApi } = require('./client');
const mcp = require('./mcp');
const { version } = require('../package.json');

const IS_WIN = process.platform === 'win32';
const PAGE = path.join(__dirname, 'status-page.html');
const EXAMPLE = path.join(__dirname, '..', 'devloop.config.example.json');
const RING_SIZE = 3000;
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const MAX_BODY = 1024 * 1024;

const HELP = `Usage: devloop-supervisor [command] [options]

Commands:
  (none)                  start the supervisor for ${CONFIG_NAME}
  init                    write an example ${CONFIG_NAME} here
  mcp                     run an MCP server on stdio for coding agents
                          (it talks to the supervisor running on --port)

Options:
  --config <file>         config file (default: nearest ${CONFIG_NAME})
  --only <a,b>            start only these processes (default: those with autostart)
  --port <n>              status page / API port (default: config port, else 4290)
  --heap <mb>             Node heap for the processes it starts (NODE_OPTIONS)
  --skip-prepare          skip the prepare command and the stale-output builds
  --detach                run in the background; stop with --stop or from the page
  --open                  open the status page in the browser
  --stop                  stop the supervisor running on --port
  --status                print that supervisor's status
  --version, --help

Options also accept key=value: only=web,api port=4300 detach=1`;

const bus = new EventEmitter();
const units = new Map();
const clients = new Set();
const startedAt = Date.now();
let cfg;
let opts;
let server = null;
let warnings = [];
let booting = false;
let shuttingDown = false;
let markerTimer = null;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clock = (ms) => new Date(ms).toTimeString().slice(0, 8);

function fail(message) {
  console.error(`devloop-supervisor: ${message}`);
  process.exit(1);
}

// ── Arguments ───────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const parsed = {
    command: null, config: null, only: null, port: null, heap: null,
    prepare: true, detach: false, open: false, stop: false, status: false, help: false, version: false,
  };
  const truthy = (value) => value === undefined || /^(1|true|yes|on)$/i.test(value);
  const toInt = (value, name) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number <= 0) fail(`${name} must be a positive whole number, got "${value}".`);
    return number;
  };
  const splitList = (value) => value.split(/[\s,]+/).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (i === 0 && ['init', 'mcp'].includes(arg)) {
      parsed.command = arg;
      continue;
    }
    const match = /^(?:--?)?([a-z][a-z-]*)(?:=(.*))?$/i.exec(arg);
    if (!match) fail(`Unrecognised argument "${arg}". Run with --help.`);
    const key = match[1].toLowerCase();
    const needsValue = ['config', 'only', 'port', 'heap'].includes(key);
    const value = match[2] ?? (needsValue ? argv[++i] : undefined);
    if (needsValue && value === undefined) fail(`${key} needs a value.`);
    switch (key) {
      case 'config': parsed.config = value; break;
      case 'only': {
        parsed.only = splitList(value);
        // PowerShell hands an unquoted a,b to a native command as separate words.
        while (argv[i + 1] && !/^-|=/.test(argv[i + 1])) parsed.only.push(...splitList(argv[++i]));
        break;
      }
      case 'port': parsed.port = toInt(value, 'port'); break;
      case 'heap': parsed.heap = toInt(value, 'heap'); break;
      case 'skip-prepare': parsed.prepare = !truthy(value); break;
      case 'detach': parsed.detach = truthy(value); break;
      case 'open': parsed.open = truthy(value); break;
      case 'stop': parsed.stop = true; break;
      case 'status': parsed.status = true; break;
      case 'version': case 'v': parsed.version = true; break;
      case 'help': case 'h': parsed.help = true; break;
      default: fail(`Unknown option "${arg}". Run with --help.`);
    }
  }
  return parsed;
}

// ── Units: one per process, plus the prepare step ───────────────────────────

class Unit {
  constructor(id, kind, label, spec = null) {
    Object.assign(this, { id, kind, label, spec });
    this.state = kind === 'serve' ? 'stopped' : 'idle';
    this.note = '';
    this.mode = 'idle'; // watch processes: idle | watch | once
    this.wanted = false; // keep it running: restart it when it exits
    this.restartNow = false; // the next exit was asked for by Restart
    this.child = null;
    this.pid = null;
    this.startedAt = null;
    this.restarts = 0;
    this.streak = 0;
    this.restartAt = null;
    this.timer = null;
    this.lastExit = null;
    this.build = { state: null, startedAt: null, at: null, ms: null, error: '' };
    this.url = null;
    this.port = spec?.port ?? null;
    this.lines = [];
    this.log = null;
    this.saveWatches = [];
  }

  view() {
    const { id, kind, label, state, note, mode, pid, startedAt, restarts, restartAt, lastExit, build, url, port } = this;
    return { id, kind, label, state, note, mode, pid, startedAt, restarts, restartAt, lastExit, build, url, port, canBuildOnce: !!this.spec?.buildOnce };
  }
}

function update(unit, changes) {
  const before = unit.state;
  Object.assign(unit, changes);
  if (unit.state !== before) {
    const detail = unit.state === 'error' ? unit.build.error || unit.note : unit.note;
    console.log(`${clock(Date.now())}  ${unit.label.padEnd(24)} ${unit.state}${detail ? `  ${detail}` : ''}`);
  }
  broadcast('unit', unit.view());
  bus.emit('change', unit);
}

function freshBuild() {
  return { state: 'building', startedAt: Date.now(), at: null, ms: null, error: '' };
}

const hasReadySignal = (unit) => (unit.spec?.signals.ready.length ?? 0) > 0;

// ── Output ──────────────────────────────────────────────────────────────────

function splitLines(onLine) {
  let rest = '';
  return {
    push(chunk) {
      const parts = (rest + chunk).split(/\r\n|\n|\r/);
      rest = parts.pop() ?? '';
      parts.forEach(onLine);
    },
    flush() {
      if (rest) onLine(rest);
      rest = '';
    },
  };
}

function levelOf(unit, text) {
  const error = unit.spec?.errorPattern ?? cfg.errorPattern;
  const warn = unit.spec?.warnPattern ?? cfg.warnPattern;
  return error.test(text) ? 'error' : warn.test(text) ? 'warn' : '';
}

function pushLine(unit, raw) {
  const text = raw.replace(ANSI, '').trimEnd();
  if (!text.trim()) return;
  const line = { t: Date.now(), text, level: levelOf(unit, text) };
  unit.lines.push(line);
  if (unit.lines.length > RING_SIZE) unit.lines.shift();
  unit.log?.write(`${new Date(line.t).toISOString()} ${text}\n`);
  broadcast('line', { id: unit.id, ...line });
  readSignals(unit, line);
}

function readSignals(unit, { text, level }) {
  if (!unit.spec) return;
  if (unit.kind === 'serve') {
    const local = cfg.urlPattern.exec(text);
    if (local?.[1]) update(unit, { url: local[1] });
  }
  const { signals } = unit.spec;
  const state = ['error', 'ready', 'building'].find((name) => signals[name].some((pattern) => pattern.test(text)));
  if (!state) {
    if (level === 'error' && unit.build.state === 'building' && !unit.build.error) unit.build.error = text;
    return;
  }
  const now = Date.now();
  if (state === 'building') {
    if (unit.build.state !== 'building') unit.build = freshBuild();
  } else {
    const ms = unit.build.startedAt ? now - unit.build.startedAt : null;
    unit.build = { ...unit.build, state, at: now, ms, error: state === 'error' ? unit.build.error || text : '' };
    if (state === 'ready') {
      unit.streak = 0;
      scheduleMarker();
    }
  }
  update(unit, unit.mode === 'once' ? {} : { state, note: '' });
}

function exitReason(unit, code, signal) {
  const recent = unit.lines.slice(-80).map((line) => line.text).join('\n');
  if (/heap out of memory|Reached heap limit|Allocation failed/i.test(recent)) {
    return opts.heap ? `Ran out of memory (heap ${opts.heap} MB).` : 'Ran out of memory. Try a larger heap (--heap or "heapMb").';
  }
  if (/EADDRINUSE|is already in use/i.test(recent)) return 'Its port was already in use.';
  if (/\bE(PERM|BUSY)\b/.test(recent)) return 'A file was locked by another process.';
  if (/\bENOENT\b/.test(recent)) return 'A file or folder disappeared mid-build.';
  if (signal) return `Killed (${signal}).`;
  return code === 0 ? 'Exited.' : `Exited with code ${code}.`;
}

// ── Processes ───────────────────────────────────────────────────────────────

function childEnv(extra = {}) {
  const heap = opts.heap ? `--max-old-space-size=${opts.heap}` : '';
  return {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, heap].filter(Boolean).join(' '),
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    NG_CLI_ANALYTICS: 'false',
    ...extra,
  };
}

function openLog(unit) {
  if (unit.log) return;
  fs.mkdirSync(cfg.logDir, { recursive: true });
  const file = path.join(cfg.logDir, `${unit.id.replace(/[^a-z0-9-]/gi, '_')}.log`);
  try {
    if (fs.statSync(file).size > 20 * 1024 * 1024) fs.renameSync(file, `${file}.1`);
  } catch { /* first run */ }
  unit.log = fs.createWriteStream(file, { flags: 'a' });
}

/** Runs a shell command for a unit; resolves with its exit once its output is drained. */
function launch(unit, command, { cwd, env }) {
  openLog(unit);
  unit.log.write(`\n===== ${new Date().toISOString()}  ${command} =====\n`);
  return new Promise((resolve) => {
    let settled = false;
    let child;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      if (unit.child === child) unit.child = null;
      resolve({ code, signal });
    };
    try {
      // A shell runs the command as written; on POSIX it leads its own process group so the whole tree can be stopped.
      child = spawn(command, { cwd, env, shell: true, windowsHide: true, detached: !IS_WIN, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      pushLine(unit, `Could not start "${command}": ${error.message}`);
      finish(-1, null);
      return;
    }
    unit.child = child;
    update(unit, { pid: child.pid ?? null, startedAt: Date.now() });
    for (const stream of [child.stdout, child.stderr]) {
      const lines = splitLines((text) => pushLine(unit, text));
      stream.setEncoding('utf8');
      stream.on('data', lines.push);
      stream.on('end', lines.flush);
    }
    child.on('error', (error) => {
      pushLine(unit, `Could not start "${command}": ${error.message}`);
      if (child.pid === undefined) finish(-1, null);
    });
    child.on('close', finish);
  });
}

/** Ends a process and everything it started (build tools run compilers as children). */
function killTree(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (IS_WIN) {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already gone */ }
  setTimeout(() => {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ }
  }, 4000).unref();
}

function clearPending(unit) {
  clearTimeout(unit.timer);
  unit.timer = null;
  unit.restartAt = null;
  for (const watcher of unit.saveWatches) watcher.close();
  unit.saveWatches = [];
}

async function start(unit) {
  if (!unit.spec || unit.child || shuttingDown) return;
  clearPending(unit);
  unit.wanted = true;
  if (unit.port && (await portBusy(unit.port))) {
    update(unit, { state: 'blocked', note: `Port ${unit.port} is in use, probably another dev server. Retrying every 5 s.` });
    unit.timer = setTimeout(() => start(unit), 5000);
    return;
  }
  if (!unit.wanted || unit.child || shuttingDown) return;
  const note = unit.kind === 'watch' && unit.spec.waitForReady ? 'Full build, then watching' : '';
  update(unit, { mode: unit.kind === 'watch' ? 'watch' : 'idle', state: 'starting', note, url: null, build: freshBuild() });
  const { spec } = unit;
  launch(unit, spec.command, { cwd: spec.cwd, env: childEnv(spec.env) })
    .then(({ code, signal }) => afterExit(unit, code, signal));
  // Nothing to wait for: it counts as ready once it is running.
  if (!hasReadySignal(unit) && unit.child) {
    const now = Date.now();
    update(unit, { state: 'ready', note: '', build: { ...unit.build, state: 'ready', at: now, ms: 0 } });
  }
}

async function afterExit(unit, code, signal) {
  const ranFor = Date.now() - (unit.startedAt ?? Date.now());
  update(unit, { pid: null, lastExit: { code, signal, at: Date.now(), reason: exitReason(unit, code, signal) } });
  // On Windows Ctrl-C reaches the children before this process; let shutdown win that race.
  await sleep(400);
  if (shuttingDown) return;
  if (unit.restartNow) {
    unit.restartNow = false;
    start(unit);
    return;
  }
  if (!unit.wanted) {
    update(unit, unit.kind === 'watch' ? { state: 'idle', mode: 'idle', note: '' } : { state: 'stopped', note: '' });
    return;
  }
  unit.streak = ranFor < cfg.quickExitMs ? unit.streak + 1 : 1;
  unit.restarts += 1;
  if (unit.streak >= cfg.crashLimit) {
    pauseAfterCrashes(unit);
    return;
  }
  const delay = Math.min(2000 * 2 ** (unit.streak - 1), 30_000);
  update(unit, { state: 'restarting', note: unit.lastExit.reason, restartAt: Date.now() + delay });
  unit.timer = setTimeout(() => start(unit), delay);
}

function pauseAfterCrashes(unit) {
  const reason = `${unit.lastExit.reason} Paused after ${cfg.crashLimit} quick crashes.`;
  const paths = unit.spec.watchPaths.filter((dir) => fs.existsSync(dir));
  if (!paths.length) {
    update(unit, { state: 'crashloop', note: `${reason} Restart it when ready.` });
    return;
  }
  update(unit, { state: 'crashloop', note: `${reason} Restarts on your next save.` });
  for (const dir of paths) {
    try {
      unit.saveWatches.push(fs.watch(dir, { recursive: true }, () => {
        if (unit.state !== 'crashloop') return;
        unit.streak = 0;
        start(unit);
      }));
    } catch { /* no recursive watching here: Restart from the page */ }
  }
}

/** A single build of a watch process that is not running; resolves true when it succeeded. */
function buildOnce(unit, note = 'One-off build') {
  unit.wanted = false;
  update(unit, { mode: 'once', state: 'building', note, build: freshBuild() });
  const { spec } = unit;
  return launch(unit, spec.buildOnce, { cwd: spec.cwd, env: childEnv(spec.env) })
    .then(({ code }) => {
      const ok = code === 0;
      const now = Date.now();
      const build = {
        ...unit.build, state: ok ? 'ready' : 'error', at: now,
        ms: now - unit.build.startedAt, error: ok ? '' : unit.build.error || `Exited with code ${code}.`,
      };
      update(unit, { mode: 'idle', state: 'idle', pid: null, note: '', build });
      if (ok) scheduleMarker();
      return ok;
    });
}

function act(unit, action) {
  if (!unit || shuttingDown) return false;
  const running = !!unit.child;
  switch (`${unit.kind}:${action}`) {
    case 'watch:watch':
    case 'watch:start':
    case 'serve:start':
      if (running || unit.mode === 'once') return false;
      unit.streak = 0;
      start(unit);
      return true;
    case 'watch:restart':
    case 'serve:restart':
      if (unit.mode === 'once') return false;
      unit.streak = 0;
      clearPending(unit);
      if (running) {
        unit.restartNow = true;
        killTree(unit.child);
      } else {
        start(unit);
      }
      return true;
    case 'watch:stop':
    case 'serve:stop':
      if (unit.mode === 'once') return false;
      unit.wanted = false;
      clearPending(unit);
      if (running) killTree(unit.child);
      else update(unit, unit.kind === 'watch' ? { state: 'idle', mode: 'idle', note: '' } : { state: 'stopped', note: '' });
      return true;
    case 'watch:build':
      if (!unit.spec.buildOnce || running || unit.mode !== 'idle') return false;
      buildOnce(unit);
      return true;
    case 'task:start':
      if (booting) return false;
      boot();
      return true;
    default:
      return false;
  }
}

// ── Freshness: what still needs a build ─────────────────────────────────────

function newestMtime(dir) {
  let newest = 0;
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules') walk(full);
      } else {
        newest = Math.max(newest, fs.statSync(full).mtimeMs);
      }
    }
  };
  try { walk(dir); } catch { /* missing directory: treated as never built */ }
  return newest;
}

const tracksFreshness = (spec) => !!(spec.sources && spec.output);

function isFresh(spec) {
  const built = newestMtime(spec.output);
  return built > 0 && newestMtime(spec.sources) <= built;
}

// Writes the configured marker once every tracked output is newer than its sources.
function scheduleMarker() {
  if (!cfg.freshMarker) return;
  clearTimeout(markerTimer);
  markerTimer = setTimeout(() => {
    const tracked = cfg.processes.filter(tracksFreshness);
    if (tracked.length && tracked.every(isFresh)) fs.writeFileSync(cfg.freshMarker, '');
  }, 3000);
  markerTimer.unref();
}

// ── Start-up ────────────────────────────────────────────────────────────────

function prepareFailed(unit, note) {
  update(unit, { state: 'error', note: `${note} Fix it, then Retry.`, pid: null, build: { ...unit.build, state: 'error', at: Date.now() } });
  return false;
}

async function prepare() {
  const unit = units.get('prepare');
  update(unit, { state: 'building', note: 'Running the prepare command', build: freshBuild() });
  if (cfg.prepare) {
    const step = await launch(unit, cfg.prepare.command, { cwd: cfg.prepare.cwd, env: childEnv(cfg.prepare.env) });
    if (step.code !== 0) return prepareFailed(unit, 'The prepare command failed.');
  }
  // Processes that will not be watched, but whose output others may read, are built once if their sources changed.
  for (const spec of cfg.processes) {
    const procUnit = units.get(spec.id);
    if (spec.kind !== 'watch' || !spec.buildOnce || !tracksFreshness(spec)) continue;
    if (opts.only.includes(spec.id) || procUnit.child || isFresh(spec)) continue;
    update(unit, { note: `Building ${spec.label}: its sources changed since its last build` });
    if (!(await buildOnce(procUnit, 'Changed since its last build'))) return prepareFailed(unit, `${spec.label} failed to build.`);
  }
  const now = Date.now();
  update(unit, { state: 'ready', note: '', pid: null, build: { ...unit.build, state: 'ready', at: now, ms: now - unit.build.startedAt } });
  return true;
}

/** Waits for a process's first build to finish (or for it to give up), so the next one never reads half-written output. */
function firstReady(unit) {
  const settled = () => unit.build.state !== 'building' || !unit.wanted || unit.state === 'crashloop';
  return new Promise((resolve) => {
    if (settled()) {
      resolve();
      return;
    }
    const done = () => {
      bus.off('change', check);
      clearTimeout(timer);
      resolve();
    };
    const check = (changed) => {
      if (changed === unit && settled()) done();
    };
    const timer = setTimeout(done, cfg.firstBuildTimeoutMs);
    bus.on('change', check);
  });
}

async function boot() {
  booting = true;
  broadcast('booting', { booting });
  try {
    if (opts.prepare && units.has('prepare') && !(await prepare())) return;
    for (const spec of cfg.processes) {
      if (!opts.only.includes(spec.id)) continue;
      const unit = units.get(spec.id);
      if (unit.child || shuttingDown) continue;
      await start(unit);
      if (spec.waitForReady) await firstReady(unit);
    }
  } finally {
    booting = false;
    broadcast('booting', { booting });
  }
}

function portBusy(port) {
  const probe = (host) => new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (busy) => {
      socket.destroy();
      resolve(busy);
    };
    socket.setTimeout(600, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
  return Promise.all([probe('127.0.0.1'), probe('::1')]).then((results) => results.some(Boolean));
}

/** Other processes matching conflictPattern (e.g. a second watch on the same output) would fight these. */
function findConflicts() {
  if (!cfg.conflictPattern) return [];
  const command = IS_WIN
    ? ['powershell.exe', ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }']]
    : ['ps', ['-eo', 'pid=,args=']];
  const output = spawnSync(command[0], command[1], { encoding: 'utf8', windowsHide: true }).stdout || '';
  return output.split(/\r?\n/)
    .map((row) => /^\s*(\d+)\s+(.*)$/.exec(row))
    .filter((row) => row && Number(row[1]) !== process.pid && cfg.conflictPattern.test(row[2]))
    .map((row) => `PID ${row[1]}: ${row[2].trim().slice(0, 160)}`);
}

// ── Status page, API and MCP endpoint ───────────────────────────────────────

function snapshot() {
  return {
    app: APP_ID, version, name: cfg.name, pid: process.pid, port: opts.port, startedAt, heap: opts.heap,
    logDir: path.relative(process.cwd(), cfg.logDir) || '.', booting, warnings,
    units: [...units.values()].map((unit) => unit.view()),
  };
}

function broadcast(event, data) {
  if (!clients.size) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) res.write(frame);
}

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** The API the MCP tools use, served from this process. */
const localApi = {
  status: async () => snapshot(),
  logs: async (id, lines) => (units.has(id) ? units.get(id).lines.slice(-Math.min(lines, RING_SIZE)) : null),
  act: async (id, action) => act(units.get(id), action),
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function handleMcp(req, res) {
  if (req.method !== 'POST') {
    res.writeHead(405, { Allow: 'POST' });
    return res.end();
  }
  // Only local pages may call it, and only with a JSON body (which a cross-site form cannot send without a preflight).
  const { origin } = req.headers;
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) return json(res, 403, { error: 'Forbidden origin' });
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) return json(res, 415, { error: 'Content-Type must be application/json' });
  let message;
  try {
    message = JSON.parse(await readBody(req));
  } catch {
    return json(res, 400, mcp.parseError());
  }
  const reply = await mcp.handleMessage(message, localApi);
  if (reply === null) {
    res.writeHead(202);
    return res.end();
  }
  return json(res, 200, reply);
}

function handle(req, res) {
  // Bound to 127.0.0.1, and only answering to its own host name: no other site can drive it.
  if (![`127.0.0.1:${opts.port}`, `localhost:${opts.port}`].includes(req.headers.host)) return json(res, 403, { error: 'Forbidden' });
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname === '/mcp') {
    handleMcp(req, res).catch(() => json(res, 500, { error: 'Internal error' }));
    return undefined;
  }
  if (req.method === 'GET') {
    if (url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(fs.readFileSync(PAGE, 'utf8'));
    }
    if (url.pathname === '/api/status') return json(res, 200, snapshot());
    if (url.pathname === '/api/logs') {
      const unit = units.get(url.searchParams.get('unit') ?? '');
      if (!unit) return json(res, 404, { error: 'Unknown unit' });
      const lines = Math.min(Number(url.searchParams.get('lines')) || 1000, RING_SIZE);
      return json(res, 200, { id: unit.id, lines: unit.lines.slice(-lines) });
    }
    if (url.pathname === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
      res.write(`event: snapshot\ndata: ${JSON.stringify(snapshot())}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return undefined;
    }
  }
  if (req.method === 'POST') {
    // A custom header forces a CORS preflight, which this server never grants.
    if (req.headers['x-devloop'] !== '1') return json(res, 403, { error: 'Missing X-Devloop header' });
    if (url.pathname === '/api/shutdown') {
      json(res, 200, { ok: true });
      return shutdown(0);
    }
    const match = /^\/api\/units\/([\w-]+)\/(\w+)$/.exec(url.pathname);
    if (match && units.has(match[1])) {
      const ok = act(units.get(match[1]), match[2]);
      return json(res, ok ? 200 : 409, { ok });
    }
  }
  return json(res, 404, { error: 'Not found' });
}

function listen() {
  return new Promise((resolve) => {
    server = http.createServer(handle);
    server.once('error', (error) => fail(error.code === 'EADDRINUSE'
      ? `Port ${opts.port} is in use by something else. Pass --port <n>.`
      : error.message));
    server.listen(opts.port, '127.0.0.1', resolve);
  });
}

function shutdown(code) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('devloop-supervisor: stopping everything it started...');
  for (const unit of units.values()) {
    clearPending(unit);
    unit.wanted = false;
    killTree(unit.child);
    unit.log?.end();
    unit.log = null;
  }
  broadcast('bye', {});
  for (const res of clients) res.end();
  server?.close();
  setTimeout(() => process.exit(code), 500);
}

// ── Commands ────────────────────────────────────────────────────────────────

async function printStatus() {
  const status = await findRunning(opts.port);
  if (!status) fail(`No supervisor is running on port ${opts.port}.`);
  console.log(`${status.name}  http://localhost:${status.port}  (pid ${status.pid}${status.heap ? `, heap ${status.heap} MB` : ''})`);
  for (const unit of status.units) {
    const built = unit.build.at ? `last build ${clock(unit.build.at)}${unit.build.ms ? ` (${Math.round(unit.build.ms / 1000)} s)` : ''}` : '';
    const exit = unit.lastExit ? `last exit ${clock(unit.lastExit.at)}: ${unit.lastExit.reason}` : '';
    console.log(`  ${unit.label.padEnd(24)} ${unit.state.padEnd(11)} ${[built, unit.restarts ? `restarts ${unit.restarts}` : '', exit].filter(Boolean).join('  ')}`);
  }
}

async function detach(argv) {
  fs.mkdirSync(cfg.logDir, { recursive: true });
  const out = fs.openSync(path.join(cfg.logDir, 'supervisor.log'), 'a');
  const args = argv.filter((arg) => !/^(--?)?(detach|open)(=.*)?$/i.test(arg));
  if (!args.some((arg) => /^(--?)?config\b/i.test(arg))) args.push('--config', cfg.file);
  spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'devloop-supervisor.js'), ...args], {
    cwd: process.cwd(), detached: true, windowsHide: true, stdio: ['ignore', out, out],
  }).unref();
  for (let attempt = 0; attempt < 60; attempt++) {
    await sleep(250);
    if (await findRunning(opts.port)) {
      if (opts.open) openBrowser(`http://localhost:${opts.port}`);
      console.log(`devloop-supervisor running in the background: http://localhost:${opts.port}`);
      console.log('Stop it with: devloop-supervisor --stop');
      return;
    }
  }
  fail(`Started in the background, but it is not answering. See ${path.join(cfg.logDir, 'supervisor.log')}.`);
}

function openBrowser(url) {
  const [command, args] = IS_WIN ? ['explorer.exe', [url]] : [process.platform === 'darwin' ? 'open' : 'xdg-open', [url]];
  spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true }).on('error', () => {}).unref();
}

function init() {
  const target = path.resolve(opts.config ?? CONFIG_NAME);
  if (fs.existsSync(target)) fail(`${path.relative(process.cwd(), target)} already exists.`);
  fs.copyFileSync(EXAMPLE, target);
  console.log(`Wrote ${path.relative(process.cwd(), target)}. Edit the processes, then run: devloop-supervisor`);
}

/** Loads the config; for --stop, --status and mcp a missing config only means the default port. */
function loadOptionalConfig(required) {
  const file = findConfigFile(opts.config);
  if (!file) {
    if (required) fail(`No ${CONFIG_NAME} found here or above. Create one with: devloop-supervisor init`);
    return null;
  }
  try {
    return loadConfig(file);
  } catch (error) {
    if (error instanceof ConfigError) fail(`${path.relative(process.cwd(), file)}: ${error.message}`);
    throw error;
  }
}

async function main(argv) {
  opts = parseArgs(argv);
  if (opts.help) return console.log(HELP);
  if (opts.version) return console.log(version);
  if (opts.command === 'init') return init();

  const needsConfig = !opts.stop && !opts.status && opts.command !== 'mcp';
  cfg = loadOptionalConfig(needsConfig);
  opts.port = opts.port ?? cfg?.port ?? 4290;

  if (opts.command === 'mcp') return mcp.serveStdio(remoteApi(opts.port), { port: opts.port });
  if (opts.status) return printStatus();
  if (opts.stop) {
    const stopped = await request(opts.port, 'POST', '/api/shutdown');
    return console.log(stopped?.body?.ok ? 'devloop-supervisor stopped.' : `No supervisor is running on port ${opts.port}.`);
  }

  opts.heap = opts.heap ?? cfg.heapMb;
  const ids = cfg.processes.map((p) => p.id);
  if (opts.only) {
    const unknown = opts.only.filter((id) => !ids.includes(id));
    if (unknown.length) fail(`Unknown process "${unknown.join(', ')}". Configured: ${ids.join(', ')}.`);
  } else {
    opts.only = cfg.processes.filter((p) => p.autostart).map((p) => p.id);
  }
  for (const spec of cfg.processes) {
    if (!fs.existsSync(spec.cwd)) fail(`${spec.id}: working folder ${path.relative(process.cwd(), spec.cwd)} does not exist.`);
  }

  if (await findRunning(opts.port)) return console.log(`devloop-supervisor is already running: http://localhost:${opts.port}`);
  if (opts.detach) return detach(argv);

  if (cfg.prepare || cfg.processes.some((p) => p.buildOnce && tracksFreshness(p))) units.set('prepare', new Unit('prepare', 'task', 'Prepare'));
  for (const spec of cfg.processes) units.set(spec.id, new Unit(spec.id, spec.kind, spec.label, spec));
  warnings = findConflicts();

  await listen();
  setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
  }, 15_000).unref();
  const pageUrl = `http://localhost:${opts.port}`;
  console.log([
    `devloop-supervisor ${version}: ${cfg.name}`,
    `  status page  ${pageUrl}`,
    `  MCP          ${pageUrl}/mcp   (or: devloop-supervisor mcp)`,
    `  starting     ${opts.only.join(', ') || 'nothing'}${opts.heap ? ` (heap ${opts.heap} MB)` : ''}`,
    `  logs         ${path.relative(process.cwd(), cfg.logDir) || '.'}${path.sep}`,
    '  stop         Ctrl-C here, devloop-supervisor --stop, or the page',
    ...warnings.map((warning) => `  WARNING      a conflicting process is running: ${warning}`),
  ].join('\n'));
  if (opts.open) openBrowser(pageUrl);
  boot();

  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', ...(IS_WIN ? ['SIGBREAK'] : [])]) process.on(signal, () => shutdown(0));
  process.on('exit', () => {
    for (const unit of units.values()) killTree(unit.child);
  });
  process.on('uncaughtException', (error) => console.error('devloop-supervisor: internal error (still running):', error));
  process.on('unhandledRejection', (error) => console.error('devloop-supervisor: internal error (still running):', error));
  return undefined;
}

module.exports = { main, parseArgs };
