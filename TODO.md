# TODO — Anthem v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `npm run format:check`, `npm run lint`, `npm test`
  (Node 22 and 24), `npm audit --omit=dev`, `npm run mutants` (one at a
  time, under `memcap`), `npx github:GladysAssistant/integration-store .`,
  then update README, `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- The `gladys-assistant-integration` topic is added at the first real release
  only.

## Status

- [x] **Milestone 1 — local control of the zones** (2026-11-25): devices
      added by IP address; one persistent TCP connection per address with
      the model (identity check), zone 2 detected by its answer, the state
      of each zone, the input names, the reports of the device, a read every
      30 s and a spaced reconnection; one Gladys device per zone with power
      state, Power on, Power off, volume capped by `max_volume`, mute state,
      Mute, Unmute and source; protective Power off and Mute (never blocked,
      kept, sent again while not confirmed); "Check" button; docs en/fr.
      Tested against a fake device on the loopback interface only, never with
      a real device.
- [ ] **Milestone 2 — real devices** (testers with an MRX x40 or AVM 70/90).
      To check first:
  - the number of IP clients the device accepts (it closes the oldest one):
    does the Anthem app push the integration out, and the other way round;
  - whether the device sends reports with Tx status off (`GCTXS`), and
    which ones (the integration reads every 30 s anyway);
  - the answer to `Z2POW?` on an MRX 540 (no zone 2: `!I` expected);
  - the ";" after a command: always, and before or after the report;
  - the volume read right after a power on (how long `!E` / `!Z` last);
  - the rendering on the Gladys dashboard of the four `button/push`, the
    `music/volume` and the `text/select`.
- [ ] **Milestone 3 — more**: older series (MRX x20/x10, AVM 60: volume in
      dB only, other sheet), STR and MDX; the listening mode
      (`Z1ALM`); a "forget a device" action; discovery by the Anthem UDP
      broadcast (DDP, port and packet in the official sheet).
- [ ] **Milestone 4 — first release**: Docker image build check, Release
      workflow, topic, then the store validator once the image is published.

## Decisions

- **Version 0.1.0** set by hand once (package.json, lock, manifest,
  `docker_image`); the Release workflow owns it from now on.
- **Protocol**: the official sheet "MRX x40, AVM 70/90 IP & RS-232" v5
  (2025-12, linked from anthemav.com). `python-anthemav` (MIT) read as an
  example only, notice in `THIRD_PARTY_NOTICES.md`.
- **Scope v1**: the x40 models of the sheet. The volume uses the per cent
  scale (`ZzPVOL`, 0..100), the cap too; a model without it keeps its volume
  unknown and Unmute is refused (the cap cannot be checked).
- **Identity**: the address (`<host>_<port>`), as the protocol gives no
  serial number in standby; one Gladys device per zone
  (`<host>_<port>_z<zone>`). A zone created in Gladys is known again from its
  external id when /data is lost.
- **No switch**: power and mute are buttons plus read-only states, so an
  "everything off" never commands an amplifier; Power off and Mute are the
  protective commands of the module (never blocked), Power on, Unmute and
  the volume go through the cap.
- **Protective commands, r1**: one slot per kind and zone (power off, mute),
  in /data too; a press succeeds only when confirmed by a read or replaced by
  a command that left; a press asks a connection at once (2 s apart at most,
  outside the backoff); a command never sent expires only after a failed
  attempt made past the hold. The cap checks after a power on go on (every
  5 s) for the whole 2-minute window. TCP keepalive on the socket.
- **Protective commands**: outside the zone queue, first on the connection
  (at most behind the one request on the wire, 1 s), commands waiting are
  cancelled and a command already dequeued is dropped before it is written
  (`beforeSend`); retried every 250 ms in the budget, then kept 2 minutes
  (/data too) and sent when the device is identified again, before any read;
  sent again (3 sends) only when a query made after the last send shows it
  not applied, never on a report sent by the device itself; a Power on (or
  an Unmute) that left ends it.
- **Confirmation**: a command is done when a query made after it shows the
  value; otherwise "sent, without confirmation" / "sent, not applied yet"
  and the zone is read 5 s and 20 s later.
- **Late answers**: a ";" cannot be told from the ";" of the next command,
  so commands are confirmed by a read made after them. A query answered
  within `requestTimeout` after a query of the same prefix timed out is
  tagged with the number of the older query: no decision that needs a read
  made after a command rests on it, and no chain of timeouts.
- **Publication**: states grouped per zone (1 s) and 300 states a minute at
  most, all zones together.
- **No settings written** on the device: Tx status (`GCTXS`) is not turned
  on (python-anthemav does); the zones are read every 30 s instead.
- **No discovery in v1**: the device broadcasts a UDP packet (DDP), which
  the SDK cannot listen to without a capture; addresses are typed.
- **Countries**: none (Anthem is sold worldwide).
- **Keywords** (for the store, when it takes them): anthem, mrx, avm, av
  receiver, amplifier, home cinema.
- **Forum**: no dedicated topic, no post from this module's work; the recap
  is posted by the lot.

## Next patch

- Review minors: see `_lots/lot25/reviews/anthem-r2.md` (M1 écart de 2 s non testé, M2 survivants, M3 course après 3 envois).
