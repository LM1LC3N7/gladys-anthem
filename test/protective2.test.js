// -----------------------------------------------------------------------------
// Review r1: a power off and a mute never replace each other; a protective
// press asks a connection at once (never left to the backoff, never expired
// unsent); an unmute overtaken by a mute; the cap after a slow power on; the
// silence and flood guards of the link.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDevice, press, settle, setup, waitFor } from './helpers/app.js';

const linkOf = (app) => [...app.links.values()][0];

test('power off then mute while the device is away: both kept, both sent when it is back', async (t) => {
  const { gladys, id, fake, app } = await setup(t, { timings: { commandBudget: 900 } });
  const device = await createDevice(gladys, id, 1);
  fake.override.set('IDM?', 'silent');
  linkOf(app).session.close();
  await settle(20);
  const off = press(gladys, device, 'power_off');
  await settle(150);
  const mute = await press(gladys, device, 'mute');
  const offAck = await off;
  assert.equal(
    offAck.success,
    false,
    `never "done" while it did not leave: ${JSON.stringify(offAck)}`,
  );
  assert.match(offAck.error, /kept|without confirmation/);
  assert.match(mute.error, /kept|without confirmation/);
  const slots = app.data.protect[`127.0.0.1_${fake.port}_z1`] ?? {};
  assert.deepEqual(
    Object.keys(slots).sort(),
    ['mute', 'power_off'],
    JSON.stringify([offAck, mute]),
  );
  fake.override.delete('IDM?');
  await waitFor(() => fake.zones[1].power === false, 'the power off sent', 4_000);
  assert.equal(fake.writes('Z1POW0').length >= 1, true);
  assert.equal(fake.writes('Z1MUT1').length >= 1, true);
});

test('a protective press connects at once, whatever the backoff; never expired unsent', async (t) => {
  const { gladys, id, fake, app } = await setup(t, {
    timings: {
      commandBudget: 900,
      reconnectBase: 5_000,
      reconnectMax: 5_000,
      protectHold: 1_000,
      protectConnectGap: 100,
    },
  });
  const device = await createDevice(gladys, id, 1);
  // The device away long enough for the backoff to reach 5 s, then back.
  fake.override.set('IDM?', 'silent');
  linkOf(app).session.close();
  await waitFor(() => !linkOf(app).session && linkOf(app).retryAt !== undefined, 'in the backoff');
  fake.override.delete('IDM?');
  const ack = await press(gladys, device, 'power_off');
  assert.equal(ack.success, true, ack.error);
  assert.equal(fake.zones[1].power, false);

  // Away again; pressed; the hold passes before the backoff ends.
  fake.zones[1].power = true;
  fake.override.set('IDM?', 'silent');
  linkOf(app).session?.close();
  await settle(50);
  const kept = await press(gladys, device, 'power_off');
  assert.match(kept.error, /kept/);
  fake.override.delete('IDM?');
  await settle(1_200);
  // The background round after the hold: a connection is tried, the power off goes.
  await app.tick();
  await waitFor(() => fake.zones[1].power === false, 'sent after the hold', 3_000);
});

test('an unmute reading the volume, overtaken by a mute: never unmuted', async (t) => {
  const { gladys, id, fake } = await setup(t, { fakeOptions: { mute: { 1: true, 2: false } } });
  const device = await createDevice(gladys, id, 1);
  fake.device.latencyMs = (chunk) => (chunk.toString('latin1').includes('Z1PVOL?') ? 200 : 0);
  const unmute = press(gladys, device, 'unmute');
  await waitFor(() => fake.commands.includes('Z1PVOL?'), 'the volume read');
  const mute = await press(gladys, device, 'mute');
  assert.equal(mute.success, true, mute.error);
  const ack = await unmute;
  assert.equal(ack.success, false);
  await settle(100);
  assert.equal(fake.writes('Z1MUT0').length, 0);
  assert.equal(fake.zones[1].mute, true);
});

test('power off ends the volume checks of a power on', async (t) => {
  const { gladys, id, fake, app } = await setup(t, {
    fakeOptions: { power: { 1: false, 2: false }, volume: { 1: 90, 2: 10 } },
    timings: { wakeCheckDelay: 500 },
  });
  const device = await createDevice(gladys, id, 1);
  fake.override.set('Z1PVOL?', (cmd) => `!E${cmd};`);
  await press(gladys, device, 'power_on');
  assert.equal(app.wakeChecks.size, 1);
  await press(gladys, device, 'power_off');
  assert.equal(app.wakeChecks.size, 0);
  assert.equal(app.wakeWindows.size, 0);
});

test('a power on slower than the quick checks: capped as soon as the volume is read', async (t) => {
  const { gladys, id, fake } = await setup(t, {
    fakeOptions: { power: { 1: false, 2: false }, volume: { 1: 90, 2: 10 } },
    timings: { wakeCheckDelay: 20, wakeChecks: 2, wakeCheckSlow: 60, wakeWindow: 5_000 },
  });
  const device = await createDevice(gladys, id, 1);
  fake.override.set('Z1PVOL?', (cmd) => `!Z${cmd};`);
  await press(gladys, device, 'power_on');
  await settle(400);
  assert.equal(fake.zones[1].volume, 90);
  fake.override.delete('Z1PVOL?');
  await waitFor(() => fake.zones[1].volume === 40, 'capped', 500);
});

test('the wake window caps on a read; once over, a loud volume is left alone', async (t) => {
  const { gladys, id, fake, app } = await setup(t, {
    fakeOptions: { power: { 1: false, 2: false }, volume: { 1: 90, 2: 10 } },
    // The checks never fire here: only the window acts.
    timings: { wakeCheckDelay: 60_000, wakeCheckSlow: 60_000, wakeWindow: 400 },
  });
  const device = await createDevice(gladys, id, 1);
  fake.override.set('Z1PVOL?', (cmd) => `!Z${cmd};`);
  await press(gladys, device, 'power_on');
  fake.override.delete('Z1PVOL?');
  const link = linkOf(app);
  await link.readAll(link.session);
  await waitFor(() => fake.zones[1].volume === 40, 'capped by the window');
  // Again, but the volume is only readable once the window is over: left alone.
  fake.zones[1].power = false;
  fake.zones[1].volume = 90;
  fake.override.set('Z1PVOL?', (cmd) => `!Z${cmd};`);
  await press(gladys, device, 'power_on');
  await settle(500);
  fake.override.delete('Z1PVOL?');
  await link.readAll(link.session);
  await settle(100);
  assert.equal(fake.zones[1].volume, 90);
  assert.equal(fake.writes('Z1PVOL').length, 1);
});

test('a device silent too long is closed and asked again', async (t) => {
  const { fake, app } = await setup(t, { timings: { poll: 80, silence: 250 } });
  await waitFor(() => linkOf(app)?.connected, 'connected');
  fake.device.silent = true;
  await waitFor(() => fake.device.connections >= 2, 'a new connection', 3_000);
});

test('a flood of frames closes the connection', async (t) => {
  const { fake, app } = await setup(t);
  await waitFor(() => linkOf(app)?.connected, 'connected');
  fake.push('Z1POW1;'.repeat(400));
  await waitFor(() => fake.device.connections >= 2, 'a new connection', 3_000);
});
