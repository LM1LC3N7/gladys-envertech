# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Local reading of Envertech EVT800 micro-inverters through their TCP link
  ("TCP server" mode, port 14889), as the pyenvertechevt800 library does: no
  cloud, no account. One connection kept open, each frame acknowledged as the
  library does, nothing else sent; a connection attempt at most once a minute
  (every 5 minutes at night), whatever asks (reconnection, save, test button,
  Discover tab, restart: the time of the last attempt is kept in `/data`).
- One device per inverter (`inverter:<serial>`, the serial of every frame):
  solar power, inverter online, AC voltage, grid frequency, and the power, DC
  voltage, DC current and temperature of each input. A frame without a
  readable serial is ignored; a frame with another serial goes to its own
  device, never to the previous one. Values published at most once a minute,
  never from a frame older than 2 minutes.
- A solar production index for the Gladys energy monitoring: the sum of the
  lifetime counters of every input, only when each one gives it, checked by
  the guard of gladys-p1-monitor (never 0, a jump or a drop taken only by the
  "Accept the held index" button); its 30-minute production declared with
  stable ids.
- The night: three failed attempts after a low power (or an hour of silence)
  and the inverter is asleep: power 0, green status, no index; red only for
  an inverter that vanishes while producing, a wrong answer or a day without
  a frame.
- Frames bounded: cut by their length byte, one 1 KiB buffer, linear search,
  90 s of silence, a flood or 2 KiB without a frame closes the link.
- Guides in English and French, cover image, third-party notices in the image.
- The night after a low power dates the reference of the index again at every
  attempt: a wrong first frame in the morning is held.
- Counters reset when the inverter powers up in the morning (if it does): the
  index goes on from its value, across restarts of the container by day and
  by night; undone only if the old counters come back at once, never by the
  normal climb of the day.
- Only data frames of the inverter keep the link alive; one serial per
  connection; the inverter shown offline when the link is lost by day.
- A device gaining an input never counts the old counter of that input.

[Unreleased]: https://github.com/LM1LC3N7/gladys-envertech/commits/main
