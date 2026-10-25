// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout) and a
// real local TCP server playing the inverter (one data frame, then it closes
// the connection): the connections really start, at 0, the interval and
// twice the interval, with a bounded number of timers. The time is sped up
// 100 times (60 s of the interval are 600 ms) but it is the real clock: it
// moves between any two reads of it.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { EnvertechApp } from '../src/app.js';
import { POLL_INTERVAL } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { TWO_MPPT } from './fixtures/evt800.js';

const SPEED = 100;

test('real clock: connections at 0, the interval and twice the interval; timers bounded', async () => {
  const connections = [];
  const server = createServer((socket) => {
    connections.push(performance.now() * SPEED);
    socket.on('error', () => {});
    socket.write(TWO_MPPT);
    // The inverter closes after its frame: the app connects again at the pace.
    setTimeout(() => socket.destroy(), 10);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  let timersSet = 0;
  const timers = {
    setTimeout(fn, ms) {
      timersSet += 1;
      return setTimeout(fn, Math.max(0, ms) / SPEED);
    },
    clearTimeout: (id) => clearTimeout(id),
  };
  const gladys = createFakeGladys({ selector: 'envertech', config: {} });
  await gladys.connect();
  const quiet = () => {};
  const app = new EnvertechApp({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: () => Date.now() * SPEED,
    monotonic: () => performance.now() * SPEED,
    timers,
    store: createMemoryStore(),
  });
  const started = performance.now() * SPEED;
  try {
    await app.start({ address: `127.0.0.1:${port}` });
    // Counted from the first connection (a cold start of the socket takes a few ms).
    const deadline = started + POLL_INTERVAL;
    while (connections.length === 0 && performance.now() * SPEED < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const until = (connections[0] ?? started) + 2.5 * POLL_INTERVAL;
    while (performance.now() * SPEED < until) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await app.stop();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  const at = connections.map((t) => Math.round(t - started));
  assert.equal(connections.length, 3, `connections at ${at}`);
  assert.ok(connections[0] - started < 0.75 * POLL_INTERVAL, `the first at once: ${at}`);
  for (let i = 1; i < connections.length; i += 1) {
    const gap = connections[i] - connections[i - 1];
    // Seen by the server: the latency of the connection before (a few real
    // ms, times SPEED, more on a loaded CI) may shorten the gap seen here:
    // wide margins.
    assert.ok(gap >= 0.7 * POLL_INTERVAL, `never sooner than the interval: ${at}`);
    assert.ok(gap < 1.5 * POLL_INTERVAL, `on time: ${at}`);
  }
  assert.ok(timersSet <= 20, `${timersSet} timers`);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});
