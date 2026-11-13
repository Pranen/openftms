import { describe, expect, it } from 'vitest';
import {
  InvalidParameterError,
  controlPointOpCodeName,
  encodeRequestControl,
  encodeReset,
  encodeSetIndoorBikeSimulation,
  encodeSetTargetHeartRate,
  encodeSetTargetInclination,
  encodeSetTargetPower,
  encodeSetTargetResistanceLevel,
  encodeSetTargetSpeed,
  encodeSetTargetedCadence,
  encodeSetWheelCircumference,
  encodeSpinDownControl,
  encodeStartOrResume,
  encodeStopOrPause,
  fromHex,
  parseControlPointResponse,
  toHex,
} from '../src/index.js';

describe('control point encoders (0x2AD9)', () => {
  it('encodes parameterless commands', () => {
    expect(toHex(encodeRequestControl())).toBe('00');
    expect(toHex(encodeReset())).toBe('01');
    expect(toHex(encodeStartOrResume())).toBe('07');
  });

  it('encodes stop / pause', () => {
    expect(toHex(encodeStopOrPause('stop'))).toBe('08 01');
    expect(toHex(encodeStopOrPause('pause'))).toBe('08 02');
  });

  it('encodes target power (ERG)', () => {
    expect(toHex(encodeSetTargetPower(200))).toBe('05 c8 00');
    expect(toHex(encodeSetTargetPower(200.4))).toBe('05 c8 00');
    expect(() => encodeSetTargetPower(40000)).toThrow(InvalidParameterError);
    expect(() => encodeSetTargetPower(Number.NaN)).toThrow(InvalidParameterError);
  });

  it('encodes simulation parameters with defaults', () => {
    // wind 0, grade 2.50 % = 250, crr 0.004 = 40, cw 0.51 = 51
    expect(toHex(encodeSetIndoorBikeSimulation({ gradePercent: 2.5 }))).toBe('11 00 00 fa 00 28 33');
  });

  it('encodes negative wind and grade', () => {
    expect(
      toHex(encodeSetIndoorBikeSimulation({ windSpeedMps: -1.5, gradePercent: -3.25, crr: 0.005, cw: 0.6 })),
    ).toBe('11 24 fa bb fe 32 3c');
  });

  it('rejects simulation values outside the wire format', () => {
    expect(() => encodeSetIndoorBikeSimulation({ crr: 0.03 })).toThrow(InvalidParameterError);
    expect(() => encodeSetIndoorBikeSimulation({ cw: -0.1 })).toThrow(InvalidParameterError);
  });

  it('encodes target resistance level in both layouts', () => {
    expect(toHex(encodeSetTargetResistanceLevel(5.5))).toBe('04 37 00');
    expect(toHex(encodeSetTargetResistanceLevel(5.5, 'uint8'))).toBe('04 37');
  });

  it('encodes the remaining targets', () => {
    expect(toHex(encodeSetTargetInclination(-1.5))).toBe('03 f1 ff');
    expect(toHex(encodeSetTargetSpeed(25.5))).toBe('02 f6 09');
    expect(toHex(encodeSetTargetHeartRate(150))).toBe('06 96');
    expect(toHex(encodeSetWheelCircumference(2105))).toBe('12 3a 52');
    expect(toHex(encodeSpinDownControl('start'))).toBe('13 01');
    expect(toHex(encodeSetTargetedCadence(90))).toBe('14 b4 00');
  });

  it('names op codes', () => {
    expect(controlPointOpCodeName(0x05)).toBe('setTargetPower');
    expect(controlPointOpCodeName(0x42)).toBe('unknown');
  });
});

describe('parseControlPointResponse', () => {
  it('parses success', () => {
    expect(parseControlPointResponse(fromHex('80 05 01'))).toMatchObject({
      requestOpCode: 0x05,
      request: 'setTargetPower',
      resultCode: 0x01,
      result: 'success',
      success: true,
    });
  });

  it('parses failures', () => {
    expect(parseControlPointResponse(fromHex('80 00 05'))).toMatchObject({
      request: 'requestControl',
      result: 'controlNotPermitted',
      success: false,
    });
    expect(parseControlPointResponse(fromHex('80 11 02'))?.result).toBe('opCodeNotSupported');
    expect(parseControlPointResponse(fromHex('80 05 09'))?.result).toBe('unknown');
  });

  it('parses spin down response parameters', () => {
    expect(parseControlPointResponse(fromHex('80 13 01 e8 03 d0 07'))?.spinDown).toEqual({
      targetSpeedLowKmh: 10,
      targetSpeedHighKmh: 20,
    });
  });

  it('tolerates extra bytes', () => {
    const r = parseControlPointResponse(fromHex('80 05 01 00'));
    expect(r?.success).toBe(true);
    expect(r?.diagnostics.trailingBytes).toBe(1);
  });

  it('returns undefined for non-responses and short packets', () => {
    expect(parseControlPointResponse(fromHex('05 01'))).toBeUndefined();
    expect(parseControlPointResponse(fromHex('80 05'))).toBeUndefined();
    expect(parseControlPointResponse(new Uint8Array())).toBeUndefined();
  });
});
