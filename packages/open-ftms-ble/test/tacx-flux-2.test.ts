import { describe, expect, it } from 'vitest';
import {
  CHARACTERISTIC,
  FtmsTrainer,
  MockPeripheral,
  MockTransport,
  SERVICE,
  fromHex,
  parseControlPointResponse,
  parseFitnessMachineFeatures,
  parseHeartRateMeasurement,
  encodeSetTargetPower,
  parseIndoorBikeData,
  parseMachineStatus,
  toHex,
  parseSupportedPowerRange,
  parseSupportedResistanceLevelRange,
} from '../src/index.js';
import { HEART_RATE_STRAP, TACX_FLUX_2 as FLUX } from './fixtures/tacx-flux-2.js';

describe('Tacx Flux 2 recordings', () => {
  it('parses the feature flags', () => {
    const f = parseFitnessMachineFeatures(fromHex(FLUX.fitnessMachineFeature));
    expect(f.machine.cadence).toBe(true);
    expect(f.machine.resistanceLevel).toBe(true);
    expect(f.machine.powerMeasurement).toBe(true);
    expect(f.machine.totalDistance).toBe(false);
    expect(f.machine.heartRateMeasurement).toBe(false);
    expect(f.targetSetting.powerTarget).toBe(true);
    expect(f.targetSetting.resistanceTarget).toBe(true);
    expect(f.targetSetting.indoorBikeSimulation).toBe(true);
    expect(f.targetSetting.spinDownControl).toBe(true);
    expect(f.targetSetting.inclinationTarget).toBe(false);
    expect(f.targetSetting.wheelCircumference).toBe(false);
  });

  it('parses the supported ranges', () => {
    expect(parseSupportedPowerRange(fromHex(FLUX.supportedPowerRange))).toMatchObject({
      minimum: 0,
      maximum: 800,
      increment: 1,
    });
    expect(parseSupportedResistanceLevelRange(fromHex(FLUX.supportedResistanceLevelRange))).toMatchObject({
      minimum: 0,
      maximum: 100,
      increment: 0.1,
    });
  });

  it('parses Indoor Bike Data (speed, cadence, power only)', () => {
    const d = parseIndoorBikeData(fromHex(FLUX.indoorBikeData.pedalling));
    expect(d.instantaneousSpeedKmh).toBeCloseTo(3.5);
    expect(d.instantaneousCadenceRpm).toBe(11);
    expect(d.instantaneousPowerW).toBe(9);
    expect(d.resistanceLevel).toBeUndefined();
    expect(d.totalDistanceM).toBeUndefined();
    const resistance = parseIndoorBikeData(fromHex(FLUX.indoorBikeData.resistanceMode));
    expect(resistance.resistanceLevel).toBe(186); // sint16, raw = target 18.6 × 10
    expect(resistance.instantaneousPowerW).toBe(0);
    for (const hex of Object.values(FLUX.indoorBikeData)) {
      const parsed = parseIndoorBikeData(fromHex(hex));
      expect(parsed.diagnostics.truncated).toBe(false);
      expect(parsed.diagnostics.trailingBytes).toBe(0);
    }
  });

  it('matches the recorded ERG exchange', () => {
    const erg = FLUX.setTargetPower120;
    expect(toHex(encodeSetTargetPower(120))).toBe(erg.write);
    expect(parseMachineStatus(fromHex(erg.machineStatus))).toMatchObject({ type: 'targetPowerChanged', targetPowerW: 120 });
    expect(parseControlPointResponse(fromHex(erg.response))).toMatchObject({ request: 'setTargetPower', success: true });
  });

  it('parses the control point and heart-rate packets', () => {
    expect(parseControlPointResponse(fromHex(FLUX.requestControlResponse))).toMatchObject({
      requestOpCode: 0x00,
      result: 'success',
    });
    expect(parseHeartRateMeasurement(fromHex(HEART_RATE_STRAP.measurement))).toMatchObject({
      heartRateBpm: 78,
      sensorContact: 'detected',
    });
  });

  it('connects to a replayed Flux 2 and clamps ERG to 800 W', async () => {
    const text = (s: string) => new TextEncoder().encode(s);
    const peripheral: MockPeripheral = new MockPeripheral({
      name: FLUX.name,
      latencyMs: 1,
      services: [
        {
          uuid: SERVICE.fitnessMachine,
          characteristics: [
            { uuid: CHARACTERISTIC.fitnessMachineFeature, properties: { read: true }, value: fromHex(FLUX.fitnessMachineFeature) },
            { uuid: CHARACTERISTIC.supportedPowerRange, properties: { read: true }, value: fromHex(FLUX.supportedPowerRange) },
            {
              uuid: CHARACTERISTIC.supportedResistanceLevelRange,
              properties: { read: true },
              value: fromHex(FLUX.supportedResistanceLevelRange),
            },
            { uuid: CHARACTERISTIC.indoorBikeData, properties: { notify: true } },
            { uuid: CHARACTERISTIC.fitnessMachineStatus, properties: { notify: true } },
            {
              uuid: CHARACTERISTIC.fitnessMachineControlPoint,
              properties: { write: true, indicate: true },
              onWrite: (bytes) => {
                peripheral
                  .characteristic(SERVICE.fitnessMachine, CHARACTERISTIC.fitnessMachineControlPoint)
                  .notify([0x80, bytes[0] ?? 0, 0x01]);
              },
            },
          ],
        },
        {
          uuid: SERVICE.deviceInformation,
          characteristics: [
            { uuid: CHARACTERISTIC.manufacturerName, properties: { read: true }, value: text('Tacx') },
            { uuid: CHARACTERISTIC.modelNumber, properties: { read: true }, value: text('T2980') },
            { uuid: CHARACTERISTIC.firmwareRevision, properties: { read: true }, value: text('3.3.45') },
          ],
        },
      ],
    });
    const trainer = new FtmsTrainer({ transport: new MockTransport([peripheral]), commandTimeoutMs: 200 });
    try {
      await trainer.connect();
      const caps = trainer.capabilities;
      expect(caps?.deviceInformation).toMatchObject(FLUX.deviceInformation);
      expect(caps?.characteristics).toEqual(FLUX.characteristics);
      await expect.poll(() => trainer.control).toBe('granted');

      peripheral.characteristic(SERVICE.fitnessMachine, CHARACTERISTIC.indoorBikeData).notify(fromHex(FLUX.indoorBikeData.pedalling));
      await expect.poll(() => trainer.telemetry.powerW).toBe(9);

      await trainer.setTargetPower(1200);
      expect(trainer.mode).toEqual({ kind: 'erg', targetPowerW: 800 });
      await expect(trainer.setSimulation({ gradePercent: 5 })).resolves.toBeUndefined();
    } finally {
      await trainer.disconnect();
    }
  });
});
