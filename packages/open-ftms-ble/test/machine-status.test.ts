import { describe, expect, it } from 'vitest';
import { fromHex, hasParseIssues, parseMachineStatus } from '../src/index.js';

describe('parseMachineStatus (0x2ADA)', () => {
  it('detects control permission lost', () => {
    const s = parseMachineStatus(fromHex('ff'));
    expect(s.type).toBe('controlPermissionLost');
    expect(s.opCode).toBe(0xff);
    expect(hasParseIssues(s.diagnostics)).toBe(false);
  });

  it('parses target power changed', () => {
    expect(parseMachineStatus(fromHex('08 c8 00'))).toMatchObject({ type: 'targetPowerChanged', targetPowerW: 200 });
  });

  it('parses stop/pause by user', () => {
    expect(parseMachineStatus(fromHex('02 01')).stopAction).toBe('stop');
    expect(parseMachineStatus(fromHex('02 02')).stopAction).toBe('pause');
  });

  it('parses simulation parameters changed', () => {
    const s = parseMachineStatus(fromHex('12 e8 03 c8 00 28 33'));
    expect(s.type).toBe('indoorBikeSimulationParametersChanged');
    expect(s.simulation).toEqual({ windSpeedMps: 1, gradePercent: 2, crr: 0.004, cw: 0.51 });
  });

  it('parses target resistance level as uint8 or sint16 by length', () => {
    expect(parseMachineStatus(fromHex('07 0a')).targetResistanceLevel).toBe(1);
    expect(parseMachineStatus(fromHex('07 f6 ff')).targetResistanceLevel).toBe(-1);
  });

  it('parses spin down status and targeted cadence', () => {
    expect(parseMachineStatus(fromHex('14 02')).spinDownStatus).toBe('success');
    expect(parseMachineStatus(fromHex('15 b4 00')).targetedCadenceRpm).toBe(90);
  });

  it('keeps unknown op codes with raw parameters', () => {
    const s = parseMachineStatus(fromHex('42 01 02'));
    expect(s.type).toBe('unknown');
    expect(Array.from(s.parameters)).toEqual([1, 2]);
    expect(hasParseIssues(s.diagnostics)).toBe(false);
  });

  it('reports truncated parameters', () => {
    const s = parseMachineStatus(fromHex('05'));
    expect(s.type).toBe('targetSpeedChanged');
    expect(s.targetSpeedKmh).toBeUndefined();
    expect(s.diagnostics.truncated).toBe(true);
  });

  it('handles an empty packet', () => {
    const s = parseMachineStatus(new Uint8Array());
    expect(s).toMatchObject({ type: 'unknown', opCode: -1 });
    expect(s.diagnostics.truncated).toBe(true);
  });
});
