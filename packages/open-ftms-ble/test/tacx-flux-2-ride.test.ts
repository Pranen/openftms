import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { FtmsTrainer, ReplayTransport, parseIndoorBikeData, parseMachineStatus, fromHex, parseRecording } from '../src/index.js';

async function loadRide() {
  const text = await readFile(new URL('./fixtures/tacx-flux-2-ride.json', import.meta.url), 'utf-8');
  return parseRecording(JSON.parse(text));
}

describe('Tacx Flux 2 recorded ride (2026-11-14)', () => {
  it('parses every recorded packet without diagnostics', async () => {
    const ride = await loadRide();
    const packets = ride.devices[0]?.packets ?? [];
    const bikeData = packets.filter((p) => p.uuid.startsWith('00002ad2'));
    const status = packets.filter((p) => p.uuid.startsWith('00002ada'));
    expect(bikeData.length).toBeGreaterThan(700);
    for (const p of bikeData) {
      const d = parseIndoorBikeData(fromHex(p.hex));
      expect(d.diagnostics).toEqual({ truncated: false, trailingBytes: 0, reservedFlags: 0 });
      expect([0x44, 0x64]).toContain(d.rawFlags); // 0x64 = with resistance level (resistance mode)
    }
    const types = new Set(status.map((p) => parseMachineStatus(fromHex(p.hex)).type));
    expect(types).toEqual(new Set(['indoorBikeSimulationParametersChanged', 'targetResistanceLevelChanged']));
    const peak = Math.max(...bikeData.map((p) => parseIndoorBikeData(fromHex(p.hex)).instantaneousPowerW ?? 0));
    expect(peak).toBeGreaterThan(100);
  });

  it('replays into FtmsTrainer like the real trainer', async () => {
    const transport = new ReplayTransport(await loadRide(), { latencyMs: 1, speed: 20 });
    const trainer = new FtmsTrainer({ transport, commandTimeoutMs: 200 });
    try {
      await trainer.connect();
      expect(trainer.deviceName).toBe('Tacx Flux-2 26370');
      expect(trainer.capabilities?.powerRange?.maximum).toBe(800);
      expect(trainer.capabilities?.deviceInformation.modelNumber).toBe('T2980');
      expect(trainer.control).toBe('granted');
      await expect.poll(() => trainer.telemetry.updatedAt).toBeDefined();
      await expect(trainer.setSimulation({ gradePercent: 5 })).resolves.toBeUndefined();
    } finally {
      await trainer.disconnect();
    }
  });
});
