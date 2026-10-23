// -----------------------------------------------------------------------------
// Approval 2, A6: a tiny evening (its sum under the margin) is never taken as
// a reset: a glitch at the wake-up then the real counters never count the
// evening twice.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BuiltIndex } from '../src/built.js';
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
const INDEX = F('production_index');

test('A6: BuiltIndex refuses a reset when the evening sum is under the margin', () => {
  const tiny = new BuiltIndex({ base: 0, counters: [0.05, 0.05], reset: null });
  assert.equal(tiny.read([0.001, 0.001], 0, { afterNight: true, maxKwh: 0.27 }).kind, undefined);
  const real = new BuiltIndex({ base: 0, counters: [0.2, 0.2], reset: null });
  assert.equal(real.read([0.001, 0.001], 0, { afterNight: true, maxKwh: 0.27 }).kind, 'reset');
});

test('A6: tiny evening, a glitch at the wake-up, the real counters back: never counted twice', async () => {
  const s = await setup({ devices: [created()] });
  await s.start();
  s.links.last().connect();
  // A tiny day: 0.05 kWh per input, then the night.
  await s.send(frame(0.05, 0.05, 5));
  await s.fail('silent');
  for (let i = 0; i < 2; i += 1) {
    await s.wait(MINUTE);
    await s.fail('unreachable');
  }
  for (let t = 0; t < 10 * HOUR; t += 5 * MINUTE) {
    await s.wait(5 * MINUTE);
    await s.fail('unreachable');
  }
  await s.wait(5 * MINUTE);
  s.links.last().connect();
  // A glitch: every counter lower at the wake-up; then the real counters.
  await s.send(frame(0.001, 0.001, 30));
  await s.wait(MINUTE);
  for (let m = 0; m <= 10; m += 1) {
    const e = 0.05 + m * 0.001;
    await s.send(frame(e, e, 120));
    await s.wait(MINUTE);
  }
  const states = statesOf(s.gladys, INDEX);
  // Real production: 0.1 in the evening, 0.02 the next morning.
  assert.ok(states.at(-1) <= 0.12 + 0.001, `counted twice? ${states.at(-1)}`);
  assert.ok(
    states.every((v, i) => i === 0 || v >= states[i - 1]),
    JSON.stringify(states),
  );
});
