// -----------------------------------------------------------------------------
// Power off and Mute: never blocked (queue, cap, configuration, /data, a
// stalled request, a full queue, a restart), nothing queued before them goes
// after them, kept and sent again while not confirmed, never fighting a
// change the device reports by itself.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { buildDevice } from '../src/model.js';
import { MemoryStore, emptyData } from '../src/store.js';
import { SELECTOR, createDevice, press, settle, setup, waitFor } from './helpers/app.js';
import { startFakeAnthem } from './fixtures/fakeAnthem.js';

const linkOf = (app) => [...app.links.values()][0];

test('power off while a command is stuck: sent next; the commands waiting are cancelled', async (t) => {
  const { gladys, id, fake } = await setup(t);
  const device = await createDevice(gladys, id, 1);
  fake.override.set('Z1PVOL35', 'silent');
  const stuck = press(gladys, device, 'volume', 35);
  await waitFor(() => fake.commands.includes('Z1PVOL35'), 'the stuck command on the wire');
  const order = [];
  stuck.then(() => order.push('stuck'));
  const waiting = press(gladys, device, 'volume', 36);
  waiting.then(() => order.push('waiting'));
  const source = press(gladys, device, 'source', '2');
  const off = await press(gladys, device, 'power_off');
  assert.equal(off.success, true, off.error);
  assert.equal(fake.zones[1].power, false);
  const acks = await Promise.all([stuck, waiting, source]);
  assert.equal(acks[0].success, false);
  assert.match(acks[1].error, /power off or a mute: nothing sent/);
  assert.match(acks[2].error, /power off or a mute: nothing sent/);
  // Cancelled at once by the power off, not after the stuck command.
  assert.deepEqual(order, ['waiting', 'stuck']);
  await settle(100);
  assert.equal(fake.writes('Z1PVOL36').length, 0);
  assert.equal(fake.writes('Z1INP').length, 0);
  // Nothing written after the power off.
  const writes = fake.commands.filter((c) => !c.endsWith('?'));
  assert.equal(writes.at(-1), 'Z1POW0');
});

test('power off and mute never depend on the cap nor on a readable configuration', async (t) => {
  const { gladys, id, fake, app } = await setup(t, {
    config: { addresses: 'x', max_volume: 1 },
    connect: false,
  });
  gladys.fake.config = { addresses: `127.0.0.1:${fake.port}`, max_volume: 1 };
  await gladys.connect();
  const device = await createDevice(gladys, id, 1);
  // The configuration cannot be read any more (Gladys busy).
  gladys.getConfig = async () => {
    throw new Error('503');
  };
  await app.connected();
  let ack = await press(gladys, device, 'mute');
  assert.equal(ack.success, true, ack.error);
  assert.equal(fake.zones[1].mute, true);
  ack = await press(gladys, device, 'power_off');
  assert.equal(ack.success, true, ack.error);
  assert.equal(fake.zones[1].power, false);
  // Mute on a zone that is off: nothing plays, done.
  ack = await press(gladys, device, 'mute');
  assert.equal(ack.success, true, ack.error);
});

test('power off with the device away: kept, then sent first when the connection comes back', async (t) => {
  const { gladys, id, fake, app } = await setup(t, { timings: { commandBudget: 900 } });
  const device = await createDevice(gladys, id, 1);
  fake.override.set('IDM?', 'silent');
  linkOf(app).session.close();
  await settle(20);
  const ack = await press(gladys, device, 'power_off');
  assert.equal(ack.success, false);
  assert.match(ack.error, /kept, sent when the connection comes back/);
  assert.equal(fake.zones[1].power, true);
  assert.ok(app.data.protect[`127.0.0.1_${fake.port}_z1`], 'kept in /data');
  const before = fake.commands.length;
  fake.override.delete('IDM?');
  await waitFor(() => fake.zones[1].power === false, 'the power off sent', 3_000);
  const after = fake.commands.slice(before);
  const identified = after.lastIndexOf('IDM?');
  assert.equal(after[identified + 1], 'Z1POW0', `sent before any read: ${after.join(' ')}`);
  await waitFor(() => !app.protect.has(`127.0.0.1_${fake.port}_z1`), 'confirmed by a later read');
});

