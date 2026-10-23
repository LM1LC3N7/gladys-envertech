// -----------------------------------------------------------------------------
// Frames of an EVT800. The first three are the frames of the tests of the
// pyenvertechevt800 library (tests/test_init.py), as they are; the builder
// encodes values the way the library decodes them.
// -----------------------------------------------------------------------------

/** Two inputs, 86 bytes (the library's "2MPPT" test). */
export const TWO_MPPT = Buffer.from(
  '680056681004315258207a007a01000000000000315258207a7a40b02d860000bafb2e8c3c4931fe000000000000000000000000315258217a7a3131017b00000e4a2ab33c4931fe020200000000000000000000ef16',
  'hex',
);

/** The values the library reads from TWO_MPPT (its test). */
export const TWO_MPPT_VALUES = [
  {
    id: '31525820',
    firmware: '7A.7A',
    dcVoltage: 32.34375,
    power: 182.09375,
    acVoltage: 241.140625,
    frequency: 49.9921875,
    temperature: 53.09375,
    energy: 5.8431396484375,
    current: 5.629951690821256,
  },
  {
    id: '31525821',
    firmware: '7A.7A',
    dcVoltage: 24.595703125,
    power: 5.921875,
    acVoltage: 241.140625,
    frequency: 49.9921875,
    temperature: 45.3984375,
    energy: 0.446533203125,
    current: 0.24076868101326135,
  },
];

/** The library's "1MPPT" test frame: cut short (65 bytes for a length of 86). */
export const ONE_MPPT_CUT = Buffer.from(
  '680056681004315258207a007a01000000000000315258207a7a40b007bc000117c223803bc03201000000000000000000000000315258217a7a280e0030000016',
  'hex',
);

/** A poll frame, 32 bytes: the serial 31525820. */
export const POLL = Buffer.from(
  '680020681006315258200000000000014b0000e7010000010500000000009016',
  'hex',
);

export const SERIAL = '31525820';
export const ADDRESS = '192.168.1.80';

const u16 = (buffer, at, raw) => buffer.writeUInt16BE(Math.max(0, Math.min(0xffff, raw)), at);

/**
 * A data frame: `serial` (8 hex), `inputs`: [{ id, power, dcVoltage, energy,
 * temperature, acVoltage, frequency } | null], raw values computed as the
 * library decodes them (`raw: { power: 0xffff }` writes a raw value as is).
 */
export function dataFrame({ serial = SERIAL, inputs = [{}] } = {}) {
  const length = 22 + 32 * Math.max(2, inputs.length);
  const frame = Buffer.alloc(length);
  frame.set([0x68, 0x00, length, 0x68, 0x10, 0x04]);
  Buffer.from(serial, 'hex').copy(frame, 6);
  frame.set([0x7a, 0x00, 0x7a, 0x01], 10);
  for (const [k, input] of inputs.entries()) {
    if (!input) continue;
    const at = 20 + 32 * k;
    const id = input.id ?? (parseInt(serial, 16) + k).toString(16).padStart(8, '0');
    Buffer.from(id, 'hex').copy(frame, at);
    frame.set([0x7a, 0x7a], at + 4);
    const v = {
      dcVoltage: 32,
      power: 150,
      energy: 100,
      temperature: 40,
      acVoltage: 230,
      frequency: 50,
      ...input,
    };
    u16(frame, at + 6, Math.round((v.dcVoltage * 32768) / 64));
    u16(frame, at + 8, Math.round((v.power * 32768) / 512));
    frame.writeUInt32BE(Math.round((v.energy * 32768) / 4), at + 10);
    u16(frame, at + 14, Math.round(((v.temperature + 40) * 32768) / 256));
    u16(frame, at + 16, Math.round((v.acVoltage * 32768) / 512));
    u16(frame, at + 18, Math.round((v.frequency * 32768) / 128));
    for (const [key, raw] of Object.entries(input.raw ?? {})) {
      const offset = { dcVoltage: 6, power: 8, temperature: 14, acVoltage: 16, frequency: 18 }[key];
      if (key === 'energy') frame.writeUInt32BE(raw, at + 10);
      else u16(frame, at + offset, raw);
    }
  }
  frame[length - 2] = 0x00;
  frame[length - 1] = 0x16;
  return frame;
}
