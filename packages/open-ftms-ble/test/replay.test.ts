import { describe, expect, it } from 'vitest';
import {
  FtmsTrainer,
  HeartRateMonitor,
  MockTransport,
  ReplayTransport,
  SessionRecorder,
  SimulatedHeartRateMonitor,
  SimulatedTrainer,
  delay,
  parseRecording,
} from '../src/index.js';

async function record() {
  const sim = new SimulatedTrainer({ intervalMs: 10, latencyMs: 1 });
  const simHrm = new SimulatedHeartRateMonitor({ intervalMs: 10, latencyMs: 1 });
  const transport = new MockTransport([sim.peripheral, simHrm.peripheral]);
  const trainer = new FtmsTrainer({ transport });
  const hrm = new HeartRateMonitor({ transport });
  const recorder = new SessionRecorder();
  recorder.attach(trainer, 'Trainer');
  recorder.attach(hrm, 'Pulsgurt');
  await trainer.connect();
  await hrm.connect();
  await trainer.setTargetPower(220);
  await delay(120);
  await trainer.disconnect();
  await hrm.disconnect();
  recorder.detach();
  return recorder.toRecording();
}

describe('SessionRecorder + ReplayTransport', () => {
  it('records reads, notifications and writes as JSON', async () => {
    const recording = await record();
    const roundTrip = parseRecording(JSON.parse(JSON.stringify(recording)));
    expect(roundTrip.devices.map((d) => d.label)).toEqual(['Trainer', 'Pulsgurt']);
    const kinds = new Set(roundTrip.devices[0]?.packets.map((p) => p.kind));
    expect(kinds).toEqual(new Set(['read', 'notification', 'write']));
  });

  it('replays a recording into the same device API', async () => {
    const recording = await record();
    const transport = new ReplayTransport(recording, { latencyMs: 1, speed: 4 });
    const trainer = new FtmsTrainer({ transport, commandTimeoutMs: 200 });
    const hrm = new HeartRateMonitor({ transport });
    try {
      await trainer.connect();
      await hrm.connect();
      expect(trainer.deviceName).toBe('Simulated FTMS Trainer');
      expect(trainer.capabilities?.powerRange?.maximum).toBe(2000);
      expect(trainer.capabilities?.deviceInformation.manufacturerName).toBe('open-ftms');
      expect(trainer.control).toBe('granted');
      await expect.poll(() => trainer.telemetry.powerW).toBeGreaterThan(0);
      await expect.poll(() => hrm.heartRateBpm).toBeGreaterThan(0);
      await expect(trainer.setTargetPower(150)).resolves.toBeUndefined();
    } finally {
      await trainer.disconnect();
      await hrm.disconnect();
    }
  });

  it('rejects foreign JSON', () => {
    expect(() => parseRecording({ hello: 'world' })).toThrow(/Not an open-ftms recording/);
  });
});
