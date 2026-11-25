// -----------------------------------------------------------------------------
// One session on the TCP server of the test kit: one request at a time,
// answers matched (prefix, ";" alone, error with the original command), late
// answers never taken for the next request, protective requests first.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ERROR_KINDS, openSession } from '../src/anthem/connection.js';
import { LIMITS } from '../src/constants.js';
import { REQUESTS } from '../src/anthem/protocol.js';
import { blackhole, refusePort, tcpServer } from './kit/index.mjs';

async function open(t, onData, extra = {}) {
  const device = await tcpServer({ onData, ...extra });
  t.after(() => device.close());
  const reports = [];
  const session = await openSession({
    host: '127.0.0.1',
    port: device.port,
    timeoutMs: 500,
    staleMs: 1_000,
    onReport: (text, seq) => reports.push([text, seq]),
  });
  t.after(() => session.close());
  return { device, session, reports };
}

const commands = (chunk) =>
  chunk
    .toString('latin1')
    .split(';')
    .filter((c) => c !== '');

test('a query gets its answer; a command its ";"; an error its original command', async (t) => {
  const { session, reports } = await open(t, (chunk) =>
    commands(chunk)
      .map((c) =>
        c === 'Z1POW?' ? 'Z1POW1;' : c === 'Z1PVOL40' ? ';' : c === 'Z1PVOL999' ? `!R${c};` : '',
      )
      .join(''),
  );
  const answer = await session.request(REQUESTS.query(1, 'POW'), 300);
  assert.equal(answer.text, 'Z1POW1');
  assert.equal(answer.seq, 1);
  assert.deepEqual(reports, [['Z1POW1', 1]]);
  assert.deepEqual(await session.request(REQUESTS.volume(1, 40), 300), { text: '', seq: 2 });
  await assert.rejects(session.request({ text: 'Z1PVOL999' }, 300), (err) => {
    assert.equal(err.kind, ERROR_KINDS.REFUSED);
    assert.equal(err.code, 'R');
    return true;
  });
});

test('a report sent by the device itself is tagged 0 and settles nothing', async (t) => {
  const { session, device, reports } = await open(t, (chunk) =>
    commands(chunk)
      .map((c) => (c === 'Z1MUT?' ? 'Z1MUT0;' : ''))
      .join(''),
  );
  // Before the query: a report of another key, never taken as the answer.
  const pending = session.request(REQUESTS.query(1, 'MUT'), 300);
  device.push('Z1POW1;');
  assert.equal((await pending).text, 'Z1MUT0');
  assert.deepEqual(reports[0], ['Z1POW1', 0]);
});

test('a late answer settles the next query, tagged with the number of the older one', async (t) => {
  let first = true;
  const { session, reports } = await open(t, (chunk) =>
    commands(chunk)
      .map((c) => {
        if (c === 'Z1PVOL?') {
          if (first) {
            first = false;
            return '';
          }
          return 'Z1PVOL22;';
        }
        return '';
      })
      .join(''),
  );
  await assert.rejects(session.request(REQUESTS.query(1, 'PVOL'), 100), (err) => {
    assert.equal(err.kind, ERROR_KINDS.TIMEOUT);
    assert.equal(err.sent, true);
    return true;
  });
  // The late answer of the first query comes before the answer of the second.
  const second = session.request(REQUESTS.query(1, 'PVOL'), 300);
  session.receive(Buffer.from('Z1PVOL80;'));
  const answer = await second;
  assert.equal(answer.text, 'Z1PVOL80');
  assert.equal(answer.seq, 1, 'tagged as the first query: never a read made after the second');
  await new Promise((resolve) => setTimeout(resolve, 30));
  // The real answer of the second one is a plain report.
  assert.deepEqual(reports.at(-1), ['Z1PVOL22', 0]);
  // Past the window, an answer is the answer of its own query again.
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const third = await session.request(REQUESTS.query(1, 'PVOL'), 300);
  assert.equal(third.seq, 3);
});

