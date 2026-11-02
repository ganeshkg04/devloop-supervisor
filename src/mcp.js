'use strict';
// A small Model Context Protocol server (JSON-RPC 2.0) so coding agents can
// read build errors and restart processes. The same handler serves two
// transports: stdio (`devloop-supervisor mcp`) and HTTP POST /mcp on the
// supervisor itself. Tools work through an `api` object:
//   status()           -> the supervisor snapshot, or null if none is running
//   logs(id, lines)    -> recent log lines of one process, or null
//   act(id, action)    -> true if the action was accepted

const readline = require('node:readline');
const { version } = require('../package.json');

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const BUSY_STATES = new Set(['starting', 'building', 'restarting']);
const ACTIVE = (unit) => !(
  (unit.kind === 'watch' && unit.state === 'idle' && unit.build?.state !== 'error')
  || (unit.kind === 'serve' && unit.state === 'stopped')
  || (unit.kind === 'task' && ['idle', 'ready'].includes(unit.state))
);

const INSTRUCTIONS = 'Tools for a local dev loop (build watches and dev servers) supervised by devloop-supervisor. '
  + 'After editing code, call wait_for_builds to let the watches rebuild and see any errors. '
  + 'Use get_errors for compile errors, get_logs for full output, and restart_process if a process is stuck or crashed.';

const processArg = { process: { type: 'string', description: 'Process id, as shown by get_status.' } };

