/**
 * A train now and then on the railway lines of the loaded L0 tiles: the rail pieces of the tiles (LINE
 * section) are chained at their shared end points; a train of a few cars runs along such a chain near the
 * camera and disappears at its end (or in a tunnel portal), then the next one comes after a pause.
 */
import * as THREE from 'three/webgpu';
import { TRAIN } from '../config';
import { retroMaterial } from './retro';

type Path = { x: Float32Array; y: Float32Array; z: Float32Array; s: Float32Array };

const key = (x: number, z: number) => `${Math.round(x)}_${Math.round(z)}`;

function carGeometry(): THREE.BufferGeometry {
  const { length: L, width: W, height: H } = TRAIN.car;
  const pos: number[] = [];
  const col: number[] = [];
  const c = (hex: number) => {
    const k = new THREE.Color(hex);
    return [k.r, k.g, k.b];
  };
  const body = c(TRAIN.colours.body);
  const band = c(TRAIN.colours.windows);
  const roof = c(TRAIN.colours.roof);
  const under = c(TRAIN.colours.under);
  // box slices from y0 to y1 with one colour; the car runs along +x, centred, bottom at y = 0
  const slice = (y0: number, y1: number, k: number[], w = W) => {
    const P = [
      [-L / 2, -w / 2],
      [L / 2, -w / 2],
      [L / 2, w / 2],
      [-L / 2, w / 2],
    ];
    for (let i = 0; i < 4; i++) {
      const [ax, az] = P[i]!;
      const [bx, bz] = P[(i + 1) % 4]!;
      pos.push(ax!, y0, az!, bx!, y0, bz!, bx!, y1, bz!, ax!, y0, az!, bx!, y1, bz!, ax!, y1, az!);
      for (let v = 0; v < 6; v++) col.push(...k);
    }
  };
  slice(0.3, 1.1, under, W * 0.8);
  slice(1.1, 2.2, body);
  slice(2.2, 3.1, band);
  slice(3.1, H, body);
  // roof
  pos.push(-L / 2, H, -W / 2, L / 2, H, -W / 2, L / 2, H, W / 2, -L / 2, H, -W / 2, L / 2, H, W / 2, -L / 2, H, W / 2);
  for (let v = 0; v < 6; v++) col.push(...roof);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
  g.computeBoundingSphere();
  return g;
}

export class Trains {
  readonly group = new THREE.Group();
  private readonly pieces = new Map<string, Float32Array[]>();
  private readonly cars: THREE.Mesh[] = [];
  private path: Path | null = null;
  private s = 0;
  private wait: number = TRAIN.firstDelay;

  constructor() {
    const geo = carGeometry();
    const mat = retroMaterial({ side: THREE.DoubleSide });
    for (let i = 0; i < TRAIN.cars; i++) {
      const m = new THREE.Mesh(geo, mat);
      m.visible = false;
      m.frustumCulled = false;
      this.cars.push(m);
      this.group.add(m);
    }
  }

  add(tile: string, rails: Float32Array[] | undefined): void {
    if (rails?.length) this.pieces.set(tile, rails);
  }

  remove(tile: string): void {
    this.pieces.delete(tile);
  }

