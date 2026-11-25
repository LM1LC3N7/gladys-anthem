// -----------------------------------------------------------------------------
// The persistent link with the device at one address: the TCP connection
// opened, the model asked (IDM, the identity check of an Anthem device), the
// power of zone 1 and zone 2 asked (zone 2 exists when it answers), the
// state of each zone that is on and the input names read, the reports of
// the device merged, every zone read again every 30 s (reports may be off
// on the device), no byte in 75 s closing the connection, and the
// reconnection spaced out (10 s, then doubled each time up to 5 minutes; the
// count is only reset by a connection that stayed up a minute).
//
// The link knows nothing of Gladys: it reports to the app through `onEvent`
// ('identified', 'up', 'update', 'down', 'failed').
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, MAX_INPUTS, TIMINGS, ZONES } from '../constants.js';
import { DeviceError, ERROR_KINDS, monotonic, openSession } from './connection.js';
import {
  REQUESTS,
  parseInputCount,
  parseInputName,
  parseModel,
  parseZoneReport,
} from './protocol.js';

/** The fields of a zone, by report key. */
const FIELDS = Object.freeze({ POW: 'power', PVOL: 'volume', MUT: 'mute', INP: 'input' });

const emptyZone = () => ({
  power: undefined,
  volume: undefined,
  mute: undefined,
  input: undefined,
  /** field -> number of the query that read it (0: a report, or never read) */
  seq: { power: 0, volume: 0, mute: 0, input: 0 },
});

export class DeviceLink {
  constructor({
    address,
    onEvent = () => {},
    logger,
    timings = TIMINGS,
    timers = globalThis,
    now = monotonic,
    connect,
  }) {
    this.host = address.host;
    this.port = address.port ?? DEFAULT_PORT;
    this.onEvent = onEvent;
    this.logger = logger;
    this.timings = timings;
    this.timers = timers;
    this.now = now;
    this.connectFn = connect;
    this.session = undefined;
    this.connecting = false;
    this.stopped = false;
    this.failures = 0;
    this.connectedAt = undefined;
    this.lastAttempt = -Infinity;
    this.retryTimer = undefined;
    this.retryAt = undefined;
    this.pollTimer = undefined;
    this.wakeTimers = new Map();
    this.volumeTimers = new Map();
    this.frames = [];
    /** When the last frame came (this.now()): no frame within `silence` closes the connection. */
    this.lastFrameAt = 0;
    /** The read chain running: { session, promise } */
    this.reading = undefined;
    /** Inputs read again at the next read (a zone turned on, settings changed). */
    this.inputsStale = true;
    /** The last error of a connection attempt (shown by "Check"). */
    this.lastError = undefined;
    /** The model the device gave on this connection (identity check). */
    this.model = undefined;
    /** Zones proven by an answer: zone 1 always, zone 2 when it answered. */
    this.zones = new Set([1]);
    /** Whether zone 2 answered or not on this connection (undefined: not known). */
    this.zone2 = undefined;
    /** input number -> name */
    this.inputs = new Map();
    this.inputCount = undefined;
    this.state = new Map(ZONES.map((zone) => [zone, emptyZone()]));
  }

  get key() {
    return this.port === DEFAULT_PORT ? this.host : `${this.host}:${this.port}`;
  }

  /** Connected, identified and read: every command may go. */
  get connected() {
    return Boolean(this.session?.open) && this.connectedAt !== undefined;
  }

  /** Connected and identified (the model answered): a protective command may go. */
  get ready() {
    return Boolean(this.session?.open) && this.model !== undefined;
  }

  /** The state of a zone: { power, volume, mute, input }, each undefined when unknown. */
  zoneState(zone) {
    const { power, volume, mute, input } = this.state.get(zone) ?? emptyZone();
    return { power, volume, mute, input };
  }

