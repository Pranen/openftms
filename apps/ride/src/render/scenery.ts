/**
 * Scenery meshes from the LINE section of an L0 tile (built in the world worker): motorways with guard rails,
 * railways with ballast, rails and catenary masts, bridges with parapets and piers, power lines with towers
 * and sagging cables, streams and rivers as water bands. Vertex colours only (flat retro look).
 */
import { Color } from 'three';
import { SCENERY } from '../config';
import { LINE_BRIDGE, LINE_KIND, LINE_TUNNEL, type SceneryLine } from '../world/tile';

export interface SceneryMesh {
  position: Float32Array;
  color: Float32Array;
}

type RGB = [number, number, number];
const rgb = (hex: number): RGB => {
  const c = new Color(hex);
  return [c.r, c.g, c.b];
};
const C = Object.fromEntries(Object.entries(SCENERY.colours).map(([k, v]) => [k, rgb(v)])) as Record<keyof typeof SCENERY.colours, RGB>;

class Builder {
  pos: number[] = [];
  col: number[] = [];
  tri(a: number[], b: number[], c: number[], k: RGB): void {
    this.pos.push(a[0]!, a[1]!, a[2]!, b[0]!, b[1]!, b[2]!, c[0]!, c[1]!, c[2]!);
    for (let i = 0; i < 3; i++) this.col.push(k[0], k[1], k[2]);
  }
  quad(a: number[], b: number[], c: number[], d: number[], k: RGB): void {
    this.tri(a, b, c, k);
    this.tri(a, c, d, k);
  }
  /** Axis-aligned box (x/z half sizes, y from y0 to y1) rotated by angle around y. */
  box(cx: number, cz: number, y0: number, y1: number, hx: number, hz: number, angle: number, k: RGB, hx1 = hx, hz1 = hz): void {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const P = (u: number, v: number, y: number) => [cx + u * c - v * s, y, cz + u * s + v * c];
    const b = [P(-hx, -hz, y0), P(hx, -hz, y0), P(hx, hz, y0), P(-hx, hz, y0)];
    const t = [P(-hx1, -hz1, y1), P(hx1, -hz1, y1), P(hx1, hz1, y1), P(-hx1, hz1, y1)];
    for (let i = 0; i < 4; i++) this.quad(b[i]!, b[(i + 1) % 4]!, t[(i + 1) % 4]!, t[i]!, k);
    this.quad(t[0]!, t[1]!, t[2]!, t[3]!, k);
  }
}

/** Points of a line in world coordinates with mitred left normals (unit, z-south frame). */
function frames(l: SceneryLine, x0: number, z0: number) {
  const n = l.x.length;
  const out: { x: number; z: number; y: number; nx: number; nz: number; tx: number; tz: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1);
    const b = Math.min(n - 1, i + 1);
    let tx = l.x[b]! - l.x[a]!;
    let tz = l.z[b]! - l.z[a]!;
    const len = Math.hypot(tx, tz) || 1;
    tx /= len;
    tz /= len;
    out.push({ x: x0 + l.x[i]!, z: z0 + l.z[i]!, y: l.h[i]!, nx: tz, nz: -tx, tx, tz });
  }
  return out;
}

/** Band from offset o0 to o1 (left +) at lift dy, segment i → i+1 only where `draw(i)`. */
function band(B: Builder, F: ReturnType<typeof frames>, o0: number, o1: number, dy: number, k: RGB, draw: (i: number) => boolean): void {
  for (let i = 0; i + 1 < F.length; i++) {
    if (!draw(i)) continue;
    const p = F[i]!;
    const q = F[i + 1]!;
    B.quad(
      [p.x + p.nx * o0, p.y + dy, p.z + p.nz * o0],
      [q.x + q.nx * o0, q.y + dy, q.z + q.nz * o0],
      [q.x + q.nx * o1, q.y + dy, q.z + q.nz * o1],
      [p.x + p.nx * o1, p.y + dy, p.z + p.nz * o1],
      k,
    );
  }
}

/** Vertical strip at offset o from y0 to y1 above the line (guard rails, parapets, deck edges). */
function wall(B: Builder, F: ReturnType<typeof frames>, o: number, y0: number, y1: number, k: RGB, draw: (i: number) => boolean): void {
  for (let i = 0; i + 1 < F.length; i++) {
    if (!draw(i)) continue;
    const p = F[i]!;
    const q = F[i + 1]!;
    const px = p.x + p.nx * o;
    const pz = p.z + p.nz * o;
    const qx = q.x + q.nx * o;
    const qz = q.z + q.nz * o;
    B.quad([px, p.y + y0, pz], [qx, q.y + y0, qz], [qx, q.y + y1, qz], [px, p.y + y1, pz], k);
  }
}

/** Positions every `spacing` m along the drawn part of a line (masts, piers), with their frame. */
function every(F: ReturnType<typeof frames>, spacing: number, phase: number, ok: (i: number) => boolean) {
  const out: { x: number; z: number; y: number; nx: number; nz: number; tx: number; tz: number }[] = [];
  let next = phase;
  let s = 0;
  for (let i = 0; i + 1 < F.length; i++) {
    const p = F[i]!;
    const q = F[i + 1]!;
    const L = Math.hypot(q.x - p.x, q.z - p.z);
    while (next <= s + L) {
      if (ok(i)) {
        const t = (next - s) / (L || 1);
        out.push({ x: p.x + (q.x - p.x) * t, z: p.z + (q.z - p.z) * t, y: p.y + (q.y - p.y) * t, nx: p.nx, nz: p.nz, tx: p.tx, tz: p.tz });
      }
      next += spacing;
    }
    s += L;
  }
  return out;
}

