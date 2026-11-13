import { InvalidParameterError } from '../errors';

/** Anything a characteristic value can arrive as. */
export type BytesLike = ArrayBuffer | ArrayBufferView | ArrayLike<number>;

/**
 * Copies `data` into a fresh, tightly sized `Uint8Array`.
 *
 * Respects `byteOffset`/`byteLength` of views: a Web Bluetooth `DataView` may
 * be a window into a larger buffer, and reading the whole buffer decodes garbage.
 */
export function toBytes(data: BytesLike): Uint8Array {
  if (data instanceof ArrayBuffer) return new Uint8Array(data.slice(0));
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice();
  }
  return Uint8Array.from(data);
}

/** Formats bytes as lowercase hex, e.g. `44 00 10 09`. */
export function toHex(data: BytesLike, separator = ' '): string {
  return Array.from(toBytes(data), (b) => b.toString(16).padStart(2, '0')).join(separator);
}

/** Parses hex such as `44 00 10 09`, `44:00:10:09`, `0x44 0x00` or `44001009`. */
export function fromHex(hex: string): Uint8Array {
  const clean = hex.replace(/0x/gi, '').replace(/[\s:,-]/g, '');
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) {
    throw new InvalidParameterError(`Invalid hex string: "${hex}"`);
  }
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Problems found while parsing a packet. Parsers never throw on bad input. */
export interface ParseDiagnostics {
  /** The packet ended before all fields announced by its flags were read. */
  readonly truncated: boolean;
  /** Bytes left over after all known fields were read. */
  readonly trailingBytes: number;
  /** Bits set in reserved (undefined) flag positions, `0` if none. */
  readonly reservedFlags: number;
}

/** True if the packet deviated from the spec in any way. */
export function hasParseIssues(d: ParseDiagnostics): boolean {
  return d.truncated || d.trailingBytes > 0 || d.reservedFlags !== 0;
}

/**
 * Bounds-checked little-endian cursor.
 *
 * Reading past the end returns `undefined` and marks the reader as truncated;
 * every following read returns `undefined` as well.
 */
export class ByteReader {
  readonly bytes: Uint8Array;
  readonly #view: DataView;
  #offset = 0;
  #truncated = false;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.#view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get offset(): number {
    return this.#offset;
  }

  get remaining(): number {
    return this.bytes.length - this.#offset;
  }

  get truncated(): boolean {
    return this.#truncated;
  }

  #claim(size: number): number | undefined {
    if (this.#truncated || this.remaining < size) {
      this.#truncated = true;
      this.#offset = this.bytes.length;
      return undefined;
    }
    const start = this.#offset;
    this.#offset += size;
    return start;
  }

  uint8(): number | undefined {
    const o = this.#claim(1);
    return o === undefined ? undefined : this.#view.getUint8(o);
  }

  sint8(): number | undefined {
    const o = this.#claim(1);
    return o === undefined ? undefined : this.#view.getInt8(o);
  }

  uint16(): number | undefined {
    const o = this.#claim(2);
    return o === undefined ? undefined : this.#view.getUint16(o, true);
  }

  sint16(): number | undefined {
    const o = this.#claim(2);
    return o === undefined ? undefined : this.#view.getInt16(o, true);
  }

  uint24(): number | undefined {
    const o = this.#claim(3);
    return o === undefined
      ? undefined
      : this.#view.getUint16(o, true) + (this.#view.getUint8(o + 2) << 16);
  }

  uint32(): number | undefined {
    const o = this.#claim(4);
    return o === undefined ? undefined : this.#view.getUint32(o, true);
  }

  /** Consumes and returns all remaining bytes. */
  rest(): Uint8Array {
    const out = this.bytes.slice(this.#offset);
    this.#offset = this.bytes.length;
    return out;
  }

  /** Consumes all remaining bytes and decodes them as UTF-8. */
  restAsUtf8(): string {
    return new TextDecoder().decode(this.rest());
  }

  diagnostics(reservedFlags = 0): ParseDiagnostics {
    return {
      truncated: this.#truncated,
      trailingBytes: this.#truncated ? 0 : this.remaining,
      reservedFlags,
    };
  }
}

function assertInteger(value: number, min: number, max: number, field: string): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new InvalidParameterError(
      `${field} must be an integer in [${min}, ${max}] on the wire, got ${String(value)}`,
    );
  }
}

/** Little-endian packet builder with range checks per field. */
export class ByteWriter {
  readonly #bytes: number[] = [];

  uint8(value: number, field = 'value'): this {
    assertInteger(value, 0, 0xff, field);
    this.#bytes.push(value);
    return this;
  }

  sint8(value: number, field = 'value'): this {
    assertInteger(value, -0x80, 0x7f, field);
    this.#bytes.push(value & 0xff);
    return this;
  }

  uint16(value: number, field = 'value'): this {
    assertInteger(value, 0, 0xffff, field);
    this.#bytes.push(value & 0xff, (value >>> 8) & 0xff);
    return this;
  }

  sint16(value: number, field = 'value'): this {
    assertInteger(value, -0x8000, 0x7fff, field);
    const u = value & 0xffff;
    this.#bytes.push(u & 0xff, u >>> 8);
    return this;
  }

  uint24(value: number, field = 'value'): this {
    assertInteger(value, 0, 0xffffff, field);
    this.#bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff);
    return this;
  }

  uint32(value: number, field = 'value'): this {
    assertInteger(value, 0, 0xffffffff, field);
    this.#bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, (value >>> 24) & 0xff);
    return this;
  }

  toBytes(): Uint8Array {
    return Uint8Array.from(this.#bytes);
  }
}

/**
 * Converts a physical value to its integer wire representation, e.g.
 * `toFixedPoint(2.5, 100)` → `250` for a field with 0.01 resolution.
 * Rounds half away from zero; guards against float noise (1.005 → 101).
 */
export function toFixedPoint(value: number, scale: number, field: string): number {
  if (!Number.isFinite(value)) {
    throw new InvalidParameterError(`${field} must be a finite number, got ${String(value)}`);
  }
  const magnitude = Math.round(Number((Math.abs(value) * scale).toFixed(6)));
  return value < 0 ? -magnitude : magnitude;
}

/** Inverse of {@link toFixedPoint}; passes `undefined` through. */
export function fromFixedPoint(raw: number | undefined, scale: number): number | undefined {
  return raw === undefined ? undefined : raw / scale;
}
