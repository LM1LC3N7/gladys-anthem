// -----------------------------------------------------------------------------
// End to end: the fake Gladys of the SDK, the handlers of the container, the
// fake Anthem device on the loopback interface. Devices, states, commands,
// the volume cap, the status and the "Check" button.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInputCommand, parseVolumeCommand } from '../src/app.js';
import { MemoryStore } from '../src/store.js';
import { createDevice, discovered, press, settle, setup, waitFor } from './helpers/app.js';

test('a typed address becomes one Gladys device per zone; states once created', async (t) => {
  const { gladys, id, fake } = await setup(t);
  const zone1 = await discovered(gladys, id, 1);
  const zone2 = await discovered(gladys, id, 2);
  assert.match(zone1.name, /^Anthem MRX 1140 \(127\.0\.0\.1:\d+\)$/);
  assert.match(zone2.name, /^Anthem MRX 1140 \(127\.0\.0\.1:\d+\) - Zone 2$/);
  assert.deepEqual(zone1.params, [
    { name: 'IP_ADDRESS', value: '127.0.0.1' },
    { name: 'ZONE', value: '1' },
  ]);
  assert.deepEqual(
    zone1.features.map((f) => f.external_id.slice(id(1).length + 1)),
    ['power', 'power_on', 'power_off', 'volume', 'muted', 'mute', 'unmute', 'source'],
  );
  assert.deepEqual(
    zone1.features.find((f) => f.external_id === id(1, 'source')).supported_options,
    [
      { value: '1', label: 'Blu-ray' },
      { value: '2', label: 'TV' },
      { value: '3', label: 'Turntable' },
    ],
  );
  // Nothing is published before the device is created.
  assert.equal(gladys.fake.lastState(id(1, 'power')), undefined);
  await createDevice(gladys, id, 1);
  await waitFor(() => gladys.fake.lastState(id(1, 'source')) === '1', 'the source');
  assert.equal(gladys.fake.lastState(id(1, 'power')), 1);
  assert.equal(gladys.fake.lastState(id(1, 'volume')), 30);
  assert.equal(gladys.fake.lastState(id(1, 'muted')), 0);
  // Zone 2 is off: power 0, nothing else (unknown while off).
  await createDevice(gladys, id, 2);
  assert.equal(gladys.fake.lastState(id(2, 'power')), 0);
  assert.equal(gladys.fake.lastState(id(2, 'volume')), undefined);
  // The device was only read: no command written.
  assert.deepEqual(
    fake.commands.filter((c) => !c.endsWith('?')),
    [],
  );
});

test('a model without zone 2 gets one Gladys device', async (t) => {
  const { gladys, id, app } = await setup(t, { fakeOptions: { model: 'MRX 540', zone2: false } });
  await discovered(gladys, id, 1);
  await settle(60);
  assert.equal(gladys.fake.discoveredDevices.length, 1);
  assert.deepEqual(app.devices[0].zones, [1]);
});

test('something that does not answer as an Anthem device is never a device', async (t) => {
  const { gladys, fake, app } = await setup(t);
  fake.override.set('IDM?', 'HELLO');
  await app.links.values().next().value.stop();
  app.links.clear();
  app.data.devices = Object.create(null);
  app.syncLinks();
  await settle(120);
  assert.equal(app.devices.length, 0);
  assert.ok(gladys.fake.discoveredDevices.length <= 2);
});

test('volume: capped by the option, read when sent; invalid values never sent', async (t) => {
  const { gladys, id, fake } = await setup(t, {
    config: { addresses: 'x', max_volume: 40 },
    connect: false,
  });
  gladys.fake.config = { addresses: `127.0.0.1:${fake.port}`, max_volume: 40 };
  await gladys.connect();
  const device = await createDevice(gladys, id, 1);
  let ack = await press(gladys, device, 'volume', 80);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(fake.writes('Z1PVOL'), ['Z1PVOL40']);
  ack = await press(gladys, device, 'volume', 25);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(fake.writes('Z1PVOL'), ['Z1PVOL40', 'Z1PVOL25']);
  for (const bad of ['', '12abc', 12.5, -1, 101, '1e2', ' ']) {
    ack = await press(gladys, device, 'volume', bad);
    assert.equal(ack.success, false, `${JSON.stringify(bad)} refused`);
  }
  assert.deepEqual(fake.writes('Z1PVOL'), ['Z1PVOL40', 'Z1PVOL25']);
  // The cap saved in the configuration applies to the next command.
  await gladys.fake.configUpdated({ addresses: `127.0.0.1:${fake.port}`, max_volume: 20 });
  ack = await press(gladys, device, 'volume', 25);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(fake.writes('Z1PVOL').at(-1), 'Z1PVOL20');
});

