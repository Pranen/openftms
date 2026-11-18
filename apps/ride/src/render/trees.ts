import * as THREE from 'three/webgpu';
import type { RouteGraph } from 'route-graph';
import { RENDER, TREES } from '../config';
import type { TileMesh } from '../workers/world-worker';
import { retroMaterial } from './retro';

/**
 * Trees (PLAN.md, Renderer): planted deterministically from the land cover codes of the L0
 * tiles on a global jittered grid (the same tree stands at the same spot on every load),
 * kept clear of roads and houses, drawn as instanced low-poly models in chunks that switch
 * off beyond `RENDER.treeDistance`.
 */

const enum Kind {
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

// --- models (height 1, foot at y = 0), flat-shaded vertex colours ---------------------------

class ModelBuilder {
  readonly pos: number[] = [];
  readonly col: number[] = [];

  tri(a: number[], b: number[], c: number[], ca: THREE.Color, cb = ca, cc = ca): void {
    this.pos.push(...a, ...b, ...c);
    for (const k of [ca, cb, cc]) this.col.push(k.r, k.g, k.b);
  }

  /** Cone sides (and optionally the bottom) from y0 at radius r to the tip at y1. */
  cone(sides: number, r: number, y0: number, y1: number, base: THREE.Color, tip: THREE.Color, phase = 0, bottom = false): void {
    for (let k = 0; k < sides; k++) {
      const a0 = phase + (k / sides) * Math.PI * 2;
      const a1 = phase + ((k + 1) / sides) * Math.PI * 2;
      const p0 = [Math.cos(a0) * r, y0, Math.sin(a0) * r];
      const p1 = [Math.cos(a1) * r, y0, Math.sin(a1) * r];
      this.tri(p1, p0, [0, y1, 0], base, base, tip);
      if (bottom) this.tri(p0, p1, [0, y0, 0], base);
    }
  }

  /** Prism (trunk) without caps. */
  prism(sides: number, r: number, y0: number, y1: number, c: THREE.Color): void {
    for (let k = 0; k < sides; k++) {
      const a0 = (k / sides) * Math.PI * 2;
      const a1 = ((k + 1) / sides) * Math.PI * 2;
      const b0 = [Math.cos(a0) * r, y0, Math.sin(a0) * r];
      const b1 = [Math.cos(a1) * r, y0, Math.sin(a1) * r];
      const t0 = [b0[0]!, y1, b0[2]!];
      const t1 = [b1[0]!, y1, b1[2]!];
      this.tri(b1, b0, t0, c);
      this.tri(b1, t0, t1, c);
    }
  }

  /** Squashed icosahedron (crown) around (0, cy, 0). */
  crown(r: number, cy: number, squash: number, low: THREE.Color, high: THREE.Color): void {
    const g = new THREE.IcosahedronGeometry(r, 0); // already non-indexed
    const p = g.attributes.position!.array as Float32Array;
    const v = (k: number) => [p[k * 3]!, cy + p[k * 3 + 1]! * squash, p[k * 3 + 2]!];
    const c = (k: number) => low.clone().lerp(high, (p[k * 3 + 1]! / r + 1) / 2);
    for (let k = 0; k < p.length / 3; k += 3) this.tri(v(k), v(k + 1), v(k + 2), c(k), c(k + 1), c(k + 2));
    g.dispose();
  }

  geometry(): THREE.BufferGeometry {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    g.computeBoundingSphere();
    return g;
  }
}

const C = (hex: number) => new THREE.Color(hex);

function coniferModel(): THREE.BufferGeometry {
  const m = new ModelBuilder();
  const [dark, light] = TREES.colours.conifer.map(C) as [THREE.Color, THREE.Color];
  m.prism(3, 0.025, 0, 0.12, C(TREES.colours.trunk));
  m.cone(5, 0.22, 0.08, 0.6, dark, light, 0, true);
  m.cone(5, 0.16, 0.38, 0.82, dark, light, 0.6);
  m.cone(5, 0.09, 0.64, 1, dark, light, 1.2);
  return m.geometry();
}

function broadleafModel(colours: readonly number[], trunk: number): THREE.BufferGeometry {
  const m = new ModelBuilder();
  const [dark, light] = colours.map(C) as [THREE.Color, THREE.Color];
  m.prism(3, 0.04, 0, trunk + 0.05, C(TREES.colours.trunk));
  m.crown(0.36, trunk + (1 - trunk) / 2, (1 - trunk) / 0.72, dark, light);
  return m.geometry();
}

// --- planting ---------------------------------------------------------------------------

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

function plant(t: TileMesh, graph: RouteGraph, heightAt: HeightAt, out: Tree[]): void {
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

/** All trees of the L0 tiles, in chunks that switch off with distance. */
export class Trees {
  readonly group = new THREE.Group();
  readonly count: number;
  private readonly chunks: { mesh: THREE.InstancedMesh; cx: number; cz: number }[] = [];

  constructor(tiles: TileMesh[], graph: RouteGraph, heightAt: HeightAt) {
    const list: Tree[] = [];
    for (const t of tiles) if (t.level === 0) plant(t, graph, heightAt, list);
    this.count = list.length;
    const models = [coniferModel(), broadleafModel(TREES.colours.broadleaf, 0.3), broadleafModel(TREES.colours.orchard, 0.35)];
    const mat = retroMaterial();
    const groups = new Map<string, Tree[]>();
    for (const tr of list) {
      const k = `${tr.kind}:${Math.floor(tr.x / TREES.chunk)}:${Math.floor(tr.z / TREES.chunk)}`;
      const g = groups.get(k) ?? [];
      g.push(tr);
      groups.set(k, g);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const c = new THREE.Color();
    for (const [k, g] of groups) {
      const [kind, ci, cj] = k.split(':').map(Number) as [number, number, number];
      const mesh = new THREE.InstancedMesh(models[kind]!, mat, g.length);
      g.forEach((tr, n) => {
        p.set(tr.x, tr.y, tr.z);
        q.setFromAxisAngle(up, tr.angle);
        s.set(tr.width, tr.height, tr.width);
        mesh.setMatrixAt(n, m.compose(p, q, s));
        mesh.setColorAt(n, c.setScalar(tr.shade));
      });
      mesh.computeBoundingSphere();
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      this.chunks.push({ mesh, cx: (ci + 0.5) * TREES.chunk, cz: (cj + 0.5) * TREES.chunk });
    }
  }

  /** Chunks beyond the tree distance are switched off (the forest colour carries the distance). */
  update(camera: THREE.Vector3): void {
    const r = RENDER.treeDistance + TREES.chunk * 0.71;
    for (const ch of this.chunks) ch.mesh.visible = Math.hypot(ch.cx - camera.x, ch.cz - camera.z) < r;
  }
}
