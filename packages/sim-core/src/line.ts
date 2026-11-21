import type { RouteGraph } from 'route-graph';

/**
 * The line a cyclist actually rides, derived from the graph centre lines:
 *  - keeps right on roads wide enough for two lanes (and on one-way carriageways),
 *  - goes round roundabouts on the ring (the graph has one node per roundabout),
 *  - rounds the corners of junctions and polyline kinks.
 *
 * It is sampled once per metre of graph travel ("u"), so samples keep their place while the window
 * slides and the line does not wobble. Physics advance the graph position by `stretch` (line metres
 * per graph metre), so the rider covers the line, not the centre line, at the simulated speed.
 */
export interface LineOptions {
  /** Window behind and ahead of the rider (graph metres). */
  back: number;
  ahead: number;
  /** Distance of the rider from the right road edge (m). */
  keepRight: number;
  /** Two-way roads narrower than this (full width, m) are ridden in the middle. */
  minTwoLaneWidth: number;
  /** Offset to the right on painted cycle lanes: lane width (m). */
  cycleLaneWidth: number;
  /** Gaussian smoothing of the centre line, the lateral offset and the final line (m). */
  centreSigma: number;
  offsetSigma: number;
  finalSigma: number;
  /** Roundabout ring as drawn by the app: lane width and minimal island radius (m). */
  ringLane: number;
  ringMinIsland: number;
  /** Where the line leaves the approach for the ring: metres outside the ring lane. */
  ringApproach: number;
  /** Entry and exit are this much (rad) further round the ring than the approach (enter turning right). */
  ringEntryAngle: number;
  /** At a dead end the rider turns on a circle of at least this radius (m). */
  uTurnRadius: number;
  /** Junction corners turning more than cornerMinAngle (rad) become arcs of these radii (ridden line, m). */
  cornerRight: number;
  cornerLeft: number;
  cornerMinAngle: number;
}

export const DEFAULT_LINE: LineOptions = {
  back: 60,
  ahead: 200,
  keepRight: 1.0,
  minTwoLaneWidth: 4.0,
  cycleLaneWidth: 1.5,
  centreSigma: 2.5,
  offsetSigma: 4,
  finalSigma: 1.5,
  cornerRight: 6,
  cornerLeft: 9,
  cornerMinAngle: 0.35,
  ringLane: 7,
  ringMinIsland: 3,
  ringApproach: 7,
  ringEntryAngle: 0.45,
  uTurnRadius: 1.5,
};

/** A stretch of one edge travelled from s0 to s1, covering relative graph distance d0 … d1. */
export interface Piece {
  edge: number;
  dir: 1 | -1;
  s0: number;
  s1: number;
  d0: number;
  d1: number;
}

/** A node passed at relative graph distance d; `uTurn` at a dead end. */
export interface Junction {
  d: number;
  node: number;
  uTurn: boolean;
}

export interface LinePoint {
  x: number;
  z: number;
  h: number;
  /** Unit tangent (direction of travel). */
  tx: number;
  tz: number;
  /** Curvature (1/m), positive = turning right. */
  k: number;
}

const STEP = 1;

/** Lateral offset to the right of the centre line on edge e (m). */
export function rightOffset(g: RouteGraph, e: number, o: LineOptions): number {
  const hw = g.halfWidth(e);
  if (g.oneway(e)) return Math.max(0, hw - o.keepRight);
  if (2 * hw < o.minTwoLaneWidth) return 0;
  if (g.cycleLane(e)) return Math.max(0, hw - o.cycleLaneWidth / 2);
  return Math.max(0, hw - o.keepRight);
}

