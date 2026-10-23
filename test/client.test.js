// -----------------------------------------------------------------------------
// The TCP link against a real local server (127.0.0.1): one connection, the
// frames decoded and acknowledged as the library does, the end codes.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { Evt800Link, hostPort } from '../src/evt800/client.js';
import { POLL, TWO_MPPT, dataFrame } from './fixtures/evt800.js';

/** A local server: `onSocket(socket)` for each connection; counts them and the bytes received. */
async function server(onSocket) {
  const seen = { connections: 0, received: [] };
  const srv = createServer((socket) => {
    seen.connections += 1;
    socket.on('data', (chunk) => seen.received.push(chunk));
    socket.on('error', () => {});
    onSocket(socket);
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  return {
    seen,
    address: `127.0.0.1:${port}`,
    close: () => new Promise((resolve) => srv.close(resolve)),
  };
}

/** A link and a promise of its end. `fast`: the silence of 90 s shortened to 100 ms. */
function link(address, { fast = false } = {}) {
  const frames = [];
  let opened = false;
  let resolveEnd;
  const ended = new Promise((resolve) => (resolveEnd = resolve));
  const timers = fast
    ? { setTimeout: (fn, ms) => setTimeout(fn, ms === 90_000 ? 100 : ms), clearTimeout }
    : { setTimeout, clearTimeout };
  const l = new Evt800Link({
    address,
    timers,
    onOpen: () => (opened = true),
    onFrame: (parsed) => frames.push(parsed),
    onClose: (err) => resolveEnd(err ?? null),
  });
  return { l, frames, ended, opened: () => opened };
}

test('hostPort: the default port 14889, IPv6, a port given', () => {
  assert.deepEqual(hostPort('192.168.1.80'), { host: '192.168.1.80', port: 14889 });
  assert.deepEqual(hostPort('evt.lan:1234'), { host: 'evt.lan', port: 1234 });
  assert.deepEqual(hostPort('[fe80::1]:99'), { host: 'fe80::1', port: 99 });
  assert.deepEqual(hostPort('[fe80::1]'), { host: 'fe80::1', port: 14889 });
});

test('frames are decoded and each one acknowledged, on one connection', async () => {
  const s = await server((socket) => {
    socket.write(Buffer.concat([POLL, TWO_MPPT.subarray(0, 40)]));
    setTimeout(() => socket.write(TWO_MPPT.subarray(40)), 20);
    setTimeout(() => socket.end(), 80);
  });
  const t = link(s.address);
  t.l.open();
  const err = await t.ended;
  assert.equal(err, null, 'closed by the inverter after frames: no error');
  assert.ok(t.opened());
  assert.deepEqual(
    t.frames.map((f) => f.kind),
    ['poll', 'data'],
  );
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(s.seen.connections, 1);
  const acks = Buffer.concat(s.seen.received).toString('hex');
  assert.equal(acks, '68001068105001000001000000007816' + '68001068105031525820000000007816');
  await s.close();
});

test('closed before any frame, nothing listening, silence, not an EVT800, a flood', async () => {
  const quiet = await server((socket) => socket.end());
  const a = link(quiet.address);
  a.l.open();
  assert.equal((await a.ended).code, 'closed');
  await quiet.close();

  // A port nobody listens on (just closed).
  const b = link(quiet.address);
  b.l.open();
  assert.equal((await b.ended).code, 'unreachable');

  const mute = await server(() => {});
  const c = link(mute.address, { fast: true });
  c.l.open();
  assert.equal((await c.ended).code, 'silent');
  await mute.close();

  const web = await server((socket) => socket.write(Buffer.alloc(3000, 0x41)));
  const d = link(web.address);
  d.l.open();
  assert.equal((await d.ended).code, 'unknown_answer');
  await web.close();

  const many = Buffer.concat(Array.from({ length: 1000 }, () => dataFrame()));
  const flood = await server((socket) => socket.write(many));
  const e = link(flood.address);
  e.l.open();
  assert.equal((await e.ended).code, 'flood');
  assert.ok(e.frames.length < 1000);
  await flood.close();
});

test('close() ends the link without calling onClose', async () => {
  const s = await server(() => {});
  let called = false;
  const l = new Evt800Link({ address: s.address, onClose: () => (called = true) });
  l.open();
  await new Promise((resolve) => setTimeout(resolve, 50));
  l.close();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(called, false);
  assert.equal(s.seen.connections, 1);
  await s.close();
});

test('the client sends nothing but acknowledgements (no header, no User-Agent)', async () => {
  const { readFileSync } = await import('node:fs');
  const code = readFileSync(new URL('../src/evt800/client.js', import.meta.url), 'utf8')
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  assert.equal((code.match(/\.write\(/g) ?? []).length, 1, 'one write: the acknowledgement');
  assert.ok(code.includes('this.socket.write(ack)'));
  for (const word of ['agent', 'User-Agent', 'user-agent', 'fetch(']) {
    assert.ok(!code.includes(word), word);
  }
});
