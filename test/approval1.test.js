// -----------------------------------------------------------------------------
// Approval 1 scenarios: the built index survives restarts by day and by night
// (B1), a normal climb never undoes a reset (I-a), the date of the night is
// kept after a restart (M-a).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BuiltIndex } from '../src/built.js';
import { createMemoryStore } from '../src/store.js';
import { SERIAL, dataFrame } from './fixtures/evt800.js';
import { F, HOUR, MINUTE, created, setup, statesOf } from './helpers/app.js';

const frame = (e1, e2, power = 100) =>
  dataFrame({
    serial: SERIAL,
    inputs: [
      { power, energy: e1 },
      { power, energy: e2 },
    ],
  });
const message = (gladys) => gladys.fake.connectionStatus?.message?.en ?? '';
const INDEX = F('production_index');

async function night(s, hours, evening) {
  await s.send(evening);
  await s.fail('silent');
  for (let i = 0; i < 2; i += 1) {
    await s.wait(MINUTE);
    await s.fail('unreachable');
  }
  for (let t = 0; t < hours * HOUR; t += 5 * MINUTE) {
    await s.wait(5 * MINUTE);
    await s.fail('unreachable');
  }
  await s.wait(5 * MINUTE);
  s.links.last().connect();
}

/** Counters of each input from `from` to `to` in `minutes`, one frame a minute. */
async function day(s, from, to, minutes, power = 200) {
  for (let m = 0; m <= minutes; m += 1) {
    const e = Math.round((from + ((to - from) * m) / minutes) * 10000) / 10000;
    await s.send(frame(e, e, power));
    await s.wait(MINUTE);
  }
}

const drops = (states) => states.filter((v, i) => i > 0 && v < states[i - 1]).length;

test('I-a: a dim day then a sunny morning: the reset is never undone by the climb', async () => {
  const s = await setup({ devices: [created()] });
  await s.start();
  s.links.last().connect();
  await day(s, 0.01, 0.15, 30, 30);
  await night(s, 12, frame(0.15, 0.15, 5));
  await day(s, 0.001, 0.6, 120, 300);
  const states = statesOf(s.gladys, INDEX);
  assert.equal(drops(states), 0);
  assert.ok(states.at(-1) >= 1.49 && states.at(-1) <= 1.51, `${states.at(-1)}`);
  assert.doesNotMatch(message(s.gladys), /held|went back|jumped/);
});

test('I-a: BuiltIndex undoes only a return at once', () => {
  const b = new BuiltIndex({ base: 0, counters: [0.15, 0.15], reset: null });
  let r = b.read([0.001, 0.001], 0, { afterNight: true, maxKwh: 0.25 });
  assert.equal(r.kind, 'reset');
  b.commit(r.next);
  // A slow climb past the evening values: no undo.
  r = b.read([0.16, 0.16], HOUR, { maxKwh: 0.35 });
  assert.equal(r.kind, undefined);
  // The evening values back at once: undone.
  r = b.read([0.15, 0.15], MINUTE, { maxKwh: 0.13 });
  assert.equal(r.kind, 'undo');
});

test('B1: a restart by day after a recognized reset: the base is kept, the index goes on', async () => {
  const store = createMemoryStore();
  const s = await setup({ devices: [created()], store });
  await s.start();
  s.links.last().connect();
  await day(s, 0.01, 1, 30, 300);
  await night(s, 12, frame(1, 1, 5));
  await day(s, 0.001, 0.3, 60, 300);
  const before = statesOf(s.gladys, INDEX).at(-1);
  assert.ok(before > 2.5, `${before}`);
  const base = store.data.indexes[INDEX].built.base;
  assert.ok(base > 1.9);
  await s.app.shutdown();
  const t = await setup({
    devices: [created({ index: { value: before, at: s.clock.now - MINUTE } })],
    store,
    now: s.clock.now + 2 * MINUTE,
  });
  await t.start();
  assert.equal(store.data.indexes[INDEX].built.base, base, 'never null after a start');
  t.links.last().connect();
  await day(t, 0.32, 0.4, 10, 300);
  const after = statesOf(t.gladys, INDEX);
  assert.equal(drops(after), 0);
  assert.ok(after.at(-1) > before);
  assert.doesNotMatch(message(t.gladys), /went back/);
});

test('B1, M-a: a restart at night: the date of the night kept, the morning reset recognized', async () => {
  const store = createMemoryStore();
  const s = await setup({ devices: [created()], store });
  await s.start();
  s.links.last().connect();
  await day(s, 0.01, 1, 30, 300);
  await night(s, 6, frame(1, 1, 5));
  const nightAt = store.data.indexes[INDEX].guard.last.at;
  await s.app.shutdown();
  // Gladys holds the evening date of the same value.
  const t = await setup({
    devices: [created({ index: { value: 2, at: s.clock.now - 6 * HOUR } })],
    store,
    now: s.clock.now + 2 * MINUTE,
  });
  await t.start();
  assert.equal(t.app.asleepLow, true);
  const guard = t.app.guardOf(t.app.createdDevice(SERIAL), INDEX);
  assert.equal(guard.last.at, nightAt, 'the date of /data, not the evening');
  // Asleep: the next attempt comes at the night pace.
  await t.wait(5 * MINUTE);
  t.links.last().connect();
  await day(t, 0.002, 0.2, 30, 300);
  const states = statesOf(t.gladys, INDEX);
  assert.equal(drops(states), 0);
  assert.ok(states.at(-1) >= 2.39, `${states.at(-1)}`);
  assert.doesNotMatch(message(t.gladys), /went back/);
});
