// -----------------------------------------------------------------------------
// Review 1 scenarios: the night redates the reference of the index (I1),
// only data frames of the link's serial keep it alive (I2), one serial per
// link (I3), the counters reset at sunrise chained (I4), an input added (M1),
// a device created while a save runs (M2). Real links against a real local
// TCP server where the link matters, the app timers on a fake clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { EnvertechApp } from '../src/app.js';
import { BuiltIndex, UNDO_WITHIN, validBuilt } from '../src/built.js';
import { Evt800Link } from '../src/evt800/client.js';
import { createMemoryStore } from '../src/store.js';
import { POLL, SERIAL, dataFrame } from './fixtures/evt800.js';
import { createFakeClock } from './helpers/fakeTimers.js';
import { DEVICE, F, HOUR, MINUTE, NOW, SELECTOR, created, setup, statesOf } from './helpers/app.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const frame = (e1 = 100, e2 = 100, extra = {}, serial = SERIAL) =>
  dataFrame({
    serial,
    inputs: [
      { power: 150, energy: e1, ...extra },
      { power: 150, energy: e2, ...extra },
    ],
  });
const message = (gladys) => gladys.fake.connectionStatus?.message?.en ?? '';
const discoveries = (gladys) =>
  gladys.fake.requests.filter((r) => r.method === 'POST' && r.path === '/discovered_device').length;

async function tcpServer() {
  const seen = { connections: 0, closed: 0, sockets: [] };
  const srv = createServer((socket) => {
    seen.connections += 1;
    seen.sockets.push(socket);
    socket.on('close', () => (seen.closed += 1));
    socket.on('error', () => {});
  });
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return {
    seen,
    address: `127.0.0.1:${srv.address().port}`,
    sock: () => seen.sockets.at(-1),
    close: async () => {
      for (const s of seen.sockets) s.destroy();
      await new Promise((resolve) => srv.close(resolve));
    },
  };
}

/** The app with real links (their timers on the fake clock too). */
async function realHarness({ devices = [], store = createMemoryStore(), address }) {
  const gladys = createFakeGladys({ selector: SELECTOR, config: { address }, devices });
  await gladys.connect();
  const { clock, timers, advance } = createFakeClock(NOW);
  const log = () => {};
  const app = new EnvertechApp({
    gladys,
    logger: { info: log, warn: log, error: log, debug: log },
    now: () => clock.now,
    monotonic: () => clock.now,
    timers,
    store,
    linkFactory: (options) => new Evt800Link({ ...options, timers, monotonic: () => clock.now }),
  });
  const pump = async (n = 4) => {
    for (let i = 0; i < n; i += 1) {
      await sleep(15);
      await advance(0);
      await app.idle();
    }
  };
  const wait = async (ms) => {
    await advance(ms);
    await pump();
  };
  return { gladys, app, clock, store, pump, wait };
}

/** A night: a low frame, the link lost, three silent attempts (asleep), then `hours`. */
async function night(s, hours, evening = frame(100, 100, { power: 5 })) {
  await s.send(evening);
  await s.fail('silent');
  for (let i = 0; i < 2; i += 1) {
    await s.wait(MINUTE);
    await s.fail('unreachable');
  }
  assert.match(message(s.gladys), /asleep/);
  for (let t = 0; t < hours * HOUR; t += 5 * MINUTE) {
    await s.wait(5 * MINUTE);
    await s.fail('unreachable');
  }
  await s.wait(5 * MINUTE);
  s.links.last().connect();
}

test('I1: after a night, a morning frame 8 kWh too high is held (the margin never covers the night)', async () => {
  const s = await setup({ devices: [created()] });
  await s.start();
  s.links.last().connect();
  await night(s, 12);
  assert.equal(s.store.data.night, true);
  const at = s.store.data.indexes[F('production_index')].guard.last.at;
  assert.ok(s.clock.now - at <= 5 * MINUTE, 'the reference is dated at the last attempt');
  await s.send(frame(108, 100, { power: 5 }));
  await s.wait(MINUTE);
  await s.send(frame(100.01, 100, { power: 5 }));
  await s.wait(MINUTE);
  await s.send(frame(100.02, 100, { power: 5 }));
  assert.deepEqual(statesOf(s.gladys, F('production_index')), [200, 200.01, 200.02]);
  assert.equal(s.store.data.night, false);
  // By day, an unchanged value never moves the date (the guard's rule kept).
  const day = s.store.data.indexes[F('production_index')].guard.last.at;
  await s.wait(MINUTE);
  await s.send(frame(100.02, 100, { power: 5 }));
  assert.equal(s.store.data.indexes[F('production_index')].guard.last.at, day);
});

