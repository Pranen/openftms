import { describe, expect, it } from 'vitest';
import { fromHex, hasParseIssues, parseHeartRateMeasurement } from '../src/index';

describe('parseHeartRateMeasurement (0x2A37)', () => {
  it('parses uint8 heart rate without contact support', () => {
    const h = parseHeartRateMeasurement(fromHex('00 48'));
    expect(h.heartRateBpm).toBe(72);
    expect(h.sensorContact).toBe('notSupported');
    expect(h.rrIntervalsMs).toEqual([]);
    expect(hasParseIssues(h.diagnostics)).toBe(false);
  });

  it('parses sensor contact status', () => {
    expect(parseHeartRateMeasurement(fromHex('06 48')).sensorContact).toBe('detected');
    expect(parseHeartRateMeasurement(fromHex('04 48')).sensorContact).toBe('notDetected');
  });

  it('parses uint16 heart rate', () => {
    expect(parseHeartRateMeasurement(fromHex('01 2c 01')).heartRateBpm).toBe(300);
  });

  it('parses RR intervals in ms', () => {
    const h = parseHeartRateMeasurement(fromHex('16 50 00 04 00 02'));
    expect(h.heartRateBpm).toBe(80);
    expect(h.sensorContact).toBe('detected');
    expect(h.rrIntervalsMs).toEqual([1000, 500]);
  });

  it('parses energy expended before RR intervals', () => {
    const h = parseHeartRateMeasurement(fromHex('18 50 10 00 00 04'));
    expect(h.energyExpendedKj).toBe(16);
    expect(h.rrIntervalsMs).toEqual([1000]);
  });

  it('reports an odd trailing byte', () => {
    const h = parseHeartRateMeasurement(fromHex('10 50 00 04 aa'));
    expect(h.rrIntervalsMs).toEqual([1000]);
    expect(h.diagnostics.trailingBytes).toBe(1);
  });
});
