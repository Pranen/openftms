import {
  ByteReader,
  ByteWriter,
  toBytes,
  toFixedPoint,
  type BytesLike,
  type ParseDiagnostics,
} from '../bytes.js';
import { invert } from '../util.js';

/** Fitness Machine Control Point (0x2AD9) op codes. */
export const CONTROL_POINT_OPCODE = {
  requestControl: 0x00,
  reset: 0x01,
  setTargetSpeed: 0x02,
  setTargetInclination: 0x03,
  setTargetResistanceLevel: 0x04,
  setTargetPower: 0x05,
  setTargetHeartRate: 0x06,
  startOrResume: 0x07,
  stopOrPause: 0x08,
  setTargetedExpendedEnergy: 0x09,
  setTargetedNumberOfSteps: 0x0a,
  setTargetedNumberOfStrides: 0x0b,
  setTargetedDistance: 0x0c,
  setTargetedTrainingTime: 0x0d,
  setTargetedTimeInTwoHeartRateZones: 0x0e,
  setTargetedTimeInThreeHeartRateZones: 0x0f,
  setTargetedTimeInFiveHeartRateZones: 0x10,
  setIndoorBikeSimulationParameters: 0x11,
  setWheelCircumference: 0x12,
  spinDownControl: 0x13,
  setTargetedCadence: 0x14,
  responseCode: 0x80,
} as const;

export type ControlPointOpCodeName = keyof typeof CONTROL_POINT_OPCODE;

/** Result codes carried in a control point response. */
export const CONTROL_POINT_RESULT = {
  success: 0x01,
  opCodeNotSupported: 0x02,
  invalidParameter: 0x03,
  operationFailed: 0x04,
  controlNotPermitted: 0x05,
} as const;

export type ControlPointResultName = keyof typeof CONTROL_POINT_RESULT;

const OPCODE_NAMES = invert(CONTROL_POINT_OPCODE);
const RESULT_NAMES = invert(CONTROL_POINT_RESULT);

export function controlPointOpCodeName(opCode: number): ControlPointOpCodeName | 'unknown' {
  return OPCODE_NAMES.get(opCode) ?? 'unknown';
}

export function controlPointResultName(resultCode: number): ControlPointResultName | 'unknown' {
  return RESULT_NAMES.get(resultCode) ?? 'unknown';
}

// ---------------------------------------------------------------------------
// Indoor bike simulation parameters (shared with Machine Status 0x12)
// ---------------------------------------------------------------------------

export interface IndoorBikeSimulationParameters {
  /** Head wind positive, tail wind negative. Resolution 0.001 m/s. */
  windSpeedMps: number;
  /** Resolution 0.01 %. */
  gradePercent: number;
  /** Coefficient of rolling resistance, resolution 0.0001 (0 … 0.0255). */
  crr: number;
  /** Wind resistance coefficient in kg/m, resolution 0.01 (0 … 2.55). */
  cw: number;
}

export const DEFAULT_SIMULATION_PARAMETERS: Readonly<IndoorBikeSimulationParameters> = {
  windSpeedMps: 0,
  gradePercent: 0,
  crr: 0.004,
  cw: 0.51,
};

export function writeSimulationParameters(w: ByteWriter, p: IndoorBikeSimulationParameters): void {
  w.sint16(toFixedPoint(p.windSpeedMps, 1000, 'windSpeedMps'), 'windSpeedMps')
    .sint16(toFixedPoint(p.gradePercent, 100, 'gradePercent'), 'gradePercent')
    .uint8(toFixedPoint(p.crr, 10000, 'crr'), 'crr')
    .uint8(toFixedPoint(p.cw, 100, 'cw'), 'cw');
}

/** Reads the 6-byte simulation block; `undefined` if the packet is too short. */
export function readSimulationParameters(r: ByteReader): IndoorBikeSimulationParameters | undefined {
  const wind = r.sint16();
  const grade = r.sint16();
  const crr = r.uint8();
  const cw = r.uint8();
  if (wind === undefined || grade === undefined || crr === undefined || cw === undefined) {
    return undefined;
  }
  return { windSpeedMps: wind / 1000, gradePercent: grade / 100, crr: crr / 10000, cw: cw / 100 };
}

// ---------------------------------------------------------------------------
// Encoders — each returns the complete value to write to 0x2AD9.
// Values are rounded to the field resolution; values that do not fit the wire
// format throw InvalidParameterError. Clamping to the device's supported range
// is the device layer's job.
// ---------------------------------------------------------------------------

const OP = CONTROL_POINT_OPCODE;

function command(opCode: number, writeParameters?: (w: ByteWriter) => void): Uint8Array {
  const w = new ByteWriter().uint8(opCode, 'opCode');
  writeParameters?.(w);
  return w.toBytes();
}

export function encodeRequestControl(): Uint8Array {
  return command(OP.requestControl);
}

export function encodeReset(): Uint8Array {
  return command(OP.reset);
}

export function encodeStartOrResume(): Uint8Array {
  return command(OP.startOrResume);
}

export function encodeStopOrPause(action: 'stop' | 'pause'): Uint8Array {
  return command(OP.stopOrPause, (w) => w.uint8(action === 'stop' ? 0x01 : 0x02, 'action'));
}

