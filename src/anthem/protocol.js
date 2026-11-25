// -----------------------------------------------------------------------------
// The Anthem IP control protocol (MRX 540/740/1140, AVM 70/90 and their
// relatives), after the official "MRX x40, AVM 70/90 IP & RS-232" sheet v5:
// ASCII commands ended by ";", queries ended by "?;", a successful command
// answered by ";" alone, an error answered by "!<code><original command>",
// state reports ("Z1POW1;") answered to a query or sent on a change.
//
// Pure, untrusted input: every frame is bounded, every value parsed strictly
// (a value that does not match exactly is unknown, never 0).
// -----------------------------------------------------------------------------

import { LIMITS, MAX_INPUTS, VOLUME, ZONES } from '../constants.js';

/** Error codes of the device ("!I…", "!R…", "!E…", "!Z…"). */
export const ERRORS = Object.freeze({
  I: 'invalid command',
  R: 'value out of range',
  E: 'cannot be executed now',
  Z: 'zone off',
});

/** Text of the device: printable ASCII and Latin-1 letters only, trimmed, bounded. */
export function cleanText(value, max = LIMITS.name) {
  if (typeof value !== 'string') {
    return undefined;
  }
  const text = value
    .replace(/[^\x20-\x7e\u00a0-\u00ff]/g, '')
    .trim()
    .slice(0, max)
    .trim();
  return text === '' ? undefined : text;
}

/**
 * Splits the byte stream into frames. A frame ends with ";" (the only
 * terminator of the specification) or a line feed (some error answers);
 * a carriage return is dropped. `{ text, ack }`: `ack` for an empty frame
 * ended by ";" (a successful command). Throws when a frame grows beyond
 * LIMITS.frame bytes without a terminator (not an Anthem device).
 */
export class FrameParser {
  constructor() {
    this.buffer = '';
  }

  push(chunk) {
    const frames = [];
    // latin1: one character per byte, never an exception on bad UTF-8.
    const text = this.buffer + Buffer.from(chunk).toString('latin1');
    let start = 0;
    for (let i = 0; i < text.length; i += 1) {
      const c = text[i];
      if (c !== ';' && c !== '\n') {
        continue;
      }
      const body = text.slice(start, i).replace(/\r/g, '');
      start = i + 1;
      if (body === '') {
        if (c === ';') {
          frames.push({ text: '', ack: true });
        }
        continue;
      }
      if (body.length > LIMITS.frame) {
        throw new Error('Frame too long');
      }
      frames.push({ text: body, ack: false });
    }
    this.buffer = text.slice(start);
    if (this.buffer.length > LIMITS.frame) {
      this.buffer = '';
      throw new Error('Frame too long');
    }
    return frames;
  }
}

/** The error of a frame: `{ code, command }`, or undefined when it is not one. */
export function parseError(text) {
  const match = /^!([IREZ])(.*)$/s.exec(text);
  return match ? { code: match[1], command: match[2] } : undefined;
}

const ZONE_REPORT = /^Z([12])(POW|PVOL|VOL|MUT|INP)(.*)$/;

/**
 * A state report of a zone: `{ zone, key, value }` with the value decoded
 * (undefined when unreadable), or undefined when the frame is not one.
 * VOL (dB) is only flagged: the per cent volume is asked instead.
 */
export function parseZoneReport(text) {
  const match = ZONE_REPORT.exec(text);
  if (!match) {
    return undefined;
  }
  const zone = Number(match[1]);
  const key = match[2];
  const raw = match[3];
  switch (key) {
    case 'POW':
    case 'MUT':
      return { zone, key, value: raw === '1' ? true : raw === '0' ? false : undefined };
    case 'PVOL':
      return { zone, key, value: parseVolume(raw) };
    case 'INP':
      return { zone, key, value: parseInput(raw) };
    default:
      return { zone, key, value: /^[+-]?\d{1,2}(?:\.[05])?$/.test(raw) ? raw : undefined };
  }
}

/** An integer 0..100 written with digits only ("035" included), else undefined. */
export function parseVolume(raw) {
  if (typeof raw !== 'string' || !/^\d{1,3}$/.test(raw)) {
    return undefined;
  }
  const value = Number(raw);
  return value >= VOLUME.min && value <= VOLUME.max ? value : undefined;
}

/** An input number 1..30, else undefined. */
export function parseInput(raw) {
  if (typeof raw !== 'string' || !/^\d{1,2}$/.test(raw)) {
    return undefined;
  }
  const value = Number(raw);
  return value >= 1 && value <= MAX_INPUTS ? value : undefined;
}

/** The model of an "IDM" answer ("IDMMRX 1140" -> "MRX 1140"). */
export function parseModel(text) {
  return text.startsWith('IDM') ? cleanText(text.slice(3)) : undefined;
}

/** The number of inputs of an "ICN" answer, else undefined. */
export function parseInputCount(text) {
  const match = /^ICN(\d{1,2})$/.exec(text);
  if (!match) {
    return undefined;
  }
  const count = Number(match[1]);
  return count >= 0 && count <= MAX_INPUTS ? count : undefined;
}

/** The name of input `n` of an "ISnIN" answer ("IS3INTurntable"), else undefined. */
export function parseInputName(text) {
  const match = /^IS(\d{1,2})IN(.*)$/s.exec(text);
  if (!match) {
    return undefined;
  }
  const input = parseInput(match[1]);
  const name = cleanText(match[2], 32);
  return input && name ? { input, name } : undefined;
}

const zoneOk = (zone) => ZONES.includes(zone);

/**
 * The commands and queries sent, as `{ text, expect }`: `text` without the
 * terminator, `expect` the prefix of the answer of a query (undefined for a
 * command, answered by ";" alone). Invalid arguments return undefined:
 * nothing out of range is ever written.
 */
export const REQUESTS = Object.freeze({
  model: () => ({ text: 'IDM?', expect: 'IDM' }),
  inputCount: () => ({ text: 'ICN?', expect: 'ICN' }),
  inputName: (input) =>
    parseInput(String(input)) === input
      ? { text: `IS${input}IN?`, expect: `IS${input}IN` }
      : undefined,
  query: (zone, key) =>
    zoneOk(zone) && ['POW', 'PVOL', 'MUT', 'INP'].includes(key)
      ? { text: `Z${zone}${key}?`, expect: `Z${zone}${key}` }
      : undefined,
  power: (zone, on) =>
    zoneOk(zone) && typeof on === 'boolean' ? { text: `Z${zone}POW${on ? 1 : 0}` } : undefined,
  mute: (zone, on) =>
    zoneOk(zone) && typeof on === 'boolean' ? { text: `Z${zone}MUT${on ? 1 : 0}` } : undefined,
  volume: (zone, value) =>
    zoneOk(zone) && Number.isInteger(value) && value >= VOLUME.min && value <= VOLUME.max
      ? { text: `Z${zone}PVOL${value}` }
      : undefined,
  input: (zone, input) =>
    zoneOk(zone) && parseInput(String(input)) === input
      ? { text: `Z${zone}INP${input}` }
      : undefined,
});