test('volume and command parsing are strict', () => {
  assert.equal(parseVolumeCommand(0), 0);
  assert.equal(parseVolumeCommand('100'), 100);
  assert.equal(parseVolumeCommand(' 7 '), 7);
  for (const bad of [null, undefined, '', true, 12.5, '12abc', 101, -1, '0x10', NaN, '1 2']) {
    assert.equal(parseVolumeCommand(bad), undefined, String(bad));
  }
  assert.equal(parseInputCommand('3'), 3);
  assert.equal(parseInputCommand(30), 30);
  for (const bad of [0, 31, '', '03x', 1.5, null, '-1']) {
    assert.equal(parseInputCommand(bad), undefined, String(bad));
  }
});

test('a volume not applied by the device is not reported as done', async (t) => {
  const { gladys, id, fake } = await setup(t);
  const device = await createDevice(gladys, id, 1);
  // Acked, but the device keeps its volume (a maximum volume set on it).
  fake.override.set('Z1PVOL35', () => ';');
  const ack = await press(gladys, device, 'volume', 35);
  assert.equal(ack.success, false);
  assert.match(ack.error, /not applied yet/);
});

test('unmute: a volume above the cap is lowered first; unknown volume: nothing sent', async (t) => {
  const { gladys, id, fake } = await setup(t, {
    fakeOptions: { volume: { 1: 70, 2: 10 }, mute: { 1: true, 2: false } },
  });
  const device = await createDevice(gladys, id, 1);
  let ack = await press(gladys, device, 'unmute');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(
    fake.commands.filter((c) => !c.endsWith('?')),
    ['Z1PVOL40', 'Z1MUT0'],
  );
  // The volume answered with an error ("!E"): unknown, not unmuted.
  fake.override.set('Z1PVOL?', (cmd) => `!E${cmd};`);
  ack = await press(gladys, device, 'unmute');
  assert.equal(ack.success, false);
  assert.match(ack.error, /volume not read, nothing sent/);
  assert.deepEqual(fake.writes('Z1MUT'), ['Z1MUT0']);
  fake.override.delete('Z1PVOL?');
  // The device acks the lowering but keeps its volume: not unmuted.
  fake.zones[1].mute = true;
  fake.zones[1].volume = 70;
  fake.override.set('Z1PVOL40', () => ';');
  ack = await press(gladys, device, 'unmute');
  assert.equal(ack.success, false);
  assert.match(ack.error, /not unmuted/);
  assert.deepEqual(fake.writes('Z1MUT'), ['Z1MUT0']);
  fake.override.delete('Z1PVOL40');
  fake.override.set('Z1PVOL?', 'silent');
  ack = await press(gladys, device, 'unmute');
  assert.equal(ack.success, false);
  assert.match(ack.error, /volume not read, nothing sent/);
  assert.deepEqual(fake.writes('Z1MUT'), ['Z1MUT0']);
  assert.equal(fake.zones[1].mute, true);
});

test('source: an input of the list, by its number; anything else refused', async (t) => {
  const { gladys, id, fake } = await setup(t);
  const device = await createDevice(gladys, id, 1);
  let ack = await press(gladys, device, 'source', '3');
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(fake.writes('Z1INP'), ['Z1INP3']);
  for (const bad of ['9', 'TV', '', '3;Z1POW1']) {
    ack = await press(gladys, device, 'source', bad);
    assert.equal(ack.success, false, bad);
  }
  assert.deepEqual(fake.writes('Z1INP'), ['Z1INP3']);
  await waitFor(() => gladys.fake.lastState(id(1, 'source')) === '3', 'the new source');
});

test('power on brings a volume above the cap back to it', async (t) => {
  const { gladys, id, fake } = await setup(t, {
    fakeOptions: { power: { 1: false, 2: false }, volume: { 1: 90, 2: 10 } },
  });
  const device = await createDevice(gladys, id, 1);
  assert.equal(gladys.fake.lastState(id(1, 'power')), 0);
  const ack = await press(gladys, device, 'power_on');
  assert.equal(ack.success, true, ack.error);
  await waitFor(() => fake.zones[1].volume === 40, 'the volume capped');
  assert.deepEqual(fake.writes('Z1'), ['Z1POW1', 'Z1PVOL40']);
});

