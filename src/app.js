// -----------------------------------------------------------------------------
// The integration: the Anthem devices it knows (typed addresses), one
// persistent TCP connection per address (src/anthem/link.js), one Gladys
// device per zone, the commands (validated before anything is sent, the
// volume capped by the configuration, serialized per zone, each within the
// 5 s Gladys waits for its ack, confirmed by a read made after it) and the
// protective commands (power off, mute: never queued, never blocked by the
// cap, kept and sent again while not confirmed). index.js only wires the SDK
// handlers to it (src/handlers.js).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, deviceId, normalizeConfig, parsePlatformId, platformId } from './config.js';
import { DEVICE_TYPE, FEATURES, MAX_VOLUME, TIMINGS, VOLUME, ZONES, LIMITS } from './constants.js';
import { DeviceError, ERROR_KINDS, monotonic } from './anthem/connection.js';
import { DeviceLink } from './anthem/link.js';
import { REQUESTS, parseInput, parseVolume, parseZoneReport } from './anthem/protocol.js';
import { T } from './i18n.js';
import { buildDevice, deviceName, featureKey, idsOf, inputOptions, stateList } from './model.js';
import { FileStore, emptyData, isInputValue } from './store.js';

const BUTTONS = new Set([FEATURES.POWER_ON, FEATURES.POWER_OFF, FEATURES.MUTE, FEATURES.UNMUTE]);

/** The protective commands: what they set, and the zone field that confirms it. */
const PROTECTIVE = Object.freeze({
  [FEATURES.POWER_OFF]: {
    field: 'power',
    key: 'POW',
    wanted: false,
    request: (zone) => REQUESTS.power(zone, false),
  },
  [FEATURES.MUTE]: {
    field: 'mute',
    key: 'MUT',
    wanted: true,
    request: (zone) => REQUESTS.mute(zone, true),
  },
});

/**
 * The volume of a command, validated strictly: an integer 0..100 given as a
 * number or as a string of digits. null, '', true, 12.5, '12abc' are refused.
 * @returns {number | undefined}
 */
export function parseVolumeCommand(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= VOLUME.min && value <= VOLUME.max
      ? value
      : undefined;
  }
  return typeof value === 'string' ? parseVolume(value.trim()) : undefined;
}

/** The input of a command: an input number given as a number or a string of digits. */
export function parseInputCommand(value) {
  if (typeof value === 'number') {
    return parseInput(String(value)) === value ? value : undefined;
  }
  return typeof value === 'string' ? parseInput(value.trim()) : undefined;
}

const short = (value) =>
  String(value)
    .replace(/[^\x20-\x7e]/g, '')
    .slice(0, 32);

const sleep = (timers, ms) => new Promise((resolve) => timers.setTimeout(resolve, ms));

