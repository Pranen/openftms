import { ByteReader, fromFixedPoint, toBytes, type BytesLike, type ParseDiagnostics } from '../bytes';
import { invert, put } from '../util';
import { readSimulationParameters, type IndoorBikeSimulationParameters } from './control-point';

/** Fitness Machine Status (0x2ADA) op codes. */
export const MACHINE_STATUS_OPCODE = {
  reset: 0x01,
  stoppedOrPausedByUser: 0x02,
  stoppedBySafetyKey: 0x03,
  startedOrResumedByUser: 0x04,
  targetSpeedChanged: 0x05,
  targetInclineChanged: 0x06,
  targetResistanceLevelChanged: 0x07,
  targetPowerChanged: 0x08,
  targetHeartRateChanged: 0x09,
  targetedExpendedEnergyChanged: 0x0a,
  targetedNumberOfStepsChanged: 0x0b,
  targetedNumberOfStridesChanged: 0x0c,
  targetedDistanceChanged: 0x0d,
  targetedTrainingTimeChanged: 0x0e,
  targetedTimeInTwoHeartRateZonesChanged: 0x0f,
  targetedTimeInThreeHeartRateZonesChanged: 0x10,
  targetedTimeInFiveHeartRateZonesChanged: 0x11,
  indoorBikeSimulationParametersChanged: 0x12,
  wheelCircumferenceChanged: 0x13,
  spinDownStatus: 0x14,
  targetedCadenceChanged: 0x15,
  /** Another client took control, or the machine revoked it. */
  controlPermissionLost: 0xff,
} as const;

export type MachineStatusType = keyof typeof MACHINE_STATUS_OPCODE | 'unknown';

export type SpinDownStatus = 'requested' | 'success' | 'error' | 'stopPedaling' | 'unknown';

/** Parsed Machine Status packet; only the fields of its `type` are set. */
export interface MachineStatus {
  readonly bytes: Uint8Array;
  /** `-1` for an empty packet. */
  readonly opCode: number;
  readonly type: MachineStatusType;
  /** All bytes after the op code. */
  readonly parameters: Uint8Array;
  stopAction?: 'stop' | 'pause' | 'unknown';
  targetSpeedKmh?: number;
  targetInclinationPercent?: number;
  targetResistanceLevel?: number;
  targetPowerW?: number;
  targetHeartRateBpm?: number;
  targetedExpendedEnergyKcal?: number;
  targetedSteps?: number;
  targetedStrides?: number;
  targetedDistanceM?: number;
  targetedTrainingTimeS?: number;
  simulation?: IndoorBikeSimulationParameters;
  wheelCircumferenceMm?: number;
  spinDownStatus?: SpinDownStatus;
  targetedCadenceRpm?: number;
  readonly diagnostics: ParseDiagnostics;
}

const TYPE_NAMES = invert(MACHINE_STATUS_OPCODE);
const SPIN_DOWN: readonly SpinDownStatus[] = ['unknown', 'requested', 'success', 'error', 'stopPedaling'];

export function parseMachineStatus(data: BytesLike): MachineStatus {
  const bytes = toBytes(data);
  const r = new ByteReader(bytes);
  const opCode = r.uint8();
  const type: MachineStatusType = opCode === undefined ? 'unknown' : (TYPE_NAMES.get(opCode) ?? 'unknown');
  const out: Omit<MachineStatus, 'diagnostics'> = {
    bytes,
    opCode: opCode ?? -1,
    type,
    parameters: bytes.slice(1),
  };

  switch (type) {
    case 'stoppedOrPausedByUser': {
      const v = r.uint8();
      if (v !== undefined) out.stopAction = v === 0x01 ? 'stop' : v === 0x02 ? 'pause' : 'unknown';
      break;
    }
    case 'targetSpeedChanged':
      put(out, 'targetSpeedKmh', fromFixedPoint(r.uint16(), 100));
      break;
    case 'targetInclineChanged':
      put(out, 'targetInclinationPercent', fromFixedPoint(r.sint16(), 10));
      break;
    case 'targetResistanceLevelChanged':
      // uint8 per FTMS 1.0 table, sint16 per erratum — decide by length.
      put(out, 'targetResistanceLevel', fromFixedPoint(r.remaining >= 2 ? r.sint16() : r.uint8(), 10));
      break;
    case 'targetPowerChanged':
      put(out, 'targetPowerW', r.sint16());
      break;
    case 'targetHeartRateChanged':
      put(out, 'targetHeartRateBpm', r.uint8());
      break;
    case 'targetedExpendedEnergyChanged':
      put(out, 'targetedExpendedEnergyKcal', r.uint16());
      break;
    case 'targetedNumberOfStepsChanged':
      put(out, 'targetedSteps', r.uint16());
      break;
    case 'targetedNumberOfStridesChanged':
      put(out, 'targetedStrides', r.uint16());
      break;
    case 'targetedDistanceChanged':
      put(out, 'targetedDistanceM', r.uint24());
      break;
    case 'targetedTrainingTimeChanged':
      put(out, 'targetedTrainingTimeS', r.uint16());
      break;
    case 'indoorBikeSimulationParametersChanged':
      put(out, 'simulation', readSimulationParameters(r));
      break;
    case 'wheelCircumferenceChanged':
      put(out, 'wheelCircumferenceMm', fromFixedPoint(r.uint16(), 10));
      break;
    case 'spinDownStatus': {
      const v = r.uint8();
      if (v !== undefined) out.spinDownStatus = SPIN_DOWN[v] ?? 'unknown';
      break;
    }
    case 'targetedCadenceChanged':
      put(out, 'targetedCadenceRpm', fromFixedPoint(r.uint16(), 2));
      break;
    case 'targetedTimeInTwoHeartRateZonesChanged':
    case 'targetedTimeInThreeHeartRateZonesChanged':
    case 'targetedTimeInFiveHeartRateZonesChanged':
    case 'unknown':
      // Not decoded; raw bytes stay available in `parameters`.
      r.rest();
      break;
    default:
      // reset, stoppedBySafetyKey, startedOrResumedByUser, controlPermissionLost: no parameters.
      break;
  }

  return { ...out, diagnostics: r.diagnostics() };
}