test('I1: an hour of silence while producing is no night: the reference is not dated again', async () => {
  const s = await setup({ devices: [created()] });
  await s.start();
  s.links.last().connect();
  await s.send(frame(100, 100, { power: 300 }));
  const at = s.store.data.indexes[F('production_index')].guard.last.at;
  for (let t = 0; t <= HOUR; t += 15 * MINUTE) {
    await s.fail('unreachable');
    await s.wait(15 * MINUTE);
  }
  assert.match(message(s.gladys), /asleep/);
  assert.equal(s.store.data.indexes[F('production_index')].guard.last.at, at);
  assert.equal(s.store.data.night, false);
});

test('I2: poll frames alone after a data frame end the link after 90 s (real TCP)', async () => {
  const srv = await tcpServer();
  const h = await realHarness({ devices: [created()], address: srv.address });
  await h.app.start({ address: srv.address });
  await h.pump();
  srv.sock().write(frame(100, 100, { power: 300 }));
  await h.pump();
  for (let i = 0; i < 4; i += 1) {
    srv.sock()?.write(POLL);
    srv.sock()?.write(frame(100, 100, {}, '31529999'));
    await h.pump(2);
    await h.wait(30_000);
  }
  assert.equal(srv.seen.closed, 1, 'closed: no data frame of its serial for 90 s');
  assert.equal(h.gladys.fake.connectionStatus.connected, false);
  assert.match(message(h.gladys), /no frame for 90 s/);
  assert.equal(h.gladys.fake.lastState(F('online')), 0, 'no longer shown as current');
  assert.doesNotMatch((await h.app.testConnection()).en, /Connected\./);
  await h.app.shutdown();
  await srv.close();
});

test('I3: two serials alternating on one link: one Discovery, bounded saves (real TCP)', async () => {
  const srv = await tcpServer();
  let saves = 0;
  const store = createMemoryStore();
  const save = store.save.bind(store);
  store.save = async (data) => {
    saves += 1;
    return save(data);
  };
  const h = await realHarness({ devices: [created()], address: srv.address, store });
  await h.app.start({ address: srv.address });
  await h.pump();
  const before = discoveries(h.gladys);
  const savesBefore = saves;
  const chunk = [];
  for (let i = 0; i < 200; i += 1) {
    chunk.push(frame(100 + i / 1000, 100, {}, i % 2 ? '31529999' : SERIAL));
  }
  srv.sock().write(Buffer.concat(chunk));
  await h.pump(10);
  assert.ok(discoveries(h.gladys) - before <= 1);
  assert.ok(saves - savesBefore <= 3, `${saves - savesBefore} saves`);
  assert.equal(h.gladys.fake.discoveredDevices.at(-1).external_id, DEVICE());
  assert.doesNotMatch(message(h.gladys), /Another inverter/);
  await h.app.shutdown();
  await srv.close();
});

test('I4: counters reset at sunrise after a night: the index goes on, nothing counted twice', async () => {
  const s = await setup({ devices: [created()] });
  await s.start();
  s.links.last().connect();
  await night(s, 12, frame(1.2, 1.1, { power: 5 }));
  await s.send(frame(0.01, 0.01, { power: 30 }));
  await s.wait(MINUTE);
  await s.send(frame(0.02, 0.02, { power: 30 }));
  await s.wait(30 * MINUTE);
  await s.send(frame(0.5, 0.5, { power: 30 }));
  assert.deepEqual(statesOf(s.gladys, F('production_index')), [2.3, 2.32, 2.34, 3.3]);
  assert.doesNotMatch(message(s.gladys), /held|went back/);
});

