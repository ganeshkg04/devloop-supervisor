'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { normalise, ConfigError } = require('../src/config');

const FILE = path.join(path.sep, 'project', 'devloop.config.json');

test('fills defaults and resolves paths against the config folder', () => {
  const cfg = normalise({
    processes: [{ id: 'lib', kind: 'watch', command: 'x', cwd: 'pkg', sources: 'pkg/src', output: 'pkg/dist' }],
  }, FILE);
  assert.equal(cfg.port, 4290);
  assert.equal(cfg.name, 'Dev loop');
  const [lib] = cfg.processes;
  assert.equal(lib.cwd, path.join(path.sep, 'project', 'pkg'));
  assert.equal(lib.output, path.join(path.sep, 'project', 'pkg', 'dist'));
  assert.deepEqual(lib.watchPaths, [path.join(path.sep, 'project', 'pkg', 'src')]);
  assert.equal(lib.waitForReady, true);
  assert.equal(lib.autostart, true);
});

test('presets supply signals; own signals replace a preset state', () => {
  const cfg = normalise({
    processes: [{ id: 'web', kind: 'serve', command: 'x', preset: 'vite', signals: { ready: ['UP'] } }],
  }, FILE);
  const { signals } = cfg.processes[0];
  assert.ok(signals.ready[0].test('UP'));
  assert.equal(signals.ready.length, 1);
  assert.ok(signals.error.some((p) => p.test('[vite] Internal server error: boom')));
});

test('rejects bad configs with a clear message', () => {
  const bad = [
    [{}, /processes/],
    [{ processes: [{ id: 'a b', kind: 'watch', command: 'x' }] }, /id must be/],
    [{ processes: [{ id: 'a', kind: 'daemon', command: 'x' }] }, /kind must be/],
    [{ processes: [{ id: 'a', kind: 'serve' }] }, /command is required/],
    [{ processes: [{ id: 'a', kind: 'serve', command: 'x', preset: 'nope' }] }, /preset "nope" is unknown/],
    [{ processes: [{ id: 'a', kind: 'serve', command: 'x' }, { id: 'a', kind: 'serve', command: 'y' }] }, /share the id/],
    [{ processes: [{ id: 'prepare', kind: 'serve', command: 'x' }] }, /reserved/],
    [{ port: -1, processes: [{ id: 'a', kind: 'serve', command: 'x' }] }, /port must be/],
    [{ processes: [{ id: 'a', kind: 'serve', command: 'x', signals: { ready: ['('] } }] }, /invalid pattern/],
  ];
  for (const [raw, message] of bad) {
    assert.throws(() => normalise(raw, FILE), (error) => error instanceof ConfigError && message.test(error.message));
  }
});
