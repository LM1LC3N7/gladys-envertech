// -----------------------------------------------------------------------------
// The integration itself: one TCP link to the EVT800 micro-inverter, its
// frames (each acknowledged by src/evt800/client.js), its device, the
// production index (the sum of the lifetime counters of its inputs) checked
// by its guard, the night, the pace kept in /data, the test and accept
// buttons. index.js only wires the SDK handlers to it. Read-only: nothing is
// ever sent to the inverter but the acknowledgement of its frames.
//
// The structure comes from gladys-omnik (approved): one timer, a session per
// address, the pace kept across restarts, the night, the guard.
//
// The pace is global and kept across restarts: never two connection attempts
// less than a minute apart, whatever asks (a reconnection to Gladys, a save of
// the form, the test button, the Discover tab, a device created, a restart of
// the container: the time of the last attempt is kept in /data, written
// BEFORE connecting). A link already open is never doubled: a reconnection to
// Gladys or a save of the same address keeps it. The values are published at
// most once a minute (the last frame, never one older than 2 minutes).
//
// A frame belongs to its session (the link of one address): when the address
// changes, the old link is closed and a late frame of it publishes nothing and
// sets no status (checked after every await).
//
// Identity: the serial is in every data frame, with its values. A frame
// without a readable serial is ignored (never "another inverter"); a frame
// with another serial goes to that inverter's own device, never to the
// previous one (a DHCP swap).
//
// Two clocks: `now` (wall clock) dates the index and what /data keeps;
// `monotonic` paces the attempts, so that a wall clock set back never stops
// them.
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { normalizeConfig } from './config.js';
import {
  ASLEEP_AFTER,
  ATTEMPT_SAVE_EVERY,
  AWAKE_POWER,
  ENERGY_MAX,
  FRAME_FRESH,
  INDEX_MAX_KW,
  INDEX_SLACK_KWH,
  LONG_SILENCE,
  MAX_KW_MAX,
  MAX_KW_MIN,
  MISSES_BEFORE_ASLEEP,
  POLL_INTERVAL,
  PUBLISH_INTERVAL,
  RETRY_MAX,
  RETRY_MIN,
  SLEEP_INTERVAL,
  STATE_HEARTBEAT,
  TEST_ANSWER_WITHIN,
} from './constants.js';
import {
  FEATURE,
  asleepStates,
  buildDevice,
  channelsOfDevice,
  ids,
  keepCreatedFeatures,
  readingStates,
  round,
  totalPower,
  within,
} from './devices.js';
import { BuiltIndex } from './built.js';
import { Evt800Link } from './evt800/client.js';
import { MAX_CHANNELS } from './evt800/protocol.js';
import { IndexGuard } from './guard.js';
import { T } from './i18n.js';
import { createFileStore } from './store.js';

const defaultTimers = { setTimeout, clearTimeout };

const SERIAL = /^[0-9A-F]{8}$/;
/** At most this many index states kept in /data (one per inverter serial seen). */
const MAX_KEPT_INDEXES = 8;
/** Codes of a link that may be the night (the inverter is powered by its panels). */
const SILENT_CODES = new Set(['timeout', 'unreachable', 'closed', 'silent']);

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

/** The margin of the index (kW): 1.25 x the peak power typed, bounded; else INDEX_MAX_KW. */
export function maxKwOf(peakKw) {
  if (!finite(peakKw)) {
    return INDEX_MAX_KW;
  }
  return Math.min(MAX_KW_MAX, Math.max(MAX_KW_MIN, Math.ceil(peakKw * 1.25 * 10) / 10));
}

/**
 * The number of inputs of a data frame: its number of blocks (review 1, M1: a
 * block with an id of 0 counts, so that a frame of 86 bytes always gives 2 and
 * the device never gains an input with a whole lifetime counter behind it).
 */
export function inputsOf(reading) {
  return reading.channels.length;
}

/**
 * The lifetime counters of a frame for a device with `channels` inputs, only
 * when EVERY one of them gives one (a partial sum would be a drop, then a
 * jump); undefined otherwise.
 */
export function countersOf(reading, channels) {
  if (!(channels > 0)) return undefined;
  const counters = [];
  for (let n = 1; n <= channels; n += 1) {
    const energy = within(reading.channels[n - 1]?.energy, ENERGY_MAX);
    if (energy === undefined) return undefined;
    counters.push(energy);
  }
  return counters;
}

