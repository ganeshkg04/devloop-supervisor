'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { handleMessage } = require('../src/mcp');

const call = (name, args = {}, id = 1) => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } });

function fakeApi() {
  const actions = [];
  const units = [
    { id: 'lib', kind: 'watch', state: 'error', build: { state: 'error', error: 'error TS2304: Cannot find name "x".', at: 1 }, restarts: 0 },
    { id: 'web', kind: 'serve', state: 'ready', build: { state: 'ready', at: 1 }, url: 'http://localhost:5173/', restarts: 1, lastExit: { reason: 'Exited with code 1.' } },
  ];
  return {
    actions,
    status: async () => ({ name: 'Test loop', booting: false, warnings: [], units }),
    logs: async (id) => (id === 'lib' ? [{ t: 1, text: 'compiling', level: '' }, { t: 2, text: 'error TS2304: Cannot find name "x".', level: 'error' }] : []),
    act: async (id, action) => {
      actions.push(`${id}:${action}`);
      return true;
    },
  };
}

test('initialize negotiates the protocol version', async () => {
  const res = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } }, fakeApi());
  assert.equal(res.result.protocolVersion, '2025-03-26');
  assert.equal(res.result.serverInfo.name, 'devloop-supervisor');
  const unknown = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } }, fakeApi());
  assert.equal(unknown.result.protocolVersion, '2025-06-18');
});

test('notifications get no reply; unknown methods get -32601', async () => {
  assert.equal(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, fakeApi()), null);
  const res = await handleMessage({ jsonrpc: '2.0', id: 3, method: 'nope' }, fakeApi());
  assert.equal(res.error.code, -32601);
});

test('get_status and get_errors describe processes', async () => {
  const api = fakeApi();
  const status = await handleMessage(call('get_status'), api);
  assert.match(status.result.content[0].text, /needs attention/);
  assert.match(status.result.content[0].text, /web \(serve\): ready .*url: http:\/\/localhost:5173\//);
  const errors = await handleMessage(call('get_errors'), api);
  assert.match(errors.result.content[0].text, /## lib: error/);
  assert.match(errors.result.content[0].text, /TS2304/);
  assert.doesNotMatch(errors.result.content[0].text, /## web/);
});

test('start_process maps to the right action for each kind', async () => {
  const api = fakeApi();
  await handleMessage(call('start_process', { process: 'lib' }), api);
  await handleMessage(call('start_process', { process: 'web' }), api);
  await handleMessage(call('restart_process', { process: 'web' }), api);
  assert.deepEqual(api.actions, ['lib:watch', 'web:start', 'web:restart']);
});

test('tool errors come back as isError results', async () => {
  const res = await handleMessage(call('get_logs', { process: 'missing' }), fakeApi());
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /Unknown process "missing"/);
  const none = await handleMessage(call('get_status'), { status: async () => null });
  assert.equal(none.result.isError, true);
  assert.match(none.result.content[0].text, /No devloop-supervisor is running/);
});

test('get_errors ignores errors from builds that were already fixed', async () => {
  const units = [{ id: 'types', kind: 'watch', state: 'ready', build: { state: 'ready', startedAt: 100, at: 110 }, restarts: 0 }];
  const api = {
    status: async () => ({ name: 'Loop', booting: false, warnings: [], units }),
    logs: async () => [
      { t: 50, text: 'error TS2345: old mistake', level: 'error' },
      { t: 105, text: 'Found 0 errors. Watching for file changes.', level: '' },
    ],
  };
  const res = await handleMessage(call('get_errors'), api);
  assert.equal(res.result.content[0].text, 'No errors.');
});