const TOOLS = [
  {
    name: 'get_status',
    description: 'State of every supervised process: building, ready, error, crashed or stopped, with the last build result, restarts and dev server URL.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_errors',
    description: 'Recent error lines (compile errors, crashes) from every process, or from one process.',
    inputSchema: {
      type: 'object',
      properties: { ...processArg, lines: { type: 'integer', minimum: 1, maximum: 200, description: 'Error lines per process (default 20).' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'get_logs',
    description: 'Recent output of one process.',
    inputSchema: {
      type: 'object',
      properties: {
        ...processArg,
        lines: { type: 'integer', minimum: 1, maximum: 1000, description: 'Lines to return (default 100).' },
        errors_only: { type: 'boolean', description: 'Only error lines.' },
      },
      required: ['process'],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'wait_for_builds',
    description: 'Wait until no process is building or restarting (e.g. after editing files), then return the status and any errors.',
    inputSchema: {
      type: 'object',
      properties: { timeout_seconds: { type: 'integer', minimum: 1, maximum: 600, description: 'Give up after this long (default 120).' } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'restart_process',
    description: 'Restart a process (stops it and starts it again; also clears a crash-loop pause).',
    inputSchema: { type: 'object', properties: processArg, required: ['process'], additionalProperties: false },
  },
  {
    name: 'start_process',
    description: 'Start a stopped process (a watch or a dev server).',
    inputSchema: { type: 'object', properties: processArg, required: ['process'], additionalProperties: false },
  },
  {
    name: 'stop_process',
    description: 'Stop a process and keep it stopped.',
    inputSchema: { type: 'object', properties: processArg, required: ['process'], additionalProperties: false },
    annotations: { destructiveHint: true },
  },
  {
    name: 'build_once',
    description: 'Run a one-off build of a watch process that is not running (only if it has a buildOnce command).',
    inputSchema: { type: 'object', properties: processArg, required: ['process'], additionalProperties: false },
  },
];

class ToolError extends Error {}

const time = (ms) => (ms ? new Date(ms).toISOString().slice(11, 19) : '');
const secs = (ms) => (ms === null || ms === undefined ? '' : `${(ms / 1000).toFixed(1)} s`);
const clamp = (value, fallback, max) => Math.min(Math.max(Number.isInteger(value) ? value : fallback, 1), max);

async function requireStatus(api) {
  const status = await api.status();
  if (!status) throw new ToolError('No devloop-supervisor is running. Start it in the project folder with: npx devloop-supervisor --detach');
  return status;
}

function findUnit(status, id) {
  if (typeof id !== 'string' || !id) throw new ToolError('"process" is required.');
  const unit = status.units.find((u) => u.id === id);
  if (!unit) throw new ToolError(`Unknown process "${id}". Known: ${status.units.map((u) => u.id).join(', ')}.`);
  return unit;
}

function overall(status) {
  const active = status.units.filter(ACTIVE);
  if (active.some((u) => u.state === 'error' || u.state === 'crashloop' || u.build?.state === 'error')) return 'needs attention';
  if (active.some((u) => u.state === 'restarting' || u.state === 'blocked')) return 'recovering';
  if (status.booting || active.some((u) => BUSY_STATES.has(u.state))) return 'building';
  return active.length ? 'all ready' : 'nothing running';
}

function describeStatus(status) {
  const rows = status.units.map((u) => {
    const parts = [`${u.id} (${u.kind}): ${u.state}`];
    if (u.build?.at) parts.push(`last build ${u.build.state} at ${time(u.build.at)}${u.build.ms ? ` in ${secs(u.build.ms)}` : ''}`);
    if (u.build?.state === 'error' && u.build.error) parts.push(`error: ${u.build.error}`);
    if (u.restarts) parts.push(`restarts: ${u.restarts}`);
    if (u.lastExit && (u.restarts || u.state !== 'ready')) parts.push(`last exit: ${u.lastExit.reason}`);
    if (u.note) parts.push(u.note);
    if (u.url) parts.push(`url: ${u.url}`);
    return `- ${parts.join(' | ')}`;
  });
  const head = `${status.name}: ${overall(status)}${status.booting ? ' (starting up)' : ''}`;
  const warn = status.warnings?.length ? [`Conflicting processes: ${status.warnings.join('; ')}`] : [];
  return [head, ...rows, ...warn].join('\n');
}

async function collectErrors(api, status, id, perProcess) {
  const targets = id ? [findUnit(status, id)] : status.units;
  const blocks = [];
  for (const unit of targets) {
    const lines = (await api.logs(unit.id, 3000)) ?? [];
    const errors = lines.filter((line) => line.level === 'error').slice(-perProcess);
    const failing = unit.build?.state === 'error' || unit.state === 'crashloop' || unit.state === 'error';
    if (!errors.length && !failing) continue;
    const head = `## ${unit.id}: ${unit.state}${unit.build?.error ? ` (build error: ${unit.build.error})` : ''}${unit.state === 'crashloop' ? ` (${unit.note})` : ''}`;
    blocks.push([head, ...errors.map((line) => `${time(line.t)} ${line.text}`)].join('\n'));
  }
  return blocks.length ? blocks.join('\n\n') : 'No errors.';
}

async function runTool(name, args, api) {
  switch (name) {
    case 'get_status':
      return describeStatus(await requireStatus(api));
    case 'get_errors': {
      const status = await requireStatus(api);
      return collectErrors(api, status, args.process, clamp(args.lines, 20, 200));
    }
    case 'get_logs': {
      const status = await requireStatus(api);
      const unit = findUnit(status, args.process);
      const count = clamp(args.lines, 100, 1000);
      let lines = (await api.logs(unit.id, 3000)) ?? [];
      if (args.errors_only) lines = lines.filter((line) => line.level === 'error');
      lines = lines.slice(-count);
      return lines.length ? lines.map((line) => `${time(line.t)} ${line.text}`).join('\n') : 'No output yet.';
    }
    case 'wait_for_builds': {
      const deadline = Date.now() + clamp(args.timeout_seconds, 120, 600) * 1000;
      // Give a just-saved file a moment to be noticed by the watches.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      let status = await requireStatus(api);
      while ((status.booting || status.units.some((u) => BUSY_STATES.has(u.state) || u.build?.state === 'building')) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        status = await requireStatus(api);
      }
      const stillBusy = status.booting || status.units.some((u) => BUSY_STATES.has(u.state));
      const errors = await collectErrors(api, status, null, 20);
      return [stillBusy ? 'Timed out: still building.' : 'Builds settled.', describeStatus(status), '', errors].join('\n');
    }
    case 'restart_process':
    case 'start_process':
    case 'stop_process':
    case 'build_once': {
      const status = await requireStatus(api);
      const unit = findUnit(status, args.process);
      const action = { restart_process: 'restart', stop_process: 'stop', build_once: 'build', start_process: unit.kind === 'watch' ? 'watch' : 'start' }[name];
      if (!(await api.act(unit.id, action))) {
        throw new ToolError(`Cannot ${action} ${unit.id} while it is ${unit.state}${action === 'build' ? ' (it must be stopped and have a buildOnce command)' : ''}.`);
      }
      return `${unit.id}: ${action} requested. Use wait_for_builds or get_status to follow it.`;
    }
    default:
      throw new ToolError(`Unknown tool "${name}".`);
  }
}

const reply = (id, result) => ({ jsonrpc: '2.0', id, result });
const error = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
const parseError = () => error(null, -32700, 'Parse error');

/** Handles one JSON-RPC message (or a batch); returns the response, or null for notifications. */
async function handleMessage(message, api) {
  if (Array.isArray(message)) {
    const replies = (await Promise.all(message.map((m) => handleMessage(m, api)))).filter(Boolean);
    return replies.length ? replies : null;
  }
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return error(message?.id ?? null, -32600, 'Invalid request');
  }
  const { id, method, params = {} } = message;
  const notification = id === undefined || id === null;
  if (notification) return null;
  switch (method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return reply(id, {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'devloop-supervisor', version },
        instructions: INSTRUCTIONS,
      });
    }
    case 'ping':
      return reply(id, {});
    case 'tools/list':
      return reply(id, { tools: TOOLS });
    case 'tools/call': {
      const name = params.name;
      if (!TOOLS.some((tool) => tool.name === name)) return error(id, -32602, `Unknown tool "${name}"`);
      try {
        const text = await runTool(name, params.arguments ?? {}, api);
        return reply(id, { content: [{ type: 'text', text }], isError: false });
      } catch (err) {
        const text = err instanceof ToolError ? err.message : `Internal error: ${err.message}`;
        return reply(id, { content: [{ type: 'text', text }], isError: true });
      }
    }
    default:
      return error(id, -32601, `Method not found: ${method}`);
  }
}

/** MCP over stdio: one JSON-RPC message per line in, one per line out. Logs go to stderr only. */
function serveStdio(api, { port }) {
  const write = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
  const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let pending = 0;
  let closed = false;
  const maybeExit = () => {
    if (closed && pending === 0) process.exit(0);
  };
  console.error(`devloop-supervisor MCP (stdio) for the supervisor on port ${port}`);
  lines.on('line', async (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      write(parseError());
      return;
    }
    pending += 1;
    try {
      const response = await handleMessage(message, api);
      if (response !== null) write(response);
    } finally {
      pending -= 1;
      maybeExit();
    }
  });
  lines.on('close', () => {
    closed = true;
    maybeExit();
  });
}

module.exports = { TOOLS, handleMessage, parseError, serveStdio };
