'use strict';
// Loads devloop.config.json and turns it into a validated, fully resolved
// configuration: paths absolute, patterns compiled, defaults filled in.

const fs = require('node:fs');
const path = require('node:path');
const PRESETS = require('./presets');

const CONFIG_NAME = 'devloop.config.json';
const KINDS = ['watch', 'serve'];

const DEFAULT_ERROR = '^\\s*(✖|✘|ERROR\\b|Error:|\\[ERROR\\]|npm ERR!)|error (TS|NG)\\d+|FATAL ERROR|Compilation failed|generation failed|Cannot find module|\\bE(NOENT|PERM|BUSY|ADDRINUSE)\\b';
const DEFAULT_WARN = '^\\s*(▲|⚠|WARNING\\b|Warning:|\\[WARNING\\])|warning TS\\d+';
const DEFAULT_URL = 'Local:\\s+(https?://\\S+)';

class ConfigError extends Error {}

function regex(source, where, flags = 'i') {
  try {
    return new RegExp(source, flags);
  } catch (error) {
    throw new ConfigError(`${where}: invalid pattern "${source}": ${error.message}`);
  }
}

function patternList(value, where) {
  if (value === undefined) return undefined;
  const list = Array.isArray(value) ? value : [value];
  return list.map((source, i) => regex(String(source), `${where}[${i}]`, ''));
}

function positive(value, fallback, where) {
  if (value === undefined || value === null) return fallback;
  if (!Number.isInteger(value) || value <= 0) throw new ConfigError(`${where} must be a positive whole number.`);
  return value;
}

function findConfigFile(explicit, cwd = process.cwd()) {
  if (explicit) return path.resolve(cwd, explicit);
  let dir = cwd;
  for (;;) {
    const candidate = path.join(dir, CONFIG_NAME);
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function normaliseProcess(raw, index, root) {
  const where = `processes[${index}]`;
  if (!raw || typeof raw !== 'object') throw new ConfigError(`${where} must be an object.`);
  const { id } = raw;
  if (typeof id !== 'string' || !/^[\w-]+$/.test(id)) throw new ConfigError(`${where}.id must be letters, digits, "-" or "_".`);
  if (id === 'prepare') throw new ConfigError(`${where}.id "prepare" is reserved.`);
  if (!KINDS.includes(raw.kind)) throw new ConfigError(`${where} (${id}).kind must be one of: ${KINDS.join(', ')}.`);
  if (typeof raw.command !== 'string' || !raw.command.trim()) throw new ConfigError(`${where} (${id}).command is required.`);

  const presetName = raw.preset ?? 'none';
  const preset = PRESETS[presetName];
  if (!preset) throw new ConfigError(`${where} (${id}).preset "${presetName}" is unknown. Known: ${Object.keys(PRESETS).join(', ')}.`);
  const own = raw.signals ?? {};
  const signals = {};
  for (const state of ['building', 'ready', 'error']) {
    signals[state] = patternList(own[state], `${where}.signals.${state}`) ?? preset[state].map((s) => new RegExp(s));
  }

  const resolve = (value) => (value ? path.resolve(root, value) : null);
  const sources = resolve(raw.sources);
  const output = resolve(raw.output);
  if (raw.buildOnce !== undefined && typeof raw.buildOnce !== 'string') throw new ConfigError(`${where} (${id}).buildOnce must be a command string.`);
  if (raw.port !== undefined) positive(raw.port, null, `${where} (${id}).port`);
  const watchPaths = (raw.watchPaths ?? (sources ? [raw.sources] : [])).map(resolve);

  return {
    id,
    label: typeof raw.label === 'string' && raw.label ? raw.label : id,
    kind: raw.kind,
    command: raw.command,
    cwd: resolve(raw.cwd ?? '.'),
    env: raw.env && typeof raw.env === 'object' ? Object.fromEntries(Object.entries(raw.env).map(([k, v]) => [k, String(v)])) : {},
    autostart: raw.autostart !== false,
    waitForReady: raw.waitForReady ?? raw.kind === 'watch',
    port: raw.port ?? null,
    buildOnce: raw.buildOnce ?? null,
    sources,
    output,
    watchPaths,
    signals,
    errorPattern: raw.errorPattern ? regex(raw.errorPattern, `${where}.errorPattern`) : null,
    warnPattern: raw.warnPattern ? regex(raw.warnPattern, `${where}.warnPattern`) : null,
  };
}

function normalise(raw, file) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ConfigError('The config must be a JSON object.');
  const root = path.dirname(file);
  if (!Array.isArray(raw.processes) || raw.processes.length === 0) throw new ConfigError('"processes" must list at least one process.');
  const processes = raw.processes.map((p, i) => normaliseProcess(p, i, root));
  const seen = new Set();
  for (const p of processes) {
    if (seen.has(p.id)) throw new ConfigError(`Two processes share the id "${p.id}".`);
    seen.add(p.id);
  }

  let prepare = null;
  if (raw.prepare) {
    const spec = typeof raw.prepare === 'string' ? { command: raw.prepare } : raw.prepare;
    if (typeof spec.command !== 'string' || !spec.command.trim()) throw new ConfigError('prepare.command is required.');
    prepare = { command: spec.command, cwd: path.resolve(root, spec.cwd ?? '.'), env: spec.env ?? {} };
  }

  return {
    file,
    root,
    name: typeof raw.name === 'string' && raw.name ? raw.name : 'Dev loop',
    port: positive(raw.port, 4290, 'port'),
    logDir: path.resolve(root, raw.logDir ?? '.devloop/logs'),
    heapMb: raw.heapMb === undefined || raw.heapMb === null ? null : positive(raw.heapMb, null, 'heapMb'),
    crashLimit: positive(raw.crashLimit, 5, 'crashLimit'),
    quickExitMs: positive(raw.quickExitMs, 60_000, 'quickExitMs'),
    firstBuildTimeoutMs: positive(raw.firstBuildTimeoutMs, 30 * 60_000, 'firstBuildTimeoutMs'),
    prepare,
    freshMarker: raw.freshMarker ? path.resolve(root, raw.freshMarker) : null,
    conflictPattern: raw.conflictPattern ? regex(raw.conflictPattern, 'conflictPattern') : null,
    errorPattern: regex(raw.errorPattern ?? DEFAULT_ERROR, 'errorPattern'),
    warnPattern: regex(raw.warnPattern ?? DEFAULT_WARN, 'warnPattern'),
    urlPattern: regex(raw.urlPattern ?? DEFAULT_URL, 'urlPattern', ''),
    processes,
  };
}

function loadConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    throw new ConfigError(`Cannot read ${file}.`);
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${file} is not valid JSON: ${error.message}`);
  }
  return normalise(raw, file);
}

module.exports = { CONFIG_NAME, ConfigError, findConfigFile, loadConfig, normalise };
