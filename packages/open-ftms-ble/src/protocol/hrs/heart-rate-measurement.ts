import { ByteReader, toBytes, type BytesLike, type ParseDiagnostics } from '../bytes';
import { decodeFlags, put, reservedBits, type FlagSet } from '../util';

/** Flag bits of Heart Rate Measurement (0x2A37), index = bit position. */
export const HEART_RATE_FLAGS = [
  'heartRateUint16',
  'sensorContactDetected',
  'sensorContactSupported',
  'energyExpendedPresent',
  'rrIntervalsPresent',
] as const;

export type SensorContact = 'notSupported' | 'detected' | 'notDetected';

export interface HeartRateMeasurement {
  readonly bytes: Uint8Array;
  readonly rawFlags: number;
  readonly flags: FlagSet<(typeof HEART_RATE_FLAGS)[number]>;
  heartRateBpm?: number;
  readonly sensorContact: SensorContact;
  energyExpendedKj?: number;
  /** RR intervals in milliseconds (wire resolution 1/1024 s), oldest first. */
  readonly rrIntervalsMs: readonly number[];
  readonly diagnostics: ParseDiagnostics;
}

export function parseHeartRateMeasurement(data: BytesLike): HeartRateMeasurement {
  const bytes = toBytes(data);
  const r = new ByteReader(bytes);
  const rawFlags = r.uint8() ?? 0;
  const flags = decodeFlags(rawFlags, HEART_RATE_FLAGS);
  const sensorContact: SensorContact = !flags.sensorContactSupported
    ? 'notSupported'
    : flags.sensorContactDetected
      ? 'detected'
      : 'notDetected';

  const rrIntervalsMs: number[] = [];
  const out: Omit<HeartRateMeasurement, 'diagnostics'> = { bytes, rawFlags, flags, sensorContact, rrIntervalsMs };

  put(out, 'heartRateBpm', flags.heartRateUint16 ? r.uint16() : r.uint8());
  if (flags.energyExpendedPresent) put(out, 'energyExpendedKj', r.uint16());
  if (flags.rrIntervalsPresent) {
    while (r.remaining >= 2) {
      const rr = r.uint16();
      if (rr !== undefined) rrIntervalsMs.push((rr * 1000) / 1024);
    }
  }

  return { ...out, diagnostics: r.diagnostics(reservedBits(rawFlags, HEART_RATE_FLAGS.length)) };
}
