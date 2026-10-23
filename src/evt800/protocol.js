// -----------------------------------------------------------------------------
// The local TCP protocol of an Envertech EVT800 micro-inverter, ported from
// the pyenvertechevt800 library (Daniel Bergmann, MIT, see
// THIRD_PARTY_NOTICES.md), the one Home Assistant uses. Pure.
//
// The protocol is NOT documented by Envertech: everything below is what the
// library reads, checked against the frames of its tests. The inverter (its
// "TCP server" mode, port 14889) sends frames on its own; the client answers
// each one with a short acknowledgement, as the library does. Nothing else is
// ever sent.
//
// A frame: 0x68 0x00 <length> 0x68 <command: 2 bytes> <serial: 4 bytes> ...
// 0x16, `length` counting the whole frame. Kinds, by length as the library:
// - 32 bytes: a "poll" frame, the serial of the inverter only;
// - 42 bytes or more: a data frame, one block of 32 bytes per input (MPPT)
//   from byte 20: id (4), firmware (2), DC voltage (2), power (2), lifetime
//   energy (4), temperature (2), AC voltage (2), AC frequency (2).
//
// Changed here: the frame is cut by its length byte (the library cuts at the
// first 0x16 after 0x68 0x00, which a value may contain), the header and the
// end byte are checked, the reads are bounded (one buffer allocated once,
// every search a linear `indexOf`), a raw value of 0xFFFF (0xFFFFFFFF) is "not
// given", and the ids are written in hexadecimal as the serial is.
// -----------------------------------------------------------------------------

export const START = 0x68;
export const END = 0x16;
/** The smallest frame read (the acknowledgement is 16 bytes); the largest one a length byte gives. */
export const MIN_FRAME = 16;
export const MAX_FRAME = 255;
/** The poll frame: the serial of the inverter only. */
export const POLL_LENGTH = 32;
/** The inputs read in a data frame, as the library (an EVT800 has two). */
export const MAX_CHANNELS = 2;
/** A frame shorter than this is never acknowledged (the library's rule). */
export const ACK_MIN_LENGTH = 24;

const BLOCK_START = 20;
const BLOCK_SIZE = 32;
/** The fields of a block use its first 20 bytes. */
const BLOCK_USED = 20;

const u16 = (b, i) => (b[i] << 8) | b[i + 1];
const u32 = (b, i) => b[i] * 0x1000000 + ((b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]);
const hex = (b, i, n) =>
  b
    .subarray(i, i + n)
    .toString('hex')
    .toUpperCase();

/** A 16-bit raw value scaled, or undefined for 0xFFFF ("not given"). */
const scaled16 = (b, i, scale, offset = 0) => {
  const raw = u16(b, i);
  return raw === 0xffff ? undefined : (raw * scale) / 32768 + offset;
};

/** The serial of a frame (bytes 6 to 9, hexadecimal), or undefined when unreadable (all 0 or all F). */
export function serialOf(frame) {
  if (frame.length < 10) return undefined;
  const serial = hex(frame, 6, 4);
  return serial === '00000000' || serial === 'FFFFFFFF' ? undefined : serial;
}

/**
 * One input of a data frame (`k` from 0). A block whose id is all 0 is kept
 * (`id` null, `empty` true): the library reads its values the same way, and
 * the number of inputs of a frame is its number of blocks (review 1, M1).
 */
function channelOf(frame, k) {
  const at = BLOCK_START + k * BLOCK_SIZE;
  const hexId = hex(frame, at, 4);
  const empty = hexId === '00000000';
  const dcVoltage = scaled16(frame, at + 6, 64);
  const power = scaled16(frame, at + 8, 512);
  const rawEnergy = u32(frame, at + 10);
  const energy = rawEnergy === 0xffffffff ? undefined : (rawEnergy * 4) / 32768;
  // The library divides power by voltage and gives 0 on a division by zero.
  let current;
  if (power !== undefined && dcVoltage !== undefined) {
    current = dcVoltage > 0 ? power / dcVoltage : power === 0 ? 0 : undefined;
  }
  return {
    id: empty ? null : hexId,
    empty,
    firmware: `${hex(frame, at + 4, 1)}.${hex(frame, at + 5, 1)}`,
    dcVoltage,
    power,
    energy,
    temperature: scaled16(frame, at + 14, 256, -40),
    acVoltage: scaled16(frame, at + 16, 512),
    frequency: scaled16(frame, at + 18, 128),
    current,
  };
}

