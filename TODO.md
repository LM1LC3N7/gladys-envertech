# TODO

## Before announcing

- [ ] Test on a real Gladys 5.2+ with a real EVT800: test button, device
      creation, the night, a sunrise, the production the core derives from
      the index.
- [ ] Test the Docker image (no Docker on the development PC yet).
- [ ] Run the store validator (`npx github:GladysAssistant/integration-store .`):
      the development agent could not run it.
- [ ] Turn on "Private vulnerability reporting" (SECURITY.md points there).
- [ ] Add the `gladys-assistant-integration` topic to publish in the store
      (after the first release: the store validator needs the GHCR image).

## To confirm on a real inverter (built without one)

- [ ] How often the inverter sends a frame (the library waits 60 s at most;
      we close after 90 s of silence).
- [ ] Whether the inverter accepts a second client (Home Assistant and Gladys
      at the same time), and whether it closes the link after each frame.
- [ ] The lifetime counter of each input: kept across the night (the index
      relies on it), never reset by a reboot? A reset is held as a drop
      (the button takes it).
- [ ] A one-input model: its frame length (the library reads the second block
      only beyond 71 bytes; an absent block has an id of 0 here).
- [ ] The acknowledgement of a poll frame echoes bytes 20 to 23 of it, as the
      library does (not the serial): kept as it is.
- [ ] The id of each input: hexadecimal here (the library prints the bytes as
      decimal pairs, 49828832 for 31 52 58 20); the label of the inverter tells.

## Decisions

- **Versions**: 0.1.0 set once by hand when leaving the template (package,
  lock file, manifest, image tag `ghcr.io/lm1lc3n7/gladys-envertech:0.1.0`),
  as for the sibling integrations; the Release workflow owns them from now on
  (the first patch release gives 0.1.1).
- **Reused project**: pyenvertechevt800 (Daniel Bergmann, MIT, 0.2.4 on PyPI,
  `main` at commit 8652cf6), cloned read-only in `_ref/pyenvertech-evt800`,
  ported to JavaScript: the TCP link, the frames, their scales and offsets,
  the acknowledgement, the fixtures of its tests. Full notice in
  THIRD_PARTY_NOTICES.md, copied into the image. The SDK stays the only
  runtime dependency. The template's demo files were removed with `git rm`
  (they stay in the history).
- **Framing**: by the length byte (byte 2), header `68 00 L 68` and end byte
  `16` checked; the library cuts at the first `16` after `68 00`, which a
  value can hold (tested). A 32-byte frame is a poll (serial only); a data
  frame holds one 32-byte block per input from byte 20, two at most as the
  library. A raw `FFFF` (`FFFFFFFF`) is "not given". No checksum check: the
  library has none and the last byte of the fixtures matches no simple sum.
- **Read-only**: no `onSetValue`; the only bytes sent are the library's
  acknowledgement of each frame of 24 bytes or more (the inverter expects it).
- **External id** (forever): `inverter:<serial>`, the 8 hexadecimal digits of
  bytes 6 to 9 of every frame (the poll frame gives the same serial). One
  inverter per integration. A frame with an unreadable serial (all 0 or all
  F) or without any input is ignored, never "another inverter"; a frame with
  another serial (a DHCP swap) is published to that inverter's own device
  (offered in Discovery), never to the previous one; the serial and the
  number of inputs are kept in `/data` so that the device is offered at a
  restart by night.
- **Features fixed by inputs**: 1 or 2 inputs, the most seen or created; a
  republished device keeps every feature of the created one
  (`keepCreatedFeatures`, as gladys-apsystems).
- **The index**: the sum of the lifetime counters of every input of the
  created device, only when each gives one (lot 13 lesson on partial totals),
  rounded to 0.001 kWh, through the guard of gladys-p1-monitor as gladys-omnik
  carries it (`maxKw` a parameter): 1.25 x the peak power typed (0.5 to
  10 kW), else 2 kW, slack 0.1 kWh. A jump or a drop is held until the
  button; a drop may be accepted (a real counter reset gives the core a
  negative delta, nothing counted), as gladys-p1-monitor. The counters per
  input are not published (they would be counted twice, and the core has no
  type for a counter it must not count). No `daily-production`: the frame
  has no counter of the day.
- **The link and the pace**: one TCP link kept open, closed after 90 s
  without a frame, by a flood (64 KiB a minute, 4 KiB of acknowledgements
  not read) or after 2 KiB without a frame (`unknown_answer`). A connection
  attempt at most once a minute (5 minutes asleep), whatever asks; the time
  of the last attempt in `/data`, written before connecting, at most once a
  minute. A reconnection to Gladys or a save of the same address keeps the
  link (`stop` only pauses the publication; the container shutdown closes
  it). The last frame published at most once a minute, never one older than
  2 minutes.
- **The night** (gladys-omnik rules, 20 W instead of 50 W for a micro-inverter):
  three failed attempts after a power under 20 W, or an hour of failures
  whatever the power, is asleep (power 0, online 0, green); red: a link lost
  while producing 20 W or more (retries 1 min doubled to 15 min), a wrong
  answer, a flood, or no frame for more than a day.
- **No credentials, no cloud, no 429/5xx**: the link has neither; nothing
  secret in the form, the logs, `/data` or the statuses.
- **States**: `publishChangedStates` with a 10-minute heartbeat: at most 16
  states a minute (tested under 20), far below the 300 states a minute of
  Gladys. No scene event (`publishSceneEvent` is never called).
- **Units**: W and kWh (energy-production-sensor), V and A (energy-sensor),
  °C (device-temperature-sensor: the inverter's own temperature), none for
  the online flag and the frequency (no Hz unit in the core, as
  gladys-apsystems): all in `DEVICE_FEATURE_UNITS_BY_CATEGORY`.
- **No custom User-Agent**, no imitation: Node's own sockets.
- **Gladys version**: `>=5.2.0`, like the other energy integrations.

## Ideas

- Several inverters in one integration (a list of addresses).
- The firmware version per input, once confirmed.
