// -----------------------------------------------------------------------------
// Constants shared by the integration. Every key stored by Gladys (actions,
// manifest keys, feature keys in src/devices.js) is forever: never rename one.
// -----------------------------------------------------------------------------

export const ACTIONS = { TEST: 'test_connection', ACCEPT_HELD: 'accept_held_index' };

/**
 * The external id of the device: `inverter:<serial>`, the serial number of
 * the micro-inverter given in every frame (8 hexadecimal digits): a new IP
 * address of the same inverter keeps its device and history.
 */
export const EXTERNAL_ID_TYPE = 'inverter';

// --- The local TCP link (as the pyenvertechevt800 library) ------------------------
/** The port of the inverter's "TCP server" mode, unless the address gives another one. */
export const DEFAULT_PORT = 14889;
/** Time to connect. */
export const CONNECT_TIMEOUT = 10_000;
/** No frame for this long: the link is closed (the library waits 60 s). */
export const SILENCE_TIMEOUT = 90_000;
/** The read buffer, allocated once (a frame is 255 bytes at most). */
export const READ_BUFFER = 1024;
/** More than this without a single frame: not an EVT800 at this address. */
export const UNKNOWN_AFTER_BYTES = 2048;
/** More than this a minute is a flood (an EVT800 sends a few hundred bytes). */
export const FLOOD_BYTES_PER_MINUTE = 64 * 1024;
/** Acknowledgements the inverter does not read: closed beyond this. */
export const MAX_PENDING_WRITE = 4096;

// --- Schedule ------------------------------------------------------------------------
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
/** Never two connection attempts less than a minute apart, whatever asks. */
export const POLL_INTERVAL = MINUTE;
/** An inverter asleep (no sun) is tried every 5 minutes. */
export const SLEEP_INTERVAL = 5 * MINUTE;
/** The values are published at most once a minute (the last frame). */
export const PUBLISH_INTERVAL = MINUTE;
/** A frame older than this is never published (never a stale value as new). */
export const FRAME_FRESH = 2 * MINUTE;
/** Failed attempts in a row before an inverter that was producing little is asleep. */
export const MISSES_BEFORE_ASLEEP = 3;
/** Below this power (W) at its last frame, an inverter that goes silent is falling asleep. */
export const AWAKE_POWER = 20;
/** Silent for this long, even after producing: asleep (night or outage, the status says both). */
export const ASLEEP_AFTER = HOUR;
/** No frame at all for this long: the status turns red, even at night. */
export const LONG_SILENCE = 24 * HOUR;
/** A wrong answer, or an inverter that vanishes producing: tries after 1 min, doubled up to 15 min. */
export const RETRY_MIN = MINUTE;
export const RETRY_MAX = 15 * MINUTE;
/** The time of the last attempt is written in /data at most once per this delay. */
export const ATTEMPT_SAVE_EVERY = MINUTE;
/** Unchanged values are sent again after this delay (publishChangedStates heartbeat). */
export const STATE_HEARTBEAT = 10 * MINUTE;
/** The test button answers within this delay (the manifest gives it 30 s). */
export const TEST_ANSWER_WITHIN = 20 * SECOND;

// --- Energy index (the sum of the lifetime counters of the inputs) ------------------
/**
 * The margin of the guard (src/guard.js) when no peak power is typed: an
 * EVT800 gives 800 W at most; 2 kW leaves room for the larger models.
 */
export const INDEX_MAX_KW = 2;
/** With a peak power typed: 1.25 x it, bounded to these (kW). */
export const MAX_KW_MIN = 0.5;
export const MAX_KW_MAX = 10;
/** kWh always accepted on top of maxKw x hours (rounding, a late frame). */
export const INDEX_SLACK_KWH = 0.1;

// --- Plausible values (else not published) ------------------------------------------
/** Power of one input (W): the frame cannot say more than 1024 W. */
export const CHANNEL_POWER_MAX = 1024;
/** DC voltage of one input (V): the frame cannot say more than 64 V. */
export const DC_VOLTAGE_MAX = 64;
/** DC current of one input (A). */
export const DC_CURRENT_MAX = 30;
/** AC voltage (V). */
export const AC_VOLTAGE_MAX = 300;
/** Grid frequency (Hz): only a value in this range is shown. */
export const FREQUENCY_MIN = 40;
export const FREQUENCY_MAX = 70;
/** Temperature of the inverter (°C). */
export const TEMPERATURE_MIN = -40;
export const TEMPERATURE_MAX = 120;
/** Lifetime counter of one input (kWh). */
export const ENERGY_MAX = 1_000_000;