/** ERG mode: target power in watts (sint16, resolution 1 W). */
export function encodeSetTargetPower(watts: number): Uint8Array {
  return command(OP.setTargetPower, (w) => w.sint16(toFixedPoint(watts, 1, 'watts'), 'watts'));
}

/** Target speed in km/h (uint16, resolution 0.01 km/h). */
export function encodeSetTargetSpeed(kmh: number): Uint8Array {
  return command(OP.setTargetSpeed, (w) => w.uint16(toFixedPoint(kmh, 100, 'kmh'), 'kmh'));
}

/** Target inclination in percent (sint16, resolution 0.1 %). */
export function encodeSetTargetInclination(percent: number): Uint8Array {
  return command(OP.setTargetInclination, (w) => w.sint16(toFixedPoint(percent, 10, 'percent'), 'percent'));
}

/**
 * Wire format of the target resistance level.
 * - `sint16`: FTMS erratum E8991 (sint16, resolution 0.1). Default.
 * - `uint8`: the table printed in FTMS 1.0 (uint8, resolution 0.1).
 * Which one a trainer expects is verified per device.
 */
export type ResistanceEncoding = 'sint16' | 'uint8';

/** Target resistance level (unitless, resolution 0.1). */
export function encodeSetTargetResistanceLevel(
  level: number,
  encoding: ResistanceEncoding = 'sint16',
): Uint8Array {
  const raw = toFixedPoint(level, 10, 'level');
  return command(OP.setTargetResistanceLevel, (w) =>
    encoding === 'sint16' ? w.sint16(raw, 'level') : w.uint8(raw, 'level'),
  );
}

/** Target heart rate in bpm (uint8). */
export function encodeSetTargetHeartRate(bpm: number): Uint8Array {
  return command(OP.setTargetHeartRate, (w) => w.uint8(toFixedPoint(bpm, 1, 'bpm'), 'bpm'));
}

/** Simulation mode; omitted fields fall back to {@link DEFAULT_SIMULATION_PARAMETERS}. */
export function encodeSetIndoorBikeSimulation(
  parameters: Partial<IndoorBikeSimulationParameters> = {},
): Uint8Array {
  const p = { ...DEFAULT_SIMULATION_PARAMETERS, ...parameters };
  return command(OP.setIndoorBikeSimulationParameters, (w) => writeSimulationParameters(w, p));
}

/** Wheel circumference in millimetres (uint16, resolution 0.1 mm). */
export function encodeSetWheelCircumference(mm: number): Uint8Array {
  return command(OP.setWheelCircumference, (w) => w.uint16(toFixedPoint(mm, 10, 'mm'), 'mm'));
}

export function encodeSpinDownControl(action: 'start' | 'ignore'): Uint8Array {
  return command(OP.spinDownControl, (w) => w.uint8(action === 'start' ? 0x01 : 0x02, 'action'));
}

/** Targeted cadence in rpm (uint16, resolution 0.5 rpm). */
export function encodeSetTargetedCadence(rpm: number): Uint8Array {
  return command(OP.setTargetedCadence, (w) => w.uint16(toFixedPoint(rpm, 2, 'rpm'), 'rpm'));
}

// ---------------------------------------------------------------------------
// Response decoding (indication: 0x80, request op code, result code, params…)
// ---------------------------------------------------------------------------

export interface ControlPointResponse {
  readonly bytes: Uint8Array;
  readonly requestOpCode: number;
  readonly request: ControlPointOpCodeName | 'unknown';
  readonly resultCode: number;
  readonly result: ControlPointResultName | 'unknown';
  readonly success: boolean;
  /** Bytes after the result code (response parameters), possibly empty. */
  readonly parameters: Uint8Array;
  /** Only on a successful spin-down start response. */
  readonly spinDown?: { readonly targetSpeedLowKmh: number; readonly targetSpeedHighKmh: number };
  readonly diagnostics: ParseDiagnostics;
}

/**
 * Decodes a control point indication. Returns `undefined` if the value is not a
 * response (first byte ≠ 0x80) or is too short to contain op code and result.
 * Extra bytes are tolerated and reported as trailing bytes.
 */
export function parseControlPointResponse(data: BytesLike): ControlPointResponse | undefined {
  const bytes = toBytes(data);
  const r = new ByteReader(bytes);
  if (r.uint8() !== OP.responseCode) return undefined;
  const requestOpCode = r.uint8();
  const resultCode = r.uint8();
  if (requestOpCode === undefined || resultCode === undefined) return undefined;

  const success = resultCode === CONTROL_POINT_RESULT.success;
  let spinDown: ControlPointResponse['spinDown'];
  if (success && requestOpCode === OP.spinDownControl && r.remaining >= 4) {
    const low = r.uint16();
    const high = r.uint16();
    if (low !== undefined && high !== undefined) {
      spinDown = { targetSpeedLowKmh: low / 100, targetSpeedHighKmh: high / 100 };
    }
  }

  return {
    bytes,
    requestOpCode,
    request: controlPointOpCodeName(requestOpCode),
    resultCode,
    result: controlPointResultName(resultCode),
    success,
    parameters: bytes.slice(3),
    ...(spinDown ? { spinDown } : {}),
    diagnostics: r.diagnostics(),
  };
}
