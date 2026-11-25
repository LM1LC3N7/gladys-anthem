# Anthem for Gladys Assistant

A [Gladys Assistant](https://gladysassistant.com) external integration for
Anthem AV receivers and processors (MRX 540, 740, 1140, AVM 70, 90), over
their local IP control: power, volume (capped), mute, source, for the main
zone and zone 2. No cloud, no account.

Unofficial, not affiliated with Anthem. Written after the official Anthem
sheet "MRX x40, AVM 70/90 IP & RS-232" v5; **never tested with a real
device yet**.

- User guide: [English](docs/en.md), [français](docs/fr.md).
- Changes: [CHANGELOG.md](CHANGELOG.md). Decisions and next steps:
  [TODO.md](TODO.md). Rules for contributors: [CLAUDE.md](CLAUDE.md).

## How it works

- One persistent TCP connection per device (port 14999): the model is asked
  (identity check), then the power of each zone (zone 2 exists when it
  answers), then the volume (per cent), mute and input of each zone that is
  on, and the input names. Every zone is read again every 30 seconds; the
  reports the device sends on a change are used too.
- One Gladys device per zone: Power (read only), Power on, Power off, Volume,
  Muted (read only), Mute, Unmute, Source. No switch: an "everything off"
  never powers an amplifier on.
- The volume cap applies to every volume set from Gladys, to Unmute (the
  volume is lowered first) and after a Power on from Gladys.
- Power off and Mute are protective: never queued behind other commands,
  never blocked by the cap or the configuration, kept and sent again while
  not confirmed.

## Development

```bash
npm install
npm test                 # node --test --test-timeout=60000
npm run lint
npm run format:check
npm run mutants          # mutation run (scripts/mutants.json)
npm run cover            # regenerates cover.png
```

The tests run against a fake Anthem device on the loopback interface
(`test/fixtures/fakeAnthem.js`, on the TCP server of the test kit copied in
`test/kit/`).

## License

Apache-2.0, see [LICENSE](LICENSE). Third-party notices:
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