test('power off not applied: sent again on a read made after it, 3 sends at most', async (t) => {
  const { gladys, id, fake, app } = await setup(t);
  const device = await createDevice(gladys, id, 1);
  // The device acks the power off but stays on.
  fake.override.set('Z1POW0', () => ';');
  const ack = await press(gladys, device, 'power_off');
  assert.equal(ack.success, false);
  assert.match(ack.error, /without confirmation/);
  assert.equal(fake.writes('Z1POW0').length, 3);
  // Reads later never send it a 4th time.
  await linkOf(app).readAll(linkOf(app).session);
  await settle(200);
  assert.equal(fake.writes('Z1POW0').length, 3);
});

test('a power on from the remote after a confirmed power off is not fought', async (t) => {
  const { gladys, id, fake, app } = await setup(t, { fakeOptions: { reports: true } });
  const device = await createDevice(gladys, id, 1);
  const ack = await press(gladys, device, 'power_off');
  assert.equal(ack.success, true, ack.error);
  fake.zones[1].power = true;
  fake.push('Z1POW1;');
  await linkOf(app).readAll(linkOf(app).session);
  await settle(100);
  assert.equal(fake.writes('Z1POW0').length, 1);
  assert.equal(app.protect.size, 0);
});

test('an unconfirmed power off is not resent from a report, only from a read after it', async (t) => {
  const { gladys, id, fake, app } = await setup(t, { fakeOptions: { reports: true } });
  const device = await createDevice(gladys, id, 1);
  fake.override.set('Z1POW0', 'silent');
  fake.override.set('Z1POW?', 'silent');
  const ack = await press(gladys, device, 'power_off');
  assert.equal(ack.success, false);
  const sends = fake.writes('Z1POW0').length;
  // The device reports "on" by itself: no decision on it.
  fake.push('Z1POW1;');
  await settle(100);
  assert.equal(fake.writes('Z1POW0').length, sends);
  // A read made after the send shows it on: sent again (once the late
  // answers of the silent queries can no longer come).
  fake.override.delete('Z1POW?');
  fake.override.delete('Z1POW0');
  await waitFor(() => {
    const link = linkOf(app);
    if (!link.reading) {
      link.readAll(link.session).catch(() => {});
    }
    return fake.zones[1].power === false;
  }, 'sent again');
});

test('a power on that left ends the resend of a power off; a mute cancels a waiting unmute', async (t) => {
  const { gladys, id, fake, app } = await setup(t, {
    fakeOptions: { mute: { 1: true, 2: false } },
  });
  const device = await createDevice(gladys, id, 1);
  fake.override.set('Z1POW0', 'silent');
  await press(gladys, device, 'power_off');
  const target = `127.0.0.1_${fake.port}_z1`;
  assert.ok(app.protect.has(target));
  fake.override.delete('Z1POW0');
  const on = await press(gladys, device, 'power_on');
  assert.equal(on.success, true, on.error);
  assert.equal(app.protect.has(target), false);
  // A stuck volume, an unmute waiting behind it, then a mute.
  fake.override.set('Z1PVOL25', 'silent');
  const stuck = press(gladys, device, 'volume', 25);
  await waitFor(() => fake.commands.includes('Z1PVOL25'), 'the stuck volume');
  const unmute = press(gladys, device, 'unmute');
  const mute = await press(gladys, device, 'mute');
  assert.equal(mute.success, true, mute.error);
  assert.match((await unmute).error, /nothing sent/);
  await stuck;
  await settle(80);
  assert.equal(fake.writes('Z1MUT0').length, 0);
  assert.equal(fake.zones[1].mute, true);
});

test('a restart sends the pending power off of /data first; a future or old date is dropped', async (t) => {
  const fake = await startFakeAnthem();
  t.after(() => fake.close());
  const now = Date.now();
  const data = emptyData();
  data.devices[`127.0.0.1_${fake.port}`] = {
    id: `127.0.0.1_${fake.port}`,
    host: '127.0.0.1',
    port: fake.port,
    model: 'MRX 1140',
    zones: [1, 2],
    inputs: [],
  };
  data.protect[`127.0.0.1_${fake.port}_z1`] = { kind: 'power_off', at: now - 10_000, sends: 1 };
  data.protect[`127.0.0.1_${fake.port}_z2`] = { kind: 'mute', at: now + 60_000, sends: 0 };
  fake.zones[2].power = true;
  const store = new MemoryStore(data);
  // Once the SDK connected, neither the configuration nor the Gladys
  // devices can be read.
  const { gladys } = await setup(t, { store, connect: false, config: { addresses: '' } });
  for (const method of ['getConfig', 'getDevices']) {
    const original = gladys[method].bind(gladys);
    let calls = 0;
    gladys[method] = async () => {
      calls += 1;
      if (calls > 1) {
        throw new Error('503');
      }
      return original();
    };
  }
  await gladys.connect();
  await waitFor(() => fake.zones[1].power === false, 'the pending power off sent');
  assert.equal(fake.commands[0], 'IDM?');
  assert.equal(fake.commands[1], 'Z1POW0');
  await settle(60);
  assert.equal(fake.writes('Z2MUT').length, 0, 'a date in the future is dropped');
  assert.equal(fake.zones[2].mute, false);
});

