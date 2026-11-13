# open-ftms-ble

Zero-dependency TypeScript library for Web Bluetooth fitness devices: FTMS
smart trainers (tested with the Tacx Flux 2) and BLE heart-rate monitors.
Chrome/Edge, `https://` or `localhost`.

```ts
import { FtmsTrainer } from 'open-ftms-ble';

const trainer = new FtmsTrainer();
trainer.on('telemetry', (t) => console.log(t.powerW, t.cadenceRpm, t.speedKmh));
button.onclick = () => trainer.connect();   // user gesture
await trainer.setTargetPower(200);          // ERG
await trainer.setSimulation({ gradePercent: 4 });
```

- Control is requested automatically, lost connections are re-established and
  the last target is restored; slider bursts are coalesced.
- `SimulatedTrainer`, `MockTransport`, `SessionRecorder` and `ReplayTransport`
  let you build and test without hardware.

Documentation (German): [API](https://github.com/Pranen/openftms/blob/main/docs/api.md) ·
[How-To: interval training](https://github.com/Pranen/openftms/blob/main/docs/howto-interval-training.md) ·
[Troubleshooting](https://github.com/Pranen/openftms/blob/main/docs/troubleshooting.md)
