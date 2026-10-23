// -----------------------------------------------------------------------------
// The Gladys device of an EVT800 micro-inverter and its states. Pure.
//
// External id (forever): inverter:<serial>, the 8 hexadecimal digits of the
// serial number the inverter gives in every frame. Feature keys (forever):
// see FEATURE below; `<n>` is the input (MPPT, one panel each) from 1.
//
// Energy rules of the Gladys core (server/utils/constants.js and the
// energy-monitoring service), as in gladys-omnik and gladys-apsystems:
// - `production_index` is the ONLY energy-production-sensor / index feature:
//   the sum of the lifetime counters of every input of the device, checked by
//   the guard (src/guard.js), never 0. Its `thirty-minutes-production` feature
//   is declared here (the core derives that one for a consumption index only),
//   ids computed (UUID v5) so an "Update" in Discovery keeps the same rows;
//   the integration never publishes it;
// - the lifetime counter of each input is NOT published on its own: as an
//   index the core would count the production twice, and the core has no type
//   for a counter it must not count (TODO.md "Decisions");
// - the inverter gives no counter of the day: no `daily-production`;
// - powers: energy-production-sensor / power (the total and one per input,
//   as gladys-apsystems); voltages and currents: energy-sensor;
// - units: only the ones the core lists for the category
//   (DEVICE_FEATURE_UNITS_BY_CATEGORY): W and kWh for
//   energy-production-sensor, V and A for energy-sensor, °C for
//   device-temperature-sensor (the inverter's own temperature, never the
//   room's), none for unknown (the core has no Hz unit: the frequency is a
//   plain decimal named with its unit, as gladys-apsystems).
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  AC_VOLTAGE_MAX,
  CHANNEL_POWER_MAX,
  DC_CURRENT_MAX,
  DC_VOLTAGE_MAX,
  EXTERNAL_ID_TYPE,
  FREQUENCY_MAX,
  FREQUENCY_MIN,
  TEMPERATURE_MAX,
  TEMPERATURE_MIN,
} from './constants.js';
import { MAX_CHANNELS } from './evt800/protocol.js';

/** Feature keys (forever). */
export const FEATURE = {
  POWER: 'power',
  PRODUCTION_INDEX: 'production_index',
  /** 30-minute production: fed by the Gladys core from the index, never by the integration. */
  PRODUCTION_30MIN: 'production_index_production',
  ONLINE: 'online',
  AC_VOLTAGE: 'ac_voltage',
  FREQUENCY: 'frequency',
  power: (n) => `power_${n}`,
  dcVoltage: (n) => `dc_voltage_${n}`,
  dcCurrent: (n) => `dc_current_${n}`,
  temperature: (n) => `temperature_${n}`,
};

/** The external ids of the inverter with this serial. */
export const ids = (gladys, serial) => gladys.externalIds(EXTERNAL_ID_TYPE, serial);

/** Namespace of the feature ids of this integration (random, fixed forever). */
const ID_NAMESPACE = Buffer.from('3f9a6c2e8b1d4e57a0c4d2b96e7f1a38', 'hex');

