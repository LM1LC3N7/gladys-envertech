// -----------------------------------------------------------------------------
// The only network access: one TCP connection to the EVT800 micro-inverter on
// the home network (port 14889 by default), no cloud. The inverter sends its
// frames on its own; each one is acknowledged as the pyenvertechevt800
// library does (see src/evt800/protocol.js). Nothing else is ever sent.
//
// Bounded: one connection per link, 10 s to connect, the link closed after
// 90 s without a frame (the library waits 60 s), one read buffer of 1 KiB
// allocated once, every frame decoded. Closed only by a real flood: more than
// 64 KiB a minute (a few hundred bytes are expected), an acknowledgement the
// inverter does not read (4 KiB pending), or 2 KiB without a single frame
// (not an EVT800 at this address).
//
// Node's own sockets: no User-Agent, no imitation. Errors carry our own codes,
// never a text of the network stack or of the inverter.
// -----------------------------------------------------------------------------

import { createConnection } from 'node:net';
import {
  CONNECT_TIMEOUT,
  DEFAULT_PORT,
  FLOOD_BYTES_PER_MINUTE,
  MAX_PENDING_WRITE,
  READ_BUFFER,
  SILENCE_TIMEOUT,
  UNKNOWN_AFTER_BYTES,
} from '../constants.js';
import { FrameReader, ackFor, parseFrame } from './protocol.js';

export class Evt800Error extends Error {
  /** @param {'timeout'|'unreachable'|'closed'|'silent'|'flood'|'unknown_answer'} code */
  constructor(code) {
    super(code);
    this.name = 'Evt800Error';
    this.code = code;
  }
}

/** `host` and `port` of an address (`[v6]:port`, `host:port`, `host`), for a socket. */
export function hostPort(address, defaultPort = DEFAULT_PORT) {
  const v6 = /^\[([0-9a-f:.]+)\](?::(\d{1,5}))?$/i.exec(address);
  if (v6) {
    return { host: v6[1], port: v6[2] ? Number(v6[2]) : defaultPort };
  }
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(address);
  return { host: match?.[1] ?? address, port: match?.[2] ? Number(match[2]) : defaultPort };
}

/**
 * One connection to the inverter. `onFrame(parsed)` for every frame,
 * `onOpen()` once connected, `onClose(err)` once at the end (`err` undefined:
 * closed by the inverter after frames, or by `close()`, which calls nothing).
 */
export class Evt800Link {
  constructor({
    address,
    onFrame = () => {},
    onOpen = () => {},
    onClose = () => {},
    connect = (options) => createConnection(options),
    timers = { setTimeout, clearTimeout },
    monotonic = () => performance.now(),
  }) {
    this.address = address;
    this.onFrame = onFrame;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.connect = connect;
    this.timers = timers;
    this.monotonic = monotonic;
    this.reader = new FrameReader(READ_BUFFER);
    this.socket = undefined;
    this.timer = undefined;
    this.ended = false;
    this.opened = false;
    this.frames = 0;
    this.received = 0;
    /** Bytes received in the current minute (flood check). */
    this.windowStart = 0;
    this.windowBytes = 0;
  }

  open() {
    this.arm(CONNECT_TIMEOUT, 'timeout');
    try {
      this.socket = this.connect(hostPort(this.address));
    } catch {
      this.end(new Evt800Error('unreachable'));
      return;
    }
    const socket = this.socket;
    socket.on('connect', () => {
      if (this.ended) return;
      this.opened = true;
      this.windowStart = this.monotonic();
      this.arm(SILENCE_TIMEOUT, 'silent');
      this.onOpen();
    });
    socket.on('data', (chunk) => this.data(chunk));
    socket.on('error', (err) => {
      const timeout = err?.code === 'ETIMEDOUT';
      this.end(new Evt800Error(timeout ? 'timeout' : this.opened ? 'closed' : 'unreachable'));
    });
    socket.on('close', () => {
      this.end(
        this.frames > 0 ? undefined : new Evt800Error(this.opened ? 'closed' : 'unreachable'),
      );
    });
  }

  /** Closes the link without calling `onClose` (a stop, a new address). */
  close() {
    if (this.ended) return;
    this.ended = true;
    this.cleanup();
  }

  arm(ms, code) {
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => this.end(new Evt800Error(code)), ms);
  }

  data(chunk) {
    if (this.ended) return;
    const mono = this.monotonic();
    if (mono - this.windowStart >= 60_000) {
      this.windowStart = mono;
      this.windowBytes = 0;
    }
    this.windowBytes += chunk.length;
    this.received += chunk.length;
    if (this.windowBytes > FLOOD_BYTES_PER_MINUTE) {
      this.end(new Evt800Error('flood'));
      return;
    }
    for (const frame of this.reader.push(chunk)) {
      if (this.ended) return;
      this.frames += 1;
      this.arm(SILENCE_TIMEOUT, 'silent');
      const ack = ackFor(frame);
      if (ack) {
        if (this.socket.writableLength > MAX_PENDING_WRITE) {
          this.end(new Evt800Error('flood'));
          return;
        }
        this.socket.write(ack);
      }
      this.onFrame(parseFrame(frame));
    }
    if (this.frames === 0 && this.received > UNKNOWN_AFTER_BYTES) {
      this.end(new Evt800Error('unknown_answer'));
    }
  }

  end(err) {
    if (this.ended) return;
    this.ended = true;
    this.cleanup();
    this.onClose(err);
  }

  cleanup() {
    if (this.timer !== undefined) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
    try {
      this.socket?.destroy();
    } catch {
      // Already closed.
    }
  }
}