test('I4: a lower frame after the night then the old counters back: undone, net zero', async () => {
  const s = await setup({ devices: [created()] });
  await s.start();
  s.links.last().connect();
  await night(s, 10);
  // A glitch: every counter tiny right after the wake-up.
  await s.send(frame(0.01, 0.01, { power: 30 }));
  await s.wait(MINUTE);
  // The real counters again: the reset is undone, the index is held until it
  // is back above the value taken (never counted twice).
  await s.send(frame(100.01, 100, { power: 30 }));
  await s.wait(MINUTE);
  await s.send(frame(100.03, 100, { power: 30 }));
  const states = statesOf(s.gladys, F('production_index'));
  assert.deepEqual(states, [200, 200.02, 200.03]);
});

test('I4: a drop by day (no night) is still held; the reset is never recognized without a night', async () => {
  const s = await setup({ devices: [created()] });
  await s.start();
  s.links.last().connect();
  await s.send(frame(100, 100));
  await s.wait(MINUTE);
  await s.send(frame(0.01, 0.01));
  assert.deepEqual(statesOf(s.gladys, F('production_index')), [200]);
  assert.match(message(s.gladys), /went back from 200 to 0.02 kWh.*every morning/);
});

test('BuiltIndex: reset, undo, change of inputs, state checked', () => {
  const b = new BuiltIndex();
  let r = b.read([10, 20], 0);
  assert.equal(r.value, 30);
  b.commit(r.next);
  r = b.read([0.1, 0.1], HOUR, { afterNight: true, maxKwh: 0.5 });
  assert.equal(r.kind, 'reset');
  assert.ok(Math.abs(r.value - 30.2) < 1e-9);
  b.commit(r.next);
  r = b.read([10, 20.1], 2 * HOUR);
  assert.equal(r.kind, 'undo');
  assert.ok(Math.abs(r.value - 30.1) < 1e-9);
  // Over the margin, or without a night: no reset.
  const c = new BuiltIndex({ base: 0, counters: [10, 20], reset: null });
  assert.equal(c.read([1, 1], 0, { afterNight: true, maxKwh: 0.5 }).kind, undefined);
  assert.equal(c.read([0.1, 0.1], 0, { afterNight: false, maxKwh: 0.5 }).kind, undefined);
  // One input lower only: no reset.
  assert.equal(c.read([0.1, 20], 0, { afterNight: true, maxKwh: 50 }).kind, undefined);
  // An input added: the index stays where it was.
  const d = new BuiltIndex({ base: 0, counters: [100], reset: null });
  r = d.read([100.01, 400], 0);
  assert.equal(r.kind, 'inputs');
  assert.ok(Math.abs(r.value - 100.01) < 1e-9);
  // A reset older than UNDO_WITHIN is never undone.
  const e = new BuiltIndex({ base: 30, counters: [0.1, 0.1], reset: { prev: [10, 20], at: 0 } });
  assert.equal(e.read([10, 20], UNDO_WITHIN + 1).kind, undefined);
  // /data checked.
  assert.deepEqual(validBuilt({ base: 'x', counters: [1, -1], reset: { prev: [1] } }), {
    base: 0,
    counters: null,
    reset: null,
  });
});

test('M1: the inputs are the blocks; a device updated to 2 inputs never jumps', async () => {
  const s = await setup({ devices: [created({ channels: 1 })] });
  await s.start();
  s.links.last().connect();
  await s.send(frame(100, 400));
  assert.equal(
    s.gladys.fake.discoveredDevices.at(-1).features.some((f) => f.external_id === F('power_2')),
    true,
  );
  assert.equal(s.gladys.fake.lastState(F('production_index')), 100);
  await s.wait(MINUTE);
  // The user clicks Update in Discovery: the device now has 2 inputs.
  s.gladys.devices.splice(0, s.gladys.devices.length, created({ channels: 2 }));
  await s.send(frame(100.01, 400.01));
  assert.deepEqual(statesOf(s.gladys, F('production_index')), [100, 100.01]);
});

test('M2: a device created while saves run: its old index state never comes back', async () => {
  const store = createMemoryStore({
    serial: SERIAL,
    channels: 2,
    indexes: { [F('production_index')]: { guard: { last: { value: 999, at: NOW }, held: null } } },
  });
  const s = await setup({ devices: [created()], store });
  await s.start();
  s.links.last().connect();
  await s.send(frame(100, 100));
  const created2 = created();
  await Promise.all([s.app.onDeviceCreated(created2), s.app.saveState()]);
  await s.settle();
  const kept = s.store.data.indexes[F('production_index')];
  assert.ok(!kept || kept.guard.last?.value !== 999);
});
