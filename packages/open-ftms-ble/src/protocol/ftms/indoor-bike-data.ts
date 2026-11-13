import { ByteReader, fromFixedPoint, toBytes, type BytesLike, type ParseDiagnostics } from '../bytes';
import { decodeFlags, put, reservedBits, type FlagSet } from '../util';

/**
 * Flag bits of Indoor Bike Data (0x2AD2), index = bit position.
 *
 * Bit 0 is inverted: `moreData === false` means Instantaneous Speed IS present.
 */
export const INDOOR_BIKE_DATA_FLAGS = [
  'moreData',
  'averageSpeedPresent',
  'instantaneousCadencePresent',
  'averageCadencePresent',
  'totalDistancePresent',
  'resistanceLevelPresent',
  'instantaneousPowerPresent',
  'averagePowerPresent',
  'expendedEnergyPresent',
  'heartRatePresent',
  'metabolicEquivalentPresent',
  'elapsedTimePresent',
  'remainingTimePresent',
] as const;

export type IndoorBikeDataFlags = FlagSet<(typeof INDOOR_BIKE_DATA_FLAGS)[number]>;

/**
 * Parsed Indoor Bike Data packet.
 *
 * A field is `undefined` when the packet does not carry it, and `null` when the
 * device sent the "data not available" sentinel. `0` always means a real zero.
 */
export interface IndoorBikeData {
  readonly bytes: Uint8Array;
  readonly rawFlags: number;
  readonly flags: IndoorBikeDataFlags;
  instantaneousSpeedKmh?: number;
  averageSpeedKmh?: number;
  instantaneousCadenceRpm?: number;
  averageCadenceRpm?: number;
  totalDistanceM?: number;
  /** Unitless, as sent by the device (see {@link IndoorBikeDataOptions}). */
  resistanceLevel?: number;
  instantaneousPowerW?: number;
  averagePowerW?: number;
  totalEnergyKcal?: number | null;
  energyPerHourKcal?: number | null;
  energyPerMinuteKcal?: number | null;
  heartRateBpm?: number;
  metabolicEquivalent?: number;
  elapsedTimeS?: number;
  remainingTimeS?: number;
  readonly diagnostics: ParseDiagnostics;
}

function sentinel(value: number | undefined, notAvailable: number): number | null | undefined {
  if (value === undefined) return undefined;
  return value === notAvailable ? null : value;
}

export interface IndoorBikeDataOptions {
  /**
   * Width of the Resistance Level field (bit 5).
   * - `sint16` (default): FTMS 1.0 / GATT XML.
   * - `uint8`: layout used by some devices and later SIG GSS drafts.
   * A wrong choice shifts every following field (power, energy, HR …).
   */
  resistanceLevelEncoding?: 'sint16' | 'uint8';
}

export function parseIndoorBikeData(data: BytesLike, options: IndoorBikeDataOptions = {}): IndoorBikeData {
  const resistanceAsUint8 = options.resistanceLevelEncoding === 'uint8';
  const bytes = toBytes(data);
  const r = new ByteReader(bytes);
  const rawFlags = r.uint16() ?? 0;
  const flags = decodeFlags(rawFlags, INDOOR_BIKE_DATA_FLAGS);
  const out: Omit<IndoorBikeData, 'diagnostics'> = { bytes, rawFlags, flags };

  if (!flags.moreData) put(out, 'instantaneousSpeedKmh', fromFixedPoint(r.uint16(), 100));
  if (flags.averageSpeedPresent) put(out, 'averageSpeedKmh', fromFixedPoint(r.uint16(), 100));
  if (flags.instantaneousCadencePresent) put(out, 'instantaneousCadenceRpm', fromFixedPoint(r.uint16(), 2));
  if (flags.averageCadencePresent) put(out, 'averageCadenceRpm', fromFixedPoint(r.uint16(), 2));
  if (flags.totalDistancePresent) put(out, 'totalDistanceM', r.uint24());
  if (flags.resistanceLevelPresent) put(out, 'resistanceLevel', resistanceAsUint8 ? r.uint8() : r.sint16());
  if (flags.instantaneousPowerPresent) put(out, 'instantaneousPowerW', r.sint16());
  if (flags.averagePowerPresent) put(out, 'averagePowerW', r.sint16());
  if (flags.expendedEnergyPresent) {
    put(out, 'totalEnergyKcal', sentinel(r.uint16(), 0xffff));
    put(out, 'energyPerHourKcal', sentinel(r.uint16(), 0xffff));
    put(out, 'energyPerMinuteKcal', sentinel(r.uint8(), 0xff));
  }
  if (flags.heartRatePresent) put(out, 'heartRateBpm', r.uint8());
  if (flags.metabolicEquivalentPresent) put(out, 'metabolicEquivalent', fromFixedPoint(r.uint8(), 10));
  if (flags.elapsedTimePresent) put(out, 'elapsedTimeS', r.uint16());
  if (flags.remainingTimePresent) put(out, 'remainingTimeS', r.uint16());

  return { ...out, diagnostics: r.diagnostics(reservedBits(rawFlags, INDOOR_BIKE_DATA_FLAGS.length)) };
}
