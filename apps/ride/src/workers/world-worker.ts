/// <reference lib="webworker" />
/**
 * Decodes tiles and builds their meshes off the main thread (Web Bluetooth lives
 * on the main thread; it must stay responsive). Returns transferable arrays.
 */
import { ShapeUtils, Vector2 } from 'three';
import { BUILDING, LANDCOVER } from '../config';
import { decodeTile, type Building } from '../world/tile';

export interface TileRequest {
  id: number;
  buffer: ArrayBuffer;
  /** World frame origin (LV95). */
  e0: number;
  n0: number;
}

export interface TileMesh {
  id: number;
  level: number;
  ix: number;
  iy: number;
  /** World position of node (0, 0) (NW corner). */
  x0: number;
  z0: number;
  n: number;
  cell: number;
  heights: Float32Array;
  /** Land cover code per node (same layout as `heights`). */
  codes: Uint8Array;
  /** Building boxes in world x/z: cx, cz, angle, half length, half width (5 floats each). */
  boxes: Float32Array;
  terrain: { position: Float32Array; color: Float32Array };
  buildings: { position: Float32Array; color: Float32Array };
  buildingCount: number;
}

const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const rgb = (hex: number): [number, number, number] => [lin((hex >> 16) & 255), lin((hex >> 8) & 255), lin(hex & 255)];
const PAL = LANDCOVER.map((pair) => pair.map(rgb));
const WALLS = BUILDING.walls.map(rgb);
const ROOFS = BUILDING.roofs.map(rgb);
const FLAT = rgb(BUILDING.flatRoof);

function hash(i: number, j: number): number {
  let h = Math.imul(i, 374761393) + Math.imul(j, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function terrain(h: Float32Array, codes: Uint8Array, n: number, cell: number, x0: number, z0: number, ix: number, iy: number) {
  const cells = (n - 1) * (n - 1);
  const position = new Float32Array(cells * 18);
  const color = new Float32Array(cells * 18);
  let p = 0;
  const put = (i: number, j: number, c: [number, number, number]) => {
    position[p] = x0 + i * cell;
    position[p + 1] = h[j * n + i]!;
    position[p + 2] = z0 + j * cell;
    color[p] = c[0];
    color[p + 1] = c[1];
    color[p + 2] = c[2];
    p += 3;
  };
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const code = codes[j * n + i]!;
      const pal = PAL[code] ?? PAL[0]!;
      for (let k = 0; k < 2; k++) {
        const c = pal[hash(ix * 4096 + i * 2 + k, iy * 4096 + j) < 0.5 ? 0 : 1]!;
        if (k === 0) {
          put(i, j, c);
          put(i, j + 1, c);
          put(i + 1, j, c);
        } else {
          put(i, j + 1, c);
          put(i + 1, j + 1, c);
          put(i + 1, j, c);
        }
      }
    }
  }
  return { position, color };
}

function buildings(list: Building[], x0: number, z0: number) {
  const pos: number[] = [];
  const col: number[] = [];
  const tri = (a: number[], b: number[], c: number[], colour: [number, number, number]) => {
    pos.push(...a, ...b, ...c);
    col.push(...colour, ...colour, ...colour);
  };
  for (const b of list) {
    const wall = WALLS[b.colour % WALLS.length]!;
    const roofC = b.roof === 0 ? FLAT : ROOFS[b.colour % ROOFS.length]!;
    const nv = b.ring.length / 2;
    const y0 = b.base;
    const y1 = b.base + 0.3 + b.eave;
    const P = (k: number, y: number) => [x0 + b.ring[k * 2]!, y, z0 + b.ring[k * 2 + 1]!];
    for (let k = 0; k < nv; k++) {
      const k2 = (k + 1) % nv;
      const a = P(k, y0);
      const c = P(k2, y0);
      const a1 = P(k, y1);
      const c1 = P(k2, y1);
      tri(a, c, a1, wall);
      tri(c, c1, a1, wall);
    }
    if (b.roof === 0) {
      const pts = [];
      for (let k = 0; k < nv; k++) pts.push(new Vector2(b.ring[k * 2]!, b.ring[k * 2 + 1]!));
      for (const t of ShapeUtils.triangulateShape(pts, [])) tri(P(t[0]!, y1), P(t[1]!, y1), P(t[2]!, y1), roofC);
      continue;
    }
    // gabled / hipped roof on the oriented box, with a little overhang
    const o = BUILDING.overhang;
    const ux = Math.cos(b.angle);
    const uz = Math.sin(b.angle);
    const vx = -uz;
    const vz = ux;
    const hl = b.halfLength + o;
    const hw = b.halfWidth + o;
    const cx = x0 + b.cx;
    const cz = z0 + b.cz;
    const yr = b.base + 0.3 + b.ridge;
    const corner = (su: number, sv: number) => [cx + ux * hl * su + vx * hw * sv, y1, cz + uz * hl * su + vz * hw * sv];
    const rl = b.roof === 2 ? Math.max(0, hl - hw) : hl;
    const ridge = (su: number) => [cx + ux * rl * su, yr, cz + uz * rl * su];
    const A = corner(-1, -1);
    const B = corner(1, -1);
    const C = corner(1, 1);
    const D = corner(-1, 1);
    const R0 = ridge(-1);
    const R1 = ridge(1);
    tri(A, B, R1, roofC);
    tri(A, R1, R0, roofC);
    tri(C, D, R0, roofC);
    tri(C, R0, R1, roofC);
    const gable = b.roof === 2 ? roofC : wall;
    tri(B, C, R1, gable);
    tri(D, A, R0, gable);
  }
  return { position: new Float32Array(pos), color: new Float32Array(col) };
}

self.onmessage = (ev: MessageEvent<TileRequest>) => {
  const { id, buffer, e0, n0 } = ev.data;
  const t = decodeTile(buffer);
  const { n, cell } = t.header;
  const x0 = t.header.originE - e0;
  const z0 = n0 - (t.header.originN + cell * (n - 1));
  const mesh: TileMesh = {
    id,
    level: t.header.level,
    ix: t.header.ix,
    iy: t.header.iy,
    x0,
    z0,
    n,
    cell,
    heights: t.heights,
    codes: t.codes,
    boxes: new Float32Array(t.buildings.flatMap((b) => [x0 + b.cx, z0 + b.cz, b.angle, b.halfLength, b.halfWidth])),
    terrain: terrain(t.heights, t.codes, n, cell, x0, z0, t.header.ix, t.header.iy),
    buildings: buildings(t.buildings, x0, z0),
    buildingCount: t.buildings.length,
  };
  (self as unknown as Worker).postMessage(mesh, [
    mesh.heights.buffer,
    mesh.codes.buffer,
    mesh.boxes.buffer,
    mesh.terrain.position.buffer,
    mesh.terrain.color.buffer,
    mesh.buildings.position.buffer,
    mesh.buildings.color.buffer,
  ]);
};
