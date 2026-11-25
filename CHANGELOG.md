# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Anthem AV receivers and processors (MRX 540, 740, 1140, AVM 70, 90) over
  their local IP control (TCP port 14999): one Gladys device per zone (main
  zone, and zone 2 when the device answers for it).
- Power state, Power on, Power off, volume (0 to 100 %), mute state, Mute,
  Unmute and source (the input names of the device) for each zone.
- A volume cap (40 % by default): every volume set from Gladys, unmuting and
  powering on never go above it.
- Power off and Mute are never blocked: they skip the queue of the zone,
  cancel the commands still waiting, are kept while the device is not
  connected (2 minutes, across a restart too) and sent again while a later
  read shows them not applied (3 sends at most).
- A command is reported as done only when a read made after it shows the
  value asked; the zone is read again 5 and 20 seconds later otherwise.
- A "Check the devices" button; the connection status says which address
  does not answer.
- Documentation in English and French.