  /** Chain of rail pieces through the piece nearest to (cx, cz), extended both ways along shared end points. */
  private chain(cx: number, cz: number): Path | null {
    const all = [...this.pieces.values()].flat();
    if (!all.length) return null;
    let best: Float32Array | null = null;
    let bd = TRAIN.spawnRadius;
    for (const p of all) {
      for (let i = 0; i < p.length; i += 3) {
        const d = Math.hypot(p[i]! - cx, p[i + 2]! - cz);
        if (d < bd) {
          bd = d;
          best = p;
        }
      }
    }
    if (!best) return null;
    const ends = new Map<string, Float32Array[]>();
    for (const p of all) {
      for (const k of [key(p[0]!, p[2]!), key(p[p.length - 3]!, p[p.length - 1]!)]) {
        const l = ends.get(k) ?? [];
        l.push(p);
        ends.set(k, l);
      }
    }
    const used = new Set<Float32Array>([best]);
    let pts: number[] = [...best];
    // grow at the end (forward) and at the start (backward) while a continuing piece exists
    for (const forward of [true, false]) {
      for (let guard = 0; guard < 200; guard++) {
        const ex = forward ? pts[pts.length - 3]! : pts[0]!;
        const ez = forward ? pts[pts.length - 1]! : pts[2]!;
        const next = (ends.get(key(ex, ez)) ?? []).find((p) => !used.has(p));
        if (!next) break;
        used.add(next);
        const n = [...next];
        const startsHere = key(n[0]!, n[2]!) === key(ex, ez);
        const seq: number[] = [];
        // orient the piece so it continues from (ex, ez)
        const count = n.length / 3;
        for (let i = 0; i < count; i++) {
          const j = forward === startsHere ? i : count - 1 - i;
          seq.push(n[j * 3]!, n[j * 3 + 1]!, n[j * 3 + 2]!);
        }
        if (forward) pts = pts.concat(seq.slice(3));
        else pts = seq.slice(0, -3).concat(pts);
      }
    }
    const n = pts.length / 3;
    const path: Path = { x: new Float32Array(n), y: new Float32Array(n), z: new Float32Array(n), s: new Float32Array(n) };
    for (let i = 0; i < n; i++) {
      path.x[i] = pts[i * 3]!;
      path.y[i] = pts[i * 3 + 1]!;
      path.z[i] = pts[i * 3 + 2]!;
      if (i) path.s[i] = path.s[i - 1]! + Math.hypot(path.x[i]! - path.x[i - 1]!, path.z[i]! - path.z[i - 1]!);
    }
    return path.s[n - 1]! > TRAIN.minPath ? path : null;
  }

  private at(p: Path, s: number, out: THREE.Vector3): THREE.Vector3 {
    const n = p.s.length;
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (p.s[mid]! <= s) lo = mid;
      else hi = mid;
    }
    const t = Math.max(0, Math.min(1, (s - p.s[lo]!) / Math.max(1e-6, p.s[hi]! - p.s[lo]!)));
    return out.set(p.x[lo]! + (p.x[hi]! - p.x[lo]!) * t, p.y[lo]! + (p.y[hi]! - p.y[lo]!) * t, p.z[lo]! + (p.z[hi]! - p.z[lo]!) * t);
  }

  private readonly a = new THREE.Vector3();
  private readonly b = new THREE.Vector3();

  update(dt: number, cam: THREE.Vector3): void {
    if (!this.path) {
      this.wait -= dt;
      if (this.wait > 0) return;
      this.path = this.chain(cam.x, cam.z);
      this.wait = TRAIN.pause;
      if (!this.path) return;
      this.s = 0;
    }
    const p = this.path;
    const end = p.s[p.s.length - 1]!;
    this.s += TRAIN.speed * dt;
    const L = TRAIN.car.length + TRAIN.gap;
    if (this.s - TRAIN.cars * L > end) {
      this.path = null;
      for (const c of this.cars) c.visible = false;
      return;
    }
    this.cars.forEach((car, i) => {
      const front = this.s - i * L;
      const rear = front - TRAIN.car.length;
      if (rear < 0 || front > end) {
        car.visible = false;
        return;
      }
      this.at(p, front, this.a);
      this.at(p, rear, this.b);
      car.visible = true;
      car.position.set((this.a.x + this.b.x) / 2, (this.a.y + this.b.y) / 2 + TRAIN.lift, (this.a.z + this.b.z) / 2);
      car.rotation.set(0, -Math.atan2(this.a.z - this.b.z, this.a.x - this.b.x), Math.atan2(this.a.y - this.b.y, TRAIN.car.length), 'YZX');
    });
  }
}
