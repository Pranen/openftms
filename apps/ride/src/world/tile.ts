/**
 * Decoder for L0 tiles written by tools/world-pipeline (ride_pipeline/tiles.py).
 * Spec: apps/ride/PLAN.md, "Kachelformat".
 */

export interface TileHeader {
  version: number;
  level: number;
  ix: number;
  iy: number;
  /** SW corner in LV95. */
  originE: number;
  originN: number;
  n: number;
  cell: number;
  hScale: number;
  hOffset: number;
}

export interface Building {
  /** Footprint in tile-local metres (x east from the tile's west edge, z south from its north edge). */
  ring: Float32Array;
  /** Oriented box: centre, angle of the long axis in the x/z frame, half length, half width. */
  cx: number;
  cz: number;
  angle: number;
  halfLength: number;
  halfWidth: number;
  base: number;
  eave: number;
  ridge: number;
  roof: number;
  colour: number;
}

/** Scenery line kinds (LINE section, tools/world-pipeline scenery.py). */
export const LINE_KIND = { motorway: 1, trunk: 2, rail: 10, power: 20, minorPower: 21, river: 30, stream: 31, canal: 32 } as const;
/** Per-point flags of the segment to the next point. */
export const LINE_BRIDGE = 1;
export const LINE_TUNNEL = 2;

/** A scenery line piece of a tile (motorway, railway, power line, waterway); points tile-local like buildings. */
export interface SceneryLine {
  kind: number;
  width: number;
  x: Float32Array;
  z: Float32Array;
  h: Float32Array;
  f: Uint16Array;
}

/** A landmark (LMRK): model style, tile-local centre, angle in the x/z frame, half sizes, base height. */
export interface LandmarkRecord {
  style: number;
  cx: number;
  cz: number;
  angle: number;
  hl: number;
  hw: number;
  base: number;
}

export interface Tile {
  header: TileHeader;
  /** Node heights, row 0 = north edge, n × n. */
  heights: Float32Array;
  codes: Uint8Array;
  buildings: Building[];
  lines: SceneryLine[];
  landmarks: LandmarkRecord[];
  /** Coarse levels: buildings as boxes (BLDQ): x, z (tile-local), angle (x/z frame), hl, hw, base, height, colour, style. */
  boxes: Float32Array;
}

export function decodeTile(buf: ArrayBuffer): Tile {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3));
  if (magic !== 'RIDE') throw new Error('not a Ride tile');
  const header: TileHeader = {
    version: dv.getUint16(4, true),
    level: dv.getUint8(6),
    ix: dv.getInt32(8, true),
    iy: dv.getInt32(12, true),
    originE: dv.getFloat64(16, true),
    originN: dv.getFloat64(24, true),
    n: dv.getUint16(32, true),
    cell: dv.getFloat32(36, true),
    hScale: dv.getFloat32(40, true),
    hOffset: dv.getFloat32(44, true),
  };
  if (header.version !== 1) throw new Error(`unsupported tile version ${header.version}`);
  const count = dv.getUint16(34, true);
  const sections = new Map<string, [number, number]>();
  for (let i = 0; i < count; i++) {
    const o = 48 + i * 12;
    const id = String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
    sections.set(id, [dv.getUint32(o + 4, true), dv.getUint32(o + 8, true)]);
  }
  const n = header.n;
  const hs = sections.get('HGHT');
  if (!hs) throw new Error('tile without HGHT');
  const d = new Uint16Array(buf, hs[0], n * n);
  // second-order delta: cumulative sums down the columns, then along the rows (uint16 wrap-around)
  const a = new Uint16Array(n * n);
  for (let i = 0; i < n; i++) a[i] = d[i]!;
  for (let j = 1; j < n; j++) for (let i = 0; i < n; i++) a[j * n + i] = (a[(j - 1) * n + i]! + d[j * n + i]!) & 0xffff;
  const heights = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    let q = 0;
    for (let i = 0; i < n; i++) {
      q = (q + a[j * n + i]!) & 0xffff;
      heights[j * n + i] = header.hOffset + q * header.hScale;
    }
  }
  const cs = sections.get('CODE');
  const codes = cs ? new Uint8Array(buf.slice(cs[0], cs[0] + n * n)) : new Uint8Array(n * n);
  const bs = sections.get('BLDG');
  const buildings = bs ? decodeBuildings(dv, bs[0], header) : [];
  const ls = sections.get('LINE');
  const lines = ls ? decodeLines(dv, ls[0], header) : [];
  const ms = sections.get('LMRK');
  const landmarks: LandmarkRecord[] = [];
  if (ms) {
    const count = dv.getUint32(ms[0], true);
    for (let k = 0, o = ms[0] + 4; k < count; k++, o += 16) {
      landmarks.push({
        style: dv.getUint8(o),
        cx: dv.getInt16(o + 2, true) / 10,
        cz: dv.getInt16(o + 4, true) / 10,
        angle: -(dv.getUint16(o + 6, true) / 65535) * Math.PI,
        hl: dv.getUint16(o + 8, true) / 10,
        hw: dv.getUint16(o + 10, true) / 10,
        base: header.hOffset + dv.getUint16(o + 12, true) * header.hScale,
      });
    }
  }
  const qs = sections.get('BLDQ');
  let boxes = new Float32Array(0);
  if (qs) {
    const count = dv.getUint32(qs[0], true);
    boxes = new Float32Array(count * 9);
    for (let k = 0, o = qs[0] + 4; k < count; k++, o += 16) {
      boxes.set(
        [
          dv.getUint16(o, true) / 10,
          dv.getUint16(o + 2, true) / 10,
          -(dv.getUint16(o + 4, true) / 65535) * Math.PI,
          dv.getUint16(o + 6, true) / 10,
          dv.getUint16(o + 8, true) / 10,
          dv.getUint16(o + 10, true) * header.hScale + header.hOffset,
          dv.getUint16(o + 12, true) / 10,
          dv.getUint8(o + 14),
          dv.getUint8(o + 15),
        ],
        k * 9,
      );
    }
  }
  return { header, heights, codes, buildings, lines, landmarks, boxes };
}