test('/data that cannot be saved never blocks a power off', async (t) => {
  const store = new MemoryStore();
  const { gladys, id, fake } = await setup(t, { store });
  const device = await createDevice(gladys, id, 1);
  store.failSave = 100;
  const ack = await press(gladys, device, 'power_off');
  assert.equal(ack.success, true, ack.error);
  assert.equal(fake.zones[1].power, false);
});

test('the configuration unread at connection: asked again, the created zones stay controlled', async (t) => {
  const fake = await startFakeAnthem();
  t.after(() => fake.close());
  const known = { host: '127.0.0.1', port: fake.port, model: 'MRX 1140', inputs: [] };
  const created = buildDevice(createFakeGladys({ selector: SELECTOR }), known, 1);
  let failures = 2;
  const { gladys, app } = await setup(t, {
    connect: false,
    config: { addresses: '', max_volume: 25 },
    gladysOptions: { devices: [created] },
  });
  const getConfig = gladys.getConfig.bind(gladys);
  let calls = 0;
  gladys.getConfig = async () => {
    calls += 1;
    // The first call is the SDK's own (before 'connected').
    if (calls > 1 && failures > 0) {
      failures -= 1;
      throw new Error('503');
    }
    return getConfig();
  };
  await gladys.connect();
  await waitFor(
    () => /configuration could not be read/.test(gladys.fake.connectionStatus?.message?.en ?? ''),
    'the status',
  );
  // Linked from the Gladys device alone; the cap is the default meanwhile.
  await waitFor(() => linkOf(app)?.connected, 'the link');
  assert.equal(app.maxVolume, 40);
  const off = await press(gladys, created, 'power_off');
  assert.equal(off.success, true, off.error);
  await waitFor(() => app.config?.maxVolume === 25, 'the configuration read at last');
  await waitFor(
    () => !/configuration/.test(gladys.fake.connectionStatus?.message?.en ?? ''),
    'the status cleared',
  );
  assert.equal(failures, 0);
});

test('/data unreadable: nothing written over it, zones known from Gladys, merged once readable', async (t) => {
  const fake = await startFakeAnthem();
  t.after(() => fake.close());
  const known = { host: '127.0.0.1', port: fake.port, model: 'MRX 1140', inputs: [] };
  const created = buildDevice(createFakeGladys({ selector: SELECTOR }), known, 2);
  const data = emptyData();
  data.devices[`127.0.0.1_${fake.port}`] = {
    ...known,
    id: `127.0.0.1_${fake.port}`,
    zones: [1, 2],
  };
  data.devices[`127.0.0.1_${fake.port}`].inputs = [{ value: '9', label: 'Old input' }];
  const store = new MemoryStore(data);
  store.failLoad = 1;
  const { gladys, app } = await setup(t, {
    store,
    connect: false,
    config: { addresses: '' },
    gladysOptions: { devices: [created] },
  });
  await gladys.connect();
  await waitFor(() => linkOf(app)?.connected, 'the link from the Gladys device');
  await settle(60);
  assert.equal(store.saves, 0, 'nothing written over unreadable data');
  assert.match(gladys.fake.connectionStatus.message.en, /cannot be read/);
  assert.equal(app.dataUnreadable, true);
  // Readable again: merged (the old input kept), saved, the status cleared.
  await waitFor(() => !app.dataUnreadable, 'read again');
  assert.ok(app.data.devices[`127.0.0.1_${fake.port}`].inputs.some((i) => i.value === '9'));
  await waitFor(() => store.saves > 0, 'saved once readable');
  await waitFor(
    () => !/cannot be read/.test(gladys.fake.connectionStatus?.message?.en ?? ''),
    'the status cleared',
  );
});
