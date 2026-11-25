// -----------------------------------------------------------------------------
// One TCP session with an Anthem device (port 14999): one request on the
// wire at a time (no pipeline), its answer matched by its prefix (a query)
// or by ";" alone (a command), an error matched by the original command,
// every other frame handed over as a state report.
//
// Bounded: 512 bytes per frame (src/anthem/protocol.js), 32 requests
// waiting, each with its own deadline; a request that cannot start before
// its deadline is dropped, never sent late. Protective commands (power off,
// mute) go first and pass even when the queue is full; commands go before
// the state reads waiting.
// -----------------------------------------------------------------------------

import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { LIMITS } from '../constants.js';
import { ERRORS, FrameParser, parseError } from './protocol.js';

export const ERROR_KINDS = Object.freeze({
  /** No connection: nothing was sent. */
  UNREACHABLE: 'unreachable',
  /** Sent, no answer in time: the device may have done it. */
  TIMEOUT: 'timeout',
  /** The connection closed while the answer was awaited: the device may have done it. */
  CLOSED: 'closed',
  /** The device answered with an error. */
  REFUSED: 'refused',
  /** Something answered, but not as an Anthem device. */
  PROTOCOL: 'protocol',
  /** No time left: nothing was sent. */
  BUDGET: 'budget',
  /** Overtaken by a power off or a mute: nothing was sent. */
  CANCELLED: 'cancelled',
});

export class DeviceError extends Error {
  constructor(kind, message, { sent = false, code } = {}) {
    super(message);
    this.name = 'DeviceError';
    this.kind = kind;
    this.sent = sent;
    this.code = code;
  }
}

/** The default connection factory (the tests redirect it to the loopback interface). */
export const createTcpConnection = (options) => net.createConnection(options);

/** The monotonic clock (ms): never jumps with the wall clock. */
export const monotonic = () => performance.now();

/**
 * Opens a session. Rejects with UNREACHABLE when nothing accepts the
 * connection within `timeoutMs`.
 */
export function openSession({
  host,
  port,
  timeoutMs,
  connect = createTcpConnection,
  now = monotonic,
  onReport,
  onClose,
  onFrame,
  staleMs = 2_000,
}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let socket;
    const fail = (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(err);
      }
      socket?.destroy();
    };
    const timer = setTimeout(
      () => fail(new DeviceError(ERROR_KINDS.UNREACHABLE, 'No connection (timeout)')),
      timeoutMs,
    );
    try {
      socket = connect({ host, port });
    } catch (err) {
      fail(new DeviceError(ERROR_KINDS.UNREACHABLE, `Cannot connect: ${err.message}`));
      return;
    }
    socket.once('error', (err) => {
      fail(new DeviceError(ERROR_KINDS.UNREACHABLE, `No connection (${err.code ?? err.message})`));
    });
    socket.once('connect', () => {
      if (settled) {
        socket.destroy();
        return;
      }
      settled = true;
      clearTimeout(timer);
      socket.setNoDelay(true);
      resolve(new Session(socket, { now, onReport, onClose, onFrame, staleMs }));
    });
  });
}

export class Session {
  constructor(socket, { now = monotonic, onReport, onClose, onFrame, staleMs = 2_000 } = {}) {
    this.socket = socket;
    this.now = now;
    this.onReport = onReport;
    this.onClose = onClose;
    this.onFrame = onFrame;
    this.staleMs = staleMs;
    this.parser = new FrameParser();
    this.closed = false;
    /** The request on the wire. */
    this.current = undefined;
    /** Requests waiting their turn. */
    this.waiting = [];
    /** query prefix -> { until, seq } of a query that timed out (its answer may come late) */
    this.stale = new Map();
    /** Number of the last request written (a read made after a command has a higher one). */
    this.seq = 0;
    socket.on('error', () => {
      // 'close' follows: handled there.
    });
    socket.on('data', (chunk) => this.receive(chunk));
    socket.on('close', () => this.closedByPeer());
  }

  get open() {
    return !this.closed && !this.socket.destroyed;
  }

  receive(chunk) {
    if (this.closed) {
      return;
    }
    let frames;
    try {
      frames = this.parser.push(chunk);
    } catch {
      this.close();
      return;
    }
    for (const frame of frames) {
      this.onFrame?.(this);
      if (this.closed) {
        return;
      }
      const seq = this.match(frame);
      if (!frame.ack && !parseError(frame.text)) {
        // Answers to a query are reports too, tagged with the number of the
        // query (0 for a report the device sent by itself).
        this.onReport?.(frame.text, seq);
      }
    }
  }

  /**
   * The number a frame answering `current` is tagged with. After a query
   * with the same prefix timed out (within `staleMs`), the frame may be the
   * late answer of that older query: it settles the current one (never a
   * timeout chain), but is tagged with the OLDER number, so no decision
   * that needs a read made after a command ever rests on it.
   */
  answerSeq(key, current) {
    const stale = this.stale.get(key);
    this.stale.delete(key);
    return stale && this.now() < stale.until ? stale.seq : current.seq;
  }

