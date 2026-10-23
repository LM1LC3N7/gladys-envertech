// -----------------------------------------------------------------------------
// The frames of the EVT800, against the frames and values of the tests of the
// pyenvertechevt800 library, and the framing on hostile streams.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FrameReader, ackFor, parseFrame, serialOf } from '../src/evt800/protocol.js';
import { ONE_MPPT_CUT, POLL, TWO_MPPT, TWO_MPPT_VALUES, dataFrame } from './fixtures/evt800.js';

const close = (actual, expected, label) =>
  assert.ok(Math.abs(actual - expected) < 1e-6, `${label}: ${actual} != ${expected}`);

test('the two-input frame of the library gives the values of its test', () => {
  const parsed = parseFrame(TWO_MPPT);
  assert.equal(parsed.kind, 'data');
  assert.equal(parsed.serial, '31525820');
  assert.equal(parsed.channels.length, 2);
  for (const [k, expected] of TWO_MPPT_VALUES.entries()) {
    const channel = parsed.channels[k];
    for (const [key, value] of Object.entries(expected)) {
      if (typeof value === 'number') close(channel[key], value, `${k}.${key}`);
      else assert.equal(channel[key], value, `${k}.${key}`);
    }
  }
});

test('the poll frame gives the serial only; its acknowledgement is the library one', () => {
  assert.deepEqual(parseFrame(POLL), { kind: 'poll', serial: '31525820' });
  // The library echoes bytes 20 to 23 of the frame, the rest fixed.
  assert.equal(ackFor(TWO_MPPT).toString('hex'), '68001068105031525820000000007816');
  assert.equal(ackFor(POLL).toString('hex'), '68001068105001000001000000007816');
  assert.equal(ackFor(Buffer.alloc(20)), undefined, 'too short: never acknowledged');
});

test('an unreadable serial, an absent input, a raw 0xFFFF', () => {
  const zero = dataFrame({ serial: '00000000' });
  assert.equal(serialOf(zero), undefined);
  assert.equal(serialOf(dataFrame({ serial: 'FFFFFFFF' })), undefined);
  const one = parseFrame(dataFrame({ inputs: [{ power: 100 }] }));
  assert.equal(one.channels[1], null, 'the second block has no id: no input');
  close(one.channels[0].power, 100, 'power');
  const glitch = parseFrame(
    dataFrame({ inputs: [{ raw: { power: 0xffff, energy: 0xffffffff } }] }),
  );
  assert.equal(glitch.channels[0].power, undefined);
  assert.equal(glitch.channels[0].energy, undefined);
  assert.equal(glitch.channels[0].current, undefined);
  // 0 V and 0 W: the library's 0 A.
  const night = parseFrame(dataFrame({ inputs: [{ power: 0, dcVoltage: 0 }] }));
  assert.equal(night.channels[0].current, 0);
  // A frame too short for one block is another kind.
  const short = Buffer.from('6800146810043152582000000000000000000016', 'hex');
  assert.equal(parseFrame(short).kind, 'other');
});

test('the reader cuts by the length byte, across chunks, a 0x16 inside the values', () => {
  // 0x16 in the power, the energy and the temperature: the library would cut there.
  const frame = dataFrame({
    inputs: [{ raw: { power: 0x1616, energy: 0x16161616, temperature: 0x6816 } }],
  });
  assert.ok(frame.subarray(4, frame.length - 1).includes(0x16));
  const reader = new FrameReader(1024);
  const frames = [];
  const stream = Buffer.concat([Buffer.from('ffff6800', 'hex'), frame, POLL, TWO_MPPT]);
  for (let i = 0; i < stream.length; i += 7) {
    frames.push(...reader.push(stream.subarray(i, i + 7)));
  }
  assert.equal(frames.length, 3);
  assert.deepEqual(frames[0], frame);
  assert.deepEqual(frames[1], POLL);
  assert.deepEqual(frames[2], TWO_MPPT);
  assert.equal(parseFrame(frames[0]).channels[0].power, (0x1616 * 512) / 32768);
});

test('the library frame cut short is never a frame; a wrong end byte is skipped', () => {
  const reader = new FrameReader(1024);
  assert.deepEqual(reader.push(ONE_MPPT_CUT), []);
  const bad = Buffer.from(TWO_MPPT);
  bad[bad.length - 1] = 0x00;
  const fresh = new FrameReader(1024);
  assert.deepEqual(fresh.push(Buffer.concat([bad, POLL])), [POLL]);
  assert.ok(fresh.skipped >= bad.length);
});

test('the reader stays linear and bounded on a hostile stream', () => {
  const reader = new FrameReader(1024);
  // Candidates everywhere: 0x68 0x00 0xff 0x68 never ending with 0x16.
  const junk = Buffer.alloc(2 * 1024 * 1024);
  for (let i = 0; i < junk.length; i += 4) junk.set([0x68, 0x00, 0xff, 0x68], i);
  const started = performance.now();
  const frames = reader.push(junk);
  frames.push(...reader.push(POLL));
  const elapsed = performance.now() - started;
  assert.ok(elapsed < 2000, `${elapsed} ms for 2 MiB`);
  assert.ok(reader.size <= 1024);
  assert.equal(reader.buffer.length, 1024, 'never grown');
  assert.ok(frames.length <= 1);
  // A plain stream of 0x68: linear too.
  const plain = new FrameReader(1024);
  const t0 = performance.now();
  plain.push(Buffer.alloc(2 * 1024 * 1024, 0x68));
  assert.ok(performance.now() - t0 < 2000);
});

test('the reader refuses a buffer that cannot hold two frames', () => {
  assert.throws(() => new FrameReader(100), RangeError);
});
