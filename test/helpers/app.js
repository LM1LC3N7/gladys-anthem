// -----------------------------------------------------------------------------
// AnthemApp with the SDK's fake Gladys, the exact handlers of the container
// (src/handlers.js), a memory store and the fake Anthem device on the
// loopback interface. Real timers (the clock moves), short timings; the
// background round never fires by itself (the tests drive it).
// -----------------------------------------------------------------------------

import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { AnthemApp } from '../../src/app.js';
import { TIMINGS } from '../../src/constants.js';
import { registerHandlers } from '../../src/handlers.js';
import { MemoryStore } from '../../src/store.js';
import { startFakeAnthem } from '../fixtures/fakeAnthem.js';

export const SELECTOR = 'anthem';

/** Real timeouts; the background round (the only interval) never fires. */
export const timers = {
  setInterval: () => 1,
  clearInterval: () => {},
  setTimeout: (fn, ms) => globalThis.setTimeout(fn, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
};

export const FAST = {
  ...TIMINGS,
  connectTimeout: 500,
  requestTimeout: 300,
  preRead: 300,
  reconnectBase: 40,
  reconnectMax: 200,
  stableAfter: 10_000,
  poll: 60_000,
  publishDelay: 5,
  persistDelay: 5,
  wakeRead: 20,
  volumeRead: 10,
  wakeCheckDelay: 30,
  followUps: [60, 150],
  configRetry: 30,
  configRetryMax: 200,
  dataRetry: 100,
};

export async function waitFor(predicate, what, timeout = 3_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`timed out waiting for ${what}`);
}

export const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));

export function memoryLogger() {
  const lines = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => lines.push(`${level} ${args.map((a) => a?.message ?? a).join(' ')}`),
    ]),
  );
  return { logger, lines };
}

export async function setup(
  t,
  { fakeOptions, config, store, timings = {}, gladysOptions = {}, connect = true, ...rest } = {},
) {
  const fake = await startFakeAnthem(fakeOptions);
  t.after(() => fake.close());
  const gladys = createFakeGladys({
    selector: SELECTOR,
    config: config ?? { addresses: `127.0.0.1:${fake.port}` },
    ...gladysOptions,
  });
  const { logger, lines } = memoryLogger();
  const memory = store ?? new MemoryStore();
  const app = new AnthemApp({
    gladys,
    logger,
    store: memory,
    timers,
    timings: { ...FAST, ...timings },
    ...rest,
  });
  registerHandlers(gladys, app, logger);
  t.after(() => app.stop());
  if (connect) {
    await gladys.connect();
  }
  const id = (zone = 1, key) =>
    `ext:${SELECTOR}:anthem:127.0.0.1_${fake.port}_z${zone}${key ? `:${key}` : ''}`;
  return { fake, gladys, app, logs: lines, store: memory, id };
}

export async function discovered(gladys, id, zone = 1) {
  await waitFor(
    () => gladys.fake.discoveredDevices.some((d) => d.external_id === id(zone)),
    `zone ${zone} in the Discovery tab`,
  );
  return gladys.fake.discoveredDevices.find((d) => d.external_id === id(zone));
}

export async function createDevice(gladys, id, zone = 1) {
  const device = await discovered(gladys, id, zone);
  await gladys.fake.deviceCreated(device);
  await waitFor(() => gladys.fake.lastState(id(zone, 'power')) !== undefined, 'the power state');
  return device;
}

export const press = (gladys, device, key, value = 1) =>
  gladys.fake.setValue(
    device,
    device.features.find((f) => f.external_id.endsWith(`:${key}`)),
    value,
  );
