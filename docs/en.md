# Anthem for Gladys Assistant

Control your Anthem AV receivers and processors from Gladys, on your local
network, without any cloud: power, volume, mute and source of the main zone
and of zone 2.

> Unofficial integration, not affiliated with Anthem. It follows the official
> Anthem IP control sheet ("MRX x40, AVM 70/90 IP & RS-232" v5) but has
> **never been tested with a real device**: your feedback is welcome.

## Supported devices

The models of the official sheet: **MRX 540, MRX 740, MRX 1140** receivers and
**AVM 70, AVM 90** processors. Zone 2 appears when the device answers for it
(MRX 740, MRX 1140, AVM 70, AVM 90).

Other Anthem models with IP control (older MRX x20 and x10, AVM 60, STR, MDX)
may answer some commands: power, mute and source may work; the volume needs
the per cent scale of the x40 models, so it stays unknown on the others and
unmuting from Gladys is then refused (the volume cap cannot be checked).

## Setting up the device

1. Connect the device to your network (Ethernet or Wi-Fi).
2. In its setup menu, turn on **IP control in standby** (also called
   connected standby): without it, the device cannot be reached while it is
   off, and Gladys cannot power it on.
3. Give it a **fixed IP address** in your router (DHCP reservation).
4. The IP control port is **14999** unless you changed "TCP Port".

The device accepts a limited number of IP clients at a time and closes the
oldest one when a new one arrives: if the Anthem app or another home
automation system is also connected, the connections may push each other out.
Gladys then reconnects at spaced intervals (10 s, doubled up to 5 minutes).

## Setting up the integration

- **IP addresses of the devices**: separated by commas, for example
  `192.168.1.40, 192.168.1.41`, with the port when it is not 14999
  (`192.168.1.40:15000`).
- **Volume cap** (1 to 100 %, 40 by default): the highest volume Gladys may
  set, on the per cent scale of the device (30 % is -25 dB, 40 % is -20 dB,
  each per cent above 30 is 0.5 dB more; 100 % is +10 dB). 100: no cap.

Then each zone appears in the **Discovery** tab: create the ones you want.
The **Check the devices** button shows the state of each zone and the cap.

## What you get, for each zone

| Feature   | Kind            | What it does                                                       |
| --------- | --------------- | ------------------------------------------------------------------ |
| Power     | read only (0/1) | 1 when the zone is on, 0 when it is off or the device unreachable  |
| Power on  | button          | turns the zone on, then brings its volume back to the cap if above |
| Power off | button          | turns the zone off (protective: see below)                         |
| Volume    | 0 to 100 %      | sets the volume, never above the cap                               |
| Muted     | read only (0/1) | 1 when the zone is muted                                           |
| Mute      | button          | mutes the zone (protective: see below)                             |
| Unmute    | button          | unmutes, after lowering a volume above the cap                     |
| Source    | dropdown        | the inputs of the device, by their name                            |

There is no on/off switch on purpose: an "everything off" or "everything on"
of a scene or a voice assistant never powers an amplifier on.

The states are read when a zone changes (when the device reports it) and every
30 seconds. A command is reported as done only when a read made after it
shows the value asked; otherwise Gladys says "sent, without confirmation" or
"sent, not applied yet", and the zone is read again 5 and 20 seconds later.

### The volume cap

Every volume set from Gladys (dashboard, scene, voice assistant) goes through
the cap, read just before the command leaves: a higher value is set to the
cap. Unmuting first reads the volume and lowers it to the cap when above,
then unmutes only once a read shows it at the cap or below; if the volume
cannot be read, nothing is sent. After a **Power on** from Gladys,
the volume is read as soon as the zone gives it (within 2 minutes) and
lowered to the cap when above. The volume set on the device itself (knob,
remote, Anthem app) is not changed otherwise.

### Power off and Mute are never blocked

Power off and Mute do not wait behind the other commands of the zone (those
still waiting are cancelled, so nothing asked before goes after them), go
first on the connection (at most behind the one request on the wire, 1 second
at most), and do not depend on the volume cap, on the configuration (even if
Gladys cannot give it), on a state read before, or on a full request queue.

They are not sent, or not confirmed, in these cases only:

- **the device is not connected**: tried again every 250 ms for about 3 seconds,
  then kept (also across a restart of the integration) and sent as soon as
  the connection comes back, for 2 minutes at most;
- **the device refuses them** (an error answer): reported as refused;
- **Mute on a zone that is off** (or a device in standby): nothing plays,
  reported as done;
- **no confirmation within the 5 seconds Gladys waits**: reported as "sent,
  without confirmation".

While not confirmed, they are sent again (3 sends at most, within 2 minutes)
when a read made after them still shows the zone on (or unmuted); a change
the device reports by itself (the remote, the app) never makes them sent
again. A Power on from Gladys that left ends this for Power off, an Unmute
from Gladys that left ends it for Mute.

## Troubleshooting

- **"No Anthem device answers yet"**: check the address, the port, that IP
  control in standby is on, and that nothing blocks port 14999.
- **Not connected while the device is off**: IP control in standby is off.
- **The volume stays unknown**: the model has no per cent volume scale (see
  Supported devices).
- **A source is missing**: the inputs are read when a zone is on; turn it on
  once.

## Privacy

Everything stays on your local network. The integration keeps in `/data` the
devices it found (address, model, zones, input names), the last volume cap,
and the Power off / Mute commands not confirmed yet. No account, no password,
no cloud.
