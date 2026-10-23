// -----------------------------------------------------------------------------
// The production index built from the lifetime counters of the inputs (review
// 1, I4). Pure.
//
// The index is `base + sum of the counters`. `base` starts at 0, so as long as
// the counters only rise the index IS their sum. If the EVT800 resets its
// counters when it powers up in the morning (not confirmed: TODO.md), the
// strict signature below adds the sum of the evening to `base`, as the
// counter of the day of gladys-imeon / gladys-zeversolar is chained, so that
// the index goes on instead of dropping:
// - EVERY input lower than its last counter taken;
// - the first frames after a confirmed night (the inverter asleep after a low
//   power, `afterNight`);
// - the new sum within `maxKwh` (the margin of the guard since the wake-up:
//   what may have been produced since the counters started again).
// A reset is undone when, within UNDO_WITHIN, every counter is back at or
// above the values of the evening (a glitch, not a reset): `base` goes back,
// nothing is ever counted twice (what the glitch added is not counted again
// while the counters climb back above it).
//
// Nothing here is final: the caller passes the value to the guard
// (src/guard.js) and keeps the new state (`commit`) only when the guard took it.
// A change of the number of inputs (the device updated in Discovery) moves
// `base` so that the index stays where it was (review 1, M1).
// -----------------------------------------------------------------------------

const HOUR = 3_600_000;
/** A reset is undone when the counters come back within this delay. */
export const UNDO_WITHIN = 3 * HOUR;
/** Two counters closer than this are equal (the frame gives about 0.000122 kWh). */
const EPSILON = 0.0005;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);

const validCounters = (list) =>
  Array.isArray(list) &&
  list.length >= 1 &&
  list.length <= 8 &&
  list.every((v) => finite(v) && v >= 0)
    ? [...list]
    : undefined;

/** The state kept in /data: `{ base, counters, reset }`, checked. */
export function validBuilt(saved) {
  const base = finite(saved?.base) ? saved.base : 0;
  const counters = validCounters(saved?.counters);
  const prev = validCounters(saved?.reset?.prev);
  const reset =
    prev && finite(saved?.reset?.at) && counters && prev.length === counters.length
      ? { prev, at: saved.reset.at }
      : null;
  return { base, counters: counters ?? null, reset };
}

const sum = (list) => list.reduce((a, b) => a + b, 0);

export class BuiltIndex {
  constructor(saved) {
    const state = validBuilt(saved);
    this.base = state.base;
    this.counters = state.counters;
    this.reset = state.reset;
  }

  state() {
    return { base: this.base, counters: this.counters, reset: this.reset };
  }

  /**
   * The index of `counters` (one per input, all known) read at `at`, and the
   * state to keep if the guard takes it: `{ value, next, kind }`, `kind`
   * 'reset' or 'undo' when the base moved.
   */
  read(counters, at, { afterNight = false, maxKwh = 0 } = {}) {
    let base = this.base;
    let reset = this.reset && at - this.reset.at < UNDO_WITHIN ? this.reset : null;
    let kind;
    const previous = this.counters;
    if (previous && previous.length !== counters.length) {
      // The device gained (or lost) an input (review 1, M1): the index goes on
      // from its value, the old counter of an input added is never counted.
      if (counters.length > previous.length) {
        base -= sum(counters.slice(previous.length));
      } else {
        base += sum(previous.slice(counters.length));
      }
      reset = null;
      kind = 'inputs';
    } else if (previous) {
      const allLower = counters.every((c, i) => c < previous[i] - EPSILON);
      if (allLower && afterNight && sum(counters) <= maxKwh) {
        base += sum(previous);
        reset = { prev: previous, at };
        kind = 'reset';
      } else if (reset && counters.every((c, i) => c >= reset.prev[i] - EPSILON)) {
        base -= sum(reset.prev);
        reset = null;
        kind = 'undo';
      }
    }
    return {
      value: base + sum(counters),
      next: { base, counters: [...counters], reset },
      kind,
    };
  }

  commit(next) {
    this.base = next.base;
    this.counters = next.counters;
    this.reset = next.reset;
  }
}
