# gladys-envertech

Unofficial [Gladys Assistant](https://gladysassistant.com) integration for
**Envertech EVT800 micro-inverters**, not affiliated with Envertech. It reads
the inverter on your network through its local TCP link ("TCP server" mode,
port 14889; no cloud, no account): solar power, power, voltage, current and
temperature of each input, AC voltage, grid frequency, and a guarded solar
production index for the Gladys energy monitoring (the sum of the lifetime
counters of the inputs). The night is handled (the inverter sleeps: power 0,
no error). Read-only: it only acknowledges the frames of the inverter.

**Never tested with a real device.** Built from the
[pyenvertechevt800](https://github.com/daniel-bergmann-00/pyenvertech-evt800)
library (MIT, see `THIRD_PARTY_NOTICES.md`), the one Home Assistant uses; the
protocol is not documented by Envertech. The structure and the index guard
come from [gladys-omnik](https://github.com/LM1LC3N7/gladys-omnik) and
[gladys-p1-monitor](https://github.com/LM1LC3N7/gladys-p1-monitor).

- User guide: [English](docs/en.md), [français](docs/fr.md)
- Changes: [CHANGELOG.md](CHANGELOG.md)
- What is left to check: [TODO.md](TODO.md)
- Rules for contributors: [CLAUDE.md](CLAUDE.md)

## Development

```bash
npm install
npm test
npm run lint
npm run format:check
npm run audit
npm run cover        # regenerates cover.png (800 x 534, plain Node)
```

Node 22 or later. The only runtime dependency is
`@gladysassistant/integration-sdk`.

## License

Apache-2.0, see `LICENSE` and `THIRD_PARTY_NOTICES.md`.
