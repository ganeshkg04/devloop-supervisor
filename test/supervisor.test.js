'use strict';
// Starts a real supervisor over fake build and serve processes, then drives it
// through its HTTP API, its HTTP MCP endpoint and the stdio MCP server.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const BIN = path.join(__dirname, '..', 'bin', 'devloop-supervisor.js');
const FIX = path.join(__dirname, 'fixtures');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const node = (script) => `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(FIX, script))}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function call(method, pathname, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, method, path: pathname, headers: { Host: `127.0.0.1:${PORT}`, ...headers } }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch { /* not JSON */ }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

const mcpCall = (message, headers = { 'Content-Type': 'application/json' }) => call('POST', '/mcp', { body: message, headers });
const unitsById = async () => Object.fromEntries((await call('GET', '/api/status')).json.units.map((u) => [u.id, u]));

async function waitFor(check, what, timeout = 15000) {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      const value = await check();
      if (value) return value;
    } catch { /* not up yet */ }
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${what}`);
    await sleep(150);
  }
}

let dir;
let supervisor;

test.before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'devloop-'));
  const signals = { building: ['BUILD START'], ready: ['BUILD OK'], error: ['BUILD FAILED'] };
  fs.writeFileSync(path.join(dir, 'devloop.config.json'), JSON.stringify({
    name: 'Test loop',
    port: PORT,
    crashLimit: 2,
    processes: [
      { id: 'lib', kind: 'watch', command: node('fake-watch.js'), signals },
      { id: 'broken', kind: 'watch', command: node('fake-watch.js'), env: { FAIL: '1' }, signals },
      { id: 'web', kind: 'serve', command: node('fake-serve.js'), signals: { ready: ['SERVER READY'] } },
      { id: 'crashy', kind: 'watch', command: node('crasher.js'), autostart: false, signals },
    ],
  }));
  supervisor = spawn(process.execPath, [BIN], { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] });
  supervisor.stdout.resume();
  supervisor.stderr.resume();
  await waitFor(async () => {
    const u = await unitsById();
    return u.lib.state === 'ready' && u.broken.build.state === 'error' && u.web.state === 'ready';
  }, 'processes to settle');
});

test.after(async () => {
  if (supervisor.exitCode === null) {
    await new Promise((resolve) => {
      spawn(process.execPath, [BIN, '--stop'], { cwd: dir, stdio: 'ignore' }).on('exit', resolve);
    });
    await waitFor(() => supervisor.exitCode !== null, 'supervisor to exit', 5000).catch(() => supervisor.kill());
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('watches build, the dev server reports its URL, logs are written', async () => {
  const u = await unitsById();
  assert.equal(u.lib.build.state, 'ready');
  assert.match(u.broken.build.error, /TS2304/);
  assert.equal(u.web.url, 'http://localhost:5999/');
  assert.equal(u.crashy.state, 'idle');
  assert.ok(fs.existsSync(path.join(dir, '.devloop', 'logs', 'lib.log')));
});

test('the API refuses other host names and header-less POSTs', async () => {
  assert.equal((await call('GET', '/api/status', { headers: { Host: 'evil.example' } })).status, 403);
  assert.equal((await call('POST', '/api/units/lib/restart')).status, 403);
  assert.equal((await call('POST', '/api/units/lib/restart', { headers: { 'X-Devloop': '1' } })).status, 200);
  await waitFor(async () => (await unitsById()).lib.state === 'ready', 'lib to come back after restart');
});

test('MCP over HTTP: initialize, list tools, read errors', async () => {
  const init = await mcpCall({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
  assert.equal(init.json.result.serverInfo.name, 'devloop-supervisor');
  const note = await mcpCall({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(note.status, 202);
  const list = await mcpCall({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.ok(list.json.result.tools.some((tool) => tool.name === 'wait_for_builds'));
  const errors = await mcpCall({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'get_errors', arguments: {} } });
  assert.match(errors.json.result.content[0].text, /## broken/);
  assert.match(errors.json.result.content[0].text, /TS2304/);
});

test('MCP over HTTP refuses foreign origins and non-JSON bodies', async () => {
  const body = { jsonrpc: '2.0', id: 1, method: 'ping' };
  assert.equal((await mcpCall(body, { 'Content-Type': 'text/plain' })).status, 415);
  assert.equal((await mcpCall(body, { 'Content-Type': 'application/json', Origin: 'https://evil.example' })).status, 403);
  assert.equal((await mcpCall(body, { 'Content-Type': 'application/json', Origin: `http://localhost:${PORT}` })).status, 200);
});

test('a crashing process restarts, then pauses after the crash limit', async () => {
  const started = await mcpCall({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'start_process', arguments: { process: 'crashy' } } });
  assert.equal(started.json.result.isError, false);
  const crashy = await waitFor(async () => {
    const u = (await unitsById()).crashy;
    return u.state === 'crashloop' ? u : null;
  }, 'crash loop', 20000);
  assert.equal(crashy.restarts, 2);
  assert.match(crashy.lastExit.reason, /out of memory/i);
});

test('MCP over stdio talks to the running supervisor', async () => {
  const child = spawn(process.execPath, [BIN, 'mcp'], { cwd: dir, stdio: ['pipe', 'pipe', 'ignore'] });
  const replies = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      replies.push(JSON.parse(buffer.slice(0, index)));
      buffer = buffer.slice(index + 1);
    }
  });
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_status', arguments: {} } })}\n`);
  child.stdin.end();
  await new Promise((resolve) => child.on('exit', resolve));
  assert.equal(replies.length, 2);
  const text = replies.find((r) => r.id === 2).result.content[0].text;
  assert.match(text, /^Test loop: needs attention/);
  assert.match(text, /lib \(watch\): ready/);
  assert.match(text, /url: http:\/\/localhost:5999\//);
});

test('a server that restarts itself in-process gets no build duration', async () => {
  // The fake server announces itself a second time, with no build seen starting.
  const web = await waitFor(async () => {
    const u = (await unitsById()).web;
    return u.build.ms === null ? u : null;
  }, 'second ready signal', 5000);
  assert.equal(web.state, 'ready');
});
