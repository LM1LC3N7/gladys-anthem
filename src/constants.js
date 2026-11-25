// -----------------------------------------------------------------------------
// Frozen keys (external ids, features, manifest actions), limits and timings.
// Every key here is stored by Gladys or by its users: never rename one.
// -----------------------------------------------------------------------------

/** `gladys.externalIds(DEVICE_TYPE, <host>_<port>_z<zone>)`. */
export const DEVICE_TYPE = 'anthem';

export const FEATURES = Object.freeze({
  /** Read only: 1 on, 0 off (or the device unreachable). */
  POWER: 'power',
  /** Push button: turns the zone on (connected standby must be enabled on the device). */
  POWER_ON: 'power_on',
  /** Push button: turns the zone off. Protective: never blocked by the volume cap. */
  POWER_OFF: 'power_off',
  /** 0..100 (the per cent scale of the device), capped by the `max_volume` option. */
  VOLUME: 'volume',
  /** Read only: 1 muted, 0 not muted. */
  MUTED: 'muted',
  /** Push button: mutes the zone. Protective: never blocked by the volume cap. */
  MUTE: 'mute',
  /** Push button: unmutes the zone, after lowering a volume above the cap. */
  UNMUTE: 'unmute',
  /** The input of the zone (its number on the device, labelled with its name). */
  SOURCE: 'source',
});

export const ACTIONS = Object.freeze({
  CHECK: 'check_devices',
});

/** The Anthem IP control port (setting "TCP Port" of the device). */
export const DEFAULT_PORT = 14999;

/** Zone 1 is the main zone; zone 2 exists on some models only (proven by its answer). */
export const ZONES = Object.freeze([1, 2]);

/** The per cent volume scale of the device (ZzPVOL). */
export const VOLUME = Object.freeze({ min: 0, max: 100 });
/** The cap of the configuration, on the same scale (100: no cap). */
export const MAX_VOLUME = Object.freeze({ min: 1, max: 100, default: 40 });

/** Inputs of the device (the protocol allows 30 input configurations). */
export const MAX_INPUTS = 30;

export const TIMINGS = Object.freeze({
  /** Opening the TCP connection. */
  connectTimeout: 5_000,
  /**
   * One request on the wire. The device answers within 100 ms (its
   * specification): 1 s without the answer is a stalled request, dropped so
   * the next one (a protective command first) goes.
   */
  requestTimeout: 1_000,
  /**
   * Gladys waits 5 s for the ack of a command: the whole command (wait in the
   * queue, reads and the confirmation read included) gets `commandBudget`.
   */
  commandBudget: 3_500,
  /** The state read just before a command (the volume before an unmute). */
  preRead: 1_000,
  /**
   * Reconnection: first after `reconnectBase`, then doubled each time up to
   * `reconnectMax`. The count is only reset by a connection that stayed up
   * `stableAfter`.
   */
  reconnectBase: 10_000,
  reconnectMax: 5 * 60_000,
  stableAfter: 60_000,
  /** The state of every zone read again this often (reports may be off on the device). */
  poll: 30_000,
  /** No byte at all within `silence` closes the connection (the polls get answers). */
  silence: 75_000,
  /** After a zone turned on: its state and the inputs read again after this. */
  wakeRead: 2_000,
  /** A volume reported in dB only: the per cent volume asked after this (grouped). */
  volumeRead: 300,
  /**
   * After a command not confirmed in its budget: the zone read again after
   * each of these delays (from the command).
   */
  followUps: Object.freeze([5_000, 20_000]),
  /**
   * A protective command (power off, mute) not confirmed is kept this long,
   * in /data too, and sent again (3 sends at most) when a read made after it
   * still shows the zone on (or unmuted), or when the connection comes back.
   */
  protectHold: 2 * 60_000,
  protectSends: 3,
  /**
   * After a Power on: the cap checked again every `wakeCheckDelay`,
   * `wakeChecks` times; and within `wakeWindow` the first state that shows
   * the zone on with its volume known lowers it to the cap when above.
   */
  wakeCheckDelay: 2_500,
  wakeChecks: 6,
  wakeWindow: 120_000,
  /** The states of one zone are published at most this often (a knob turned fast). */
  publishDelay: 1_000,
  /** Writes to /data are grouped. */
  persistDelay: 1_000,
  /** /data unreadable (permissions, I/O error): read again after this. */
  dataRetry: 10_000,
  /** The background round: status, created devices read again. */
  tick: 30_000,
  /** getConfig() failed: asked again after this, doubled up to `configRetryMax`. */
  configRetry: 5_000,
  configRetryMax: 5 * 60_000,
  /** More frames than this within `floodWindow`: the connection is closed. */
  floodFrames: 300,
  floodWindow: 10_000,
});

export const LIMITS = Object.freeze({
  /** Devices (addresses) known. */
  devices: 20,
  addresses: 20,
  /** Bytes of one frame (the device sends 258 at most). */
  frame: 512,
  /** Requests waiting on one connection (protective commands pass anyway). */
  pending: 32,
  /** Length of a name or a model. */
  name: 64,
  /** States published a minute, all zones together. */
  statesPerMinute: 300,
});
