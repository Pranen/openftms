import { ByteReader, toBytes, type BytesLike, type ParseDiagnostics } from '../bytes';
import { decodeFlags, invert, reservedBits, type FlagSet } from '../util';

export const TRAINING_STATUS_FLAGS = ['trainingStatusStringPresent', 'extendedStringPresent'] as const;

export const TRAINING_STATUS = {
  other: 0x00,
  idle: 0x01,
  warmingUp: 0x02,
  lowIntensityInterval: 0x03,
  highIntensityInterval: 0x04,
  recoveryInterval: 0x05,
  isometric: 0x06,
  heartRateControl: 0x07,
  fitnessTest: 0x08,
  speedOutsideControlRegionLow: 0x09,
  speedOutsideControlRegionHigh: 0x0a,
  coolDown: 0x0b,
  wattControl: 0x0c,
  manualMode: 0x0d,
  preWorkout: 0x0e,
  postWorkout: 0x0f,
} as const;

export type TrainingStatusName = keyof typeof TRAINING_STATUS | 'unknown';

export interface TrainingStatus {
  readonly bytes: Uint8Array;
  readonly rawFlags: number;
  readonly flags: FlagSet<(typeof TRAINING_STATUS_FLAGS)[number]>;
  readonly statusCode?: number;
  readonly status: TrainingStatusName;
  readonly statusString?: string;
  readonly diagnostics: ParseDiagnostics;
}

const NAMES = invert(TRAINING_STATUS);

export function parseTrainingStatus(data: BytesLike): TrainingStatus {
  const bytes = toBytes(data);
  const r = new ByteReader(bytes);
  const rawFlags = r.uint8() ?? 0;
  const flags = decodeFlags(rawFlags, TRAINING_STATUS_FLAGS);
  const statusCode = r.uint8();
  const statusString = flags.trainingStatusStringPresent && r.remaining > 0 ? r.restAsUtf8() : undefined;
  return {
    bytes,
    rawFlags,
    flags,
    ...(statusCode !== undefined ? { statusCode } : {}),
    status: statusCode === undefined ? 'unknown' : (NAMES.get(statusCode) ?? 'unknown'),
    ...(statusString !== undefined ? { statusString } : {}),
    diagnostics: r.diagnostics(reservedBits(rawFlags, TRAINING_STATUS_FLAGS.length)),
  };
}
