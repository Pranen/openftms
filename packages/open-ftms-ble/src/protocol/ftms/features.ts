import { ByteReader, toBytes, type BytesLike, type ParseDiagnostics } from '../bytes.js';
import { decodeFlags, reservedBits, type FlagSet } from '../util.js';

/** Fitness Machine Features field of 0x2ACC, index = bit position. */
export const MACHINE_FEATURE_FLAGS = [
  'averageSpeed',
  'cadence',
  'totalDistance',
  'inclination',
  'elevationGain',
  'pace',
  'stepCount',
  'resistanceLevel',
  'strideCount',
  'expendedEnergy',
  'heartRateMeasurement',
  'metabolicEquivalent',
  'elapsedTime',
  'remainingTime',
  'powerMeasurement',
  'forceOnBeltAndPowerOutput',
  'userDataRetention',
] as const;

/** Target Setting Features field of 0x2ACC, index = bit position. */
export const TARGET_SETTING_FEATURE_FLAGS = [
  'speedTarget',
  'inclinationTarget',
  'resistanceTarget',
  'powerTarget',
  'heartRateTarget',
  'targetedExpendedEnergy',
  'targetedStepNumber',
  'targetedStrideNumber',
  'targetedDistance',
  'targetedTrainingTime',
  'targetedTimeInTwoHeartRateZones',
  'targetedTimeInThreeHeartRateZones',
  'targetedTimeInFiveHeartRateZones',
  'indoorBikeSimulation',
  'wheelCircumference',
  'spinDownControl',
  'targetedCadence',
] as const;

export type MachineFeatures = FlagSet<(typeof MACHINE_FEATURE_FLAGS)[number]>;
export type TargetSettingFeatures = FlagSet<(typeof TARGET_SETTING_FEATURE_FLAGS)[number]>;

export interface FitnessMachineFeatures {
  readonly bytes: Uint8Array;
  readonly rawMachineFeatures: number;
  readonly rawTargetSettingFeatures: number;
  /** What the machine reports (Indoor Bike Data fields etc.). */
  readonly machine: MachineFeatures;
  /** Which control point targets the machine accepts. */
  readonly targetSetting: TargetSettingFeatures;
  /** `reservedFlags` is the OR of the reserved bits of both fields. */
  readonly diagnostics: ParseDiagnostics;
}

export function parseFitnessMachineFeatures(data: BytesLike): FitnessMachineFeatures {
  const bytes = toBytes(data);
  const r = new ByteReader(bytes);
  const rawMachineFeatures = r.uint32() ?? 0;
  const rawTargetSettingFeatures = r.uint32() ?? 0;
  const reserved =
    (reservedBits(rawMachineFeatures, MACHINE_FEATURE_FLAGS.length) |
      reservedBits(rawTargetSettingFeatures, TARGET_SETTING_FEATURE_FLAGS.length)) >>>
    0;
  return {
    bytes,
    rawMachineFeatures,
    rawTargetSettingFeatures,
    machine: decodeFlags(rawMachineFeatures, MACHINE_FEATURE_FLAGS),
    targetSetting: decodeFlags(rawTargetSettingFeatures, TARGET_SETTING_FEATURE_FLAGS),
    diagnostics: r.diagnostics(reserved),
  };
}
