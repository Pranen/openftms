# open-ftms

Zero-dependency TypeScript library for Web Bluetooth fitness devices — FTMS trainers
(primary target: Tacx Flux 2) and BLE heart-rate monitors — plus a demo/test harness.

| Path | Content |
|---|---|
| `packages/open-ftms-ble` | the library (`transport/` → `protocol/` → `devices/`) |
| `apps/demo` | Vite test harness: telemetry (left) and control (right); live at [pranen.github.io/openftms](https://pranen.github.io/openftms/) |
| `docs` | [API](docs/api.md), [How-To: interval training](docs/howto-interval-training.md), [troubleshooting](docs/troubleshooting.md), [deployment](docs/deployment.md) (German) |

## Library at a glance

```ts
import { FtmsTrainer, HeartRateMonitor } from 'open-ftms-ble';

const trainer = new FtmsTrainer();            // Web Bluetooth by default
trainer.on('telemetry', (t) => render(t.powerW, t.cadenceRpm, t.speedKmh));
trainer.on('connectionStateChange', (e) => console.log(e.state));

button.onclick = () => trainer.connect();     // must run in a user gesture
await trainer.setTargetPower(200);            // ERG
await trainer.setSimulation({ gradePercent: 4, windSpeedMps: 2 });

// No hardware? Same API on a simulated trainer:
// const sim = new SimulatedTrainer();
// const trainer = new FtmsTrainer({ transport: new MockTransport([sim.peripheral]) });
```

Defaults: control is requested automatically (and re-requested after a loss),
lost connections are re-established with backoff, and the last ERG/simulation
target is restored after a reconnect. Slider bursts are coalesced ("latest wins").

| Layer | Path | Content |
|---|---|---|
| devices | `src/devices` | `FtmsTrainer`, `HeartRateMonitor`, connection state machine, control point client |
| protocol | `src/protocol` | pure parsers/encoders for FTMS (0x2AD2, 0x2ADA, 0x2ACC, 0x2AD3, ranges, 0x2AD9) and HRS (0x2A37) |
| transport | `src/transport` | Web Bluetooth, mock transport, GATT queue |
| simulator | `src/simulator` | software trainer and heart-rate strap on the mock transport |
| replay | `src/replay` | `SessionRecorder` and `ReplayTransport`: record real rides, replay them without hardware |
| examples | `examples` | `interval-workout.ts`, the tested code of the interval How-To |

## Demo harness

`npm run dev`, then open http://localhost:5173 in Chrome/Edge. Switch the source
to **Simulator** to try everything without hardware (incl. link loss, control
loss and "another app holds control"). The right column sends Request Control,
Reset, Start/Pause/Stop, ERG, simulation (grade, wind, Crr, Cw), resistance and
raw control point bytes; "live" sends while dragging (coalesced, latest wins).
**Intervall-Programm** runs the How-To workout (with a ×10 time-lapse).

- **Bericht kopieren/herunterladen**: text report with device info and capabilities
  of every device seen (kept after disconnecting), events, GATT timings and the last packets.
- **Aufnahme herunterladen / Aufnahme laden…**: record a session as JSON and
  replay it later as a source, without hardware.
- **Letzten Trainer/Pulsgurt verbinden**: reconnect a device picked earlier without the chooser.

## Development

```bash
npm install
npm run dev        # demo on http://localhost:5173 (Chrome/Edge); no auto-reload (keeps BLE + logs), DEMO_HMR=1 enables it
npm test           # library unit tests
npm run typecheck
npm run build
npm pack -w open-ftms-ble   # tarball for other projects: npm install ./open-ftms-ble-0.1.0.tgz
```

Web Bluetooth works in Chromium browsers only (Chrome, Edge) and needs a secure
context (`https://` or `localhost`). On Windows, do not pair the trainer in the
OS Bluetooth settings.

## License

[MIT](LICENSE)