/** Gaussian smoothing of a with weights by the distances in pos (cumulative metres). */
function smooth(values: Float64Array[], pos: Float64Array, sigma: number, from = 0, to = pos.length): void {
  if (sigma <= 0) return;
  const n = pos.length;
  const reach = 3 * sigma;
  const out = values.map((v) => Float64Array.from(v));
  for (let i = from; i < to; i++) {
    let lo = i;
    while (lo > 0 && pos[i]! - pos[lo - 1]! <= reach) lo--;
    let hi = i;
    while (hi < n - 1 && pos[hi + 1]! - pos[i]! <= reach) hi++;
    let w = 0;
    const acc = values.map(() => 0);
    for (let j = lo; j <= hi; j++) {
      const t = (pos[j]! - pos[i]!) / sigma;
      const wj = Math.exp(-0.5 * t * t);
      w += wj;
      for (let v = 0; v < values.length; v++) acc[v]! += values[v]![j]! * wj;
    }
    for (let v = 0; v < values.length; v++) out[v]![i] = acc[v]! / w;
  }
  values.forEach((v, k) => v.set(out[k]!));
}

function cumulative(x: Float64Array, z: Float64Array): Float64Array {
  const c = new Float64Array(x.length);
  for (let i = 1; i < x.length; i++) c[i] = c[i - 1]! + Math.hypot(x[i]! - x[i - 1]!, z[i]! - z[i - 1]!);
  return c;
}

const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));

/** Cubic Hermite from p0 (tangent m0) to p1 (tangent m1), n points without the start. */
function hermite(out: [number, number][], p0: [number, number], m0: [number, number], p1: [number, number], m1: [number, number], n: number): void {
  for (let k = 1; k <= n; k++) {
    const t = k / n;
    const t2 = t * t;
    const t3 = t2 * t;
    const h00 = 2 * t3 - 3 * t2 + 1;
    const h10 = t3 - 2 * t2 + t;
    const h01 = -2 * t3 + 3 * t2;
    const h11 = t3 - t2;
    out.push([h00 * p0[0] + h10 * m0[0] + h01 * p1[0] + h11 * m1[0], h00 * p0[1] + h10 * m0[1] + h01 * p1[1] + h11 * m1[1]]);
  }
}

export class DrivenLine {
  readonly n: number;
  readonly x: Float64Array;
  readonly z: Float64Array;
  readonly h: Float64Array;
  /** Cumulative line length (m). */
  readonly c: Float64Array;
  /** Curvature (1/m, + right). */
  readonly k: Float64Array;

