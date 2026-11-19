import * as THREE from 'three/webgpu';
import { RENDER, TREES } from '../config';
import type { TileMesh } from '../workers/world-worker';
import { TREE_STRIDE } from '../world/plant';
import { retroMaterial } from './retro';

/**
 * Trees (PLAN.md, Renderer): planted in the tile worker (world/plant.ts) as each L0 tile streams
 * in, drawn here as instanced low-poly models in chunks that switch off beyond `RENDER.treeDistance`.
 */

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

type Chunk = { mesh: THREE.InstancedMesh; cx: number; cz: number };

/** Trees of the loaded L0 tiles, planted when a tile arrives, in chunks that switch off with distance. */
export class Trees {
  readonly group = new THREE.Group();
  private readonly byTile = new Map<string, { chunks: Chunk[]; count: number }>();
  private readonly models = [coniferModel(), broadleafModel(TREES.colours.broadleaf, 0.3), broadleafModel(TREES.colours.orchard, 0.35)];
  private readonly mat = retroMaterial();

  get count(): number {
    let n = 0;
    for (const t of this.byTile.values()) n += t.count;
    return n;
  }

  add(t: TileMesh, key: string): void {
    if (t.level !== 0 || this.byTile.has(key) || !t.trees) return;
    const T = t.trees;
    const count = T.length / TREE_STRIDE;
    const groups = new Map<string, number[]>();
    for (let i = 0; i < count; i++) {
      const o = i * TREE_STRIDE;
      const k = `${T[o]}:${Math.floor(T[o + 1]! / TREES.chunk)}:${Math.floor(T[o + 3]! / TREES.chunk)}`;
      const g = groups.get(k) ?? [];
      g.push(o);
      groups.set(k, g);
    }
    const m = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const p = new THREE.Vector3();
    const s = new THREE.Vector3();
    const c = new THREE.Color();
    const chunks: Chunk[] = [];
    for (const [k, g] of groups) {
      const [kind, ci, cj] = k.split(':').map(Number) as [number, number, number];
      const mesh = new THREE.InstancedMesh(this.models[kind]!, this.mat, g.length);
      g.forEach((o, n) => {
        p.set(T[o + 1]!, T[o + 2]!, T[o + 3]!);
        q.setFromAxisAngle(up, T[o + 6]!);
        s.set(T[o + 5]!, T[o + 4]!, T[o + 5]!);
        mesh.setMatrixAt(n, m.compose(p, q, s));
        mesh.setColorAt(n, c.setScalar(T[o + 7]!));
      });
      mesh.computeBoundingSphere();
      mesh.matrixAutoUpdate = false;
      this.group.add(mesh);
      chunks.push({ mesh, cx: (ci + 0.5) * TREES.chunk, cz: (cj + 0.5) * TREES.chunk });
    }
    this.byTile.set(key, { chunks, count });
  }

  remove(key: string): void {
    const t = this.byTile.get(key);
    if (!t) return;
    for (const ch of t.chunks) {
      ch.mesh.removeFromParent();
      ch.mesh.dispose(); // instance buffers only; the shared models stay
    }
    this.byTile.delete(key);
  }

  /** Chunks beyond the tree distance are switched off (the forest colour carries the distance). */
  update(camera: THREE.Vector3): void {
    const r = RENDER.treeDistance + TREES.chunk * 0.71;
    for (const t of this.byTile.values())
      for (const ch of t.chunks) ch.mesh.visible = Math.hypot(ch.cx - camera.x, ch.cz - camera.z) < r;
  }
}
