/// <reference lib="webworker" />
/**
 * Decodes tiles and builds their meshes off the main thread (Web Bluetooth lives
 * on the main thread; it must stay responsive). Returns transferable arrays.
 */
import { ShapeUtils, Vector2 } from 'three';
import { BUILDING, LANDCOVER, STREAM } from '../config';
import { RouteGraph, type GraphMeta } from 'route-graph';
import { plantTile } from '../world/plant';
import { decodeTile, type Building } from '../world/tile';

/** The ride graph, sent once: trees are planted clear of the roads. */
export interface GraphMessage {
  graph: { meta: GraphMeta; bin: ArrayBuffer };
}

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
  /** Terrain meshes, chunks × chunks, row by row from the north-west (see STREAM.chunks). */
  terrain: { position: Float32Array; color: Uint8Array }[];
  chunks: number;
  buildings: { position: Float32Array; color: Float32Array };
  buildingCount: number;
  /** L0: planted trees (world/plant.ts, TREE_STRIDE floats each). */
  trees?: Float32Array;
}

const lin = (c: number) => {
  const v = c / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const rgb = (hex: number): [number, number, number] => [lin((hex >> 16) & 255), lin((hex >> 8) & 255), lin(hex & 255)];
const PAL = LANDCOVER.map((pair) => pair.map(rgb));
/** Terrain colours as normalised bytes (a third of the memory of floats; the terrain is most of it). */
const PAL8 = PAL.map((pair) => pair.map((c) => c.map((v) => Math.round(v * 255))));
const WALLS = BUILDING.walls.map(rgb);
const ROOFS = BUILDING.roofs.map(rgb);
const FLAT = rgb(BUILDING.flatRoof);

function hash(i: number, j: number): number {
  let h = Math.imul(i, 374761393) + Math.imul(j, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/**
 * Terrain of one tile, split into chunks × chunks meshes (a coarse tile hides the chunks a
 * loaded finer tile covers, PLAN.md "Höhenpyramide"), each with a skirt hanging down along
 * its border that covers the cracks to neighbours of another level.
 */
function terrain(h: Float32Array, codes: Uint8Array, n: number, cell: number, x0: number, z0: number, ix: number, iy: number,
  chunks: number, skirt: number, step: number) {
  const k = (n - 1) / chunks; // cells per chunk side
  const m = k / step; // quads per chunk side after thinning
  const out: { position: Float32Array; color: Uint8Array }[] = [];
  for (let cj = 0; cj < chunks; cj++) {
    for (let ci = 0; ci < chunks; ci++) {
      const tris = 2 * m * m + 16 * m; // surface + skirts (4 edges × m segments × 2 triangles × 2 windings)
      const position = new Float32Array(tris * 9);
      const color = new Uint8Array(tris * 12); // RGBA bytes: WebGPU has no 3-byte vertex format
      let p = 0;
      const node = (i: number, j: number, c: readonly number[], drop = 0) => {
        position[p] = x0 + i * cell;
        position[p + 1] = h[j * n + i]! - drop;
        position[p + 2] = z0 + j * cell;
        const q = (p / 3) * 4;
        color[q] = c[0]!;
        color[q + 1] = c[1]!;
        color[q + 2] = c[2]!;
        color[q + 3] = 255;
        p += 3;
      };
      const colourAt = (i: number, j: number, kk: number) => {
        const code = codes[Math.min(n - 2, j) * n + Math.min(n - 2, i)]!;
        const pal = PAL8[code] ?? PAL8[0]!;
        return pal[hash(ix * 4096 + i * 2 + kk, iy * 4096 + j) < 0.5 ? 0 : 1]!;
      };
      const i0 = ci * k;
      const j0 = cj * k;
      for (let j = j0; j < j0 + k; j += step) {
        for (let i = i0; i < i0 + k; i += step) {
          const a = colourAt(i, j, 0);
          node(i, j, a);
          node(i, j + step, a);
          node(i + step, j, a);
          const b = colourAt(i, j, 1);
          node(i, j + step, b);
          node(i + step, j + step, b);
          node(i + step, j, b);
        }
      }
      // skirts: vertical strips under the four chunk edges, drawn from both sides
      const edge = (ia: number, ja: number, ib: number, jb: number) => {
        const c = colourAt(Math.min(ia, ib), Math.min(ja, jb), 0);
        node(ia, ja, c);
        node(ib, jb, c);
        node(ia, ja, c, skirt);
        node(ib, jb, c);
        node(ib, jb, c, skirt);
        node(ia, ja, c, skirt);
        node(ib, jb, c);
        node(ia, ja, c);
        node(ia, ja, c, skirt);
        node(ia, ja, c, skirt);
        node(ib, jb, c, skirt);
        node(ib, jb, c);
      };
      for (let t = 0; t < k; t += step) {
        edge(i0 + t, j0, i0 + t + step, j0);
        edge(i0 + t, j0 + k, i0 + t + step, j0 + k);
        edge(i0, j0 + t, i0, j0 + t + step);
        edge(i0 + k, j0 + t, i0 + k, j0 + t + step);
      }
      out.push({ position, color });
    }
  }
  return out;
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

let graph: RouteGraph | null = null;

self.onmessage = (ev: MessageEvent<TileRequest | GraphMessage>) => {
  if ('graph' in ev.data) {
    graph = new RouteGraph(ev.data.graph.meta, ev.data.graph.bin);
    return;
  }
  const { id, buffer, e0, n0 } = ev.data;
  const t = decodeTile(buffer);
  const { n, cell } = t.header;
  const x0 = t.header.originE - e0;
  const z0 = n0 - (t.header.originN + cell * (n - 1));
  const level = t.header.level;
  const chunks = STREAM.chunks[level] ?? 1;
  const mesh: TileMesh = {
    id,
    level,
    ix: t.header.ix,
    iy: t.header.iy,
    x0,
    z0,
    n,
    cell,
    heights: t.heights,
    codes: t.codes,
    boxes: new Float32Array(t.buildings.flatMap((b) => [x0 + b.cx, z0 + b.cz, b.angle, b.halfLength, b.halfWidth])),
    terrain: terrain(t.heights, t.codes, n, cell, x0, z0, t.header.ix, t.header.iy, chunks, STREAM.skirt[level] ?? 50, STREAM.step[level] ?? 1),
    chunks,
    buildings: buildings(t.buildings, x0, z0),
    buildingCount: t.buildings.length,
  };
  if (level === 0 && graph) mesh.trees = plantTile(mesh, graph);
  (self as unknown as Worker).postMessage(mesh, [
    ...(mesh.trees ? [mesh.trees.buffer] : []),
    mesh.heights.buffer,
    mesh.codes.buffer,
    mesh.boxes.buffer,
    ...mesh.terrain.flatMap((c) => [c.position.buffer, c.color.buffer]),
    mesh.buildings.position.buffer,
    mesh.buildings.color.buffer,
  ]);
};
