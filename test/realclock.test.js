// -----------------------------------------------------------------------------
// On the real clock (sped up 100 times): the zones are read every 30 s,
// measured (never faster, never a cycle late), and stop() leaves no timer.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { AnthemApp } from '../src/app.js';
import { DeviceLink } from '../src/anthem/link.js';
import { TIMINGS } from '../src/constants.js';
import { registerHandlers } from '../src/handlers.js';
import { MemoryStore } from '../src/store.js';
import { measurePeriod, realClock, spyOn } from './kit/index.mjs';
import { startFakeAnthem } from './fixtures/fakeAnthem.js';
import { memoryLogger } from './helpers/app.js';

test('the zones are read every 30 s (real clock, sped up)', async (t) => {
  const fake = await startFakeAnthem();
  t.after(() => fake.close());
  const clock = realClock({ speed: 100 });
  t.after(() => clock.close());
  const spy = spyOn(DeviceLink.prototype, 'poll', clock);
  t.after(() => spy.restore());
  const gladys = createFakeGladys({
    selector: 'anthem',
    config: { addresses: `127.0.0.1:${fake.port}` },
  });
  const app = new AnthemApp({
    gladys,
    logger: memoryLogger().logger,
    store: new MemoryStore(),
    now: clock.monotonic,
    wallNow: clock.now,
    timers: clock.timers,
    timings: TIMINGS,
  });
  registerHandlers(gladys, app);
  t.after(() => app.stop());
  await gladys.connect();
  await measurePeriod(spy, { count: 4, period: TIMINGS.poll });
  const reads = fake.queries('Z1POW?').length;
  assert.ok(reads >= 4, `${reads} reads`);
  await app.stop();
  // What was written before stop() may still be on its way.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const after = fake.commands.length;
  await clock.sleep(2 * TIMINGS.poll);
  assert.equal(fake.commands.length, after, 'nothing asked after stop()');
});
