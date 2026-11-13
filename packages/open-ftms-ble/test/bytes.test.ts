import { describe, expect, it } from 'vitest';
import {
  ByteReader,
  ByteWriter,
  InvalidParameterError,
  fromHex,
  toBytes,
  toFixedPoint,
  toHex,
} from '../src/index';

describe('toBytes', () => {
  it('respects byteOffset/byteLength of a DataView', () => {
    const buffer = new Uint8Array([0xaa, 0x01, 0x02, 0xbb]).buffer;
    expect(Array.from(toBytes(new DataView(buffer, 1, 2)))).toEqual([0x01, 0x02]);
  });

  it('copies the data', () => {
    const source = new Uint8Array([1, 2]);
    const copy = toBytes(source);
    source[0] = 9;
    expect(copy[0]).toBe(1);
  });

  it('accepts ArrayBuffer and number arrays', () => {
    expect(toHex(new Uint8Array([0x0a, 0xff]).buffer)).toBe('0a ff');
    expect(toHex([0x80, 0x05, 0x01])).toBe('80 05 01');
  });
});

describe('hex', () => {
  it('round-trips', () => {
    expect(toHex(fromHex('44 00 10 09'))).toBe('44 00 10 09');
    expect(toHex(fromHex('0x44:0x00-1009'), '')).toBe('44001009');
  });

  it('rejects invalid input', () => {
    expect(() => fromHex('abc')).toThrow(InvalidParameterError);
    expect(() => fromHex('zz')).toThrow(InvalidParameterError);
  });
});

describe('ByteReader', () => {
  it('reads little-endian integers', () => {
    const r = new ByteReader(fromHex('ff fe ff 45 23 01 78 56 34 12'));
    expect(r.uint8()).toBe(0xff);
    expect(r.sint16()).toBe(-2);
    expect(r.uint24()).toBe(0x012345);
    expect(r.uint32()).toBe(0x12345678);
    expect(r.diagnostics()).toEqual({ truncated: false, trailingBytes: 0, reservedFlags: 0 });
  });

  it('marks truncation and stops reading', () => {
    const r = new ByteReader(fromHex('01 02 03'));
    expect(r.uint16()).toBe(0x0201);
    expect(r.uint16()).toBeUndefined();
    expect(r.uint8()).toBeUndefined();
    expect(r.diagnostics().truncated).toBe(true);
  });

  it('reports trailing bytes', () => {
    const r = new ByteReader(fromHex('01 02 03'));
    r.uint8();
    expect(r.diagnostics().trailingBytes).toBe(2);
  });
});

describe('ByteWriter', () => {
  it('writes little-endian integers', () => {
    const bytes = new ByteWriter().uint8(1).sint16(-2).uint16(0x1234).uint24(0x012345).uint32(0xdeadbeef).toBytes();
    expect(toHex(bytes)).toBe('01 fe ff 34 12 45 23 01 ef be ad de');
  });

  it('rejects out-of-range and non-integer values', () => {
    expect(() => new ByteWriter().uint8(256)).toThrow(InvalidParameterError);
    expect(() => new ByteWriter().sint16(40000)).toThrow(InvalidParameterError);
    expect(() => new ByteWriter().uint16(-1)).toThrow(InvalidParameterError);
    expect(() => new ByteWriter().uint8(1.5)).toThrow(InvalidParameterError);
  });
});

describe('toFixedPoint', () => {
  it('rounds half away from zero without float noise', () => {
    expect(toFixedPoint(1.005, 100, 'x')).toBe(101);
    expect(toFixedPoint(-1.005, 100, 'x')).toBe(-101);
    expect(toFixedPoint(0.004, 10000, 'x')).toBe(40);
    expect(toFixedPoint(200.4, 1, 'x')).toBe(200);
  });

  it('rejects non-finite values', () => {
    expect(() => toFixedPoint(Number.NaN, 1, 'x')).toThrow(InvalidParameterError);
    expect(() => toFixedPoint(Number.POSITIVE_INFINITY, 1, 'x')).toThrow(InvalidParameterError);
  });
});