  /** The number of the query that read a field of a zone (0 when not read by a query). */
  readSeq(zone, field) {
    return this.state.get(zone)?.seq[field] ?? 0;
  }

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.retryAt = undefined;
    this.stopTimers();
    const session = this.session;
    this.session = undefined;
    session?.close();
  }

  /**
   * A reconnection asked now (configuration saved): skips the backoff,
   * never the base interval since the last attempt.
   */
  retrySoon() {
    if (this.stopped || this.session || this.connecting) {
      return;
    }
    const wait = Math.max(0, this.lastAttempt + this.timings.reconnectBase - this.now());
    this.schedule(wait);
  }

  schedule(ms) {
    this.timers.clearTimeout(this.retryTimer);
    this.retryAt = this.now() + ms;
    this.retryTimer = this.timers.setTimeout(() => {
      this.retryTimer = undefined;
      this.retryAt = undefined;
      this.connect();
    }, ms);
  }

  /**
   * A connection asked now by a protective command (power off, mute):
   * independent of the backoff, but never sooner than `protectConnectGap`
   * after the last attempt (no storm while the user presses again).
   */
  connectNow() {
    if (this.stopped || this.session || this.connecting) {
      return;
    }
    const now = this.now();
    const at = Math.max(now, this.lastAttempt + this.timings.protectConnectGap);
    if (this.retryAt !== undefined && this.retryAt <= at) {
      return;
    }
    this.schedule(at - now);
  }

  backoff() {
    if (
      this.connectedAt !== undefined &&
      this.now() - this.connectedAt >= this.timings.stableAfter
    ) {
      this.failures = 0;
    }
    this.connectedAt = undefined;
    this.failures += 1;
    return Math.min(
      this.timings.reconnectMax,
      this.timings.reconnectBase * 2 ** Math.min(this.failures - 1, 16),
    );
  }

  resetSessionState() {
    this.model = undefined;
    this.zone2 = undefined;
    this.inputsStale = true;
    this.state = new Map(ZONES.map((zone) => [zone, emptyZone()]));
  }

  async connect() {
    if (this.stopped || this.connecting || this.session) {
      return;
    }
    this.connecting = true;
    this.lastAttempt = this.now();
    let session;
    try {
      session = await openSession({
        host: this.host,
        port: this.port,
        timeoutMs: this.timings.connectTimeout,
        connect: this.connectFn,
        staleMs: this.timings.requestTimeout,
        onReport: (text, seq) => this.report(session, text, seq),
        onClose: () => this.closed(session),
        onFrame: (source) => this.frame(source),
      });
      if (this.stopped) {
        session.close();
        return;
      }
      this.session = session;
      this.lastFrameAt = this.now();
      this.resetSessionState();
      // The model answers on every Anthem model, in standby too: an answer
      // "IDM…" tells it is one. Anything else: not an Anthem device.
      let model;
      try {
        model = parseModel(
          (await session.request(REQUESTS.model(), this.timings.requestTimeout)).text,
        );
      } catch {
        model = undefined;
      }
      if (!model) {
        throw new DeviceError(ERROR_KINDS.PROTOCOL, 'Not an Anthem device (no model)');
      }
      this.model = model;
      this.onEvent('identified', this);
      await this.readAll(session);
      if (!session.open) {
        throw new DeviceError(ERROR_KINDS.UNREACHABLE, 'Connection closed while reading');
      }
      if (this.state.get(1).power === undefined) {
        throw new DeviceError(ERROR_KINDS.PROTOCOL, 'Not an Anthem device (no power state)');
      }
      this.connectedAt = this.now();
      this.lastError = undefined;
      this.startPoll(session);
      this.onEvent('up', this);
    } catch (err) {
      this.lastError = err;
      if (session) {
        // Opened, then not a usable Anthem device: closed, spaced out.
        if (this.session === session) {
          this.session = undefined;
        }
        session.onClose = undefined;
        session.close();
        this.model = undefined;
      }
      if (!this.stopped) {
        const delay = this.backoff();
        this.logger?.debug?.(`${this.key}: ${err.message}, next attempt in ${delay / 1000} s`);
        this.schedule(delay);
        this.onEvent('failed', this, err);
      }
    } finally {
      this.connecting = false;
    }
  }

  /** Reads every zone (and the inputs when stale); one read chain at a time. */
  readAll(session) {
    if (this.reading?.session === session) {
      return this.reading.promise;
    }
    const promise = this.runReadAll(session).finally(() => {
      if (this.reading?.promise === promise) {
        this.reading = undefined;
      }
    });
    this.reading = { session, promise };
    return promise;
  }

  async query(session, request) {
    try {
      return await session.request(request, this.timings.requestTimeout);
    } catch (err) {
      return err;
    }
  }

  async runReadAll(session) {
    for (const zone of ZONES) {
      if (!session.open) {
        return;
      }
      if (zone !== 1 && this.zone2 === false) {
        continue;
      }
      const answer = await this.query(session, REQUESTS.query(zone, 'POW'));
      if (zone !== 1) {
        if (answer instanceof DeviceError) {
          if (answer.kind === ERROR_KINDS.REFUSED && answer.code === 'I') {
            // "!I" (invalid command): no zone 2 on this model. Any other
            // refusal may pass: asked again at the next read.
            this.zone2 = false;
          }
          continue;
        }
        this.zone2 = true;
        this.zones.add(zone);
      }
    }
    let anyOn = false;
    for (const zone of ZONES) {
      if (!this.zones.has(zone) || !session.open) {
        continue;
      }
      if (this.state.get(zone).power === true) {
        anyOn = true;
        await this.readZoneDetails(session, zone);
      }
    }
    if (anyOn && this.inputsStale && session.open) {
      await this.readInputs(session);
    }
  }

  async readZoneDetails(session, zone) {
    for (const key of ['PVOL', 'MUT', 'INP']) {
      if (!session.open) {
        return;
      }
      const answer = await this.query(session, REQUESTS.query(zone, key));
      if (answer instanceof DeviceError && answer.kind === ERROR_KINDS.REFUSED) {
        // Zone off ("!Z"), standby or not on this model ("!I"): unknown.
        this.forget(zone, FIELDS[key]);
      }
    }
  }

  async readInputs(session) {
    const answer = await this.query(session, REQUESTS.inputCount());
    if (answer instanceof DeviceError) {
      return;
    }
    const count = parseInputCount(answer.text);
    if (count === undefined) {
      return;
    }
    this.inputCount = count;
    for (let input = 1; input <= Math.min(count, MAX_INPUTS); input += 1) {
      if (!session.open) {
        return;
      }
      await this.query(session, REQUESTS.inputName(input));
    }
    this.inputsStale = false;
    this.onEvent('inputs', this);
  }

  forget(zone, field) {
    const state = this.state.get(zone);
    if (state && state[field] !== undefined) {
      state[field] = undefined;
      state.seq[field] = 0;
      if (this.connectedAt !== undefined) {
        this.onEvent('update', this, zone);
      }
    }
  }

  /** A frame that is not an ack nor an error: the answer of a query or a report. */
  report(session, text, seq) {
    if (session !== this.session) {
      return;
    }
    const zoneReport = parseZoneReport(text);
    if (zoneReport) {
      this.zoneReport(session, zoneReport, seq);
      return;
    }
    const input = parseInputName(text);
    if (input) {
      if (this.inputs.get(input.input) !== input.name) {
        this.inputs.set(input.input, input.name);
        if (this.connectedAt !== undefined && !this.reading) {
          this.onEvent('inputs', this);
        }
      }
      return;
    }
    if (text === 'BSC1') {
      // Bulk settings changed on the device: everything read again.
      this.inputsStale = true;
      this.scheduleWakeRead(session, 1);
    }
  }

  zoneReport(session, { zone, key, value }, seq) {
    if (zone !== 1 && this.zone2 === false) {
      return;
    }
    if (key === 'VOL') {
      // The volume in dB (a knob turned): the per cent volume asked again.
      this.scheduleVolumeRead(session, zone);
      return;
    }
    const field = FIELDS[key];
    const state = this.state.get(zone);
    if (value === undefined) {
      return;
    }
    if (zone !== 1 && this.zone2 !== true) {
      this.zone2 = true;
      this.zones.add(zone);
    }
    const before = state[field];
    state[field] = value;
    state.seq[field] = seq;
    if (field === 'power') {
      if (value === false) {
        // A zone off has no volume, mute or input to read.
        state.volume = undefined;
        state.mute = undefined;
        state.input = undefined;
      } else if (before === false && this.connectedAt !== undefined) {
        // Turned on: what was refused while off can be read now.
        this.inputsStale = this.inputsStale || this.inputs.size === 0;
        this.scheduleWakeRead(session, zone);
      }
    }
    if (this.connectedAt !== undefined && (before !== value || seq > 0)) {
      this.onEvent('update', this, zone);
    }
  }

  scheduleWakeRead(session, zone) {
    if (this.wakeTimers.has(zone)) {
      return;
    }
    this.wakeTimers.set(
      zone,
      this.timers.setTimeout(() => {
        this.wakeTimers.delete(zone);
        if (session === this.session && session.open) {
          this.readAll(session).catch(() => {});
        }
      }, this.timings.wakeRead),
    );
  }

  scheduleVolumeRead(session, zone) {
    if (this.volumeTimers.has(zone)) {
      return;
    }
    this.volumeTimers.set(
      zone,
      this.timers.setTimeout(() => {
        this.volumeTimers.delete(zone);
        if (session === this.session && session.open) {
          this.query(session, REQUESTS.query(zone, 'PVOL')).then((answer) => {
            if (answer instanceof DeviceError && answer.kind === ERROR_KINDS.REFUSED) {
              this.forget(zone, 'volume');
            }
          });
        }
      }, this.timings.volumeRead),
    );
  }

  /**
   * Every frame, counted before it is used: a device flooding the
   * connection is closed, then asked again spaced out.
   */
  frame(session) {
    const now = this.now();
    this.lastFrameAt = now;
    this.frames.push(now);
    while (this.frames.length > 0 && now - this.frames[0] > this.timings.floodWindow) {
      this.frames.shift();
    }
    if (this.frames.length > this.timings.floodFrames) {
      this.logger?.warn?.(`${this.key}: too many frames, connection closed`);
      this.frames = [];
      session.close();
    }
  }

  closed(session) {
    if (session !== this.session) {
      return;
    }
    this.session = undefined;
    this.stopTimers();
    const wasUp = this.connectedAt !== undefined;
    this.resetSessionState();
    if (this.stopped || !wasUp) {
      // Closed while connecting: connect() fails and spaces the next attempt.
      return;
    }
    const delay = this.backoff();
    this.schedule(delay);
    this.logger?.info?.(`${this.key}: connection lost, next attempt in ${delay / 1000} s`);
    this.onEvent('down', this);
  }

  /** Every zone read again every `poll`; no byte within `silence` closes the connection. */
  startPoll(session) {
    this.timers.clearTimeout(this.pollTimer);
    this.pollTimer = this.timers.setTimeout(() => {
      this.pollTimer = undefined;
      this.poll(session);
    }, this.timings.poll);
  }

  poll(session) {
    if (session !== this.session || !session.open) {
      return;
    }
    if (this.now() - this.lastFrameAt > this.timings.silence) {
      this.logger?.info?.(`${this.key}: no answer, connection closed`);
      session.close();
      return;
    }
    this.startPoll(session);
    this.readAll(session).catch(() => {});
  }

  stopTimers() {
    this.timers.clearTimeout(this.pollTimer);
    this.pollTimer = undefined;
    for (const timer of [...this.wakeTimers.values(), ...this.volumeTimers.values()]) {
      this.timers.clearTimeout(timer);
    }
    this.wakeTimers.clear();
    this.volumeTimers.clear();
  }

  /**
   * A request on the open session. A protective one only needs the device
   * identified; every other one needs the link up. UNREACHABLE (nothing
   * sent) otherwise.
   */
  request(request, timeoutMs, options = {}) {
    const ok = options.protective ? this.ready : this.connected;
    if (!ok) {
      return Promise.reject(
        new DeviceError(ERROR_KINDS.UNREACHABLE, 'Not connected: nothing sent'),
      );
    }
    return this.session.request(request, timeoutMs, options);
  }
}
