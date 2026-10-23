// -----------------------------------------------------------------------------
// The app: the pace, the device, the values once a minute, the index and its
// guard, the identity, the night, the late frames, the buttons.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../src/store.js';
import { ADDRESS, SERIAL, dataFrame } from './fixtures/evt800.js';
import {
  CONFIG,
  DEVICE,
  F,
  HOUR,
  MINUTE,
  NOW,
  createLinks,
  created,
  setup,
  statesOf,
} from './helpers/app.js';

const frame = (energy1 = 100, energy2 = 100, extra = {}) =>
  dataFrame({
    inputs: [
      { power: 150, energy: energy1, ...extra },
      { power: 150, energy: energy2, ...extra },
    ],
  });

const message = (gladys) => gladys.fake.connectionStatus?.message?.en ?? '';

test('first start: one connection; the first frame offers the device', async () => {
  const s = await setup();
  await s.start();
  assert.equal(s.links.links.length, 1);
  assert.equal(s.links.last().address, ADDRESS);
  s.links.last().connect();
  await s.settle();
  assert.match(message(s.gladys), /waiting for the first frame/);
  await s.send(frame());
  const device = s.gladys.fake.discoveredDevices.at(-1);
  assert.equal(device.external_id, DEVICE());
  assert.ok(device.features.some((f) => f.external_id === F('power_2')));
  assert.equal(s.gladys.fake.connectionStatus.connected, true);
  assert.match(message(s.gladys), /create its device/);
  assert.equal(s.gladys.fake.states.length, 0, 'no device created: nothing published');
  assert.equal(s.store.data.serial, SERIAL);
  assert.equal(s.store.data.channels, 2);
});

test('the values of a created device, at most once a minute, the newest frame', async () => {
  const s = await setup({ devices: [created()] });
  await s.start();
  s.links.last().connect();
  await s.send(frame(100, 100));
  assert.equal(s.gladys.fake.lastState(F('power')), 300);
  assert.equal(s.gladys.fake.lastState(F('production_index')), 200);
  assert.equal(s.gladys.fake.lastState(F('power_1')), 150);
  assert.equal(s.gladys.fake.lastState(F('dc_voltage_2')), 32);
  assert.equal(s.gladys.fake.lastState(F('ac_voltage')), 230);
  assert.equal(s.gladys.fake.lastState(F('frequency')), 50);
  assert.equal(s.gladys.fake.lastState(F('temperature_1')), 40);
  assert.equal(s.gladys.fake.lastState(F('online')), 1);
  assert.equal(s.gladys.fake.lastState(F('dc_current_1')), 4.69);
  assert.ok(
    !s.gladys.fake.states.some(
      (x) => x.device_feature_external_id === F('production_index_production'),
    ),
  );
  assert.equal(s.gladys.fake.connectionStatus.connected, true);
  // Three frames within the minute: none published before it ends, then the newest.
  for (const [i, e] of [100.01, 100.02, 100.03].entries()) {
    await s.wait(10_000);
    await s.send(frame(e, 100, { power: 200 + i }));
  }
  assert.deepEqual(statesOf(s.gladys, F('production_index')), [200]);
  await s.wait(30_000);
  assert.deepEqual(statesOf(s.gladys, F('production_index')), [200, 200.03]);
  assert.equal(s.gladys.fake.lastState(F('power_1')), 202);
  assert.equal(s.links.links.length, 1, 'one link the whole time');
  assert.equal(s.gladys.fake.sceneEvents.length, 0);
});

test('the pace: a restart, a reconnection, a save, the test button never connect sooner', async () => {
  const store = createMemoryStore();
  const links = createLinks();
  const s = await setup({ store, links });
  await s.start();
  assert.equal(links.links.length, 1);
  assert.equal(store.data.lastAttemptAt, NOW, 'kept BEFORE connecting');
  // Gladys reconnects, the form is saved again: the link is kept.
  await s.start();
  await s.start({ ...CONFIG });
  assert.equal(links.links.length, 1);
  // The link fails at once; the container restarts 10 s later.
  await s.fail('unreachable');
  await s.app.shutdown();
  const t = await setup({ store, links, now: NOW + 10_000 });
  await t.start();
  assert.equal(links.links.length, 1, 'no attempt before a minute');
  assert.match((await t.app.testConnection()).en, /No frame yet|Next try/);
  assert.equal(links.links.length, 1, 'the test button waits for the pace too');
  await t.app.scan();
  assert.equal(links.links.length, 1);
  await t.wait(50_000);
  assert.equal(links.links.length, 2, 'one minute after the last attempt');
});

