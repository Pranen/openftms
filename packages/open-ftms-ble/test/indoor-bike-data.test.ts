import { describe, expect, it } from 'vitest';
import { fromHex, hasParseIssues, parseIndoorBikeData } from '../src/index.js';

describe('parseIndoorBikeData (0x2AD2)', () => {
  it('parses speed, cadence and power (typical trainer packet)', () => {
    // flags 0x0044: cadence + power; bit 0 clear → speed present
    const d = parseIndoorBikeData(fromHex('44 00 10 09 b4 00 c8 00'));
    expect(d.rawFlags).toBe(0x0044);
    expect(d.flags.moreData).toBe(false);
    expect(d.flags.instantaneousCadencePresent).toBe(true);
    expect(d.instantaneousSpeedKmh).toBe(23.2);
    expect(d.instantaneousCadenceRpm).toBe(90);
    expect(d.instantaneousPowerW).toBe(200);
    expect(d.heartRateBpm).toBeUndefined();
    expect(hasParseIssues(d.diagnostics)).toBe(false);
  });

  it('parses every field in spec order', () => {
    const d = parseIndoorBikeData(
      fromHex('fe 1f e8 03 84 03 a0 00 96 00 45 23 01 fb ff fa 00 f0 00 64 00 ff ff ff 8c 2d 10 0e 58 02'),
    );
    expect(d).toMatchObject({
      instantaneousSpeedKmh: 10,
      averageSpeedKmh: 9,
      instantaneousCadenceRpm: 80,
      averageCadenceRpm: 75,
      totalDistanceM: 0x012345,
      resistanceLevel: -5,
      instantaneousPowerW: 250,
      averagePowerW: 240,
      totalEnergyKcal: 100,
      energyPerHourKcal: null,
      energyPerMinuteKcal: null,
      heartRateBpm: 140,
      metabolicEquivalent: 4.5,
      elapsedTimeS: 3600,
      remainingTimeS: 600,
    });
    expect(hasParseIssues(d.diagnostics)).toBe(false);
  });

  it('treats bit 0 as inverted "More Data": set → no speed field', () => {
    const d = parseIndoorBikeData(fromHex('41 00 c8 00'));
    expect(d.flags.moreData).toBe(true);
    expect(d.instantaneousSpeedKmh).toBeUndefined();
    expect('instantaneousSpeedKmh' in d).toBe(false);
    expect(d.instantaneousPowerW).toBe(200);
  });

  it('optionally reads resistance level as uint8 (reference vector of @deancochran/ftms, MIT)', () => {
    const bytes = fromHex('fe 1f e8 03 84 03 b4 00 aa 00 e8 03 00 08 fa 00 f0 00 2c 01 90 01 05 91 50 58 02 64 00');
    const d = parseIndoorBikeData(bytes, { resistanceLevelEncoding: 'uint8' });
    expect(d).toMatchObject({
      resistanceLevel: 8,
      instantaneousPowerW: 250,
      averagePowerW: 240,
      totalEnergyKcal: 300,
      heartRateBpm: 145,
      remainingTimeS: 100,
    });
    expect(hasParseIssues(d.diagnostics)).toBe(false);
    // The default sint16 layout misaligns this packet and reports it as truncated.
    expect(parseIndoorBikeData(bytes).diagnostics.truncated).toBe(true);
  });

  it('parses negative power (sint16)', () => {
    expect(parseIndoorBikeData(fromHex('40 00 10 09 ce ff')).instantaneousPowerW).toBe(-50);
  });

  it('keeps 0 distinct from absent', () => {
    const d = parseIndoorBikeData(fromHex('44 00 00 00 00 00 00 00'));
    expect(d.instantaneousSpeedKmh).toBe(0);
    expect(d.instantaneousPowerW).toBe(0);
  });

  it('reports truncation instead of throwing', () => {
    const d = parseIndoorBikeData(fromHex('44 00 10 09 b4'));
    expect(d.instantaneousSpeedKmh).toBe(23.2);
    expect(d.instantaneousCadenceRpm).toBeUndefined();
    expect(d.instantaneousPowerW).toBeUndefined();
    expect(d.diagnostics.truncated).toBe(true);
  });

  it('reports reserved flags and trailing bytes', () => {
    const d = parseIndoorBikeData(fromHex('40 20 10 09 c8 00 aa'));
    expect(d.instantaneousPowerW).toBe(200);
    expect(d.diagnostics).toEqual({ truncated: false, trailingBytes: 1, reservedFlags: 0x2000 });
  });

  it('handles an empty packet', () => {
    const d = parseIndoorBikeData(new Uint8Array());
    expect(d.diagnostics.truncated).toBe(true);
  });

  it('accepts a DataView window into a larger buffer', () => {
    const buffer = fromHex('ff ff 40 00 10 09 c8 00 ff').buffer;
    const d = parseIndoorBikeData(new DataView(buffer, 2, 6));
    expect(d.instantaneousPowerW).toBe(200);
    expect(hasParseIssues(d.diagnostics)).toBe(false);
  });
});