/** A deterministic UUID (version 5, RFC 9562) of a name (as gladys-apsystems). */
export function uuidOf(name) {
  const hash = createHash('sha1').update(ID_NAMESPACE).update(String(name), 'utf8').digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const feature = (external, key, name, category, type, extra = {}) => ({
  name,
  external_id: external.feature(key),
  category,
  type,
  min: 0,
  max: 1_000_000_000,
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...extra,
});

const production = (external, key, name, max) =>
  feature(external, key, name, C.ENERGY_PRODUCTION_SENSOR, T.ENERGY_PRODUCTION_SENSOR.POWER, {
    unit: U.WATT,
    max,
  });

/** The number of inputs a created device has features for (`power_<n>`), 0 when none. */
export function channelsOfDevice(gladys, serial, device) {
  const external = ids(gladys, serial);
  let count = 0;
  for (let n = 1; n <= MAX_CHANNELS; n += 1) {
    if (
      (device?.features ?? []).some((f) => f.external_id === external.feature(FEATURE.power(n)))
    ) {
      count = n;
    }
  }
  return count;
}

/**
 * The device of the inverter. `info`: `{ serial, firmware, channels }`,
 * `channels` the number of inputs (1 or 2) seen so far or created.
 */
export function buildDevice(gladys, info, { address }) {
  const external = ids(gladys, info.serial);
  const productionIndexId = external.feature(FEATURE.PRODUCTION_INDEX);
  const channels = Math.min(MAX_CHANNELS, Math.max(1, info.channels ?? 1));
  const features = [
    production(external, FEATURE.POWER, 'Solar production', MAX_CHANNELS * CHANNEL_POWER_MAX),
    feature(
      external,
      FEATURE.PRODUCTION_INDEX,
      'Solar production index',
      C.ENERGY_PRODUCTION_SENSOR,
      T.ENERGY_PRODUCTION_SENSOR.INDEX,
      { id: uuidOf(productionIndexId), unit: U.KILOWATT_HOUR },
    ),
    feature(
      external,
      FEATURE.PRODUCTION_30MIN,
      'Solar production index (30-minute production)',
      C.ENERGY_PRODUCTION_SENSOR,
      T.ENERGY_PRODUCTION_SENSOR.THIRTY_MINUTES_PRODUCTION,
      {
        id: uuidOf(external.feature(FEATURE.PRODUCTION_30MIN)),
        energy_parent_id: uuidOf(productionIndexId),
        unit: U.KILOWATT_HOUR,
      },
    ),
    feature(
      external,
      FEATURE.ONLINE,
      'Inverter online (1 = sending, 0 = asleep)',
      C.UNKNOWN,
      T.SENSOR.BINARY,
      { max: 1 },
    ),
    feature(external, FEATURE.AC_VOLTAGE, 'AC voltage', C.ENERGY_SENSOR, T.ENERGY_SENSOR.VOLTAGE, {
      unit: U.VOLT,
      max: AC_VOLTAGE_MAX,
    }),
    // No frequency category or Hz unit in the core: a plain decimal, named with its unit.
    feature(external, FEATURE.FREQUENCY, 'Grid frequency (Hz)', C.UNKNOWN, T.SENSOR.DECIMAL, {
      max: FREQUENCY_MAX,
    }),
  ];
  for (let n = 1; n <= channels; n += 1) {
    features.push(
      production(external, FEATURE.power(n), `Input ${n} power`, CHANNEL_POWER_MAX),
      feature(
        external,
        FEATURE.dcVoltage(n),
        `Input ${n} DC voltage`,
        C.ENERGY_SENSOR,
        T.ENERGY_SENSOR.VOLTAGE,
        { unit: U.VOLT, max: DC_VOLTAGE_MAX },
      ),
      feature(
        external,
        FEATURE.dcCurrent(n),
        `Input ${n} DC current`,
        C.ENERGY_SENSOR,
        T.ENERGY_SENSOR.CURRENT,
        { unit: U.AMPERE, max: DC_CURRENT_MAX },
      ),
      feature(
        external,
        FEATURE.temperature(n),
        `Input ${n} temperature`,
        C.DEVICE_TEMPERATURE_SENSOR,
        T.SENSOR.DECIMAL,
        { unit: U.CELSIUS, min: TEMPERATURE_MIN, max: TEMPERATURE_MAX },
      ),
    );
  }
  return {
    name: `Envertech ${info.serial}`,
    external_id: external.device,
    features,
    params: [
      { name: 'address', value: address },
      { name: 'serial', value: info.serial },
      { name: 'firmware', value: info.firmware ?? '' },
      { name: 'inputs', value: String(channels) },
    ],
  };
}

/** What a feature declaration holds (a created feature also carries Gladys' own fields). */
const DECLARED = [
  'id',
  'name',
  'external_id',
  'category',
  'type',
  'unit',
  'min',
  'max',
  'read_only',
  'has_feedback',
  'keep_history',
  'energy_parent_id',
];

/**
 * A device republished in Discovery never loses a feature of the device the
 * user created (the core would mark it `structure_changed`, and "Update"
 * would delete that feature and its history): the features of the created
 * device that the new build lacks are kept as they are (gladys-apsystems).
 */
export function keepCreatedFeatures(built, created) {
  if (!created) {
    return built;
  }
  const have = new Set(built.features.map((f) => f.external_id));
  const kept = (created.features ?? [])
    .filter((f) => f?.external_id && !have.has(f.external_id))
    .map((f) =>
      Object.fromEntries(
        DECLARED.filter((k) => f[k] !== undefined && f[k] !== null).map((k) => [k, f[k]]),
      ),
    );
  return kept.length === 0 ? built : { ...built, features: [...built.features, ...kept] };
}

export const round = (value, digits) => Math.round(value * 10 ** digits) / 10 ** digits;

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/** A value within [min, max], else undefined (a glitch, not sent). */
export const within = (value, max, min = 0) =>
  isNumber(value) && value >= min && value <= max ? value : undefined;

const state = (external, key, value, digits) =>
  isNumber(value)
    ? [{ device_feature_external_id: external.feature(key), state: round(value, digits) }]
    : [];

/** The plausible values of one input, each undefined when not plausible. */
export function channelValues(channel) {
  return {
    power: within(channel?.power, CHANNEL_POWER_MAX),
    dcVoltage: within(channel?.dcVoltage, DC_VOLTAGE_MAX),
    dcCurrent: within(channel?.current, DC_CURRENT_MAX),
    temperature: within(channel?.temperature, TEMPERATURE_MAX, TEMPERATURE_MIN),
    acVoltage: within(channel?.acVoltage, AC_VOLTAGE_MAX),
    frequency: within(channel?.frequency, FREQUENCY_MAX, FREQUENCY_MIN),
  };
}

/**
 * The total power of a reading over the `channels` inputs of the device: only
 * when every one of them gives a plausible power (never a partial sum).
 */
export function totalPower(reading, channels) {
  let total = 0;
  for (let n = 1; n <= channels; n += 1) {
    const power = channelValues(reading.channels[n - 1]).power;
    if (power === undefined) return undefined;
    total += power;
  }
  return channels > 0 ? total : undefined;
}

/**
 * The states of a data frame for a device with `channels` inputs. `index`:
 * the value the guard let through (undefined: not published).
 */
export function readingStates(external, reading, index, channels) {
  const states = [
    ...state(external, FEATURE.POWER, totalPower(reading, channels), 1),
    // The index: never 0 (the guard never lets 0 through, checked again here).
    ...(isNumber(index) && index > 0 ? state(external, FEATURE.PRODUCTION_INDEX, index, 3) : []),
    ...state(external, FEATURE.ONLINE, 1, 0),
  ];
  const blocks = reading.channels.slice(0, channels);
  const values = blocks.map(channelValues);
  // An empty block (id all 0, nothing behind it) gives no value of its own.
  const first = (key) => values.find((v, k) => !blocks[k]?.empty && v[key] !== undefined)?.[key];
  states.push(
    ...state(external, FEATURE.AC_VOLTAGE, first('acVoltage'), 1),
    ...state(external, FEATURE.FREQUENCY, first('frequency'), 2),
  );
  for (const [k, v] of values.entries()) {
    if (blocks[k]?.empty) continue;
    const n = k + 1;
    states.push(
      ...state(external, FEATURE.power(n), v.power, 1),
      ...state(external, FEATURE.dcVoltage(n), v.dcVoltage, 2),
      ...state(external, FEATURE.dcCurrent(n), v.dcCurrent, 2),
      ...state(external, FEATURE.temperature(n), v.temperature, 1),
    );
  }
  return states;
}

/** The inverter asleep (the night): no production, offline; the index is never sent. */
export function asleepStates(external, channels) {
  const states = [
    ...state(external, FEATURE.POWER, 0, 0),
    ...state(external, FEATURE.ONLINE, 0, 0),
  ];
  for (let n = 1; n <= channels; n += 1) {
    states.push(
      ...state(external, FEATURE.power(n), 0, 0),
      ...state(external, FEATURE.dcCurrent(n), 0, 0),
    );
  }
  return states;
}