export class AnthemApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'anthem' }),
    store = new FileStore(),
    now = monotonic,
    wallNow = Date.now,
    timers = globalThis,
    timings = TIMINGS,
    connect,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.store = store;
    this.now = now;
    this.wallNow = wallNow;
    this.timers = timers;
    this.timings = timings;
    this.connect = connect;
    /** The configuration read from Gladys; undefined until read once. */
    this.config = undefined;
    this.data = undefined;
    /** /data could not be read: nothing is written over it until it is. */
    this.dataUnreadable = false;
    this.dataTimer = undefined;
    /** addressKey -> DeviceLink */
    this.links = new Map();
    /** target (platform id) -> command queue */
    this.queues = new Map();
    /** platform ids (zones) created in Gladys */
    this.created = new Set();
    this.createdStale = false;
    /** target -> timer of the grouped publication of its states */
    this.publishTimers = new Map();
    /** When each state of the last minute was published (this.now()). */
    this.published = [];
    /** target -> { epochOff, epochMute }: bumped by a power off / a mute */
    this.epochs = new Map();
    /** target -> pending protective { kind, at (monotonic), wallAt, sends, sentSeq } */
    this.protect = new Map();
    /** targets whose protective resend is running */
    this.protectSending = new Set();
    /** target -> timers of the follow-up reads */
    this.followUps = new Map();
    /** target -> { timer }: the wake-up check chain after a Power on */
    this.wakeChecks = new Map();
    /** target -> until when (this.now()) a Power on of Gladys is followed */
    this.wakeWindows = new Map();
    this.wakeCapping = new Set();
    this.generation = 0;
    this.tickTimer = undefined;
    this.persistTimer = undefined;
    this.configTimer = undefined;
    this.configFailures = 0;
    this.configUnread = false;
    this.lastStatus = undefined;
    this.warned = new Set();
    this.started = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  /** The volume cap now: the configuration, else the last one saved, else the default. */
  get maxVolume() {
    return this.config?.maxVolume ?? this.data?.maxVolume ?? MAX_VOLUME.default;
  }

  /**
   * Connected to Gladys (also after every reconnection): the configuration
   * is read; when that fails, the app starts anyway with what /data and
   * Gladys know (created devices, pending protective commands, last cap),
   * and asks the configuration again at spaced intervals.
   */
  async connected() {
    this.timers.clearTimeout(this.configTimer);
    this.configTimer = undefined;
    let raw;
    try {
      raw = await this.gladys.getConfig();
    } catch (err) {
      this.logger.warn(`Could not read the configuration: ${err.message}`);
      this.configUnread = true;
      await this.start(undefined, { connected: true });
      this.scheduleConfigRetry();
      return;
    }
    this.configFailures = 0;
    this.configUnread = false;
    await this.start(raw, { connected: true });
  }

  scheduleConfigRetry() {
    this.configFailures += 1;
    const delay = Math.min(
      this.timings.configRetryMax,
      this.timings.configRetry * 2 ** Math.min(this.configFailures - 1, 16),
    );
    const generation = this.generation;
    this.timers.clearTimeout(this.configTimer);
    this.configTimer = this.timers.setTimeout(async () => {
      this.configTimer = undefined;
      if (generation !== this.generation) {
        return;
      }
      let raw;
      try {
        raw = await this.gladys.getConfig();
      } catch (err) {
        this.logger.warn(`Could not read the configuration again: ${err.message}`);
        if (generation === this.generation) {
          this.scheduleConfigRetry();
        }
        return;
      }
      if (generation !== this.generation) {
        return;
      }
      this.configFailures = 0;
      this.configUnread = false;
      await this.start(raw);
    }, delay);
  }

  /**
   * (Re)start with a configuration (undefined: keep the one known): on every
   * connection to Gladys and on every configuration save. The links are
   * kept (a reconnection to Gladys never drops them); what this app
   * remembered as "already published" is forgotten, since the core forgot
   * it too.
   */
  async start(raw, { connected = false } = {}) {
    if (raw !== undefined) {
      this.config = normalizeConfig(raw);
      this.configUnread = false;
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    this.started = true;
    this.timers.clearInterval(this.tickTimer);
    this.tickTimer = this.timers.setInterval(() => this.tick(), this.timings.tick);
    if (connected) {
      this.lastStatus = undefined;
      this.gladys.forgetPublishedStates?.();
    }
    if (!this.data) {
      await this.loadData();
    }
    if (this.config && this.data.maxVolume !== this.config.maxVolume) {
      this.data.maxVolume = this.config.maxVolume;
      this.persist();
    }
    await this.step('read the Gladys devices', () => this.refreshCreated());
    // A configuration save asks the silent links again (never sooner than the
    // base interval); a reconnection to Gladys does not.
    await this.step('open the links', () => this.syncLinks({ retry: !connected }));
    await this.step('publish the devices', () => this.publishDevices());
    await this.step('publish the states', () => this.publishAllStates());
    await this.step('publish the status', () => this.updateStatus());
  }

  async step(name, task) {
    try {
      await task();
    } catch (err) {
      this.logger.warn(`Start: could not ${name}: ${err.message}`);
    }
  }

  /**
   * Reads /data. Unreadable (not missing, not corrupted): empty data in
   * memory, nothing written over the file, read again every 10 s; what it
   * holds is merged once it can be read.
   */
  async loadData() {
    try {
      const loaded = await this.store.load();
      this.dataUnreadable = false;
      if (this.data) {
        this.mergeData(loaded);
      } else {
        this.data = loaded;
        this.restoreProtect();
      }
      if (this.store.corrupted) {
        this.logger.warn('Unreadable /data/anthem.json moved to anthem.json.bad');
      }
    } catch (err) {
      if (!this.data) {
        this.data = emptyData();
      }
      if (!this.dataUnreadable) {
        this.logger.warn(`Could not read /data: ${err.message}`);
      }
      this.dataUnreadable = true;
      this.timers.clearTimeout(this.dataTimer);
      const generation = this.generation;
      this.dataTimer = this.timers.setTimeout(() => {
        this.dataTimer = undefined;
        if (generation === this.generation && this.dataUnreadable) {
          this.loadData()
            .then(() => {
              if (!this.dataUnreadable) {
                this.syncLinks();
                return this.publishDevices();
              }
              return undefined;
            })
            .then(() => this.updateStatus())
            .catch(() => {});
        }
      }, this.timings.dataRetry);
    }
  }

  /** /data read late: its devices, options and pending commands merged into memory. */
  mergeData(loaded) {
    for (const [id, device] of Object.entries(loaded.devices)) {
      const current = this.data.devices[id];
      if (!current) {
        if (Object.keys(this.data.devices).length < LIMITS.devices) {
          this.data.devices[id] = device;
        }
        continue;
      }
      current.model = current.model ?? device.model;
      current.zones = ZONES.filter((z) => current.zones.includes(z) || device.zones.includes(z));
      this.mergeInputs(current, device.inputs, { relabel: false });
    }
    if (this.data.maxVolume === undefined) {
      this.data.maxVolume = loaded.maxVolume;
    }
    for (const [target, entry] of Object.entries(loaded.protect)) {
      if (!this.protect.has(target)) {
        this.data.protect[target] = entry;
      }
    }
    this.restoreProtect();
    this.persist();
  }

  stop() {
    this.started = false;
    this.generation += 1;
    this.timers.clearInterval(this.tickTimer);
    this.tickTimer = undefined;
    this.timers.clearTimeout(this.configTimer);
    this.configTimer = undefined;
    this.timers.clearTimeout(this.dataTimer);
    this.dataTimer = undefined;
    for (const link of this.links.values()) {
      link.stop();
    }
    this.links.clear();
    for (const handle of this.publishTimers.values()) {
      this.timers.clearTimeout(handle);
    }
    this.publishTimers.clear();
    for (const target of [...this.followUps.keys()]) {
      this.cancelFollowUps(target);
    }
    for (const target of [...this.wakeChecks.keys()]) {
      this.cancelWakeCheck(target);
    }
    this.wakeWindows.clear();
    for (const queue of this.queues.values()) {
      for (const item of queue.items.splice(0)) {
        item.reject(new DeviceError(ERROR_KINDS.CANCELLED, 'Integration stopping: nothing sent'));
      }
    }
    if (this.persistTimer || this.data) {
      this.timers.clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      if (this.data && !this.dataUnreadable) {
        // /data written at a clean stop (pending protective commands included).
        return this.store.save(this.data).catch(() => {});
      }
    }
    return Promise.resolve();
  }

  /** The background round: created devices if unread, expired protective commands, status. */
  tick() {
    if (!this.data) {
      return Promise.resolve();
    }
    return Promise.resolve()
      .then(async () => {
        if (this.createdStale) {
          await this.refreshCreated();
          this.syncLinks();
        }
        for (const target of [...this.protect.keys()]) {
          this.protectExpired(target);
        }
      })
      .then(() => this.updateStatus())
      .catch((err) => this.logger.warn(`Background round failed: ${err.message}`));
  }

  persist() {
    if (this.persistTimer || this.dataUnreadable || !this.data) {
      return;
    }
    this.persistTimer = this.timers.setTimeout(() => {
      this.persistTimer = undefined;
      if (this.dataUnreadable) {
        return;
      }
      this.store
        .save(this.data)
        .catch((err) => this.logger.warn(`Could not save /data: ${err.message}`));
    }, this.timings.persistDelay);
  }

  warnOnce(key, message) {
    if (!this.warned.has(key)) {
      this.warned.add(key);
      this.logger.warn(message);
    }
  }

  // --- Known devices -----------------------------------------------------------

  get devices() {
    return Object.values(this.data?.devices ?? {});
  }

  /** Every zone of every known device: [{ device, zone, target }]. */
  get targets() {
    return this.devices.flatMap((device) =>
      device.zones.map((zone) => ({ device, zone, target: platformId(device, zone) })),
    );
  }

  /** The known device and zone of a Gladys device, or undefined. */
  targetOf(gladysDevice) {
    return this.targets.find(
      ({ device, zone }) => idsOf(this.gladys, device, zone).device === gladysDevice?.external_id,
    );
  }

  linkOf(device) {
    return this.links.get(addressKey(device));
  }

  connectedLink(device) {
    const link = this.linkOf(device);
    return link?.connected ? link : undefined;
  }

  /**
   * What is known of a zone: its state when connected, null when the
   * device does not answer, undefined when nothing is known yet (first
   * connection in progress, or a connection just lost).
   */
  zoneState(device, zone) {
    const link = this.linkOf(device);
    if (link?.connected) {
      return link.zones.has(zone) ? link.zoneState(zone) : undefined;
    }
    return link && link.lastError && !link.connected ? null : undefined;
  }

  /**
   * One link per typed address, per device with a zone created in Gladys,
   * and per device with a protective command pending. A device known in
   * /data but neither typed nor created gets no connection: the device
   * accepts a limited number of IP clients and closes the oldest one.
   */
  syncLinks({ retry = false } = {}) {
    if (!this.started || !this.data) {
      return;
    }
    const wanted = new Map();
    for (const address of this.config?.addresses ?? []) {
      wanted.set(addressKey(address), address);
    }
    for (const device of this.devices) {
      const used = device.zones.some((zone) => {
        const target = platformId(device, zone);
        return this.created.has(target) || this.protect.has(target);
      });
      if (used) {
        wanted.set(addressKey(device), { host: device.host, port: device.port });
      }
    }
    for (const [key, link] of this.links) {
      if (!wanted.has(key)) {
        link.stop();
        this.links.delete(key);
      }
    }
    for (const [key, address] of wanted) {
      const existing = this.links.get(key);
      if (existing) {
        if (retry) {
          existing.retrySoon();
        }
        continue;
      }
      const link = new DeviceLink({
        address,
        logger: this.logger,
        timings: this.timings,
        timers: this.timers,
        now: this.now,
        connect: this.connect,
        onEvent: (event, source, zone) => this.linkEvent(event, source, zone),
      });
      this.links.set(key, link);
      link.start();
    }
  }

  linkEvent(event, link, zone) {
    if (this.links.get(link.key) !== link || !this.data) {
      return;
    }
    const device = this.data.devices[deviceId(link)];
    if (event === 'identified') {
      const known = this.remember(link);
      if (known) {
        // Pending protective commands go first, before any state read.
        for (const z of known.zones) {
          this.sendProtect(platformId(known, z));
        }
      }
    } else if (event === 'up') {
      const known = this.remember(link);
      if (known) {
        this.logger.info(`${deviceName(known)} connected`);
        this.publishDevices().catch((err) =>
          this.logger.warn(`Could not publish the devices: ${err.message}`),
        );
        for (const z of known.zones) {
          const target = platformId(known, z);
          this.schedulePublish(target, 0);
          this.checkProtect(target);
          this.capInWakeWindow(known, z, link);
        }
      }
    } else if (event === 'inputs') {
      if (device && this.mergeInputs(device, this.linkInputs(link), { relabel: true })) {
        this.persist();
        this.publishDevices().catch(() => {});
      }
    } else if (event === 'update') {
      if (device && device.zones.includes(zone)) {
        const target = platformId(device, zone);
        this.schedulePublish(target);
        this.checkProtect(target);
        this.capInWakeWindow(device, zone, link);
      } else if (device && link.zones.has(zone)) {
        this.remember(link);
        this.publishDevices().catch(() => {});
      }
    } else if (event === 'failed' && device) {
      // The device known at this address does not answer: power 0.
      for (const z of device.zones) {
        this.schedulePublish(platformId(device, z), 0);
      }
    }
    this.updateStatus().catch(() => {});
  }

  linkInputs(link) {
    return [...link.inputs.entries()].map(([input, name]) => ({
      value: String(input),
      label: name,
    }));
  }

  /**
   * Remembers the device answering at the address of `link`: its model, its
   * zones (they only grow) and its input names.
   */
  remember(link) {
    const table = this.data.devices;
    const id = deviceId(link);
    let device = Object.hasOwn(table, id) ? table[id] : undefined;
    if (!device) {
      if (Object.keys(table).length >= LIMITS.devices) {
        this.warnOnce('devices', `More than ${LIMITS.devices} devices: the next ones are ignored`);
        return undefined;
      }
      device = { id, host: link.host, port: link.port, model: undefined, zones: [1], inputs: [] };
      table[id] = device;
      this.persist();
    }
    let changed = false;
    if (link.model && link.model !== device.model) {
      if (device.model) {
        this.logger.warn(
          `${addressKey(device)}: the model changed (${device.model} -> ${link.model})`,
        );
      }
      device.model = link.model;
      changed = true;
    }
    const zones = ZONES.filter((z) => device.zones.includes(z) || link.zones.has(z));
    if (zones.length !== device.zones.length) {
      device.zones = zones;
      changed = true;
    }
    if (this.mergeInputs(device, this.linkInputs(link), { relabel: true })) {
      changed = true;
    }
    if (changed) {
      this.persist();
    }
    return device;
  }

  /**
   * Inputs merged into a device: new numbers added, names updated when
   * `relabel` (the device gave them now). Never removed: a scene may use them.
   */
  mergeInputs(device, inputs, { relabel }) {
    let changed = false;
    const current = inputOptions(device);
    for (const { value, label } of inputs) {
      if (!isInputValue(value) || typeof label !== 'string' || label.trim() === '') {
        continue;
      }
      const existing = current.find((o) => o.value === value);
      if (!existing) {
        current.push({ value, label: label.trim().slice(0, 32) });
        changed = true;
      } else if (relabel && existing.label !== label.trim().slice(0, 32)) {
        existing.label = label.trim().slice(0, 32);
        changed = true;
      }
    }
    if (changed) {
      device.inputs = current.sort((a, b) => Number(a.value) - Number(b.value));
    }
    return changed;
  }

  /**
   * The inputs of the zones created in Gladys (`gladys.devices`, kept up to
   * date by the SDK), merged into the known device: inputs seen before a
   * reset of /data are never dropped from the created device.
   */
  mergeCreatedOptions(device) {
    const list = Array.isArray(this.gladys.devices) ? this.gladys.devices : [];
    for (const zone of device.zones) {
      const ids = idsOf(this.gladys, device, zone);
      const created = list.find((d) => d?.external_id === ids.device);
      const features = Array.isArray(created?.features) ? created.features : [];
      const feature = features.find((f) => f?.external_id === ids.feature(FEATURES.SOURCE));
      const options = Array.isArray(feature?.supported_options) ? feature.supported_options : [];
      if (
        this.mergeInputs(
          device,
          options.map((o) => ({ value: String(o?.value ?? ''), label: o?.label })),
          { relabel: false },
        )
      ) {
        this.persist();
      }
    }
  }

  async publishDevices() {
    if (!this.data) {
      return;
    }
    const devices = this.devices;
    devices.forEach((device) => this.mergeCreatedOptions(device));
    await this.gladys.publishDiscoveredDevices(
      this.targets.map(({ device, zone }) => buildDevice(this.gladys, device, zone)),
    );
  }

  /**
   * The zones created in Gladys. When `getDevices` fails, the list the SDK
   * keeps (`gladys.devices`) is used, and the call is made again at every
   * round until it works. A created zone missing from /data (reset or
   * unreadable) is known again from its external id: same address, same id.
   */
  async refreshCreated() {
    let list;
    try {
      list = await this.gladys.getDevices();
      this.createdStale = false;
    } catch (err) {
      this.createdStale = true;
      if (!Array.isArray(this.gladys.devices)) {
        throw err;
      }
      this.logger.warn(`Could not read the Gladys devices (${err.message}): using the last list`);
      list = this.gladys.devices;
    }
    const prefix = this.gladys.externalIds(DEVICE_TYPE, '').device;
    const created = new Set();
    for (const gladysDevice of Array.isArray(list) ? list : []) {
      const externalId = String(gladysDevice?.external_id ?? '');
      if (!externalId.startsWith(prefix)) {
        continue;
      }
      const target = parsePlatformId(externalId.slice(prefix.length));
      if (!target) {
        continue;
      }
      const id = deviceId(target);
      let device = this.data.devices[id];
      if (!device && Object.keys(this.data.devices).length < LIMITS.devices) {
        device = {
          id,
          host: target.host,
          port: target.port,
          model: undefined,
          zones: [1],
          inputs: [],
        };
        this.data.devices[id] = device;
        this.persist();
      }
      if (!device) {
        continue;
      }
      if (!device.zones.includes(target.zone)) {
        device.zones = ZONES.filter((z) => device.zones.includes(z) || z === target.zone);
        this.persist();
      }
      created.add(platformId(device, target.zone));
    }
    this.created = created;
  }

  // --- States --------------------------------------------------------------------

  /** The states of a zone, grouped: at most one publication per `publishDelay`. */
  schedulePublish(target, delay = this.timings.publishDelay) {
    if (this.publishTimers.has(target)) {
      if (delay > 0) {
        return;
      }
      this.timers.clearTimeout(this.publishTimers.get(target));
    }
    const generation = this.generation;
    const handle = this.timers.setTimeout(() => {
      this.publishTimers.delete(target);
      if (generation !== this.generation) {
        return;
      }
      const found = this.targets.find((t) => t.target === target);
      if (found) {
        this.publishStates(found.device, found.zone).catch(() => {});
      }
    }, delay);
    this.publishTimers.set(target, handle);
  }

  async publishStates(device, zone) {
    if (!this.created.has(platformId(device, zone))) {
      return;
    }
    const states = stateList(this.gladys, device, zone, this.zoneState(device, zone));
    if (states.length === 0) {
      return;
    }
    // 300 states a minute at most, all zones together: beyond, later.
    const now = this.now();
    this.published = this.published.filter((at) => now - at < 60_000);
    if (this.published.length + states.length > LIMITS.statesPerMinute) {
      this.schedulePublish(platformId(device, zone), 5_000);
      return;
    }
    this.published.push(...states.map(() => now));
    try {
      await this.gladys.publishChangedStates(states);
    } catch (err) {
      this.logger.warn(
        `Could not publish the states of ${deviceName(device, zone)}: ${err.message}`,
      );
    }
  }

  async publishAllStates() {
    for (const { device, zone } of this.targets) {
      await this.publishStates(device, zone);
    }
  }

  // --- Commands ------------------------------------------------------------------

  /** Validates a command before anything is queued or sent. */
  validate(device, key, value) {
    if (key === FEATURES.VOLUME) {
      const volume = parseVolumeCommand(value);
      if (volume === undefined) {
        throw new Error('Invalid volume: an integer from 0 to 100');
      }
      return volume;
    }
    if (key === FEATURES.SOURCE) {
      const input = parseInputCommand(value);
      if (input === undefined || !inputOptions(device).some((o) => o.value === String(input))) {
        throw new Error('Unknown source: nothing sent');
      }
      return input;
    }
    if (BUTTONS.has(key)) {
      return undefined;
    }
    throw new Error(`Feature "${short(key)}" cannot be commanded`);
  }

  epoch(target) {
    let epoch = this.epochs.get(target);
    if (!epoch) {
      epoch = { off: 0, mute: 0 };
      this.epochs.set(target, epoch);
    }
    return epoch;
  }

  async setValue(gladysDevice, feature, value) {
    const found = this.targetOf(gladysDevice);
    if (!found) {
      throw new Error('Unknown device: nothing sent');
    }
    const { device, zone } = found;
    const target = platformId(device, zone);
    const key = featureKey(gladysDevice.external_id, feature?.external_id);
    const checked = this.validate(device, key, value);
    // The budget runs from the request of Gladys, the wait in the queue included.
    const started = this.now();
    if (PROTECTIVE[key]) {
      return this.runProtective(device, zone, key, started);
    }
    let late = false;
    // Set just before a command leaves: from then on it may have reached the device.
    const context = { mayHaveSent: false };
    const epoch = { ...this.epoch(target) };
    const run = this.enqueue(target, async () => {
      if (late || this.remaining(started) < 50) {
        late = true;
        throw new DeviceError(ERROR_KINDS.BUDGET, 'No time left for this command, nothing sent');
      }
      return this.command(device, zone, key, checked, { started, context, epoch });
    });
    // Wall-clock timer (not the injectable timers): the ack Gladys waits for.
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(
        () => {
          late = true;
          reject(
            context.mayHaveSent
              ? new DeviceError(ERROR_KINDS.TIMEOUT, 'Sent, without confirmation from the device', {
                  sent: true,
                })
              : new DeviceError(
                  ERROR_KINDS.BUDGET,
                  'No time left for this command (device busy), nothing sent',
                ),
          );
        },
        Math.max(0, this.remaining(started)) + 100,
      );
    });
    run.catch(() => {});
    try {
      return await Promise.race([run, deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  remaining(started) {
    return this.timings.commandBudget - (this.now() - started);
  }

  /** The command queue of one zone: one command at a time. */
  enqueue(target, task) {
    let queue = this.queues.get(target);
    if (!queue) {
      queue = { running: false, items: [] };
      this.queues.set(target, queue);
    }
    return new Promise((resolve, reject) => {
      queue.items.push({ task, resolve, reject });
      this.drain(queue);
    });
  }

  async drain(queue) {
    if (queue.running) {
      return;
    }
    queue.running = true;
    while (queue.items.length > 0) {
      const item = queue.items.shift();
      try {
        item.resolve(await item.task());
      } catch (err) {
        item.reject(err);
      }
    }
    queue.running = false;
  }

  /**
   * Whether a command queued with `epoch` may still be sent: never after a
   * power off of its zone (nothing queued before a power off goes after
   * it), and an unmute never after a mute.
   */
  stillAllowed(target, epoch, key) {
    const now = this.epoch(target);
    return now.off === epoch.off && (key !== FEATURES.UNMUTE || now.mute === epoch.mute);
  }

  /**
   * Sends one command and waits for its ";". A command that may have
   * reached the device is never reported as "not sent".
   */
  async send(device, zone, link, request, { started, context, epoch, key, onWrite }) {
    const target = platformId(device, zone);
    try {
      // One request on the wire at a time: never longer than `requestTimeout`
      // (the device answers in 100 ms), so a power off never waits long.
      return await link.request(
        request,
        Math.min(this.timings.requestTimeout, this.remaining(started)),
        {
          urgent: true,
          beforeSend: () => this.stillAllowed(target, epoch, key),
          onWrite: (seq) => {
            context.mayHaveSent = true;
            onWrite?.(seq);
          },
        },
      );
    } catch (err) {
      if (err.kind === ERROR_KINDS.TIMEOUT || err.kind === ERROR_KINDS.CLOSED) {
        this.scheduleFollowUps(device, zone);
        throw new DeviceError(ERROR_KINDS.TIMEOUT, 'Sent, without confirmation from the device', {
          sent: true,
        });
      }
      if (err.kind === ERROR_KINDS.CANCELLED) {
        throw new DeviceError(err.kind, 'Overtaken by a power off or a mute: nothing sent');
      }
      if (err.kind === ERROR_KINDS.UNREACHABLE || err.kind === ERROR_KINDS.BUDGET) {
        throw new DeviceError(
          err.kind,
          err.kind === ERROR_KINDS.BUDGET
            ? 'No time left for this command, nothing sent'
            : `${deviceName(device, zone)} is not connected: nothing sent`,
        );
      }
      throw err;
    }
  }

  /**
   * One field of a zone read now (a query sent after the command). Returns
   * the value and the number of the query, or undefined when unread.
   */
  async read(link, zone, key, budget, options = {}) {
    if (!(budget > 0)) {
      return undefined;
    }
    try {
      const answer = await link.request(REQUESTS.query(zone, key), budget, options);
      return { value: parseZoneReport(answer.text)?.value, seq: answer.seq };
    } catch (err) {
      if (err.kind === ERROR_KINDS.REFUSED) {
        return { value: undefined, seq: 0, refused: err.code };
      }
      return undefined;
    }
  }

  /**
   * After a command: the field read again. Confirmed when the read shows
   * the value asked; otherwise "sent, not confirmed yet", and the zone is
   * read again later.
   */
  async confirm(device, zone, link, key, wanted, started) {
    const budget = Math.min(this.timings.preRead, this.remaining(started) - 50);
    const read = await this.read(link, zone, key, budget, { urgent: true });
    if (read && read.value === wanted) {
      return undefined;
    }
    this.scheduleFollowUps(device, zone);
    throw new DeviceError(
      ERROR_KINDS.TIMEOUT,
      read?.value === undefined
        ? 'Sent, without confirmation from the device'
        : 'Sent, not applied yet by the device',
      { sent: true },
    );
  }

  unconnected(device, zone) {
    return new DeviceError(
      ERROR_KINDS.UNREACHABLE,
      `${deviceName(device, zone)} is not connected (IP control in standby off, unplugged or unreachable): nothing sent`,
    );
  }

  async command(device, zone, key, value, { started, context, epoch }) {
    const target = platformId(device, zone);
    if (!this.stillAllowed(target, epoch, key)) {
      throw new DeviceError(
        ERROR_KINDS.CANCELLED,
        'Overtaken by a power off or a mute: nothing sent',
      );
    }
    const link = this.connectedLink(device);
    if (!link || !link.zones.has(zone)) {
      throw this.unconnected(device, zone);
    }
    const options = { started, context, epoch, key };
    switch (key) {
      case FEATURES.POWER_ON: {
        this.cancelWakeCheck(target);
        // However slow the wake-up, the first state that shows the zone on
        // above the cap within `wakeWindow` lowers it.
        this.wakeWindows.set(target, this.now() + this.timings.wakeWindow);
        await this.send(device, zone, link, REQUESTS.power(zone, true), {
          ...options,
          // A power on that left ends the resend of an earlier power off.
          onWrite: (seq) => {
            context.writeSeq = seq;
            this.dropProtect(target, FEATURES.POWER_OFF);
          },
        });
        // A zone wakes up at the volume it had (or the power-on volume of
        // the device): brought back to the cap, within this command first,
        // then in the background. The ack never depends on it.
        const done = await this.capVolume(device, zone, link, epoch, () =>
          Math.min(this.timings.preRead, this.remaining(started) - 100),
        ).catch(() => false);
        if (done) {
          this.wakeWindows.delete(target);
          return undefined;
        }
        this.capAfterWake(device, zone, epoch, 1);
        // Done only when a read after it shows the zone on.
        if (link.zoneState(zone).power === true && link.readSeq(zone, 'power') > context.writeSeq) {
          return undefined;
        }
        return this.confirm(device, zone, link, 'POW', true, started);
      }
      case FEATURES.VOLUME: {
        // The cap is read here, just before the command leaves: a
        // configuration saved while the command waited applies.
        const cap = this.maxVolume;
        const wanted = Math.min(value, cap);
        if (wanted < value) {
          this.logger.info(`${deviceName(device, zone)}: volume ${value}% capped to ${cap}%`);
        }
        await this.send(device, zone, link, REQUESTS.volume(zone, wanted), options);
        return this.confirm(device, zone, link, 'PVOL', wanted, started);
      }
      case FEATURES.UNMUTE: {
        // Unmuting never makes the zone play above the cap: the volume read
        // just now decides, and is lowered first when above it.
        const budget = Math.min(this.timings.preRead, this.remaining(started) - 200);
        const read = await this.read(link, zone, 'PVOL', budget, { urgent: true });
        if (!read || read.value === undefined) {
          throw new Error(
            read?.refused === 'Z' || read?.refused === 'I'
              ? `${deviceName(device, zone)} is off: nothing sent`
              : `${deviceName(device, zone)}: volume not read, nothing sent`,
          );
        }
        const cap = this.maxVolume;
        if (read.value > cap) {
          this.logger.info(
            `${deviceName(device, zone)}: volume ${read.value}% lowered to ${cap}% before unmuting`,
          );
          await this.send(device, zone, link, REQUESTS.volume(zone, cap), options);
          // Unmuted only once a read shows the volume at the cap or below.
          const check = await this.read(
            link,
            zone,
            'PVOL',
            Math.min(this.timings.preRead, this.remaining(started) - 200),
            { urgent: true },
          );
          if (check?.value === undefined || check.value > cap) {
            this.scheduleFollowUps(device, zone);
            throw new DeviceError(
              ERROR_KINDS.TIMEOUT,
              `${deviceName(device, zone)}: volume lowered, not confirmed: not unmuted`,
              { sent: true },
            );
          }
        }
        await this.send(device, zone, link, REQUESTS.mute(zone, false), {
          ...options,
          onWrite: () => this.dropProtect(target, FEATURES.MUTE),
        });
        return this.confirm(device, zone, link, 'MUT', false, started);
      }
      case FEATURES.SOURCE:
        await this.send(device, zone, link, REQUESTS.input(zone, value), options);
        return this.confirm(device, zone, link, 'INP', value, started);
      default:
        throw new Error(`Feature "${short(key)}" cannot be commanded`);
    }
  }

  // --- Protective commands (power off, mute) ---------------------------------------

  /**
   * A power off or a mute: never queued behind the other commands of the
   * zone (they are cancelled: nothing queued before it goes after it),
   * never blocked by the cap, the configuration or a state read, sent first
   * on the connection. Tried again every 250 ms within the budget while the
   * device is not connected; then kept (in /data too) and sent when the
   * connection comes back, within `protectHold`. Sent again (3 sends at
   * most) while a read made after it shows the zone still on (or unmuted).
   */
  async runProtective(device, zone, key, started) {
    const target = platformId(device, zone);
    const epoch = this.epoch(target);
    if (key === FEATURES.POWER_OFF) {
      epoch.off += 1;
      this.cancelWakeCheck(target);
      this.wakeWindows.delete(target);
    } else {
      epoch.mute += 1;
    }
    this.cancelQueued(target);
    this.setProtect(target, key);
    let sent = false;
    while (this.remaining(started) > 300) {
      const pending = this.protect.get(target);
      if (!pending || pending.kind !== key) {
        // Confirmed by a read, or overtaken by a newer command that left.
        return undefined;
      }
      const link = this.linkOf(device);
      if (!link?.ready) {
        await sleep(this.timers, 250);
        continue;
      }
      // At most one request on the wire before it (requestTimeout), then its own answer.
      const outcome = await this.sendProtectOnce(target, link, zone, key, () =>
        Math.min(2 * this.timings.requestTimeout, this.remaining(started) - 250),
      );
      if (outcome === 'done') {
        return undefined;
      }
      if (outcome === 'refused') {
        throw new DeviceError(ERROR_KINDS.REFUSED, 'Refused by the device', { sent: true });
      }
      if (outcome === 'sent') {
        sent = true;
        // The confirmation: a read sent after it.
        const read = await this.read(
          link,
          zone,
          PROTECTIVE[key].key,
          Math.min(this.timings.requestTimeout, this.remaining(started) - 100),
          { protective: true },
        );
        if (this.protectConfirmedBy(target, read)) {
          return undefined;
        }
        if (read?.value === undefined) {
          break;
        }
        // Read after it, still on (or unmuted): sent again while budget and sends are left.
        if (!this.sendsLeft(this.protect.get(target))) {
          break;
        }
        continue;
      }
      if (outcome === 'unsent') {
        await sleep(this.timers, 250);
      }
    }
    this.scheduleFollowUps(device, zone);
    throw new DeviceError(
      sent ? ERROR_KINDS.TIMEOUT : ERROR_KINDS.UNREACHABLE,
      sent
        ? 'Sent, without confirmation from the device: sent again if a later read shows it was not applied'
        : `${deviceName(device, zone)} is not connected: kept, sent when the connection comes back (2 minutes at most)`,
      { sent },
    );
  }

  /**
   * One send of the pending protective command of `target`. 'done' when
   * nothing is left to do (refused because the zone is off: nothing to
   * mute), 'refused' when the device answered an error, 'sent' when it left
   * (acked or not), 'unsent' when nothing left.
   */
  async sendProtectOnce(target, link, zone, key, budget) {
    const pending = this.protect.get(target);
    if (!pending || pending.kind !== key) {
      return 'done';
    }
    if (!this.sendsLeft(pending)) {
      return 'sent';
    }
    try {
      await link.request(PROTECTIVE[key].request(zone), budget(), {
        protective: true,
        onWrite: (seq) => {
          pending.sends += 1;
          pending.sentSeq = seq;
          this.saveProtect();
        },
      });
      return 'sent';
    } catch (err) {
      if (err.kind === ERROR_KINDS.REFUSED) {
        if (key === FEATURES.MUTE && (err.code === 'Z' || err.code === 'I')) {
          // The zone is off (or the device in standby): it plays nothing.
          this.clearProtect(target);
          return 'done';
        }
        this.logger.warn(`${target}: ${key} refused by the device (${err.message})`);
        this.clearProtect(target);
        return 'refused';
      }
      return err.sent ? 'sent' : 'unsent';
    }
  }

  /** Whether a pending protective command may be sent again (3 sends at most). */
  sendsLeft(pending) {
    return Boolean(pending) && pending.sends < this.timings.protectSends;
  }

  /** True (and the pending command cleared) when `read`, made after the last send, confirms it. */
  protectConfirmedBy(target, read) {
    const pending = this.protect.get(target);
    if (!pending) {
      return true;
    }
    if (!read || read.value === undefined || read.seq <= pending.sentSeq) {
      return false;
    }
    if (read.value === PROTECTIVE[pending.kind].wanted) {
      this.clearProtect(target);
      return true;
    }
    return false;
  }

  setProtect(target, key) {
    this.protect.set(target, {
      kind: key,
      at: this.now(),
      wallAt: this.wallNow(),
      // A new press restarts the count: the user asked again.
      sends: 0,
      sentSeq: 0,
    });
    this.saveProtect();
  }

  clearProtect(target) {
    if (this.protect.delete(target)) {
      this.saveProtect();
    }
  }

  /** A newer command of the target left: the resend of `kind` stops. */
  dropProtect(target, kind) {
    if (this.protect.get(target)?.kind === kind) {
      this.clearProtect(target);
    }
  }

  saveProtect() {
    if (!this.data) {
      return;
    }
    const table = Object.create(null);
    for (const [target, { kind, wallAt, sends }] of this.protect) {
      table[target] = { kind, at: wallAt, sends };
    }
    this.data.protect = table;
    this.persist();
  }

  /**
   * The pending protective commands of /data, back in memory after a
   * restart: their age from the wall clock (the only clock that survives a
   * restart); a date in the future or older than `protectHold` is dropped.
   */
  restoreProtect() {
    const wall = this.wallNow();
    for (const [target, entry] of Object.entries(this.data?.protect ?? {})) {
      if (this.protect.has(target)) {
        continue;
      }
      const age = wall - entry.at;
      if (age < 0 || age > this.timings.protectHold) {
        continue;
      }
      this.protect.set(target, {
        kind: entry.kind,
        at: this.now() - age,
        wallAt: entry.at,
        sends: entry.sends,
        sentSeq: 0,
      });
    }
    this.saveProtect();
  }

  /** Drops a pending command older than `protectHold`; true when dropped. */
  protectExpired(target) {
    const pending = this.protect.get(target);
    if (pending && this.now() - pending.at > this.timings.protectHold) {
      this.logger.info(`${target}: ${pending.kind} not confirmed, no longer sent again`);
      this.clearProtect(target);
      return true;
    }
    return false;
  }

  /** The connection came back (device identified): the pending command of `target` sent. */
  sendProtect(target) {
    const pending = this.protect.get(target);
    if (!pending || this.protectExpired(target) || this.protectSending.has(target)) {
      return;
    }
    const parsed = parsePlatformId(target);
    const device = parsed && this.data.devices[deviceId(parsed)];
    const link = device && this.linkOf(device);
    if (!link?.ready || !this.sendsLeft(pending)) {
      return;
    }
    this.protectSending.add(target);
    this.sendProtectOnce(target, link, parsed.zone, pending.kind, () => this.timings.requestTimeout)
      .catch(() => {})
      .finally(() => {
        this.protectSending.delete(target);
        this.scheduleFollowUps(device, parsed.zone);
      });
  }

  /**
   * A state of the zone changed: a pending protective command is confirmed
   * by a read made after its last send, or sent again when that read shows
   * it not applied. Reports the device sends by itself never decide (a
   * power on from the remote is not fought).
   */
  checkProtect(target) {
    const pending = this.protect.get(target);
    if (!pending || this.protectExpired(target)) {
      return;
    }
    const parsed = parsePlatformId(target);
    const device = parsed && this.data.devices[deviceId(parsed)];
    const link = device && this.linkOf(device);
    if (!link?.ready) {
      return;
    }
    if (pending.sends === 0) {
      this.sendProtect(target);
      return;
    }
    const { field, wanted } = PROTECTIVE[pending.kind];
    const state = link.zoneState(parsed.zone);
    if (
      field === 'mute' &&
      state.power === false &&
      link.readSeq(parsed.zone, 'power') > pending.sentSeq
    ) {
      // The zone was read off after the mute: it plays nothing.
      this.clearProtect(target);
      return;
    }
    if (link.readSeq(parsed.zone, field) <= pending.sentSeq) {
      return;
    }
    if (state[field] === wanted) {
      this.clearProtect(target);
    } else if (state[field] === !wanted) {
      this.sendProtect(target);
    }
  }

  /** Commands queued for a zone, cancelled by its power off or mute (never sent). */
  cancelQueued(target) {
    const queue = this.queues.get(target);
    if (!queue) {
      return;
    }
    for (const item of queue.items.splice(0)) {
      item.reject(
        new DeviceError(ERROR_KINDS.CANCELLED, 'Overtaken by a power off or a mute: nothing sent'),
      );
    }
  }

  // --- Follow-up reads and the cap after a power on --------------------------------

  /** A command not confirmed: the device read again 5 s and 20 s after it. */
  scheduleFollowUps(device, zone) {
    const target = platformId(device, zone);
    this.cancelFollowUps(target);
    const generation = this.generation;
    const timers = this.timings.followUps.map((delay) =>
      this.timers.setTimeout(() => {
        const link = this.connectedLink(device);
        if (generation === this.generation && link?.session) {
          link.readAll(link.session).catch(() => {});
        }
      }, delay),
    );
    this.followUps.set(target, timers);
  }

  cancelFollowUps(target) {
    for (const timer of this.followUps.get(target) ?? []) {
      this.timers.clearTimeout(timer);
    }
    this.followUps.delete(target);
  }

  /**
   * Reads the power and the volume of a zone, and lowers the volume to the
   * cap when the zone is on and above it. True when settled (lowered, or
   * nothing to lower), false when the device cannot tell yet (waking up).
   * Never after a power off of the zone.
   */
  async capVolume(device, zone, link, epoch, budget) {
    const target = platformId(device, zone);
    if (budget() <= 0 || !link.connected || !this.stillAllowed(target, epoch)) {
      return false;
    }
    const power = await this.read(link, zone, 'POW', budget(), { urgent: true });
    if (power?.value !== true || budget() <= 0) {
      return false;
    }
    const volume = await this.read(link, zone, 'PVOL', budget(), { urgent: true });
    if (volume?.value === undefined) {
      return false;
    }
    const cap = this.maxVolume;
    if (volume.value <= cap) {
      return true;
    }
    if (budget() <= 0) {
      return false;
    }
    this.logger.info(
      `${deviceName(device, zone)}: woke up at volume ${volume.value}%, lowered to ${cap}%`,
    );
    await link.request(REQUESTS.volume(zone, cap), budget(), {
      urgent: true,
      beforeSend: () => this.stillAllowed(target, epoch),
    });
    return true;
  }

  cancelWakeCheck(target) {
    const chain = this.wakeChecks.get(target);
    if (chain) {
      this.timers.clearTimeout(chain.timer);
      this.wakeChecks.delete(target);
    }
  }

  /** After a Power on: the cap checked again every `wakeCheckDelay`, `wakeChecks` times at most. */
  capAfterWake(device, zone, epoch, attempt, chain = { timer: undefined }) {
    const target = platformId(device, zone);
    if (attempt === 1) {
      this.cancelWakeCheck(target);
      this.wakeChecks.set(target, chain);
    }
    const current = () => this.wakeChecks.get(target) === chain;
    if (attempt > this.timings.wakeChecks) {
      this.wakeChecks.delete(target);
      this.logger.info(`${deviceName(device, zone)}: volume not confirmed after power on`);
      return;
    }
    const generation = this.generation;
    chain.timer = this.timers.setTimeout(() => {
      if (generation !== this.generation || !current()) {
        return;
      }
      this.enqueue(target, async () => {
        const link = this.connectedLink(device);
        if (!link || !current()) {
          return !current();
        }
        return this.capVolume(device, zone, link, epoch, this.deadline(this.timings.preRead));
      })
        .catch(() => false)
        .then((done) => {
          if (!current()) {
            return;
          }
          if (done) {
            this.wakeChecks.delete(target);
            this.wakeWindows.delete(target);
          } else {
            this.capAfterWake(device, zone, epoch, attempt + 1, chain);
          }
        });
    }, this.timings.wakeCheckDelay);
  }

  deadline(ms) {
    const end = this.now() + ms;
    return () => end - this.now();
  }

  /**
   * Within the window opened by a Power on of Gladys: the first state that
   * shows the zone on with its volume known closes it, after lowering the
   * volume to the cap (through the zone queue) when above.
   */
  capInWakeWindow(device, zone, link) {
    const target = platformId(device, zone);
    const until = this.wakeWindows.get(target);
    if (until === undefined) {
      return;
    }
    if (this.now() > until) {
      this.wakeWindows.delete(target);
      return;
    }
    const { power, volume } = link.zoneState(zone);
    if (power !== true || !Number.isInteger(volume) || this.wakeCapping.has(target)) {
      return;
    }
    if (volume <= this.maxVolume) {
      this.wakeWindows.delete(target);
      return;
    }
    this.wakeCapping.add(target);
    const generation = this.generation;
    const epoch = { ...this.epoch(target) };
    this.enqueue(target, async () => {
      const current = this.connectedLink(device);
      if (generation !== this.generation || !current || !this.wakeWindows.has(target)) {
        return false;
      }
      return this.capVolume(device, zone, current, epoch, this.deadline(this.timings.preRead));
    })
      .catch(() => false)
      .then((done) => {
        this.wakeCapping.delete(target);
        if (done) {
          this.wakeWindows.delete(target);
          this.cancelWakeCheck(target);
        }
      });
  }

  // --- Device lifecycle ------------------------------------------------------------

  async deviceCreated(gladysDevice) {
    const found = this.targetOf(gladysDevice);
    if (!found) {
      return;
    }
    const target = platformId(found.device, found.zone);
    this.created.add(target);
    this.syncLinks();
    // The SDK forgot what was published for this zone: its current state
    // again (only what the link knows now, never a remembered value).
    await this.publishStates(found.device, found.zone);
    await this.updateStatus();
  }

  async deviceDeleted(gladysDevice) {
    const found = this.targetOf(gladysDevice);
    if (found) {
      this.created.delete(platformId(found.device, found.zone));
      this.syncLinks();
      await this.updateStatus();
    }
  }

  // --- Configuration screen button -------------------------------------------------

  async checkDevices() {
    if (this.devices.length === 0) {
      return T.noDevice;
    }
    const lines = this.targets.map(({ device, zone }) =>
      T.checkLine(
        deviceName(device, zone),
        this.connectedLink(device) ? this.zoneState(device, zone) : null,
      ),
    );
    return T.check(lines, this.maxVolume);
  }

  // --- Status ------------------------------------------------------------------------

  /** The typed addresses where no Anthem device answers yet. */
  silentAddresses() {
    return (this.config?.addresses ?? [])
      .filter((a) => !Object.hasOwn(this.data.devices, deviceId(a)))
      .filter((a) => {
        const link = this.links.get(addressKey(a));
        return link && !link.connected && link.lastError;
      })
      .map(addressKey);
  }

  async updateStatus() {
    if (!this.started || !this.data) {
      return;
    }
    const notes = [];
    if (this.configUnread) {
      notes.push(T.configUnread);
    }
    if (this.dataUnreadable) {
      notes.push(T.dataUnreadable);
    } else if (this.store.corrupted) {
      notes.push(T.dataReset);
    }
    if (this.config?.invalid > 0) {
      notes.push(T.invalidEntries(this.config.invalid));
    }
    const silent = this.silentAddresses();
    if (silent.length > 0) {
      notes.push(T.noAnswerAt(silent));
    }
    const off = this.devices
      .filter(
        (d) =>
          d.zones.some((z) => this.created.has(platformId(d, z))) && this.zoneState(d, 1) === null,
      )
      .map((d) => deviceName(d));
    if (off.length > 0) {
      notes.push(T.unreachable(off));
    }
    // A local integration without an account: "connected" means running; what
    // does not answer is said in the message.
    const status = { connected: true };
    if (notes.length > 0) {
      status.message = {
        en: notes.map((n) => n.en).join(' '),
        fr: notes.map((n) => n.fr).join(' '),
      };
    }
    const key = JSON.stringify(status);
    if (key === this.lastStatus) {
      return;
    }
    try {
      await this.gladys.setConnectionStatus(status.connected, status.message);
      this.lastStatus = key;
    } catch (err) {
      this.logger.warn(`Could not publish the status: ${err.message}`);
    }
  }
}