/** After the wake-up from a confirmed night, a reset of the counters is recognized this long. */
const RESET_AFTER_WAKE = 60 * 60_000;

/** The index Gladys already holds for a feature of a created device, when it says so. */
function lastValueOf(device, featureId) {
  const feature = (device?.features ?? []).find((f) => f.external_id === featureId);
  const value = Number(feature?.last_value);
  const at = Date.parse(feature?.last_value_changed ?? '');
  return feature?.last_value !== null &&
    feature?.last_value !== undefined &&
    Number.isFinite(value) &&
    Number.isFinite(at)
    ? { value, at }
    : undefined;
}

/** The index states kept in /data: plain objects under string keys only. */
function keptIndexes(indexes) {
  if (!indexes || typeof indexes !== 'object' || Array.isArray(indexes)) {
    return {};
  }
  const kept = {};
  for (const [key, value] of Object.entries(indexes)) {
    if (key !== '__proto__' && value && typeof value === 'object' && !Array.isArray(value)) {
      kept[key] = value;
    }
  }
  return kept;
}

export class EnvertechApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'envertech' }),
    now = Date.now,
    monotonic = () => performance.now(),
    timers = defaultTimers,
    linkFactory = (options) => new Evt800Link(options),
    store = createFileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.linkFactory = linkFactory;
    /** /data: index guards, serial, inputs, time of the last attempt and of the last frame. */
    this.store = store;
    this.savedKey = undefined;
    this.config = normalizeConfig();
    /** `{ link, discovered }` of the current address; replaced (never reused) when it changes. */
    this.session = undefined;
    this.running = false;
    this.timer = undefined;
    this.publishTimer = undefined;
    this.connecting = Promise.resolve();
    this.flushing = Promise.resolve();
    this.jobs = Promise.resolve();
    this.lifecycle = Promise.resolve();
    this.lastStatus = undefined;
    /** The test button waits for these: resolved by a data frame or the end of a link. */
    this.waiters = [];

    const kept = store.load();
    const at = now();
    /** `{ serial, firmware, channels }` of the inverter; the serial and inputs alone when read back. */
    this.info =
      typeof kept.serial === 'string' && SERIAL.test(kept.serial)
        ? {
            serial: kept.serial,
            channels:
              Number.isInteger(kept.channels) && kept.channels >= 1 && kept.channels <= MAX_CHANNELS
                ? kept.channels
                : 1,
          }
        : undefined;
    // The last attempt before a restart: the next one never comes sooner than
    // the interval (a date in the future, a clock set back, is brought to now).
    this.lastAttemptAt = finite(kept.lastAttemptAt) ? Math.min(kept.lastAttemptAt, at) : undefined;
    this.savedAttemptAt = this.lastAttemptAt;
    /** Monotonic time of the last connection attempt. */
    this.lastConnectAt =
      this.lastAttemptAt === undefined ? undefined : monotonic() - (at - this.lastAttemptAt);
    /** Wall time of the last data frame, for LONG_SILENCE. */
    this.lastGoodAt = finite(kept.lastGoodAt) ? Math.min(kept.lastGoodAt, at) : undefined;
    this.startedAt = at;
    /** Monotonic time of the last publication of values. */
    this.lastPublishAt = undefined;
    /** By index feature external id: IndexGuard, and BuiltIndex (src/built.js). */
    this.guards = new Map();
    this.builts = new Map();
    /** The saves to /data, one after the other (review 1, M2). */
    this.saveQueue = Promise.resolve();
    this.resetReads();
    if (kept.night === true) {
      // Asleep after a low power when the container stopped: still the night
      // (the reset of the counters at sunrise is recognized after a restart).
      this.asleep = true;
      this.asleepLow = true;
    }
  }

  /** What belongs to one address: forgotten when it changes. */
  resetReads() {
    /** The last outcome: `{ at (monotonic), kind: 'reading' | 'asleep' | 'error', reading?, err? }`. */
    this.outcome = undefined;
    /** The last data frame: `{ at (monotonic), reading, published }`. */
    this.latest = undefined;
    this.asleep = false;
    /** Asleep after a low power (a real night, not an outage while producing). */
    this.asleepLow = false;
    /** Wall time of the first frame after such a night. */
    this.wokeAt = undefined;
    this.misses = 0;
    this.firstMissAt = undefined;
    /** The total power of the last frame (W): an inverter that vanishes producing more is not asleep. */
    this.lastPower = undefined;
    /** Wrong answers and vanished inverters: retries doubled, in memory. */
    this.failures = 0;
    this.nextTryAt = undefined;
    this.lastError = undefined;
    this.noSerial = false;
    this.noIndex = false;
    this.otherInverter = undefined;
  }

  // --- Lifecycle -------------------------------------------------------------

  start(raw = {}) {
    return this.serialize(() => this.doStart(raw));
  }

  /** Gladys is gone: nothing is published until the next start; the link stays. */
  stop() {
    return this.serialize(() => this.doStop());
  }

  /** The container stops: the link is closed too. */
  shutdown() {
    return this.serialize(() => {
      this.doStop();
      this.session?.link?.close();
      if (this.session) this.session.link = undefined;
    });
  }

  /** Resolves once every queued start/stop and the work running are done (tests). */
  async idle() {
    await this.lifecycle;
    await this.connecting;
    await this.jobs;
    await this.flushing;
  }

  serialize(job) {
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch(() => {});
    return run;
  }

  async doStart(raw) {
    this.doStop();
    const config = normalizeConfig(raw);
    const first = this.session === undefined;
    const changed = first || config.address !== this.config.address;
    this.config = config;
    if (changed) {
      // Another address: its own link and story. The pace does not end
      // (never two attempts less than a minute apart).
      this.session?.link?.close();
      this.session = { link: undefined, discovered: false };
      if (!first) {
        this.resetReads();
        this.lastGoodAt = undefined;
        this.startedAt = this.now();
      }
    }
    this.running = true;
    // The core keeps the connection status, the Discovery list and the last
    // values in memory: a restarted Gladys has lost them, so they are always
    // sent again (the values with the next frame).
    this.lastStatus = undefined;
    this.gladys.forgetPublishedStates?.();
    if (!config.address) {
      await this.setStatus(...this.currentStatus());
      return;
    }
    if (!changed || first) {
      // Another address may be another inverter: its device is published
      // once its serial is read, never the old one with the new address.
      await this.discover();
    }
    await this.updateStatus();
    if (this.latest && !this.latest.published) {
      this.requestPublish();
    }
    this.schedule();
  }

  doStop() {
    this.running = false;
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (this.publishTimer !== undefined) {
      this.timers.clearTimeout(this.publishTimer);
      this.publishTimer = undefined;
    }
  }

  // --- Pace ------------------------------------------------------------------

  /** The monotonic time from which the next connection attempt may start. */
  dueAt() {
    const mono = this.monotonic();
    let due =
      this.lastConnectAt === undefined
        ? mono
        : this.lastConnectAt + (this.asleep ? SLEEP_INTERVAL : POLL_INTERVAL);
    if (this.nextTryAt !== undefined) {
      due = Math.max(due, this.nextTryAt);
    }
    return due;
  }

  /** One timer: the next connection attempt when it is due (none while a link is open). */
  schedule() {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    if (!this.running || !this.config.address || this.session?.link) {
      return;
    }
    const wait = Math.max(0, this.dueAt() - this.monotonic());
    this.timer = this.timers.setTimeout(() => {
      this.timer = undefined;
      this.connecting = this.connectNow();
      return this.connecting;
    }, wait);
  }

  async connectNow() {
    const session = this.session;
    if (!this.running || !this.config.address || !session || session.link) {
      return;
    }
    const mono = this.monotonic();
    if (mono < this.dueAt()) {
      this.schedule();
      return;
    }
    this.lastConnectAt = mono;
    // Kept BEFORE connecting: a restart during it never connects again sooner.
    await this.saveAttempt(this.now());
    if (session !== this.session || !this.running || session.link) {
      return;
    }
    // One serial per link (review 1, I3): the first data frame with a readable
    // serial fixes it, synchronously, before any other frame of the same
    // chunk. Another serial on the same TCP link is not a DHCP swap: ignored,
    // and it never keeps the link alive (I2). A new link may give another one.
    const ctx = { serial: undefined, warned: false };
    const keepsAlive = (parsed) => {
      if (parsed.kind !== 'data' || !parsed.serial || parsed.channels.length === 0) {
        return false;
      }
      ctx.serial ??= parsed.serial;
      return parsed.serial === ctx.serial;
    };
    const link = this.linkFactory({
      address: this.config.address,
      keepsAlive,
      onOpen: () => this.guarded(() => this.linkOpened(session, link)),
      onFrame: (parsed) => this.guarded(() => this.frameReceived(session, link, ctx, parsed)),
      onClose: (err) => this.guarded(() => this.linkClosed(session, link, err)),
    });
    session.link = link;
    link.open();
  }

  /** A job after the others, never thrown at the link. */
  guarded(job) {
    const run = this.jobs.then(job).catch((err) => {
      this.logger.error(`Envertech: unexpected error (${err?.name ?? 'Error'})`);
    });
    this.jobs = run;
    return run;
  }

  async saveAttempt(now) {
    this.lastAttemptAt = now;
    if (
      this.savedAttemptAt === undefined ||
      now < this.savedAttemptAt ||
      now - this.savedAttemptAt >= ATTEMPT_SAVE_EVERY
    ) {
      this.savedAttemptAt = now;
      await this.saveState();
    }
  }

  // --- The link ----------------------------------------------------------------------

  async linkOpened(session, link) {
    if (session !== this.session || link !== session.link || !this.running) return;
    await this.updateStatus();
  }

  async frameReceived(session, link, ctx, parsed) {
    if (session !== this.session || link !== session.link) {
      return;
    }
    const gone = () => session !== this.session;
    if (parsed.kind !== 'data') {
      // A poll frame (its serial only) or a frame of another kind: acknowledged, nothing else.
      return;
    }
    const inputs = inputsOf(parsed);
    if (!parsed.serial || inputs === 0) {
      // A serial unreadable once is never "another inverter": nothing written.
      if (!this.noSerial) {
        this.logger.warn('Envertech: a frame without serial number or input, ignored');
      }
      this.noSerial = !parsed.serial;
      return;
    }
    if (parsed.serial !== ctx.serial) {
      // Another serial on the same link (I3): ignored, logged once per link.
      if (!ctx.warned) {
        ctx.warned = true;
        this.logger.warn('Envertech: frames of two serial numbers on one link, the second ignored');
      }
      return;
    }
    this.noSerial = false;
    const mono = this.monotonic();
    const serial = parsed.serial;
    const previous = this.info?.serial;
    if (previous !== undefined && previous !== serial) {
      // At most once per link: the serial of a link never changes (M3).
      this.otherInverter = serial;
      this.logger.warn('Envertech: another inverter answers at this address');
    }
    if (this.asleepLow) {
      // The first frame after a confirmed night: a reset of the counters is
      // recognized for a while (src/built.js).
      this.wokeAt = this.now();
    }
    const nightEnds = this.asleepLow;
    this.asleepLow = false;
    const firmware = parsed.channels.find((c) => !c.empty)?.firmware;
    const known = previous === serial ? (this.info.channels ?? 0) : 0;
    const created = channelsOfDevice(this.gladys, serial, this.createdDevice(serial));
    const info = { serial, firmware, channels: Math.max(known, created, inputs) };
    const infoChanged = JSON.stringify(info) !== JSON.stringify(this.info);
    this.info = info;
    this.failures = 0;
    this.nextTryAt = undefined;
    this.lastError = undefined;
    this.misses = 0;
    this.firstMissAt = undefined;
    this.asleep = false;
    this.lastGoodAt = this.now();
    const power = totalPower(parsed, inputs);
    if (power !== undefined) this.lastPower = power;
    this.outcome = { at: mono, kind: 'reading', reading: parsed };
    this.latest = { at: mono, reading: parsed, published: false };
    this.resolveWaiters();
    if (infoChanged || nightEnds) {
      // The serial and inputs in /data: a restart by night still offers the device.
      await this.saveState();
      if (gone()) return;
    }
    if (!this.running) {
      return;
    }
    if (infoChanged || !session.discovered) {
      // Also the first frame of a session: a new address of the same
      // inverter reaches the Discovery list at once.
      session.discovered = true;
      await this.discover();
      if (gone()) return;
    }
    this.requestPublish();
    await this.updateStatus();
  }

  async linkClosed(session, link, err) {
    if (session !== this.session || link !== session.link) {
      return;
    }
    session.link = undefined;
    if (err) {
      await this.failed(err, this.monotonic(), () => session !== this.session);
    } else {
      // Closed by the inverter after its frames: connected again at the pace.
      this.logger.info('Envertech: the inverter closed the connection');
    }
    this.resolveWaiters();
    if (session === this.session) {
      this.schedule();
    }
  }

  async failed(err, mono, gone) {
    const code = err?.code ?? 'error';
    // Our own words only (Evt800Error codes): never a text of the network stack.
    this.logger.warn(`Envertech link ended: ${code}`);
    this.outcome = { at: mono, kind: 'error', err };
    if (SILENT_CODES.has(code)) {
      this.misses += 1;
      this.firstMissAt ??= mono;
      if (this.asleep) {
        // Still the night: the reference of the index dated again (nothing is
        // produced meanwhile), then the status.
        if (this.asleepLow) {
          await this.redateNight();
          if (gone()) return;
        }
        await this.updateStatus();
        return;
      }
      const low = this.lastPower === undefined || this.lastPower < AWAKE_POWER;
      if ((low && this.misses >= MISSES_BEFORE_ASLEEP) || mono - this.firstMissAt >= ASLEEP_AFTER) {
        this.asleep = true;
        // A night after a low power (review 1, I1, the lot 13 lesson): the
        // reference of the guard is dated again at every attempt of the
        // night, so that the margin of the morning never covers the night.
        // Not after an hour of silence while producing (an outage).
        this.asleepLow = low;
        if (low) {
          await this.redateNight();
          if (gone()) return;
        }
        this.failures = 0;
        this.nextTryAt = undefined;
        this.lastError = undefined;
        this.latest = undefined;
        this.outcome = { at: mono, kind: 'asleep' };
        this.logger.info('Envertech inverter asleep (no frame)');
        await this.publishAsleep(gone);
        if (gone()) return;
        await this.updateStatus();
        return;
      }
      if (low) {
        // Falling asleep, probably (the evening): nothing red yet.
        await this.updateStatus();
        return;
      }
    }
    // A wrong answer, or an inverter that vanished while producing: red,
    // retries doubled (never faster than the pace).
    const wait = Math.min(RETRY_MIN * 2 ** this.failures, RETRY_MAX);
    this.failures += 1;
    this.lastError = err;
    this.nextTryAt = mono + wait;
    // The last values are no longer current (review 1, I2): the inverter is
    // shown offline (its power stays unknown, never 0 by day).
    await this.publishOffline(gone);
    if (gone()) return;
    await this.updateStatus();
  }

  async publishOffline(gone) {
    const serial = this.info?.serial;
    const created = this.createdDevice(serial);
    if (!created || gone() || !this.running) {
      return;
    }
    await this.publishStates(created, [
      { device_feature_external_id: ids(this.gladys, serial).feature(FEATURE.ONLINE), state: 0 },
    ]);
  }

  resolveWaiters() {
    const waiters = this.waiters;
    this.waiters = [];
    for (const resolve of waiters) resolve();
  }

  // --- Status ------------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  async updateStatus() {
    if (!this.running) return;
    const [connected, message] = this.currentStatus();
    await this.setStatus(connected, message);
  }

  /** The status from what is known now: never a connection. */
  currentStatus() {
    const address = this.config.address;
    if (!address) {
      return [false, this.config.invalidAddress ? T.badAddress : T.noAddress];
    }
    const notes = this.heldNotes();
    const now = this.now();
    if (this.lastError && this.failures > 0) {
      const wait = Math.max(0, (this.nextTryAt ?? 0) - this.monotonic());
      return [false, T.unreachable(address, this.lastError, wait, notes)];
    }
    if (this.asleep) {
      const since = this.lastGoodAt ?? this.startedAt;
      if (now - since > LONG_SILENCE) {
        return [false, T.silent(address, notes)];
      }
      return [true, T.asleep(address, notes)];
    }
    if (this.info && this.latest !== undefined) {
      if (!this.createdDevice(this.info.serial)) {
        return [true, T.noDevice(this.info.serial)];
      }
      const extra = [];
      if (this.otherInverter) extra.push(T.notes.otherInverter(this.otherInverter));
      if (this.noSerial) extra.push(T.notes.noSerial);
      if (this.noIndex) extra.push(T.notes.noIndex);
      return [true, T.ok(address, [...extra, ...notes])];
    }
    if (this.session?.link?.opened) {
      return [false, T.waitingFrame(address)];
    }
    return [false, T.connecting(address)];
  }

  /** The index held back, for every status (the user must see it while waiting). */
  heldNotes() {
    const created = this.info ? this.createdDevice(this.info.serial) : undefined;
    if (!created) {
      return [];
    }
    const held = this.guardOf(
      created,
      ids(this.gladys, this.info.serial).feature(FEATURE.PRODUCTION_INDEX),
    ).held;
    return held ? [T.notes.held(held)] : [];
  }

  // --- /data -------------------------------------------------------------------------

  /**
   * Keeps the serial, the inputs, the night, the times and the index states
   * in /data when they changed. One save after the other (review 1, M2): each
   * reads /data inside the queue. `drop`: an index id whose state is removed
   * (a device created anew).
   */
  saveState({ drop } = {}) {
    const run = this.saveQueue.then(() => this.doSave(drop));
    this.saveQueue = run.catch(() => {});
    return run;
  }

  async doSave(drop) {
    const indexes = {};
    for (const [id, guard] of this.guards) {
      indexes[id] = { guard: guard.state(), built: this.builts.get(id)?.state() ?? null };
    }
    const kept = keptIndexes(this.store.load().indexes);
    for (const id of Object.keys(indexes)) delete kept[id];
    if (drop) delete kept[drop];
    const merged = Object.entries({ ...kept, ...indexes }).slice(-MAX_KEPT_INDEXES);
    const state = {
      serial: this.info?.serial ?? null,
      channels: this.info?.channels ?? null,
      night: Boolean(this.asleep && this.asleepLow),
      lastAttemptAt: this.lastAttemptAt ?? null,
      lastGoodAt: this.lastGoodAt ?? null,
      indexes: Object.fromEntries(merged),
    };
    const key = JSON.stringify(state);
    if (key === this.savedKey) {
      return;
    }
    try {
      await this.store.save(state);
      this.savedKey = key;
    } catch (err) {
      this.logger.warn(`Saving the Envertech state in /data failed (${err?.code ?? 'error'})`);
    }
  }

  // --- Devices -----------------------------------------------------------------------

  /** The created Gladys device of the inverter with this serial, undefined until the user creates it. */
  createdDevice(serial) {
    if (!serial) return undefined;
    const id = ids(this.gladys, serial).device;
    return (this.gladys.devices ?? []).find((d) => d.external_id === id);
  }

  async discover() {
    if (!this.info || !this.config.address || !this.running) {
      return;
    }
    const created = this.createdDevice(this.info.serial);
    const device = keepCreatedFeatures(
      buildDevice(this.gladys, this.info, { address: this.config.address }),
      created,
    );
    await this.gladys
      .publishDiscoveredDevices([device])
      .catch((err) => this.logger.warn(`Publishing the Envertech device failed: ${err.message}`));
  }

  /** The Discover tab asks: the known device, never a connection (the next one comes at its time). */
  async scan() {
    await this.discover();
  }

  async onDeviceCreated(device) {
    const serial = this.info?.serial;
    if (!serial || device?.external_id !== ids(this.gladys, serial).device) {
      return;
    }
    // A new device: no reference of its index yet (nor a state kept in /data
    // for a deleted device of the same id). Its values come with the next frame.
    const id = ids(this.gladys, serial).feature(FEATURE.PRODUCTION_INDEX);
    this.guards.delete(id);
    this.builts.delete(id);
    // In the queue of the saves (M2): a save running never puts the old state back.
    this.savedKey = undefined;
    await this.saveState({ drop: id });
    // The inverter now answering has its device: the note about it ends.
    this.otherInverter = undefined;
    await this.updateStatus();
  }

  async onDeviceUpdated(device) {
    if (this.info && device?.external_id === ids(this.gladys, this.info.serial).device) {
      await this.updateStatus();
    }
  }

  // --- Values ------------------------------------------------------------------------

  /** The guard of the index of a created device, from Gladys and /data, with the margin now. */
  guardOf(created, id) {
    const kw = maxKwOf(this.config.peakKw);
    const limits = { maxKw: kw, slackKwh: INDEX_SLACK_KWH };
    if (!this.guards.has(id)) {
      const saved = keptIndexes(this.store.load().indexes)[id];
      this.guards.set(
        id,
        new IndexGuard(lastValueOf(created, id), saved?.guard, this.now(), limits),
      );
    } else if (this.guards.get(id).maxKw !== kw) {
      this.guards.set(
        id,
        new IndexGuard(undefined, this.guards.get(id).state(), this.now(), limits),
      );
    }
    return this.guards.get(id);
  }

  /** The index built from the counters (src/built.js) of a created device, from /data. */
  builtOf(id) {
    if (!this.builts.has(id)) {
      const saved = keptIndexes(this.store.load().indexes)[id];
      this.builts.set(id, new BuiltIndex(saved?.built));
    }
    return this.builts.get(id);
  }

  /**
   * The night after a low power (review 1, I1): the reference of the guard of
   * the created device is dated now (its value unchanged), so that the margin
   * of the first frame of the morning counts from the last attempt of the
   * night, not from the evening. Nothing is produced meanwhile.
   */
  async redateNight() {
    const created = this.info ? this.createdDevice(this.info.serial) : undefined;
    if (created) {
      const guard = this.guardOf(
        created,
        ids(this.gladys, this.info.serial).feature(FEATURE.PRODUCTION_INDEX),
      );
      const now = this.now();
      if (guard.last && now > guard.last.at) {
        guard.last = { value: guard.last.value, at: now };
      }
    }
    await this.saveState();
  }

  /** The last frame, published at most once a minute. */
  requestPublish() {
    if (!this.running || this.publishTimer !== undefined) {
      return;
    }
    const mono = this.monotonic();
    const wait =
      this.lastPublishAt === undefined || mono < this.lastPublishAt
        ? 0
        : Math.max(0, this.lastPublishAt + PUBLISH_INTERVAL - mono);
    this.publishTimer = this.timers.setTimeout(() => {
      this.publishTimer = undefined;
      const run = this.flushing.then(() => this.flush());
      this.flushing = run.catch((err) => {
        this.logger.error(`Envertech: unexpected error (${err?.name ?? 'Error'})`);
      });
      return this.flushing;
    }, wait);
  }

  async flush() {
    const session = this.session;
    const latest = this.latest;
    const mono = this.monotonic();
    if (!this.running || !latest || latest.published || mono - latest.at > FRAME_FRESH) {
      return;
    }
    latest.published = true;
    this.lastPublishAt = mono;
    const gone = () => session !== this.session;
    await this.publishReading(latest.reading, gone);
    if (gone()) return;
    await this.updateStatus();
  }

  /** The states of a frame, to the device of ITS serial, the index through the guard. */
  async publishReading(reading, gone) {
    this.noIndex = false;
    const created = this.createdDevice(reading.serial);
    if (!created) {
      return;
    }
    const external = ids(this.gladys, reading.serial);
    // The features are fixed when the user creates the device.
    const channels = channelsOfDevice(this.gladys, reading.serial, created) || inputsOf(reading);
    const id = external.feature(FEATURE.PRODUCTION_INDEX);
    const guard = this.guardOf(created, id);
    const now = this.now();
    const counters = countersOf(reading, channels);
    let total;
    let built;
    if (counters) {
      // The index built from the counters (review 1, I4): their sum, chained
      // over a reset of every counter right after a confirmed night.
      const afterNight = this.wokeAt !== undefined && now - this.wokeAt < RESET_AFTER_WAKE;
      const maxKwh = guard.last ? guard.margin(guard.last.at, now) : 0;
      built = this.builtOf(id).read(counters, now, { afterNight, maxKwh });
      const value = round(built.value, 3);
      total = value > 0 ? value : undefined;
    }
    const plausible = total !== undefined && guard.accept(total, now);
    if (plausible) {
      this.builtOf(id).commit(built.next);
      if (built.kind) {
        this.logger.info(`Envertech counters ${built.kind}: the production index goes on`);
      }
    }
    this.noIndex = total === undefined;
    if (total !== undefined && !plausible && guard.held) {
      this.logger.warn(
        `Envertech production index ${guard.held.direction === 'down' ? 'drop' : 'jump'} held back: the "Accept the held index" button takes it`,
      );
    }
    // While a value is held, the last accepted one is sent again (no delta for the core).
    const index = plausible ? total : guard.held ? guard.last?.value : undefined;
    // The guard is in /data BEFORE Gladys gets the value: a crash in between
    // never sends an index /data does not know.
    await this.saveState();
    if (gone()) return;
    await this.publishStates(created, readingStates(external, reading, index, channels));
  }

  /** The night: power 0, offline; the index is never sent. */
  async publishAsleep(gone) {
    const serial = this.info?.serial;
    const created = this.createdDevice(serial);
    if (!created || gone() || !this.running) {
      return;
    }
    const channels = channelsOfDevice(this.gladys, serial, created) || this.info.channels;
    await this.publishStates(created, asleepStates(ids(this.gladys, serial), channels));
  }

  async publishStates(created, states) {
    // Only the features the created device has (they are fixed at its creation).
    const features = created.features ? new Set(created.features.map((f) => f.external_id)) : null;
    const allowed = features
      ? states.filter((s) => features.has(s.device_feature_external_id))
      : states;
    if (allowed.length === 0) {
      return;
    }
    await this.gladys
      .publishChangedStates(allowed, { heartbeat: STATE_HEARTBEAT })
      .catch((err) => this.logger.warn(`Publishing the Envertech values failed: ${err.message}`));
  }

  // --- Configuration screen buttons -------------------------------------------------

  /**
   * The "Accept the held index" button: takes the value held as shown now
   * (plus what may come until the next frame, src/guard.js), never anything
   * else. Published with the next frame (never a connection sooner).
   */
  async acceptHeldIndex() {
    const serial = this.info?.serial;
    const created = this.createdDevice(serial);
    if (!created) {
      return T.accept.nothing;
    }
    const guard = this.guardOf(created, ids(this.gladys, serial).feature(FEATURE.PRODUCTION_INDEX));
    const taken = guard.acceptHeld();
    if (!taken) {
      return T.accept.nothing;
    }
    this.logger.info(
      `Envertech production index ${taken.direction === 'down' ? 'drop' : 'jump'} accepted by the user`,
    );
    return taken.direction === 'down' ? T.accept.down(taken) : T.accept.up(taken);
  }

  /**
   * The test button: never a connection sooner than the pace allows. With a
   * link open it tells the last frame; when an attempt is due, this click
   * makes it and waits for the first frame (20 s at most); otherwise it tells
   * the last outcome.
   */
  async testConnection() {
    if (!this.config.address) {
      return this.config.invalidAddress ? T.badAddress : T.noAddress;
    }
    const link = this.session?.link;
    if (link) {
      return this.latest ? this.describeOutcome() : T.test.waiting;
    }
    if (this.dueAt() > this.monotonic() || !this.running) {
      return this.describeOutcome();
    }
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve(T.test.slow), TEST_ANSWER_WITHIN);
    });
    const answered = new Promise((resolve) => this.waiters.push(resolve));
    try {
      if (this.timer !== undefined) {
        this.timers.clearTimeout(this.timer);
        this.timer = undefined;
      }
      this.connecting = this.connectNow();
      await this.connecting;
      if (!this.session?.link && this.outcome?.kind !== 'reading') {
        // Not connected (another click raced, or the save failed): what is known.
        return this.describeOutcome();
      }
      return await Promise.race([answered.then(() => this.describeOutcome()), late]);
    } finally {
      this.timers.clearTimeout(timer);
      if (this.running && !this.session?.link) this.schedule();
    }
  }

  /** The last outcome in words, and the time to the next attempt. */
  describeOutcome() {
    const mono = this.monotonic();
    const next = Math.max(0, this.dueAt() - mono);
    const outcome = this.outcome;
    if (!outcome) {
      return T.test.notYet(next);
    }
    const ago = Math.max(0, mono - outcome.at);
    if (outcome.kind === 'reading') {
      const inputs = inputsOf(outcome.reading);
      const power = totalPower(outcome.reading, inputs);
      return T.test.reading(
        {
          serial: outcome.reading.serial,
          power: power === undefined ? '?' : round(power, 0),
          inputs,
        },
        ago,
        Boolean(this.session?.link),
      );
    }
    if (outcome.kind === 'asleep') {
      return T.test.asleep(ago, next);
    }
    return T.test.failed(this.config.address, outcome.err, ago, next);
  }
}
