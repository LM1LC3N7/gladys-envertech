# Envertech for Gladys Assistant

Unofficial connector, not affiliated with Envertech. It reads your Envertech
EVT800 micro-inverter on your home network, through its local TCP link,
without any cloud and without any account.

**Never tested with a real device**: it was built from the pyenvertechevt800
library (the one Home Assistant uses) and the frames of its tests. The
protocol is not documented by Envertech. Please report what you see (see
"Feedback" below).

## What you get

One Gladys device per micro-inverter, named after its serial number:

| Feature                      | What it is                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| Solar production (W)         | the power of all its inputs together; 0 at night                                        |
| Solar production index (kWh) | a cumulative index for the Gladys energy monitoring (production per half hour, revenue) |
| Inverter online              | 1 while the inverter sends its frames, 0 asleep (the night)                             |
| AC voltage (V)               | the grid voltage the inverter sees                                                      |
| Grid frequency (Hz)          | a plain number (Gladys has no Hz unit)                                                  |
| Input n power (W)            | the power of each input (one panel each)                                                |
| Input n DC voltage (V)       | the voltage of the panel                                                                |
| Input n DC current (A)       | the current of the panel (power divided by voltage)                                     |
| Input n temperature (°C)     | the temperature the inverter gives for that input                                       |

Read-only: the integration only acknowledges the frames of the inverter (as
the library does, the inverter expects it), it never sends a command. The
inverter gives no counter of the day; its lifetime counter per input is not
published on its own (see "The energy index").

## Setting it up

1. The EVT800 must be in its "TCP server" mode (the mode the Home Assistant
   integration uses), listening on port 14889. Find its IP address in your
   router and give it a fixed address if you can.
2. In Gladys, open the integration, enter the address (by day: at night the
   inverter is powered off with its panels), and save. Add `:port` only if it
   is not 14889.
3. Open the "Discover" tab and create the device. Its values come with the
   next frame (within a minute by day).
4. Optional: enter the peak power of the panels on this inverter (kWp). It
   bounds what the energy index may take between two frames (2 kW when
   empty). Never enter less than the real peak power: in doubt, leave it
   empty.

The integration keeps one connection open and publishes the last frame at
most once a minute. It never tries to connect more than once a minute,
whatever asks (a restart, a save, the test button). The "Test the
connection" button tells the last frame, or makes the connection attempt when
one is due and waits for the first frame.

If another program (Home Assistant, for example) is connected to the
inverter at the same time, the inverter may refuse the second connection:
use one of them.

## The night

An EVT800 is powered by its panels: at sunset it stops and goes silent. That
is not an error: after three failed attempts with a power under 20 W (or an
hour of silence whatever the power), the inverter is "asleep", its powers go
to 0, the status stays green and says so, and it is tried every 5 minutes
until it wakes up. The status turns red if the inverter vanishes while
producing 20 W or more (new tries after 1 minute, doubled up to 15 minutes),
if the address does not give EVT800 frames, or if there is no frame for more
than a day.

## The energy index

Each input of the inverter has its own lifetime counter. The production index
is their sum, published only when every input gives its counter (a partial
sum would look like a drop, then a jump). It goes through a guard: it is
never 0; a jump larger than the peak power allows since the last value, or a
drop, is held back, shown in the integration status, and only taken when you
click "Accept the held index" in the configuration (a jump is then counted at
once; nothing is counted for a drop, the index goes on from there). Saving
the configuration never accepts anything.

## Limits

- One micro-inverter per integration; two inputs at most (as the library).
- The protocol is not documented: the meaning of each value comes from the
  library, checked only against the frames of its tests.
- The integration needs Gladys 5.2.0 or later.

## Privacy

Nothing leaves your network: the integration only talks to the address you
entered. Only the serial number, the number of inputs, the index guard and
the times of the last attempt and frame are kept in `/data`.

## Feedback

Issues and pull requests: <https://github.com/LM1LC3N7/gladys-envertech>. If
you own an EVT800, the integration logs (by day and at night, with the serial
numbers hidden) help a lot.
