// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, scripted links and a virtual clock.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { EnvertechApp } from '../../src/app.js';
import { buildDevice } from '../../src/devices.js';
import { Evt800Error } from '../../src/evt800/client.js';
import { parseFrame } from '../../src/evt800/protocol.js';
import { createMemoryStore } from '../../src/store.js';
import { ADDRESS, SERIAL } from '../fixtures/evt800.js';
import { createFakeClock } from './fakeTimers.js';

export const SELECTOR = 'envertech';
export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const NOW = Date.parse('2026-10-21T10:00:00Z');
export const F = (key, serial = SERIAL) => `ext:${SELECTOR}:inverter:${serial}:${key}`;
export const DEVICE = (serial = SERIAL) => `ext:${SELECTOR}:inverter:${serial}`;
export const CONFIG = { address: ADDRESS };

/** The device as the user created it (`channels` inputs), the index Gladys holds when given. */
export function created({ index, serial = SERIAL, channels = 2 } = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  const device = buildDevice(gladys, { serial, channels }, { address: ADDRESS });
  if (index) {
    const feature = device.features.find((f) => f.external_id === F('production_index', serial));
    feature.last_value = index.value;
    feature.last_value_changed = new Date(index.at).toISOString();
  }
  return device;
}

/** Scripted links: each one created by the app is kept, the test drives it. */
export function createLinks() {
  const links = [];
  const factory = (options) => {
    const link = {
      options,
      address: options.address,
      opened: false,
      closed: false,
      ended: false,
      open() {
        link.started = true;
      },
      close() {
        link.closed = true;
      },
      /** The inverter accepts the connection. */
      connect() {
        link.opened = true;
        options.onOpen();
      },
      /** The inverter sends a frame (a Buffer). */
      frame(buffer) {
        if (link.closed || link.ended) return undefined;
        const parsed = parseFrame(buffer);
        // As Evt800Link: the app's keepsAlive sees the frame first (it fixes the serial of the link).
        link.alive = (link.alive ?? 0) + (options.keepsAlive?.(parsed) ? 1 : 0);
        return options.onFrame(parsed);
      },
      /** The link ends with an error code, or without (closed by the inverter after frames). */
      end(code) {
        if (link.closed || link.ended) return undefined;
        link.ended = true;
        return options.onClose(code ? new Evt800Error(code) : undefined);
      },
    };
    links.push(link);
    return link;
  };
  return { links, factory, last: () => links[links.length - 1] };
}

export async function setup({
  devices = [],
  store = createMemoryStore(),
  now = NOW,
  config = CONFIG,
  links = createLinks(),
} = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices });
  await gladys.connect();
  const { clock, timers, advance } = createFakeClock(now);
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const app = new EnvertechApp({
    gladys,
    logger: { lines, info: log, warn: log, error: log, debug: log },
    now: () => clock.now,
    monotonic: () => clock.now,
    timers,
    store,
    linkFactory: links.factory,
  });
  const settle = async () => {
    for (let i = 0; i < 5; i += 1) {
      await advance(0);
      await app.idle();
    }
  };
  const start = async (cfg = config) => {
    await app.start(cfg);
    await settle();
  };
  const wait = async (ms) => {
    await advance(ms);
    await settle();
  };
  /** The current link sends a frame; everything it triggers done. */
  const send = async (buffer) => {
    links.last().frame(buffer);
    await settle();
  };
  const fail = async (code) => {
    links.last().end(code);
    await settle();
  };
  return { app, gladys, clock, store, links, start, wait, settle, send, fail, lines };
}

/** The states published for a feature, in order. */
export const statesOf = (gladys, featureId) =>
  gladys.fake.states.filter((s) => s.device_feature_external_id === featureId).map((s) => s.state);
