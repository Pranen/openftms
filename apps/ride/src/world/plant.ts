import type { RouteGraph } from 'route-graph';
import { TREES } from '../config';

/**
 * Tree planting (PLAN.md, Kachelformat: the client plants trees from CODE and a seed),
 * deterministic on a global jittered grid, clear of roads and houses. Runs in the tile worker;
 * the result is a flat list the renderer turns into instanced meshes (render/trees.ts).
 */

/** The tile fields planting needs (a subset of TileMesh). */
export interface PlantTile {
  x0: number;
  z0: number;
  n: number;
  cell: number;
  heights: Float32Array;
  codes: Uint8Array;
  boxes: Float32Array;
}

/** Floats per tree in the planted list: kind, x, y, z, height, width, angle, shade. */
export const TREE_STRIDE = 8;

export const enum Kind {
  Conifer = 0,
  Broadleaf = 1,
  Orchard = 2,
}

// land cover codes (tools/world-pipeline tiles.py)
const MEADOW = 0;
const FOREST = 1;
const ORCHARD = 2;
const SETTLEMENT = 3;
const FARMLAND = 7;

function hash(i: number, j: number, salt: number): number {
  let h = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(salt, 982451653);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Smooth value noise in [0, 1] (stands of conifers and broadleaf trees instead of salt and pepper). */
function noise(x: number, z: number): number {
  const i = Math.floor(x);
  const j = Math.floor(z);
  const u = x - i;
  const v = z - j;
  const su = u * u * (3 - 2 * u);
  const sv = v * v * (3 - 2 * v);
  const a = hash(i, j, 7);
  const b = hash(i + 1, j, 7);
  const c = hash(i, j + 1, 7);
  const d = hash(i + 1, j + 1, 7);
  return a + (b - a) * su + (c - a) * sv + (a - b - c + d) * su * sv;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};


interface Tree {
  kind: Kind;
  x: number;
  y: number;
  z: number;
  height: number;
  width: number;
  angle: number;
  shade: number;
}

type HeightAt = (x: number, z: number) => number | null;

function plant(t: PlantTile, graph: RouteGraph, heightAt: HeightAt, out: Tree[]): void {
  const size = (t.n - 1) * t.cell;
  const x1 = t.x0 + size;
  const z1 = t.z0 + size;
  // houses in 50 m buckets
  const BUCKET = 50;
  const houses = new Map<number, number[]>();
  const key = (i: number, j: number) => i * 65536 + j;
  for (let b = 0; b < t.boxes.length / 5; b++) {
    const r = t.boxes[b * 5 + 3]! + t.boxes[b * 5 + 4]! + TREES.clearHouse;
    const bx = t.boxes[b * 5]!;
    const bz = t.boxes[b * 5 + 1]!;
    for (let i = Math.floor((bx - r) / BUCKET); i <= Math.floor((bx + r) / BUCKET); i++) {
      for (let j = Math.floor((bz - r) / BUCKET); j <= Math.floor((bz + r) / BUCKET); j++) {
        const list = houses.get(key(i, j)) ?? [];
        list.push(b);
        houses.set(key(i, j), list);
      }
    }
  }
  const nearHouse = (x: number, z: number, gap: number) => {
    for (const b of houses.get(key(Math.floor(x / BUCKET), Math.floor(z / BUCKET))) ?? []) {
      const dx = x - t.boxes[b * 5]!;
      const dz = z - t.boxes[b * 5 + 1]!;
      const a = t.boxes[b * 5 + 2]!;
      const u = Math.abs(dx * Math.cos(a) + dz * Math.sin(a));
      const v = Math.abs(-dx * Math.sin(a) + dz * Math.cos(a));
      if (u < t.boxes[b * 5 + 3]! + gap && v < t.boxes[b * 5 + 4]! + gap) return true;
    }
    return false;
  };
  const codeAt = (x: number, z: number) => {
    const i = Math.round((x - t.x0) / t.cell);
    const j = Math.round((z - t.z0) / t.cell);
    return t.codes[j * t.n + i];
  };
  const layers: [number[], { spacing: number; density: number }, number][] = [
    [[FOREST], TREES.forest, 11],
    [[ORCHARD], TREES.orchard, 13],
    [[MEADOW, FARMLAND], TREES.meadow, 17],
    [[SETTLEMENT], TREES.settlement, 19],
  ];
  for (const [codes, { spacing, density }, salt] of layers) {
    // global grid: a tree belongs to the tile its position falls in (half-open)
    for (let j = Math.floor(t.z0 / spacing); j <= Math.ceil(z1 / spacing); j++) {
      for (let i = Math.floor(t.x0 / spacing); i <= Math.ceil(x1 / spacing); i++) {
        if (hash(i, j, salt) > density) continue;
        const orchard = codes[0] === ORCHARD;
        // orchards: rows with a little jitter; elsewhere free
        const jit = orchard ? 0.15 : 0.8;
        const x = (i + 0.5 + jit * (hash(i, j, salt + 1) - 0.5)) * spacing;
        const z = (j + 0.5 + jit * (hash(i, j, salt + 2) - 0.5)) * spacing;
        if (x < t.x0 || x >= x1 || z < t.z0 || z >= z1) continue;
        if (!codes.includes(codeAt(x, z) ?? -1)) continue;
        const y = heightAt(x, z);
        if (y === null) continue;
        const road = graph.nearest(x, z, 16);
        if (road && road.dist < graph.halfWidth(road.edge) + TREES.clearRoad) continue;
        if (nearHouse(x, z, TREES.clearHouse)) continue;
        const r = hash(i, j, salt + 3);
        let kind: Kind;
        if (orchard) kind = Kind.Orchard;
        else {
          const share = TREES.coniferLow + (TREES.coniferHigh - TREES.coniferLow) * smooth(TREES.coniferFrom, TREES.coniferTo, y);
          const stand = noise(x / 140, z / 140) * 0.75 + hash(i, j, salt + 4) * 0.25;
          // single trees in the open and in villages are mostly broadleaf
          kind = stand < (codes[0] === FOREST ? share : share * 0.4) ? Kind.Conifer : Kind.Broadleaf;
        }
        const [h0, h1] = kind === Kind.Conifer ? TREES.coniferHeight : kind === Kind.Broadleaf ? TREES.broadleafHeight : TREES.orchardHeight;
        const height = h0 + (h1 - h0) * r;
        out.push({
          kind,
          x,
          y: y - 0.3,
          z,
          height,
          width: height * (0.85 + 0.3 * hash(i, j, salt + 5)),
          angle: hash(i, j, salt + 6) * Math.PI * 2,
          shade: 0.82 + 0.3 * hash(i, j, salt + 7),
        });
      }
    }
  }
}

/** Exact height on the tile's own triangles (same split as the terrain mesh). */
function tileHeight(t: PlantTile): HeightAt {
  return (x, z) => {
    const fx = (x - t.x0) / t.cell;
    const fz = (z - t.z0) / t.cell;
    if (fx < 0 || fz < 0 || fx > t.n - 1 || fz > t.n - 1) return null;
    const i = Math.min(t.n - 2, Math.floor(fx));
    const j = Math.min(t.n - 2, Math.floor(fz));
    const u = fx - i;
    const v = fz - j;
    const h = (a: number, b: number) => t.heights[b * t.n + a]!;
    return u + v <= 1
      ? h(i, j) + (h(i + 1, j) - h(i, j)) * u + (h(i, j + 1) - h(i, j)) * v
      : h(i + 1, j + 1) + (h(i, j + 1) - h(i + 1, j + 1)) * (1 - u) + (h(i + 1, j) - h(i + 1, j + 1)) * (1 - v);
  };
}

/** All trees of an L0 tile as a flat list (TREE_STRIDE floats each). */
export function plantTile(t: PlantTile, graph: RouteGraph): Float32Array {
  const list: Tree[] = [];
  plant(t, graph, tileHeight(t), list);
  const out = new Float32Array(list.length * TREE_STRIDE);
  list.forEach((tr, k) => out.set([tr.kind, tr.x, tr.y, tr.z, tr.height, tr.width, tr.angle, tr.shade], k * TREE_STRIDE));
  return out;
}
