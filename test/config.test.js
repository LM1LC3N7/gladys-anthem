// -----------------------------------------------------------------------------
// The configuration and /data: strict parsing, nothing unsafe kept.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  normalizeConfig,
  parseAddress,
  parseMaxVolume,
  parsePlatformId,
  platformId,
} from '../src/config.js';
import { FileStore, sanitizeData } from '../src/store.js';

test('addresses: IPv4 with an optional port; never broadcast, multicast or 0.0.0.0', () => {
  assert.deepEqual(parseAddress('192.168.1.40'), { host: '192.168.1.40', port: 14999 });
  assert.deepEqual(parseAddress(' tcp://192.168.1.40:15000/ '), {
    host: '192.168.1.40',
    port: 15000,
  });
  for (const bad of [
    '',
    'anthem.local',
    '192.168.1.400',
    '192.168.1.40:0',
    '192.168.1.40:70000',
    '0.0.0.0',
    '255.255.255.255',
    '224.0.0.1',
    '239.1.2.3',
    '192.168.1.40\u0000',
    '[::1]',
    undefined,
  ]) {
    assert.equal(parseAddress(bad), undefined, String(bad));
  }
  const config = normalizeConfig({
    addresses: '192.168.1.40, 192.168.1.40:14999; 10.0.0.2:15000 nope',
    max_volume: '55',
  });
  assert.deepEqual(config.addresses, [
    { host: '192.168.1.40', port: 14999 },
    { host: '10.0.0.2', port: 15000 },
  ]);
  assert.equal(config.invalid, 1);
  assert.equal(config.maxVolume, 55);
});

test('the volume cap: 1..100, rounded down, anything unreadable gives 40', () => {
  assert.equal(parseMaxVolume(40.9), 40);
  assert.equal(parseMaxVolume(0), 1);
  assert.equal(parseMaxVolume(250), 100);
  for (const bad of [null, undefined, '', ' ', 'abc', true, NaN, Infinity]) {
    assert.equal(parseMaxVolume(bad), 40, String(bad));
  }
  assert.equal(normalizeConfig({}).maxVolume, 40);
});

test('platform ids: exact, and read back', () => {
  const id = platformId({ host: '10.0.0.2', port: 14999 }, 2);
  assert.equal(id, '10.0.0.2_14999_z2');
  assert.deepEqual(parsePlatformId(id), { host: '10.0.0.2', port: 14999, zone: 2 });
  for (const bad of [
    '10.0.0.2_14999_z3',
    '10.0.0.2_14999',
    '10.0.0.2_014999_z1',
    'x_1_z1',
    '0.0.0.0_1_z1',
  ]) {
    assert.equal(parsePlatformId(bad), undefined, bad);
  }
});

test('/data: only valid devices, zones, inputs and pending commands kept; no prototype', () => {
  const data = sanitizeData(
    JSON.parse(`{
      "maxVolume": "70.5",
      "devices": {
        "10.0.0.2_14999": { "host": "10.0.0.2", "port": 14999, "model": "MRX\\u0000 740", "zones": [1, 2, 3],
          "inputs": [{ "value": "2", "label": " TV " }, { "value": "0", "label": "x" }, { "value": "2", "label": "dup" },
                     { "value": "31", "label": "x" }, { "value": "1", "label": "\\u0001" }] },
        "10.0.0.3_14999": { "host": "10.0.0.9", "port": 14999 },
        "__proto__": { "host": "10.0.0.4", "port": 14999 }
      },
      "protect": {
        "10.0.0.2_14999_z1": { "kind": "power_off", "at": 1000, "sends": 1 },
        "10.0.0.2_14999_z3": { "kind": "power_off", "at": 1000, "sends": 1 },
        "10.0.0.2_14999_z2": { "kind": "power_on", "at": 1000, "sends": 0 }
      }
    }`),
  );
  assert.equal(data.maxVolume, 70);
  assert.deepEqual(Object.keys(data.devices), ['10.0.0.2_14999']);
  assert.equal(Object.getPrototypeOf(data.devices), null);
  const device = data.devices['10.0.0.2_14999'];
  assert.equal(device.model, 'MRX 740');
  assert.deepEqual(device.zones, [1, 2]);
  assert.deepEqual(device.inputs, [
    { value: '1', label: 'Input 1' },
    { value: '2', label: 'TV' },
  ]);
  assert.deepEqual(Object.keys(data.protect), ['10.0.0.2_14999_z1']);
  assert.equal({}.host, undefined);
});

test('the file store: missing is empty, not JSON moved aside, unreadable throws', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'anthem-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new FileStore({ dir });
  assert.deepEqual(Object.keys((await store.load()).devices), []);
  await store.save({ devices: {}, maxVolume: 30, protect: {} });
  assert.equal((await store.load()).maxVolume, 30);
  await writeFile(join(dir, 'anthem.json'), '{not json');
  assert.deepEqual(Object.keys((await store.load()).devices), []);
  assert.equal(store.corrupted, true);
  assert.equal(await readFile(join(dir, 'anthem.json.bad'), 'utf8'), '{not json');
  if (process.getuid?.() !== 0) {
    const locked = new FileStore({ dir });
    await writeFile(join(dir, 'anthem.json'), '{}');
    await chmod(join(dir, 'anthem.json'), 0o000);
    await assert.rejects(locked.load(), (err) => err.code === 'EACCES');
    assert.equal(locked.corrupted, false);
    await chmod(join(dir, 'anthem.json'), 0o600);
  }
});