test('the test button: tells the last frame, or connects when due and waits for one', async () => {
  const s = await setup();
  await s.start();
  s.links.last().connect();
  assert.match((await s.app.testConnection()).en, /no frame of the inverter yet/);
  await s.send(frame());
  assert.match(
    (await s.app.testConnection()).en,
    /Envertech inverter 31525820, 2 input\(s\), 300 W\. Connected/,
  );
  await s.fail('silent');
  await s.wait(MINUTE);
  // The schedule already connected again: the button tells, never doubles.
  assert.equal(s.links.links.length, 2);
  await s.app.testConnection();
  assert.equal(s.links.links.length, 2);
});

test('the test button makes the due attempt itself and answers with the frame', async () => {
  const s = await setup();
  await s.start();
  await s.fail('unreachable');
  // Due again in a minute: the timer is set; the click comes when due, first.
  s.clock.now += MINUTE;
  const answer = s.app.testConnection();
  await s.settle();
  const link = s.links.last();
  assert.equal(s.links.links.length, 2);
  link.connect();
  link.frame(frame());
  assert.match((await answer).en, /Frame received now|Last frame/);
});

test('index: a jump is held, shown, and taken only by the button; never 0, never partial', async () => {
  const s = await setup({ devices: [created({ index: { value: 200, at: NOW - MINUTE } })] });
  await s.start();
  s.links.last().connect();
  await s.send(frame(100, 100));
  // 50 kWh in a minute: held, the last value sent again.
  await s.wait(MINUTE);
  await s.send(frame(150, 100));
  assert.deepEqual(statesOf(s.gladys, F('production_index')), [200]);
  assert.match(message(s.gladys), /jumped from 200 to 250 kWh/);
  assert.ok(s.store.data.indexes[F('production_index')].guard.held);
  assert.match((await s.app.acceptHeldIndex()).en, /50 kWh/);
  await s.wait(MINUTE);
  await s.send(frame(150, 100.01));
  assert.equal(s.gladys.fake.lastState(F('production_index')), 250.01);
  // A counter at 0 or a missing input: no index at all (never 0, never a partial sum).
  await s.wait(MINUTE);
  await s.send(frame(0, 0));
  await s.wait(MINUTE);
  await s.send(dataFrame({ inputs: [{ energy: 300 }, { raw: { energy: 0xffffffff } }] }));
  assert.deepEqual(statesOf(s.gladys, F('production_index')), [200, 250.01]);
  assert.match(message(s.gladys), /lifetime counter of every input/);
});

test('a frame without serial is ignored; another serial goes to its own device only', async () => {
  const s = await setup({ devices: [created()] });
  await s.start();
  s.links.last().connect();
  await s.send(dataFrame({ serial: '00000000', inputs: [{}, {}] }));
  assert.equal(s.gladys.fake.states.length, 0);
  assert.equal(s.store.data.serial ?? null, null);
  await s.send(frame());
  let before = s.gladys.fake.states.length;
  await s.wait(MINUTE);
  // Another serial on the SAME link: ignored (review 1, I3).
  await s.send(dataFrame({ serial: '31529999', inputs: [{ energy: 5 }, { energy: 5 }] }));
  assert.equal(s.gladys.fake.discoveredDevices.at(-1).external_id, DEVICE());
  assert.equal(s.gladys.fake.states.length, before);
  // A DHCP swap: another inverter at the address, on a new link (the old
  // device is shown offline when the link is lost, nothing else).
  await s.fail('closed');
  assert.equal(s.gladys.fake.lastState(F('online')), 0);
  await s.wait(MINUTE);
  s.links.last().connect();
  before = s.gladys.fake.states.length;
  await s.send(dataFrame({ serial: '31529999', inputs: [{ energy: 5 }, { energy: 5 }] }));
  await s.wait(MINUTE);
  const after = s.gladys.fake.states.slice(before);
  assert.ok(after.every((x) => !x.device_feature_external_id.startsWith(DEVICE())));
  assert.equal(s.gladys.fake.discoveredDevices.at(-1).external_id, DEVICE('31529999'));
  assert.match(message(s.gladys), /create its device/);
});

