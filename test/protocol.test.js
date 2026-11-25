// -----------------------------------------------------------------------------
// The protocol (pure): frames, strict values, requests never out of range.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  FrameParser,
  REQUESTS,
  cleanText,
  parseError,
  parseInput,
  parseInputCount,
  parseInputName,
  parseModel,
  parseVolume,
  parseZoneReport,
} from '../src/anthem/protocol.js';

test('frames: ";" ends a frame, ";" alone is an ack, LF ends an error, CR dropped', () => {
  const parser = new FrameParser();
  assert.deepEqual(parser.push(Buffer.from('Z1POW1;;!IHELLO\r\n')), [
    { text: 'Z1POW1', ack: false },
    { text: '', ack: true },
    { text: '!IHELLO', ack: false },
  ]);
  // Split anywhere: the rest waits for its terminator.
  assert.deepEqual(parser.push(Buffer.from('Z1PV')), []);
  assert.deepEqual(parser.push(Buffer.from('OL35;\n')), [{ text: 'Z1PVOL35', ack: false }]);
});

test('frames: bounded; bytes read as Latin-1, never an exception on bad UTF-8', () => {
  const parser = new FrameParser();
  assert.throws(() => parser.push(Buffer.alloc(600, 0x41)), /too long/);
  const fresh = new FrameParser();
  assert.throws(() => fresh.push(Buffer.from(`${'A'.repeat(520)};`)), /too long/);
  const latin = new FrameParser();
  assert.deepEqual(latin.push(Buffer.from([0x49, 0x53, 0x31, 0x49, 0x4e, 0xe9, 0xff, 0x3b])), [
    { text: 'IS1INéÿ', ack: false },
  ]);
});

test('errors: the code and the original command', () => {
  assert.deepEqual(parseError('!RZ1VOL+50'), { code: 'R', command: 'Z1VOL+50' });
  assert.deepEqual(parseError('!ZZ1PVOL?'), { code: 'Z', command: 'Z1PVOL?' });
  assert.equal(parseError('!XZ1'), undefined);
  assert.equal(parseError('Z1POW1'), undefined);
});

test('zone reports: strict values, unknown never 0', () => {
  assert.deepEqual(parseZoneReport('Z1POW1'), { zone: 1, key: 'POW', value: true });
  assert.deepEqual(parseZoneReport('Z2MUT0'), { zone: 2, key: 'MUT', value: false });
  assert.deepEqual(parseZoneReport('Z1PVOL035'), { zone: 1, key: 'PVOL', value: 35 });
  assert.deepEqual(parseZoneReport('Z1INP12'), { zone: 1, key: 'INP', value: 12 });
  assert.deepEqual(parseZoneReport('Z1VOL-35.5'), { zone: 1, key: 'VOL', value: '-35.5' });
  for (const [text, key] of [
    ['Z1POW', 'POW'],
    ['Z1POW2', 'POW'],
    ['Z1PVOL', 'PVOL'],
    ['Z1PVOL101', 'PVOL'],
    ['Z1PVOL-1', 'PVOL'],
    ['Z1PVOL5.5', 'PVOL'],
    ['Z1PVOL 5', 'PVOL'],
    ['Z1INP0', 'INP'],
    ['Z1INP31', 'INP'],
    ['Z1INP', 'INP'],
    ['Z1VOLx', 'VOL'],
  ]) {
    const report = parseZoneReport(text);
    assert.equal(report.key, key, text);
    assert.equal(report.value, undefined, text);
  }
  for (const text of ['Z3POW1', 'Z0POW1', 'ZPOW1', 'Z1ALM01', 'IDMMRX', '']) {
    assert.equal(parseZoneReport(text), undefined, text);
  }
});

test('values: volume 0..100, input 1..30, model, input count and names', () => {
  assert.equal(parseVolume('0'), 0);
  assert.equal(parseVolume('100'), 100);
  for (const bad of ['', ' ', '101', '-0', '1e2', '0x1', '50%', undefined, 50]) {
    assert.equal(parseVolume(bad), undefined, String(bad));
  }
  assert.equal(parseInput('30'), 30);
  assert.equal(parseInput('0'), undefined);
  assert.equal(parseModel('IDMMRX 1140'), 'MRX 1140');
  assert.equal(parseModel('IDM'), undefined);
  assert.equal(parseModel('IDM\u0001\u0002'), undefined);
  assert.equal(parseModel('HELLO'), undefined);
  assert.equal(parseInputCount('ICN9'), 9);
  assert.equal(parseInputCount('ICN31'), undefined);
  assert.equal(parseInputCount('ICN'), undefined);
  assert.deepEqual(parseInputName('IS3INTurntable'), { input: 3, name: 'Turntable' });
  assert.deepEqual(parseInputName('IS10INApple TV 4K'), { input: 10, name: 'Apple TV 4K' });
  assert.equal(parseInputName('IS3IN'), undefined);
  assert.equal(parseInputName('IS0INx'), undefined);
  assert.equal(parseInputName('IS3ARC1'), undefined, 'the room correction report');
  assert.equal(cleanText('\u0000a\u001fb\u007f'), 'ab');
  assert.equal(cleanText('  '), undefined);
  assert.equal(cleanText(42), undefined);
  assert.equal(cleanText('x'.repeat(100)).length, 64);
});

test('requests: exact texts, nothing out of range ever built', () => {
  assert.deepEqual(REQUESTS.model(), { text: 'IDM?', expect: 'IDM' });
  assert.deepEqual(REQUESTS.query(2, 'PVOL'), { text: 'Z2PVOL?', expect: 'Z2PVOL' });
  assert.deepEqual(REQUESTS.power(1, false), { text: 'Z1POW0' });
  assert.deepEqual(REQUESTS.mute(2, true), { text: 'Z2MUT1' });
  assert.deepEqual(REQUESTS.volume(1, 40), { text: 'Z1PVOL40' });
  assert.deepEqual(REQUESTS.input(1, 3), { text: 'Z1INP3' });
  assert.deepEqual(REQUESTS.inputName(3), { text: 'IS3IN?', expect: 'IS3IN' });
  for (const bad of [
    REQUESTS.volume(1, 101),
    REQUESTS.volume(1, -1),
    REQUESTS.volume(1, 40.5),
    REQUESTS.volume(3, 40),
    REQUESTS.volume(1, '40'),
    REQUESTS.input(1, 0),
    REQUESTS.input(1, 31),
    REQUESTS.input(1, '3'),
    REQUESTS.power(1, 1),
    REQUESTS.mute(0, true),
    REQUESTS.query(1, 'VOL'),
    REQUESTS.inputName(31),
  ]) {
    assert.equal(bad, undefined);
  }
});
