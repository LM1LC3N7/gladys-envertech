# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the project below, distributed under its own
license, the MIT License, whose full notice is reproduced here.

## pyenvertechevt800 (daniel-bergmann-00/pyenvertech-evt800)

<https://github.com/daniel-bergmann-00/pyenvertech-evt800>, by Daniel
Bergmann, the library the Envertech EVT800 integration of Home Assistant uses.
Version 0.2.4 on PyPI (2025-10-16), branch `main` at commit 8652cf6.

Ported to JavaScript in `src/evt800/protocol.js` and `src/evt800/client.js`:
the local TCP link of the inverter (its "TCP server" mode, port 14889), the
frames it sends (the poll frame of 32 bytes and its serial, the data frame
and the layout, scales and offsets of each input: id, firmware, DC voltage,
power, lifetime energy, temperature, AC voltage, AC frequency, the current as
power over voltage), the acknowledgement sent back for each frame (its fixed
bytes and the four bytes echoed), the reconnection after a silence, and the
frames of its tests (`tests/test_init.py`, used in `test/fixtures/evt800.js`).
Changed here: a frame is cut by its length byte and its header and end byte
are checked (the library cuts at the first 0x16), the reads are bounded in
size and time and every search is linear, a raw value of 0xFFFF is "not
given", the ids are written in hexadecimal, and the values are checked
against plausible ranges before they are published.

Its license notice, reproduced as it appears in its `LICENSE` file:

```
The MIT License (MIT)

Copyright (c) 2025 Daniel Bergmann

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## gladys-omnik, gladys-apsystems and gladys-p1-monitor

The structure of the integration (`src/app.js`: the pace, the night, the
session per address, the buttons), the plausibility guard of the energy index
(`src/guard.js`, from gladys-p1-monitor, its margin a parameter, taken from
gladys-omnik as it is), the `/data` store (`src/store.js`), the address parser
(`src/config.js`) and the features kept on a republished device
(`keepCreatedFeatures` in `src/devices.js`) come from the sibling
integrations [gladys-omnik](https://github.com/LM1LC3N7/gladys-omnik),
[gladys-apsystems](https://github.com/LM1LC3N7/gladys-apsystems) and
[gladys-p1-monitor](https://github.com/LM1LC3N7/gladys-p1-monitor), same
project, Apache-2.0.
