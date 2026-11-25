// -----------------------------------------------------------------------------
// A fake Anthem device (MRX 1140 by default) on the loopback interface, on
// the TCP server of the test kit, answering as the official IP & RS-232
// sheet v5 says: queries "Z1POW?;" -> "Z1POW1;", commands -> ";", errors
// "!I…;" (invalid, or anything but IDM/POW in standby), "!Z…;" (zone off),
// "!R…;" (out of range). With `reports` on (Tx status), every change is
// also reported, as the device does.
// -----------------------------------------------------------------------------

import { tcpServer } from '../kit/index.mjs';

export async function startFakeAnthem({
  model = 'MRX 1140',
  zone2 = true,
  power = { 1: true, 2: false },
  volume = { 1: 30, 2: 20 },
  mute = { 1: false, 2: false },
  input = { 1: 1, 2: 2 },
  inputs = ['Blu-ray', 'TV', 'Turntable'],
  reports = false,
  latencyMs = 0,
  singleClient = false,
} = {}) {
  const zones = {};
  for (const z of zone2 ? [1, 2] : [1]) {
    zones[z] = { power: power[z], volume: volume[z], mute: mute[z], input: input[z] };
  }
  const fake = {
    model,
    zones,
    inputs: [...inputs],
    reports,
    /** Every command and query received, in order (without ';'). */
    commands: [],
    /** command text -> 'silent' | 'drop' | answer string (without ';') | function */
    override: new Map(),
    /** Commands applied, not answered (the ";" never comes). */
    ackless: false,
    device: undefined,
    get port() {
      return fake.device.port;
    },
    writes(prefix) {
      return fake.commands.filter((c) => c.startsWith(prefix) && !c.endsWith('?'));
    },
    queries(prefix) {
      return fake.commands.filter((c) => c.startsWith(prefix) && c.endsWith('?'));
    },
    push(text) {
      fake.device.push(text);
    },
    close: () => fake.device.close(),
  };

  const standby = () => Object.values(zones).every((z) => !z.power);

  const handle = (cmd) => {
    fake.commands.push(cmd);
    const special = fake.override.get(cmd);
    if (special === 'silent') {
      return '';
    }
    if (typeof special === 'function') {
      return special(cmd, fake) ?? '';
    }
    if (typeof special === 'string') {
      return `${special};`;
    }
    if (cmd === 'IDM?') {
      return `IDM${fake.model};`;
    }
    const zoneMatch = /^Z(\d)(POW|PVOL|MUT|INP)(.*)$/.exec(cmd);
    if (!zoneMatch) {
      if (standby()) {
        return `!I${cmd};`;
      }
      if (cmd === 'ICN?') {
        return `ICN${fake.inputs.length};`;
      }
      const name = /^IS(\d+)IN\?$/.exec(cmd);
      if (name) {
        const n = Number(name[1]);
        return n >= 1 && n <= fake.inputs.length ? `IS${n}IN${fake.inputs[n - 1]};` : `!R${cmd};`;
      }
      return `!I${cmd};`;
    }
    const z = zones[Number(zoneMatch[1])];
    const key = zoneMatch[2];
    const arg = zoneMatch[3];
    if (!z) {
      return `!I${cmd};`;
    }
    if (key === 'POW') {
      if (arg === '?') {
        return `Z${zoneMatch[1]}POW${z.power ? 1 : 0};`;
      }
      if (arg !== '0' && arg !== '1') {
        return `!R${cmd};`;
      }
      z.power = arg === '1';
      const report = fake.reports ? `Z${zoneMatch[1]}POW${arg};` : '';
      return fake.ackless ? report : `;${report}`;
    }
    if (standby()) {
      return `!I${cmd};`;
    }
    if (!z.power) {
      return `!Z${cmd};`;
    }
    const field = { PVOL: 'volume', MUT: 'mute', INP: 'input' }[key];
    if (arg === '?') {
      const value = key === 'MUT' ? (z.mute ? 1 : 0) : z[field];
      return `Z${zoneMatch[1]}${key}${value};`;
    }
    let value;
    if (key === 'PVOL' && /^\d{1,3}$/.test(arg) && Number(arg) <= 100) {
      value = Number(arg);
    } else if (key === 'MUT' && (arg === '0' || arg === '1')) {
      value = arg === '1';
    } else if (
      key === 'INP' &&
      /^\d{1,2}$/.test(arg) &&
      Number(arg) >= 1 &&
      Number(arg) <= fake.inputs.length
    ) {
      value = Number(arg);
    } else {
      return `!R${cmd};`;
    }
    z[field] = value;
    const shown = key === 'MUT' ? (value ? 1 : 0) : value;
    const report = fake.reports ? `Z${zoneMatch[1]}${key}${shown};` : '';
    return fake.ackless ? report : `;${report}`;
  };

  fake.device = await tcpServer({
    latencyMs,
    singleClient,
    onData: (chunk) => {
      const text = chunk.toString('latin1');
      let answer = '';
      for (const cmd of text.split(';').filter((c) => c !== '')) {
        answer += handle(cmd);
      }
      return answer === '' ? undefined : answer;
    },
  });
  return fake;
}
