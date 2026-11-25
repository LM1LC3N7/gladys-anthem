// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form.
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { DEFAULT_PORT, LIMITS, MAX_VOLUME, ZONES } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULT_CONFIG = {
  addresses: '',
  max_volume: MAX_VOLUME.default,
};

/**
 * The address of a device typed by the user: an IPv4 address, with an
 * optional port (14999 by default; a pasted URL is reduced to its host and
 * port).
 * @returns {{ host: string, port: number } | undefined} undefined when invalid or empty.
 */
export function parseAddress(raw) {
  const text = String(raw ?? '')
    .trim()
    .replace(/^(?:https?|tcp):\/\//i, '')
    .replace(/[/?#].*$/, '')
    .toLowerCase();
  if (text === '' || text.length > 260) {
    return undefined;
  }
  const match = text.match(/^([^:]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    return undefined;
  }
  // IPv4 only: the address is the identity of a device, and a host name
  // next to its IP address would give the same device twice. Never the
  // "this network", broadcast or multicast addresses.
  if (isIP(host) !== 4) {
    return undefined;
  }
  const [a] = host.split('.').map(Number);
  if (a === 0 || a >= 224 || host === '255.255.255.255') {
    return undefined;
  }
  return { host, port };
}

export const addressKey = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}:${port}`);

/**
 * The id of the device at an address: the Anthem protocol gives no serial
 * number over IP in standby, so the address is the identity.
 */
export const deviceId = ({ host, port }) => `${host}_${port}`;

/** The platform id of one zone of a device (the external id of its Gladys device). */
export const platformId = (address, zone) => `${deviceId(address)}_z${zone}`;

/** The address and zone of a platform id, or undefined. */
export function parsePlatformId(id) {
  const match = /^(\d{1,3}(?:\.\d{1,3}){3})_(\d{1,5})_z(\d)$/.exec(String(id ?? ''));
  if (!match) {
    return undefined;
  }
  const address = parseAddress(`${match[1]}:${match[2]}`);
  const zone = Number(match[3]);
  if (!address || !ZONES.includes(zone) || platformId(address, zone) !== id) {
    return undefined;
  }
  return { ...address, zone };
}

/** The volume cap: an integer 1..100; anything unreadable gives the default. */
export function parseMaxVolume(raw) {
  const value = typeof raw === 'string' && raw.trim() === '' ? NaN : Number(raw);
  if (raw === null || raw === undefined || typeof raw === 'boolean' || !Number.isFinite(value)) {
    return MAX_VOLUME.default;
  }
  // Rounded down: a cap of 40.7 never lets 41 through.
  return Math.min(MAX_VOLUME.max, Math.max(MAX_VOLUME.min, Math.floor(value)));
}

export function normalizeConfig(raw = {}) {
  const c = {
    ...DEFAULT_CONFIG,
    ...Object.fromEntries(Object.entries(raw ?? {}).filter(([, v]) => v != null)),
  };
  const addresses = [];
  const invalid = [];
  for (const entry of String(c.addresses ?? '')
    .split(/[\s,;]+/)
    .filter((e) => e !== '')) {
    const address = parseAddress(entry);
    if (!address) {
      invalid.push(entry);
    } else if (
      !addresses.some((a) => addressKey(a) === addressKey(address)) &&
      addresses.length < LIMITS.addresses
    ) {
      addresses.push(address);
    }
  }
  // Only the number of invalid entries is kept: an invalid entry is never shown again.
  return { addresses, invalid: invalid.length, maxVolume: parseMaxVolume(c.max_volume) };
}