function decodeLines(dv: DataView, offset: number, h: TileHeader): SceneryLine[] {
  const count = dv.getUint32(offset, true);
  const out: SceneryLine[] = [];
  let o = offset + 4;
  for (let k = 0; k < count; k++) {
    const kind = dv.getUint8(o);
    const width = dv.getUint16(o + 2, true) / 10;
    const n = dv.getUint16(o + 4, true);
    o += 8;
    const line: SceneryLine = { kind, width, x: new Float32Array(n), z: new Float32Array(n), h: new Float32Array(n), f: new Uint16Array(n) };
    for (let i = 0; i < n; i++) {
      line.x[i] = dv.getInt16(o, true) / 10;
      line.z[i] = dv.getInt16(o + 2, true) / 10;
      line.h[i] = h.hOffset + dv.getUint16(o + 4, true) * h.hScale;
      line.f[i] = dv.getUint16(o + 6, true);
      o += 8;
    }
    out.push(line);
  }
  return out;
}

function decodeBuildings(dv: DataView, offset: number, h: TileHeader): Building[] {
  const count = dv.getUint32(offset, true);
  const out: Building[] = [];
  let o = offset + 4;
  for (let k = 0; k < count; k++) {
    const cx = dv.getInt16(o, true) / 10;
    const cz = dv.getInt16(o + 2, true) / 10;
    const angLv95 = (dv.getUint16(o + 4, true) / 65535) * Math.PI;
    const halfLength = dv.getUint16(o + 6, true) / 10;
    const halfWidth = dv.getUint16(o + 8, true) / 10;
    const base = h.hOffset + dv.getUint16(o + 10, true) * h.hScale;
    const eave = dv.getUint16(o + 12, true) / 10;
    const ridge = dv.getUint16(o + 14, true) / 10;
    const roof = dv.getUint8(o + 16);
    const colour = dv.getUint8(o + 17);
    const nv = dv.getUint16(o + 18, true);
    o += 20;
    const ring = new Float32Array(nv * 2);
    for (let i = 0; i < nv; i++) {
      ring[i * 2] = dv.getInt16(o, true) / 10;
      ring[i * 2 + 1] = dv.getInt16(o + 2, true) / 10;
      o += 4;
    }
    // LV95 angle (from east towards north) -> x/z frame (z points south)
    out.push({ ring, cx, cz, angle: -angLv95, halfLength, halfWidth, base, eave, ridge, roof, colour });
  }
  return out;
}