test('the night: silent attempts after a low power are asleep, green, power 0, no index', async () => {
  const s = await setup({ devices: [created()] });
  await s.start();
  s.links.last().connect();
  await s.send(frame(100, 100, { power: 3 }));
  await s.fail('silent');
  for (let i = 0; i < 2; i += 1) {
    await s.wait(MINUTE);
    await s.fail('unreachable');
  }
  assert.equal(s.gladys.fake.connectionStatus.connected, true);
  assert.match(message(s.gladys), /asleep/);
  assert.equal(s.gladys.fake.lastState(F('power')), 0);
  assert.equal(s.gladys.fake.lastState(F('power_2')), 0);
  assert.equal(s.gladys.fake.lastState(F('online')), 0);
  assert.deepEqual(statesOf(s.gladys, F('production_index')), [200]);
  // Asleep: one attempt every 5 minutes.
  const count = s.links.links.length;
  await s.wait(4 * MINUTE);
  assert.equal(s.links.links.length, count);
  await s.wait(MINUTE);
  assert.equal(s.links.links.length, count + 1);
  // More than a day without a frame: red.
  for (let t = 0; t < 25 * HOUR; t += 5 * MINUTE) {
    await s.fail('unreachable');
    await s.wait(5 * MINUTE);
  }
  assert.equal(s.gladys.fake.connectionStatus.connected, false);
  assert.match(message(s.gladys), /more than a day/);
});

test('an inverter that vanishes producing is red, retries doubled; never a stale value', async () => {
  const s = await setup({ devices: [created()] });
  await s.start();
  s.links.last().connect();
  await s.send(frame());
  await s.fail('silent');
  assert.equal(s.gladys.fake.connectionStatus.connected, false);
  assert.match(message(s.gladys), /no frame for 90 s\): new try in 1 min/);
  await s.wait(MINUTE);
  await s.fail('unreachable');
  assert.match(message(s.gladys), /new try in 2 min/);
  assert.ok(!statesOf(s.gladys, F('power')).includes(0), 'never 0 W by day');
});

test('a late frame of the old address publishes nothing; a stale frame is never published', async () => {
  const s = await setup({ devices: [created()] });
  await s.start();
  const old = s.links.last();
  old.connect();
  await s.send(frame());
  await s.start({ address: '192.168.1.81' });
  assert.equal(old.closed, true);
  const count = s.gladys.fake.states.length;
  await s.wait(MINUTE);
  old.frame(frame(101, 101));
  await s.settle();
  await s.wait(MINUTE);
  assert.equal(s.gladys.fake.states.length, count);
  // Gladys goes away right after a frame; it comes back 3 minutes later.
  const t = await setup({ devices: [created()] });
  await t.start();
  t.links.last().connect();
  await t.send(frame());
  await t.wait(10_000);
  await t.send(frame(100.01, 100));
  await t.app.stop();
  await t.wait(3 * MINUTE);
  const n = t.gladys.fake.states.length;
  await t.start();
  assert.equal(t.gladys.fake.states.length, n, 'a frame of 3 minutes ago is not published');
  assert.equal(t.links.links.length, 1, 'the link was kept');
});

test('Discovery keeps the features of the created device; status and Discovery at every start', async () => {
  const s = await setup({ devices: [created({ channels: 2 })] });
  await s.start();
  s.links.last().connect();
  await s.send(dataFrame({ inputs: [{}] }));
  const device = s.gladys.fake.discoveredDevices.at(-1);
  assert.ok(device.features.some((f) => f.external_id === F('temperature_2')));
  const discoveries = () =>
    s.gladys.fake.requests.filter((r) => r.method === 'POST' && r.path === '/discovered_device')
      .length;
  const published = discoveries();
  const statuses = s.gladys.fake.connectionStatuses.length;
  await s.start();
  assert.equal(discoveries(), published + 1);
  assert.equal(s.gladys.fake.connectionStatuses.length, statuses + 1);
  // A restart by night: the device known from /data is offered again.
  const t = await setup({ store: s.store, now: NOW + HOUR });
  await t.start();
  assert.equal(t.gladys.fake.discoveredDevices.at(-1).external_id, DEVICE());
});

test('a frame every 5 s for 10 minutes stays far below 300 states a minute', async () => {
  const s = await setup({ devices: [created()] });
  await s.start();
  s.links.last().connect();
  for (let i = 0; i < 120; i += 1) {
    await s.send(frame(100 + i / 1000, 100, { power: 100 + i }));
    await s.wait(5000);
  }
  const perMinute = s.gladys.fake.states.length / 10;
  assert.ok(perMinute <= 20, `${perMinute} states a minute`);
});

test('/data holds no text of the inverter, only what is listed', async () => {
  const s = await setup({ devices: [created()] });
  await s.start();
  s.links.last().connect();
  await s.send(frame());
  assert.deepEqual(Object.keys(s.store.data).sort(), [
    'channels',
    'indexes',
    'lastAttemptAt',
    'lastGoodAt',
    'night',
    'serial',
  ]);
  const t = await setup({
    store: createMemoryStore({ serial: '__proto__', indexes: { __proto__: { a: 1 } } }),
  });
  assert.equal(t.app.info, undefined);
});