  /**
   * Settles the request on the wire when `frame` answers it. Returns the
   * number of the query it answered (0 otherwise).
   */
  match(frame) {
    const current = this.current;
    const error = frame.ack ? undefined : parseError(frame.text);
    if (frame.ack) {
      // A late ";" cannot be told from the ";" of the next command: the
      // commands are confirmed by a read made after them (src/app.js).
      if (!current || current.expect !== undefined) {
        return 0;
      }
      this.settle(current);
      current.resolve({ text: '', seq: current.seq });
      return 0;
    }
    if (error) {
      if (!current || error.command !== current.text) {
        return 0;
      }
      this.stale.delete(`!${error.command}`);
      this.settle(current);
      current.reject(
        new DeviceError(
          ERROR_KINDS.REFUSED,
          `Refused by the device: ${ERRORS[error.code] ?? 'error'}`,
          { code: error.code, sent: true },
        ),
      );
      return 0;
    }
    if (!current || current.expect === undefined || !frame.text.startsWith(current.expect)) {
      return 0;
    }
    const seq = this.answerSeq(current.expect, current);
    this.settle(current);
    current.resolve({ text: frame.text, seq });
    return seq;
  }

  settle(current) {
    this.current = undefined;
    clearTimeout(current.timer);
    // The next request goes once the current answer is handled.
    queueMicrotask(() => this.next());
  }

  /**
   * Sends one request (`{ text, expect }` of REQUESTS) and resolves with
   * `{ text, seq }`: the answer of a query, '' for a command. UNREACHABLE or
   * BUDGET: nothing was sent. After the request left, TIMEOUT or CLOSED mark
   * a request that may have reached the device (`sent: true`).
   * `protective` requests go before everything waiting, even when the queue
   * is full; `urgent` ones (commands) before the reads waiting. A request
   * still waiting at its deadline is dropped then, never written. `onWrite`
   * is called just before it is written, with its number; `beforeSend`
   * just before that: when it returns false, the request is dropped,
   * nothing sent (a command overtaken by a power off or a mute).
   */
  request(request, timeoutMs, { urgent = false, protective = false, onWrite, beforeSend } = {}) {
    if (!this.open) {
      return Promise.reject(
        new DeviceError(ERROR_KINDS.UNREACHABLE, 'Not connected: nothing sent'),
      );
    }
    if (!request || typeof request.text !== 'string') {
      return Promise.reject(new DeviceError(ERROR_KINDS.PROTOCOL, 'Invalid request: nothing sent'));
    }
    if (!protective && this.waiting.length >= LIMITS.pending) {
      return Promise.reject(
        new DeviceError(ERROR_KINDS.BUDGET, 'Too many requests waiting: nothing sent'),
      );
    }
    if (!(timeoutMs > 0)) {
      return Promise.reject(new DeviceError(ERROR_KINDS.BUDGET, 'No time left: nothing sent'));
    }
    return new Promise((resolve, reject) => {
      const rank = protective ? 2 : urgent ? 1 : 0;
      const item = {
        text: request.text,
        expect: request.expect,
        frame: Buffer.from(`${request.text};`, 'latin1'),
        deadline: this.now() + timeoutMs,
        rank,
        onWrite,
        beforeSend,
        resolve,
        reject,
        timer: undefined,
        seq: 0,
      };
      // Waiting behind the request on the wire: dropped at its own deadline.
      item.timer = setTimeout(() => {
        const index = this.waiting.indexOf(item);
        if (index !== -1) {
          this.waiting.splice(index, 1);
          reject(new DeviceError(ERROR_KINDS.BUDGET, 'No time left: nothing sent'));
        }
      }, timeoutMs);
      const index = this.waiting.findIndex((w) => w.rank < rank);
      this.waiting.splice(index === -1 ? this.waiting.length : index, 0, item);
      this.next();
    });
  }

  next() {
    while (!this.current && this.waiting.length > 0 && this.open) {
      const item = this.waiting.shift();
      clearTimeout(item.timer);
      const left = item.deadline - this.now();
      if (left <= 0) {
        item.reject(new DeviceError(ERROR_KINDS.BUDGET, 'No time left: nothing sent'));
        continue;
      }
      if (item.beforeSend && !item.beforeSend()) {
        item.reject(new DeviceError(ERROR_KINDS.CANCELLED, 'Cancelled: nothing sent'));
        continue;
      }
      this.current = item;
      this.seq += 1;
      item.seq = this.seq;
      item.timer = setTimeout(() => {
        if (this.current !== item) {
          return;
        }
        this.current = undefined;
        // Its answer may still come: ignored for a while, never taken as
        // the answer of the next request.
        if (item.expect !== undefined) {
          this.stale.set(item.expect, { until: this.now() + this.staleMs, seq: item.seq });
        }
        item.reject(
          new DeviceError(ERROR_KINDS.TIMEOUT, 'Sent, without answer from the device', {
            sent: true,
          }),
        );
        this.next();
      }, left);
      try {
        item.onWrite?.(item.seq);
        this.socket.write(item.frame);
      } catch (err) {
        clearTimeout(item.timer);
        this.current = undefined;
        item.reject(new DeviceError(ERROR_KINDS.UNREACHABLE, `Not sent: ${err.message}`));
      }
    }
  }

  closedByPeer() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    const current = this.current;
    this.current = undefined;
    if (current) {
      clearTimeout(current.timer);
      current.reject(
        new DeviceError(ERROR_KINDS.CLOSED, 'Connection closed before the answer', {
          sent: true,
        }),
      );
    }
    for (const item of this.waiting.splice(0)) {
      clearTimeout(item.timer);
      item.reject(new DeviceError(ERROR_KINDS.UNREACHABLE, 'Connection closed: nothing sent'));
    }
    this.onClose?.();
  }

  close() {
    try {
      this.socket.destroy();
    } catch {
      // Already closed.
    }
    this.closedByPeer();
  }
}