test('power on of a slow device: the volume is capped once it can be read', async (t) => {
  const { gladys, id, fake } = await setup(t, {
    fakeOptions: { power: { 1: false, 2: false }, volume: { 1: 90, 2: 10 } },
  });
  const device = await createDevice(gladys, id, 1);
  // Waking up: the volume cannot be read for a while.
  fake.override.set('Z1PVOL?', (cmd) => `!E${cmd};`);
  const ack = await press(gladys, device, 'power_on');
  assert.equal(ack.success, true, ack.error);
  await settle(80);
  assert.equal(fake.zones[1].volume, 90);
  fake.override.delete('Z1PVOL?');
  await waitFor(() => fake.zones[1].volume === 40, 'the volume capped later');
});

test('check button: each zone with its state, and the cap', async (t) => {
  const { gladys, id } = await setup(t, { fakeOptions: { mute: { 1: true, 2: false } } });
  await createDevice(gladys, id, 1);
  const ack = await gladys.fake.action('check_devices');
  assert.equal(ack.success, true, ack.error);
  const { en, fr } = ack.data.message;
  assert.match(en, /MRX 1140 \(127\.0\.0\.1:\d+\): connected, on, volume 30%, muted/);
  assert.match(en, /Zone 2: connected, off/);
  assert.match(en, /Volume cap: 40%/);
  assert.match(fr, /connectée, allumée, volume 30 %, en sourdine/);
});

test('the status says which address does not answer; invalid entries are counted, never shown', async (t) => {
  const { gladys } = await setup(t, {
    config: { addresses: '127.0.0.1:1, 300.1.1.1, <script>' },
  });
  await waitFor(
    () =>
      /No Anthem device answers yet at: 127\.0\.0\.1:1/.test(
        gladys.fake.connectionStatus?.message?.en ?? '',
      ),
    'the silent address in the status',
  );
  const message = gladys.fake.connectionStatus.message;
  assert.match(message.en, /2 invalid addresses ignored/);
  assert.match(message.fr, /2 adresses invalides ignorées/);
  assert.doesNotMatch(JSON.stringify(message), /script|300\.1/);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('five zones on slow devices, one scene: all set; a silent device stops none', async (t) => {
  const fakes = [];
  const { startFakeAnthem } = await import('./fixtures/fakeAnthem.js');
  for (let i = 0; i < 5; i += 1) {
    const fake = await startFakeAnthem({ zone2: false, latencyMs: 120 });
    t.after(() => fake.close());
    fakes.push(fake);
  }
  const addresses = fakes.map((f) => `127.0.0.1:${f.port}`).join(', ');
  const { gladys, app } = await setup(t, {
    config: { addresses: `${addresses}, 127.0.0.1:1` },
    timings: { requestTimeout: 600, preRead: 600 },
  });
  await waitFor(() => app.devices.length === 5, 'five devices', 5_000);
  await waitFor(() => gladys.fake.discoveredDevices.length === 5, 'five published', 5_000);
  await waitFor(
    () => [...app.links.values()].filter((l) => l.connected).length === 5,
    'five connected',
    5_000,
  );
  for (const device of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(device);
  }
  const devices = gladys.fake.discoveredDevices.filter((d) => !d.external_id.includes('_1_z'));
  const acks = await Promise.all(devices.map((d) => press(gladys, d, 'volume', 22)));
  assert.equal(acks.filter((a) => a.success).length, devices.length, JSON.stringify(acks));
  for (const fake of fakes) {
    assert.equal(fake.zones[1].volume, 22);
  }
});

test('deleted from Gladys and no longer typed: the connection is closed', async (t) => {
  const { gladys, id, fake, app } = await setup(t);
  const device = await createDevice(gladys, id, 1);
  await gladys.fake.configUpdated({ addresses: '' });
  assert.equal(app.links.size, 1, 'kept while created');
  await gladys.fake.deviceDeleted(device);
  assert.equal(app.links.size, 0);
  await waitFor(() => fake.device.open === 0, 'the connection closed');
});

test('a restart keeps the known devices and their inputs', async (t) => {
  const store = new MemoryStore();
  const first = await setup(t, { store });
  await discovered(first.gladys, first.id, 2);
  await first.app.stop();
  assert.ok(store.data.devices[`127.0.0.1_${first.fake.port}`]);
  assert.deepEqual(store.data.devices[`127.0.0.1_${first.fake.port}`].zones, [1, 2]);
  assert.equal(store.data.devices[`127.0.0.1_${first.fake.port}`].inputs.length, 3);
});
