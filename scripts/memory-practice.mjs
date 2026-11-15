// Test-only HTTP transport for workspaces where even loopback sockets are denied.
// The kit env and its client/check/scorer code are imported without modification.
import http from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
const [kit, trial = '0', output = '/tmp/aggregator-memory-0'] = process.argv.slice(2);
if (!kit) throw new Error('usage: node scripts/memory-practice.mjs KIT TRIAL OUTPUT [--list]');
mkdirSync(output, { recursive: true });
Object.assign(process.env, {
  MAKEFUN_ENV_DATA_DIR: resolve(kit, `practice/trial-${trial}/input/env`),
  MAKEFUN_STATE_DIR: resolve(output), MAKEFUN_ENV_HOST: '127.0.0.1', MAKEFUN_ENV_PORT: '8080',
  MAKEFUN_ENV_URL: 'http://127.0.0.1:8080', MAKEFUN_PROMPT_FILE: resolve(kit, `practice/trial-${trial}/input/prompt.txt`),
});
const servers = new Map();
let nextPort = 19000;
http.createServer = (handler) => {
  const server = new EventEmitter();
  let address;
  server.listen = (...a) => {
    const opts = typeof a[0] === 'object' ? a[0] : { port: a[0], host: a[1] };
    address = { address: opts.host, family: 'IPv4', port: opts.port || nextPort++ };
    servers.set(address.port, handler);
    queueMicrotask(a.at(-1));
    return server;
  };
  server.address = () => address;
  server.close = () => { servers.delete(address.port); return server; };
  return server;
};
syncBuiltinESMExports();
globalThis.fetch = async (input, init = {}) => {
  const url = new URL(input);
  if (url.hostname !== '127.0.0.1') throw new Error('test transport allows loopback only');
  const handler = servers.get(Number(url.port));
  if (!handler) throw new Error('no listener');
  return new Promise((resolveResponse, reject) => {
    const req = Readable.from(init.body ? [Buffer.from(init.body)] : []);
    req.method = init.method ?? 'GET';
    req.url = url.pathname + url.search;
    req.headers = Object.fromEntries(new Headers(init.headers));
    req.headers.host = url.host;
    req.socket = { remoteAddress: '127.0.0.1' };
    let status = 200, headers = {}, ended = false;
    const chunks = [];
    const res = {
      headersSent: false,
      writeHead(code, h) { status = code; headers = h; this.headersSent = true; return this; },
      write(chunk) { chunks.push(Buffer.from(chunk)); return true; },
      end(chunk) {
        if (ended) return;
        ended = true;
        if (chunk) chunks.push(Buffer.from(chunk));
        resolveResponse(new Response(Buffer.concat(chunks), { status, headers }));
      },
    };
    try { handler(req, res); } catch (e) { reject(e); }
  });
};
const stdoutWrite = process.stdout.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);
await import(pathToFileURL(resolve(kit, 'program/env/server.mjs')));
process.stdout.write = stdoutWrite;
const exporter = process.listeners('SIGTERM')[0];
const realExit = process.exit.bind(process);
process.exit = (code) => {
  // The real env's SIGTERM handler builds exactly its normal state export.
  process.exit = () => {};
  exporter();
  process.exit = realExit;
  // Scorer file name is defined by the kit; leave all exported bytes untouched.
  realExit(code);
};
await import(pathToFileURL(resolve('main.ts')));
