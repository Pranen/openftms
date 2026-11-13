import { describe, expect, it } from 'vitest';
import {
  fromHex,
  hasParseIssues,
  parseFitnessMachineFeatures,
  parseSupportedHeartRateRange,
  parseSupportedInclinationRange,
  parseSupportedPowerRange,
  parseSupportedResistanceLevelRange,
  parseSupportedSpeedRange,
  parseTrainingStatus,
} from '../src/index.js';

describe('parseFitnessMachineFeatures (0x2ACC)', () => {
  it('decodes machine and target-setting feature bits', () => {
    // machine: cadence(1), heart rate(10), power(14); target: resistance(2), power(3), simulation(13)
    const f = parseFitnessMachineFeatures(fromHex('02 44 00 00 0c 20 00 00'));
    expect(f.rawMachineFeatures).toBe(0x4402);
    expect(f.machine.cadence).toBe(true);
    expect(f.machine.heartRateMeasurement).toBe(true);
    expect(f.machine.powerMeasurement).toBe(true);
    expect(f.machine.totalDistance).toBe(false);
    expect(f.targetSetting.resistanceTarget).toBe(true);
    expect(f.targetSetting.powerTarget).toBe(true);
    expect(f.targetSetting.indoorBikeSimulation).toBe(true);
    expect(f.targetSetting.speedTarget).toBe(false);
    expect(hasParseIssues(f.diagnostics)).toBe(false);
  });

  it('reports reserved bits and truncation', () => {
    expect(parseFitnessMachineFeatures(fromHex('00 00 10 00 00 00 00 00')).diagnostics.reservedFlags).toBe(0x100000);
    expect(parseFitnessMachineFeatures(fromHex('02 44 00 00')).diagnostics.truncated).toBe(true);
  });
});

describe('parseTrainingStatus (0x2AD3)', () => {
  it('parses a status without string', () => {
    expect(parseTrainingStatus(fromHex('00 01'))).toMatchObject({ status: 'idle', statusCode: 1 });
  });

  it('parses a status with string', () => {
    const t = parseTrainingStatus(fromHex('01 0d 41 42'));
    expect(t.status).toBe('manualMode');
    expect(t.statusString).toBe('AB');
  });

  it('maps unknown codes', () => {
    expect(parseTrainingStatus(fromHex('00 fb')).status).toBe('unknown');
  });
});

describe('supported ranges', () => {
  it('power range 0x2AD8', () => {
    expect(parseSupportedPowerRange(fromHex('00 00 d0 07 01 00'))).toMatchObject({
      minimum: 0,
      maximum: 2000,
      increment: 1,
    });
  });

  it('resistance range 0x2AD6, 6-byte (spec) layout', () => {
    expect(parseSupportedResistanceLevelRange(fromHex('00 00 64 00 01 00'))).toMatchObject({
      minimum: 0,
      maximum: 10,
      increment: 0.1,
      encoding: 'sint16',
    });
  });

  it('resistance range 0x2AD6, 3-byte layout', () => {
    expect(parseSupportedResistanceLevelRange(fromHex('01 64 01'))).toMatchObject({
      minimum: 1,
      maximum: 100,
      increment: 1,
      encoding: 'uint8',
    });
  });

  it('inclination, speed and heart rate ranges', () => {
    expect(parseSupportedInclinationRange(fromHex('38 ff c8 00 01 00'))).toMatchObject({
      minimum: -20,
      maximum: 20,
      increment: 0.1,
    });
    expect(parseSupportedSpeedRange(fromHex('00 00 10 27 0a 00'))).toMatchObject({
      minimum: 0,
      maximum: 100,
      increment: 0.1,
    });
    expect(parseSupportedHeartRateRange(fromHex('28 dc 01'))).toMatchObject({
      minimum: 40,
      maximum: 220,
      increment: 1,
    });
  });

  it('reports truncated ranges', () => {
    const r = parseSupportedPowerRange(fromHex('00 00 d0'));
    expect(r.minimum).toBe(0);
    expect(r.maximum).toBeUndefined();
    expect(r.diagnostics.truncated).toBe(true);
  });
});
