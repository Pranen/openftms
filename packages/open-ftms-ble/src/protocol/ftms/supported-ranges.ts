import { ByteReader, toBytes, type BytesLike, type ParseDiagnostics } from '../bytes';

/** A supported range (0x2AD4 … 0x2AD8). Values are `undefined` if truncated. */
export interface SupportedRange {
  readonly bytes: Uint8Array;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly increment?: number;
  readonly diagnostics: ParseDiagnostics;
}

type Read = (r: ByteReader) => number | undefined;

function parseRange(data: BytesLike, readMin: Read, readMax: Read, readIncrement: Read, scale: number) {
  const bytes = toBytes(data);
  const r = new ByteReader(bytes);
  const values = [readMin(r), readMax(r), readIncrement(r)].map((v) =>
    v === undefined ? undefined : v / scale,
  );
  const [minimum, maximum, increment] = values;
  return {
    bytes,
    ...(minimum !== undefined ? { minimum } : {}),
    ...(maximum !== undefined ? { maximum } : {}),
    ...(increment !== undefined ? { increment } : {}),
    diagnostics: r.diagnostics(),
  };
}

const u8: Read = (r) => r.uint8();
const u16: Read = (r) => r.uint16();
const s16: Read = (r) => r.sint16();

/** 0x2AD8 — watts (sint16 min/max, uint16 increment). */
export function parseSupportedPowerRange(data: BytesLike): SupportedRange {
  return parseRange(data, s16, s16, u16, 1);
}

/** 0x2AD4 — km/h (uint16, resolution 0.01). */
export function parseSupportedSpeedRange(data: BytesLike): SupportedRange {
  return parseRange(data, u16, u16, u16, 100);
}

/** 0x2AD5 — percent (sint16 min/max, uint16 increment, resolution 0.1). */
export function parseSupportedInclinationRange(data: BytesLike): SupportedRange {
  return parseRange(data, s16, s16, u16, 10);
}

/** 0x2AD7 — bpm (uint8). */
export function parseSupportedHeartRateRange(data: BytesLike): SupportedRange {
  return parseRange(data, u8, u8, u8, 1);
}

export interface SupportedResistanceLevelRange extends SupportedRange {
  /** Which wire layout was detected from the packet length. */
  readonly encoding: 'sint16' | 'uint8';
}

/**
 * 0x2AD6 — unitless.
 * Spec: sint16 min/max + uint16 increment, resolution 0.1 (6 bytes). Some
 * devices send three uint8 values (3 bytes) as plain levels without scaling;
 * the layout is chosen by packet length.
 */
export function parseSupportedResistanceLevelRange(data: BytesLike): SupportedResistanceLevelRange {
  const bytes = toBytes(data);
  return bytes.length >= 6
    ? { ...parseRange(bytes, s16, s16, u16, 10), encoding: 'sint16' }
    : { ...parseRange(bytes, u8, u8, u8, 1), encoding: 'uint8' };
}