/** Underside, deck edges and piers of bridge segments (the deck itself is the line's band). */
function bridge(B: Builder, F: ReturnType<typeof frames>, half: number, isBridge: (i: number) => boolean, ground: (x: number, z: number) => number): void {
  const S = SCENERY.bridge;
  band(B, F, half + S.overhang, -half - S.overhang, -S.deck, C.concrete, isBridge);
  for (const side of [1, -1]) {
    wall(B, F, side * (half + S.overhang), -S.deck, S.parapet, C.concrete, isBridge);
  }
  for (const p of every(F, S.pierSpacing, S.pierSpacing / 2, isBridge)) {
    const g = ground(p.x, p.z);
    if (p.y - S.deck - g < 1.5) continue;
    const ang = Math.atan2(p.nz, p.nx);
    B.box(p.x, p.z, g - 1, p.y - S.deck, S.pier, half * 0.7, ang, C.pier);
  }
}

export function buildScenery(lines: SceneryLine[], x0: number, z0: number, ground: (x: number, z: number) => number): SceneryMesh {
  const B = new Builder();
  for (const l of lines) {
    const F = frames(l, x0, z0);
    const drawn = (i: number) => !(l.f[i]! & LINE_TUNNEL);
    const isBridge = (i: number) => !!(l.f[i]! & LINE_BRIDGE) && !(l.f[i]! & LINE_TUNNEL);
    const half = l.width / 2;
    switch (l.kind) {
      case LINE_KIND.motorway:
      case LINE_KIND.trunk: {
        const M = SCENERY.motorway;
        band(B, F, half, -half, M.lift, C.asphalt, drawn);
        for (const side of [1, -1]) {
          band(B, F, side * (half - M.edgeInset), side * (half - M.edgeInset - M.line), M.lift + 0.01, C.white, drawn);
          wall(B, F, side * (half - 0.15), M.lift + M.railLow, M.lift + M.railHigh, C.rail, drawn);
        }
        bridge(B, F, half, isBridge, ground);
        break;
      }
      case LINE_KIND.rail: {
        const R = SCENERY.rail;
        band(B, F, R.ballast / 2, -R.ballast / 2, R.lift, C.ballast, drawn);
        for (const side of [1, -1]) {
          const o = side * R.gauge / 2;
          band(B, F, o + R.railWidth / 2, o - R.railWidth / 2, R.lift + R.railHeight, C.steel, drawn);
          wall(B, F, o, R.lift, R.lift + R.railHeight, C.steel, drawn);
        }
        bridge(B, F, R.ballast / 2, isBridge, ground);
        // catenary masts beside the track with a cantilever over it
        for (const p of every(F, R.mastSpacing, 0, drawn)) {
          const mx = p.x + p.nx * R.mastOffset;
          const mz = p.z + p.nz * R.mastOffset;
          const ang = Math.atan2(p.tz, p.tx);
          B.box(mx, mz, p.y, p.y + R.mastHeight, 0.15, 0.15, ang, C.mast);
          const ax = p.x + p.nx * (R.mastOffset / 2);
          const az = p.z + p.nz * (R.mastOffset / 2);
          B.box(ax, az, p.y + R.wireHeight, p.y + R.wireHeight + 0.15, 0.05, R.mastOffset / 2, ang, C.mast);
        }
        break;
      }
      case LINE_KIND.power:
      case LINE_KIND.minorPower: {
        const P = l.kind === LINE_KIND.power ? SCENERY.power : SCENERY.minorPower;
        const colour = l.kind === LINE_KIND.power ? C.tower : C.pole;
        // towers at the points (each tile draws the towers of its points; a tower on the shared point of two
        // pieces is drawn twice, which is invisible)
        for (const p of F) {
          const ang = Math.atan2(p.tz, p.tx);
          B.box(p.x, p.z, p.y - 0.5, p.y + P.height, P.base, P.base, ang, colour, P.top, P.top);
          for (const arm of P.arms) B.box(p.x, p.z, p.y + arm, p.y + arm + P.armThickness, P.armLength, 0.2, ang + Math.PI / 2, colour);
        }
        // cables from arm tip to arm tip, sagging
        for (let i = 0; i + 1 < F.length; i++) {
          const p = F[i]!;
          const q = F[i + 1]!;
          const span = Math.hypot(q.x - p.x, q.z - p.z);
          const sag = span * P.sag;
          for (const arm of P.arms) {
            for (const side of [1, -1]) {
              const o = side * (P.armLength - 0.3);
              const n = 8;
              let prev: number[] | null = null;
              for (let k = 0; k <= n; k++) {
                const t = k / n;
                const x = p.x + (q.x - p.x) * t + (p.nx + (q.nx - p.nx) * t) * o;
                const z = p.z + (q.z - p.z) * t + (p.nz + (q.nz - p.nz) * t) * o;
                const y = p.y + (q.y - p.y) * t + arm - 4 * sag * t * (1 - t);
                const cur = [x, y, z];
                if (prev) B.quad(prev, cur, [cur[0]!, cur[1]! - P.cable, cur[2]!], [prev[0]!, prev[1]! - P.cable, prev[2]!], C.cable);
                prev = cur;
              }
            }
          }
        }
        break;
      }
      default: {
        // water: a band draped over the terrain; rivers are areas in the land cover already (a band in
        // the middle of them shows as a stripe), so only streams and canals
        if (l.kind === LINE_KIND.river || l.width > SCENERY.water.maxBand) break;
        const W = SCENERY.water;
        const F2 = F.map((p) => ({ ...p, y: Math.min(p.y, ground(p.x, p.z)) }));
        band(B, F2, half, -half, W.lift, C.water, drawn);
      }
    }
  }
  return { position: new Float32Array(B.pos), color: new Float32Array(B.col) };
}