test('one request on the wire; protective ones first, even when the queue is full', async (t) => {
  const order = [];
  const { session } = await open(
    t,
    (chunk) =>
      commands(chunk)
        .map((c) => {
          order.push(c);
          return c.endsWith('?') ? `${c.slice(0, -1)}1;` : ';';
        })
        .join(''),
    { latencyMs: 20 },
  );
  const reads = [];
  // One on the wire, LIMITS.pending - 1 waiting, then a command: the queue is full.
  for (let i = 0; i < LIMITS.pending; i += 1) {
    reads.push(session.request(REQUESTS.query(1, 'POW'), 5_000).catch((err) => err));
  }
  const command = session.request(REQUESTS.volume(1, 10), 5_000, { urgent: true });
  const refused = await session.request(REQUESTS.query(1, 'MUT'), 5_000).catch((err) => err);
  assert.equal(refused.kind, ERROR_KINDS.BUDGET);
  const off = session.request(REQUESTS.power(1, false), 5_000, { protective: true });
  await off;
  await command;
  // Only the read already on the wire went before the power off; the
  // command before the reads waiting.
  assert.deepEqual(order.slice(0, 3), ['Z1POW?', 'Z1POW0', 'Z1PVOL10']);
  await Promise.all(reads);
});

test('beforeSend: a request overtaken is dropped, never written', async (t) => {
  const { session, device } = await open(t, (chunk) =>
    commands(chunk)
      .map(() => ';')
      .join(''),
  );
  const err = await session
    .request(REQUESTS.mute(1, false), 300, { beforeSend: () => false })
    .catch((e) => e);
  assert.equal(err.kind, ERROR_KINDS.CANCELLED);
  await session.request(REQUESTS.mute(1, true), 300);
  assert.equal(device.text(), 'Z1MUT1;');
});

test('a request waiting past its deadline is dropped, never sent late', async (t) => {
  const { session, device } = await open(t, () => '', {});
  const first = session.request(REQUESTS.query(1, 'POW'), 200).catch((e) => e);
  const second = await session.request(REQUESTS.volume(1, 10), 50).catch((e) => e);
  assert.equal(second.kind, ERROR_KINDS.BUDGET);
  assert.equal((await first).kind, ERROR_KINDS.TIMEOUT);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(device.text(), 'Z1POW?;');
});

test('the connection closed: the request on the wire "may have been sent", the others not', async (t) => {
  const { session, device } = await open(t, () => undefined);
  const onWire = session.request(REQUESTS.power(1, false), 2_000).catch((e) => e);
  const waiting = session.request(REQUESTS.query(1, 'POW'), 2_000).catch((e) => e);
  await new Promise((resolve) => setTimeout(resolve, 30));
  await device.close();
  assert.equal((await onWire).kind, ERROR_KINDS.CLOSED);
  assert.equal((await onWire).sent, true);
  assert.equal((await waiting).kind, ERROR_KINDS.UNREACHABLE);
  assert.equal((await waiting).sent, false);
});

test('an oversized frame closes the connection', async (t) => {
  const { session, device } = await open(t, () => undefined);
  let closed = false;
  session.onClose = () => {
    closed = true;
  };
  device.push('A'.repeat(LIMITS.frame + 10));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(closed, true);
  assert.equal(session.open, false);
});

test('nothing listening, or silent: no session', async (t) => {
  const port = await refusePort();
  await assert.rejects(
    openSession({ host: '127.0.0.1', port, timeoutMs: 300 }),
    (err) => err.kind === ERROR_KINDS.UNREACHABLE,
  );
  const hole = await blackhole();
  t.after(() => hole.close());
  const session = await openSession({ host: '127.0.0.1', port: hole.port, timeoutMs: 300 });
  t.after(() => session.close());
  await assert.rejects(session.request(REQUESTS.model(), 100), (err) => err.kind === 'timeout');
});