/**
 * What a whole frame says: `{ kind: 'poll', serial }`, `{ kind: 'data',
 * serial, channels: [channel] }` or `{ kind: 'other', serial }`.
 * `serial` is undefined when unreadable.
 */
export function parseFrame(frame) {
  const serial = serialOf(frame);
  if (frame.length === POLL_LENGTH) {
    return { kind: 'poll', serial };
  }
  // A block counts only when its 20 bytes end before the checksum and 0x16.
  const blocks = Math.min(
    MAX_CHANNELS,
    Math.max(0, Math.floor((frame.length - 2 - BLOCK_START - BLOCK_USED) / BLOCK_SIZE) + 1),
  );
  if (blocks === 0) {
    return { kind: 'other', serial };
  }
  const channels = [];
  for (let k = 0; k < blocks; k += 1) {
    channels.push(channelOf(frame, k));
  }
  return { kind: 'data', serial, channels };
}

/**
 * The acknowledgement of a frame, as the library sends it (bytes 20 to 23 of
 * the frame echoed), or undefined for a frame too short to be acknowledged.
 */
export function ackFor(frame) {
  if (frame.length < ACK_MIN_LENGTH) {
    return undefined;
  }
  const ack = Buffer.from([0x68, 0x00, 0x10, 0x68, 0x10, 0x50, 0, 0, 0, 0, 0, 0, 0, 0, 0x78, 0x16]);
  frame.copy(ack, 6, 20, 24);
  return ack;
}

/**
 * Cuts a stream into frames. One buffer allocated once (`limit` bytes); bytes
 * that are not part of a frame are dropped (and counted in `skipped`). Each
 * `push` is linear in the bytes it gets: every search is an `indexOf` from
 * where the previous one stopped, a candidate is dropped by one byte at most
 * once, and the rest is moved once per pass.
 */
export class FrameReader {
  constructor(limit = 1024) {
    if (limit < 2 * MAX_FRAME) {
      throw new RangeError('FrameReader needs room for two frames');
    }
    this.buffer = Buffer.alloc(limit);
    this.size = 0;
    this.skipped = 0;
  }

  /** The frames completed by `chunk` (copies), in order. */
  push(chunk) {
    const frames = [];
    let offset = 0;
    while (offset < chunk.length) {
      const room = this.buffer.length - this.size;
      const take = Math.min(room, chunk.length - offset);
      chunk.copy(this.buffer, this.size, offset, offset + take);
      this.size += take;
      offset += take;
      this.extract(frames);
    }
    return frames;
  }

  extract(frames) {
    const buffer = this.buffer;
    let pos = 0;
    for (;;) {
      const i = buffer.indexOf(START, pos);
      if (i === -1 || i >= this.size) {
        this.skipped += this.size - pos;
        pos = this.size;
        break;
      }
      this.skipped += i - pos;
      if (this.size - i < 4) {
        pos = i;
        break;
      }
      const length = buffer[i + 2];
      if (buffer[i + 1] !== 0x00 || buffer[i + 3] !== START || length < MIN_FRAME) {
        this.skipped += 1;
        pos = i + 1;
        continue;
      }
      if (this.size - i < length) {
        // Waiting for the rest (at most MAX_FRAME bytes: the buffer holds it).
        pos = i;
        break;
      }
      if (buffer[i + length - 1] !== END) {
        this.skipped += 1;
        pos = i + 1;
        continue;
      }
      frames.push(Buffer.from(buffer.subarray(i, i + length)));
      pos = i + length;
    }
    if (pos > 0) {
      buffer.copyWithin(0, pos, this.size);
      this.size -= pos;
    }
  }
}