  /**
   * @param u0 absolute graph travel of sample 0 (samples every metre)
   * @param travel the rider's absolute graph travel (the pieces' d = 0)
   */
  constructor(
    readonly g: RouteGraph,
    pieces: readonly Piece[],
    junctions: readonly Junction[],
    readonly u0: number,
    count: number,
    travel: number,
    readonly o: LineOptions = DEFAULT_LINE,
  ) {
    this.n = count;
    const cx = new Float64Array(count);
    const cz = new Float64Array(count);
    const off = new Float64Array(count);
    this.h = new Float64Array(count);
    // 1. centre line and raw offsets
    let p = 0;
    const pt = { x: 0, z: 0, tx: 1, tz: 0 };
    for (let i = 0; i < count; i++) {
      const d = u0 + i * STEP - travel;
      while (p < pieces.length - 1 && d > pieces[p]!.d1) p++;
      const pc = pieces[p]!;
      const before = Math.max(0, pc.d0 - d); // only before the first piece (spawn): extrapolate
      const f = pc.d1 > pc.d0 ? Math.min(1, Math.max(0, (d - pc.d0) / (pc.d1 - pc.d0))) : 0;
      const s = pc.s0 + (pc.s1 - pc.s0) * f;
      g.point(pc.edge, s, pt);
      cx[i] = pt.x - pt.tx * pc.dir * before;
      cz[i] = pt.z - pt.tz * pc.dir * before;
      this.h[i] = g.height(pc.edge, s);
      off[i] = rightOffset(g, pc.edge, o);
    }
    // turn on a small circle at dead ends
    for (const j of junctions) {
      if (!j.uTurn) continue;
      const i0 = Math.round((travel + j.d - u0) / STEP);
      for (let i = Math.max(0, i0 - 8); i <= Math.min(count - 1, i0 + 8); i++) off[i] = Math.max(off[i]!, o.uTurnRadius);
    }
    const ug = new Float64Array(count).map((_, i) => i * STEP);
    smooth([off], ug, o.offsetSigma);
    this.corners(cx, cz, off, junctions, travel);
    smooth([cx, cz], ug, o.centreSigma);
    // 2. offset to the right of the smoothed centre line
    const x = new Float64Array(count);
    const z = new Float64Array(count);
    for (let i = 0; i < count; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(count - 1, i + 1);
      let tx = cx[b]! - cx[a]!;
      let tz = cz[b]! - cz[a]!;
      const l = Math.hypot(tx, tz) || 1;
      tx /= l;
      tz /= l;
      // right of (tx, tz) with x east, z south is (-tz, tx)
      x[i] = cx[i]! - tz * off[i]!;
      z[i] = cz[i]! + tx * off[i]!;
    }
    // 3. roundabouts: replace the passage through the centre node by an arc on the ring
    const rings = new Map(g.meta.roundabouts ?? []);
    let lastOut = -1;
    for (const j of junctions) {
      const r = rings.get(j.node);
      if (r === undefined || j.uTurn) continue;
      const iJ = Math.round((travel + j.d - u0) / STEP);
      if (iJ <= 0 || iJ >= count - 1) continue;
      this.ring(x, z, iJ, g.nodeX(j.node), g.nodeZ(j.node), r, lastOut, (iOut) => (lastOut = iOut));
    }
    // 4. final smoothing (by line length, so the ring keeps its radius)
    smooth([x, z], cumulative(x, z), o.finalSigma);
    this.x = x;
    this.z = z;
    this.c = cumulative(x, z);
    // 5. curvature from the heading change per metre
    this.k = new Float64Array(count);
    const head = new Float64Array(count);
    for (let i = 0; i < count - 1; i++) head[i] = Math.atan2(z[i + 1]! - z[i]!, x[i + 1]! - x[i]!);
    head[count - 1] = head[count - 2] ?? 0;
    for (let i = 1; i < count - 1; i++) {
      const ds = (this.c[i + 1]! - this.c[i - 1]!) / 2;
      this.k[i] = ds > 1e-3 ? wrap(head[i]! - head[i - 1]!) / ds : 0;
    }
    smooth([this.k], this.c, 1);
  }

  /**
   * Junction corners as circular arcs on the centre line, sized so the ridden line (offset to the right)
   * takes right turns tight and left turns wide; limited by the distance to the neighbouring junctions.
   */
  private corners(cx: Float64Array, cz: Float64Array, off: Float64Array, junctions: readonly Junction[], travel: number): void {
    const o = this.o;
    const g = this.g;
    const n = this.n;
    const rings = new Map(g.meta.roundabouts ?? []);
    const sx = Float64Array.from(cx);
    const sz = Float64Array.from(cz);
    const at = (f: number): [number, number] => {
      const t = Math.min(n - 1, Math.max(0, f));
      const i = Math.min(n - 2, Math.floor(t));
      const w = t - i;
      return [sx[i]! + (sx[i + 1]! - sx[i]!) * w, sz[i]! + (sz[i + 1]! - sz[i]!) * w];
    };
    const fs = junctions.map((j) => (travel + j.d - this.u0) / STEP);
    junctions.forEach((j, q) => {
      const f = fs[q]!;
      if (j.uTurn || rings.has(j.node) || f < 2 || f > n - 3) return;
      const C: [number, number] = [g.nodeX(j.node), g.nodeZ(j.node)];
      const P0 = at(f - 10 / STEP);
      const P1 = at(f + 10 / STEP);
      let ix = C[0] - P0[0];
      let iz = C[1] - P0[1];
      let ox = P1[0] - C[0];
      let oz = P1[1] - C[1];
      const il = Math.hypot(ix, iz);
      const ol = Math.hypot(ox, oz);
      if (il < 1 || ol < 1) return;
      ix /= il;
      iz /= il;
      ox /= ol;
      oz /= ol;
      const delta = Math.atan2(ix * oz - iz * ox, ix * ox + iz * oz); // + right
      const ad = Math.abs(delta);
      if (ad < o.cornerMinAngle || ad > 2.6) return;
      const offJ = off[Math.min(n - 1, Math.max(0, Math.round(f)))]!;
      let rc = delta > 0 ? o.cornerRight + offJ : Math.max(3, o.cornerLeft - offJ);
      const tanH = Math.tan(ad / 2);
      const gap = Math.min(q > 0 ? f - fs[q - 1]! : Infinity, q < fs.length - 1 ? fs[q + 1]! - f : Infinity) * STEP;
      let T = rc * tanH;
      const tMax = Math.min(30, gap * 0.5, f * STEP - 1, (n - 1 - f) * STEP - 1);
      if (T > tMax) {
        T = tMax;
        rc = T / tanH;
      }
      if (T < 1) return;
      const sgn = Math.sign(delta);
      const A = [C[0] - ix * T, C[1] - iz * T];
      // centre on the inside of the turn: right normal of (ix, iz) is (-iz, ix)
      const O = [A[0]! - iz * sgn * rc, A[1]! + ix * sgn * rc];
      const a0 = Math.atan2(A[1]! - O[1]!, A[0]! - O[0]!);
      const f0 = f - T / STEP;
      const span = (2 * T) / STEP;
      for (let i = Math.ceil(f0); i <= Math.floor(f0 + span); i++) {
        const phi = a0 + delta * ((i - f0) / span);
        cx[i] = O[0]! + rc * Math.cos(phi);
        cz[i] = O[1]! + rc * Math.sin(phi);
      }
    });
  }

