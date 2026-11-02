'use strict';
// Talks to a running supervisor over its local HTTP API (used by --stop,
// --status, --detach and the stdio MCP server).

const http = require('node:http');

const APP_ID = 'devloop-supervisor';

function request(port, method, pathname, timeout = 1500) {
  return new Promise((resolve) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path: pathname, timeout,
      headers: { Host: `127.0.0.1:${port}`, 'X-Devloop': '1' },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(body) }); } catch { resolve({ status: res.statusCode, body: null }); }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function findRunning(port) {
  const res = await request(port, 'GET', '/api/status');
  return res?.body?.app === APP_ID ? res.body : null;
}

/** The API the MCP tools use, backed by a supervisor's HTTP endpoints. */
function remoteApi(port) {
  return {
    status: () => findRunning(port),
    async logs(id, lines) {
      const res = await request(port, 'GET', `/api/logs?unit=${encodeURIComponent(id)}&lines=${lines}`);
      return res?.status === 200 ? res.body.lines : null;
    },
    async act(id, action) {
      const res = await request(port, 'POST', `/api/units/${encodeURIComponent(id)}/${encodeURIComponent(action)}`);
      return res?.status === 200;
    },
  };
}

module.exports = { APP_ID, request, findRunning, remoteApi };
