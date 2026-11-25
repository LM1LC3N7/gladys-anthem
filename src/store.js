// -----------------------------------------------------------------------------
// What the integration keeps across restarts, in /data (the one writable
// volume, file mode 0600): the known devices by id (`<host>_<port>`), their
// model, their zones and input names (they only grow), the last volume cap
// read from the configuration (used while the configuration cannot be read),
// and the protective commands (power off, mute) not confirmed yet. No
// secret: the Anthem protocol has none.
//
// The tables have no prototype, and a key that is not the id of a valid
// address is never kept.
// -----------------------------------------------------------------------------

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cleanText } from './anthem/protocol.js';
import { deviceId, parseAddress, parseMaxVolume, parsePlatformId } from './config.js';
import { LIMITS, MAX_INPUTS, ZONES } from './constants.js';

export const emptyData = () => ({
  devices: Object.create(null),
  maxVolume: undefined,
  protect: Object.create(null),
});

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** An option value of the source dropdown: an input number 1..30 as a string. */
export const isInputValue = (value) =>
  typeof value === 'string' && /^[1-9]\d?$/.test(value) && Number(value) <= MAX_INPUTS;

export const PROTECTIVE_KINDS = Object.freeze(['power_off', 'mute']);

function sanitizeInputs(inputs) {
  const seen = new Set();
  const result = [];
  for (const option of Array.isArray(inputs) ? inputs.slice(0, MAX_INPUTS * 4) : []) {
    if (isObject(option) && isInputValue(option.value) && !seen.has(option.value)) {
      seen.add(option.value);
      result.push({
        value: option.value,
        label: cleanText(option.label, 32) ?? `Input ${option.value}`,
      });
    }
  }
  return result.sort((a, b) => Number(a.value) - Number(b.value));
}

function sanitize(data) {
  const base = emptyData();
  if (!isObject(data)) {
    return base;
  }
  if (data.maxVolume !== undefined && data.maxVolume !== null) {
    base.maxVolume = parseMaxVolume(data.maxVolume);
  }
  const devices = isObject(data.devices) ? data.devices : {};
  for (const [id, device] of Object.entries(devices).slice(0, LIMITS.devices)) {
    if (!isObject(device)) {
      continue;
    }
    const address = parseAddress(`${device.host}:${device.port}`);
    if (!address || deviceId(address) !== id) {
      continue;
    }
    base.devices[id] = {
      id,
      host: address.host,
      port: address.port,
      model: cleanText(device.model),
      zones: ZONES.filter(
        (zone) => zone === 1 || (Array.isArray(device.zones) && device.zones.includes(zone)),
      ),
      inputs: sanitizeInputs(device.inputs),
    };
  }
  const protect = isObject(data.protect) ? data.protect : {};
  for (const [key, entry] of Object.entries(protect).slice(0, LIMITS.devices * ZONES.length)) {
    const target = parsePlatformId(key);
    if (
      target &&
      isObject(entry) &&
      PROTECTIVE_KINDS.includes(entry.kind) &&
      Number.isFinite(entry.at) &&
      Number.isInteger(entry.sends) &&
      entry.sends >= 0
    ) {
      base.protect[key] = { kind: entry.kind, at: entry.at, sends: entry.sends };
    }
  }
  return base;
}

export class FileStore {
  constructor({ dir = process.env.DATA_DIR || '/data', name = 'anthem.json' } = {}) {
    this.dir = dir;
    this.path = join(dir, name);
    /** The file was not JSON: moved aside to `.bad`, the app says so. */
    this.corrupted = false;
  }

  /**
   * The saved data. A missing file gives empty data. A file that is not
   * JSON is moved aside to `anthem.json.bad` (`corrupted` set). A file that
   * cannot be read (permissions, I/O error) throws: the app never takes it
   * for an empty one and never writes over it.
   */
  async load() {
    let text;
    try {
      text = await readFile(this.path, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') {
        return emptyData();
      }
      throw err;
    }
    try {
      return sanitize(JSON.parse(text));
    } catch {
      this.corrupted = true;
      const bad = `${this.path}.bad`;
      await rename(this.path, bad).catch(() => {});
      await chmod(bad, 0o600).catch(() => {});
      return emptyData();
    }
  }

  async save(data) {
    await mkdir(this.dir, { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

/** For the tests: `failLoad` / `failSave` make the next calls throw. */
export class MemoryStore {
  constructor(data = emptyData()) {
    this.data = JSON.parse(JSON.stringify(data));
    this.saves = 0;
    this.loads = 0;
    this.corrupted = false;
    this.failLoad = 0;
    this.failSave = 0;
  }

  async load() {
    this.loads += 1;
    if (this.failLoad > 0) {
      this.failLoad -= 1;
      throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
    }
    return sanitize(JSON.parse(JSON.stringify(this.data)));
  }

  async save(data) {
    if (this.failSave > 0) {
      this.failSave -= 1;
      throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
    }
    // Through JSON, as the file store: what a restart would read back.
    this.data = JSON.parse(JSON.stringify(data));
    this.saves += 1;
  }
}

export { sanitize as sanitizeData };