  /** Replace samples around index iJ (the roundabout node) by approach curve, ring arc and exit curve. */
  private ring(x: Float64Array, z: Float64Array, iJ: number, ox: number, oz: number, r: number, minIn: number, done: (iOut: number) => void): void {
    const o = this.o;
    const ri = Math.max(o.ringMinIsland, r - o.ringLane / 2);
    const rho = ri + o.ringLane * 0.55;
    const outer = rho + o.ringApproach;
    const dist = (i: number) => Math.hypot(x[i]! - ox, z[i]! - oz);
    let iIn = iJ;
    while (iIn > 0 && dist(iIn) < outer) iIn--;
    let iOut = iJ;
    while (iOut < this.n - 1 && dist(iOut) < outer) iOut++;
    if (iIn <= minIn || dist(iIn) < outer || dist(iOut) < outer || iOut - iIn < 3) return; // window too short: leave it
    const dirAt = (i: number, step: number): [number, number] => {
      const j = Math.min(this.n - 1, Math.max(0, i + step));
      const dx = (x[j]! - x[i]!) * Math.sign(step);
      const dz = (z[j]! - z[i]!) * Math.sign(step);
      const l = Math.hypot(dx, dz) || 1;
      return [dx / l, dz / l];
    };
    const tIn = dirAt(iIn, -2).map((v) => v) as [number, number];
    const tOut = dirAt(iOut, 2);
    const E: [number, number] = [x[iIn]!, z[iIn]!];
    const X: [number, number] = [x[iOut]!, z[iOut]!];
    // right-hand traffic: anticlockwise seen from above (north up) = decreasing atan2(z, x) with z south
    const phiIn = Math.atan2(E[1] - oz, E[0] - ox);
    const phiOut = Math.atan2(X[1] - oz, X[0] - ox);
    const phiS = phiIn - o.ringEntryAngle;
    const phiE = phiOut + o.ringEntryAngle;
    let sweep = (((phiS - phiE) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    if (sweep < 0.2) sweep += 2 * Math.PI;
    const P = (phi: number): [number, number] => [ox + rho * Math.cos(phi), oz + rho * Math.sin(phi)];
    const T = (phi: number): [number, number] => [Math.sin(phi), -Math.cos(phi)];
    const path: [number, number][] = [E];
    const A = P(phiS);
    const B = P(phiS - sweep);
    const m1 = Math.hypot(A[0] - E[0], A[1] - E[1]);
    const m2 = Math.hypot(X[0] - B[0], X[1] - B[1]);
    const ts = T(phiS);
    const te = T(phiS - sweep);
    hermite(path, E, [tIn[0] * m1, tIn[1] * m1], A, [ts[0] * m1, ts[1] * m1], 24);
    const arcN = Math.max(4, Math.ceil((sweep * rho) / 0.5));
    for (let k = 1; k <= arcN; k++) path.push(P(phiS - (sweep * k) / arcN));
    hermite(path, B, [te[0] * m2, te[1] * m2], X, [tOut[0] * m2, tOut[1] * m2], 24);
    // resample: graph samples iIn…iOut spread evenly over the path's length
    const cum = [0];
    for (let k = 1; k < path.length; k++) cum.push(cum[k - 1]! + Math.hypot(path[k]![0] - path[k - 1]![0], path[k]![1] - path[k - 1]![1]));
    const total = cum[cum.length - 1]!;
    let k = 0;
    for (let i = iIn + 1; i < iOut; i++) {
      const target = (total * (i - iIn)) / (iOut - iIn);
      while (k < cum.length - 2 && cum[k + 1]! < target) k++;
      const f = cum[k + 1]! > cum[k]! ? (target - cum[k]!) / (cum[k + 1]! - cum[k]!) : 0;
      x[i] = path[k]![0] + (path[k + 1]![0] - path[k]![0]) * f;
      z[i] = path[k]![1] + (path[k + 1]![1] - path[k]![1]) * f;
    }
    done(iOut);
  }

  /** Fractional sample index of absolute graph travel u. */
  private index(u: number): number {
    return Math.min(this.n - 1, Math.max(0, (u - this.u0) / STEP));
  }

  /** Line length at absolute graph travel u. */
  lengthAt(u: number): number {
    const t = this.index(u);
    const i = Math.min(this.n - 2, Math.floor(t));
    return this.c[i]! + (this.c[i + 1]! - this.c[i]!) * (t - i);
  }

  /** Line metres per graph metre at absolute graph travel u. */
  stretch(u: number): number {
    const i = Math.min(this.n - 2, Math.floor(this.index(u)));
    return Math.min(4, Math.max(0.25, (this.c[i + 1]! - this.c[i]!) / STEP));
  }

  /** Point at line length c (clamped to the window). */
  at(c: number, out: LinePoint = { x: 0, z: 0, h: 0, tx: 1, tz: 0, k: 0 }): LinePoint {
    const C = this.c;
    let lo = 0;
    let hi = this.n - 1;
    if (c <= C[0]!) hi = 1;
    else if (c >= C[hi]!) lo = hi - 1;
    else {
      while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (C[mid]! <= c) lo = mid;
        else hi = mid;
      }
    }
    const seg = C[hi]! - C[lo]!;
    const f = seg > 0 ? Math.min(1, Math.max(0, (c - C[lo]!) / seg)) : 0;
    out.x = this.x[lo]! + (this.x[hi]! - this.x[lo]!) * f;
    out.z = this.z[lo]! + (this.z[hi]! - this.z[lo]!) * f;
    out.h = this.h[lo]! + (this.h[hi]! - this.h[lo]!) * f;
    out.k = this.k[lo]! + (this.k[hi]! - this.k[lo]!) * f;
    // tangent from a short chord around c (smooth between samples)
    const a = Math.max(0, lo - 1);
    const b = Math.min(this.n - 1, hi + 1);
    const ta = [this.x[hi]! - this.x[a]!, this.z[hi]! - this.z[a]!];
    const tb = [this.x[b]! - this.x[lo]!, this.z[b]! - this.z[lo]!];
    const tx = ta[0]! * (1 - f) + tb[0]! * f;
    const tz = ta[1]! * (1 - f) + tb[1]! * f;
    const l = Math.hypot(tx, tz) || 1;
    out.tx = tx / l;
    out.tz = tz / l;
    return out;
  }
}
