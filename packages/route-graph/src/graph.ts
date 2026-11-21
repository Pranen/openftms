import {
  ATTR_ACCESS_BWD,
  ATTR_ACCESS_FWD,
  ATTR_CYCLELANE,
  ATTR_ONEWAY,
  parseArrays,
  type GraphArrays,
  type GraphMeta,
} from './format.js';

/** A place on the network: edge, travel direction (+1 along the edge, -1 against) and arc length from the edge start. */
export interface EdgePos {
  edge: number;
  dir: 1 | -1;
  s: number;
}

/** One way out of a node: the edge and whether it is travelled forwards (leaving from its start). */
export interface Exit {
  edge: number;
  dir: 1 | -1;
}

export interface Point {
  x: number;
  z: number;
  /** Unit tangent in the edge direction. */
  tx: number;
  tz: number;
}

export interface Nearest {
  edge: number;
  s: number;
  dist: number;
}

export interface Section {
  start: number;
  end: number;
  flags: number;
}

const GRID = 100; // m, spatial index cell

/**
 * Read-only view of the road graph. Coordinates are in the world frame
 * (x = E - E0, z = N0 - N, metres); heights in metres above sea level.
 */
export class RouteGraph {
  readonly a: GraphArrays;
  readonly nodeCount: number;
  readonly edgeCount: number;
  /** Cumulative length of each edge's (simplified) geometry, aligned with geomX/geomZ. */
  private readonly geomCum: Float32Array;
  private readonly geomLen: Float32Array;
  private readonly sectionsByEdge = new Map<number, Section[]>();
  private readonly cells = new Map<number, number[]>(); // cell -> [edge, segment, edge, segment, …]
  private readonly decoder = new TextDecoder();
  private gx0 = 0;
  private gz0 = 0;

  constructor(readonly meta: GraphMeta, buffer: ArrayBuffer) {
    this.a = parseArrays(meta, buffer);
    this.nodeCount = meta.nodes;
    this.edgeCount = meta.edges;
    const { geomX, geomZ, edgeGeomStart, edgeGeomCount } = this.a;
    this.geomCum = new Float32Array(geomX.length);
    this.geomLen = new Float32Array(this.edgeCount);
    for (let e = 0; e < this.edgeCount; e++) {
      const g0 = edgeGeomStart[e]!;
      const n = edgeGeomCount[e]!;
      let acc = 0;
      this.geomCum[g0] = 0;
      for (let k = 1; k < n; k++) {
        const dx = (geomX[g0 + k]! - geomX[g0 + k - 1]!) / 100;
        const dz = (geomZ[g0 + k]! - geomZ[g0 + k - 1]!) / 100;
        acc += Math.hypot(dx, dz);
        this.geomCum[g0 + k] = acc;
      }
      this.geomLen[e] = acc;
    }
    for (let i = 0; i < this.a.secEdge.length; i++) {
      const e = this.a.secEdge[i]!;
      const list = this.sectionsByEdge.get(e) ?? [];
      list.push({ start: this.a.secStart[i]! / 100, end: this.a.secEnd[i]! / 100, flags: this.a.secFlags[i]! });
      this.sectionsByEdge.set(e, list);
    }
    this.buildIndex();
  }

  /** Parse graph.json text/object and graph.bin buffer. */
  static from(meta: GraphMeta | string, buffer: ArrayBuffer): RouteGraph {
    return new RouteGraph(typeof meta === 'string' ? (JSON.parse(meta) as GraphMeta) : meta, buffer);
  }

  // --- nodes and edges -------------------------------------------------------------

  nodeX(n: number): number {
    return this.a.nodeX[n]! / 100;
  }

  nodeZ(n: number): number {
    return this.a.nodeZ[n]! / 100;
  }

  nodeFlags(n: number): number {
    return this.a.nodeFlags[n]!;
  }

  from(e: number): number {
    return this.a.edgeFrom[e]!;
  }

  to(e: number): number {
    return this.a.edgeTo[e]!;
  }

  /** Length in metres (of the original geometry; profiles are sampled on it). */
  length(e: number): number {
    return this.a.edgeLength[e]! / 100;
  }

  edgeClass(e: number): number {
    return this.a.edgeAttrs[e]! & 15;
  }

  surface(e: number): number {
    return (this.a.edgeAttrs[e]! >> 4) & 7;
  }

  routes(e: number): number {
    return this.a.edgeRoutes[e]!;
  }

  /** Whether the edge may be ridden in direction dir (OSM oneway rules). */
  allowed(e: number, dir: 1 | -1): boolean {
    return (this.a.edgeAttrs[e]! & (dir > 0 ? ATTR_ACCESS_FWD : ATTR_ACCESS_BWD)) !== 0;
  }

  /** Whether the edge has a painted cycle lane (OSM cycleway=lane/track). */
  cycleLane(e: number): boolean {
    return (this.a.edgeAttrs[e]! & ATTR_CYCLELANE) !== 0;
  }

  name(e: number): string {
    const id = this.a.edgeName[e]!;
    const o = this.a.nameOffsets;
    return this.decoder.decode(this.a.nameBytes.subarray(o[id]!, o[id + 1]!));
  }

  halfWidth(e: number): number {
    const hw = this.meta.roadHalfWidth[this.edgeClass(e)] ?? 2;
    return this.oneway(e) ? hw * (this.meta.onewayWidth ?? 1) : hw;
  }

  /** One carriageway of a one-way road for motor traffic (bikes may still be allowed both ways). */
  oneway(e: number): boolean {
    return (this.a.edgeAttrs[e]! & ATTR_ONEWAY) !== 0;
  }

  sections(e: number): readonly Section[] {
    return this.sectionsByEdge.get(e) ?? [];
  }

  /** Exits of a node (every incident edge, travelled away from the node). */
  exits(n: number): Exit[] {
    const { adjOffsets, adjEntries } = this.a;
    const out: Exit[] = [];
    for (let k = adjOffsets[n]!; k < adjOffsets[n + 1]!; k++) {
      const v = adjEntries[k]!;
      out.push({ edge: v >>> 1, dir: v & 1 ? -1 : 1 });
    }
    return out;
  }

  /** Node at the end of travelling edge e in direction dir. */
  endNode(e: number, dir: 1 | -1): number {
    return dir > 0 ? this.to(e) : this.from(e);
  }

  // --- geometry and height -----------------------------------------------------------

  /** Point and tangent at arc length s (clamped) along edge e. */
  point(e: number, s: number, out: Point = { x: 0, z: 0, tx: 1, tz: 0 }): Point {
    const { geomX, geomZ, edgeGeomStart, edgeGeomCount } = this.a;
    const g0 = edgeGeomStart[e]!;
    const n = edgeGeomCount[e]!;
    const L = this.length(e);
    const gl = this.geomLen[e]!;
    const t = L > 0 ? Math.min(Math.max(s, 0), L) * (gl / L) : 0;
    // binary search the segment
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (this.geomCum[g0 + mid]! <= t) lo = mid;
      else hi = mid;
    }
    const c0 = this.geomCum[g0 + lo]!;
    const c1 = this.geomCum[g0 + hi]!;
    const f = c1 > c0 ? (t - c0) / (c1 - c0) : 0;
    const x0 = geomX[g0 + lo]! / 100;
    const z0 = geomZ[g0 + lo]! / 100;
    const x1 = geomX[g0 + hi]! / 100;
    const z1 = geomZ[g0 + hi]! / 100;
    out.x = x0 + (x1 - x0) * f;
    out.z = z0 + (z1 - z0) * f;
    const len = Math.hypot(x1 - x0, z1 - z0) || 1;
    out.tx = (x1 - x0) / len;
    out.tz = (z1 - z0) / len;
    return out;
  }

  /** Smoothed height of the road at arc length s (linear between the 5 m profile samples). */
  height(e: number, s: number): number {
    const { edgeProfStart, profile } = this.a;
    const p0 = edgeProfStart[e]!;
    const p1 = e + 1 < this.edgeCount ? edgeProfStart[e + 1]! : profile.length;
    const count = p1 - p0;
    const step = this.meta.profileStep;
    const L = this.length(e);
    const ss = Math.min(Math.max(s, 0), L);
    let i = Math.floor(ss / step);
    if (i >= count - 1) i = count - 2;
    if (i < 0) return this.h(profile[p0]!);
    const sa = i * step;
    const sb = i + 1 === count - 1 ? L : (i + 1) * step;
    const f = sb > sa ? (ss - sa) / (sb - sa) : 0;
    return this.h(profile[p0 + i]!) + (this.h(profile[p0 + i + 1]!) - this.h(profile[p0 + i]!)) * f;
  }

  private h(q: number): number {
    return this.meta.heightOffset + q * this.meta.heightScale;
  }

  // --- spatial index -----------------------------------------------------------------

  private key(cx: number, cz: number): number {
    return (cx + 32768) * 65536 + (cz + 32768);
  }

  private buildIndex(): void {
    const { geomX, geomZ, edgeGeomStart, edgeGeomCount } = this.a;
    for (let e = 0; e < this.edgeCount; e++) {
      const g0 = edgeGeomStart[e]!;
      for (let k = 0; k < edgeGeomCount[e]! - 1; k++) {
        const x0 = geomX[g0 + k]! / 100;
        const z0 = geomZ[g0 + k]! / 100;
        const x1 = geomX[g0 + k + 1]! / 100;
        const z1 = geomZ[g0 + k + 1]! / 100;
        const cx0 = Math.floor(Math.min(x0, x1) / GRID);
        const cx1 = Math.floor(Math.max(x0, x1) / GRID);
        const cz0 = Math.floor(Math.min(z0, z1) / GRID);
        const cz1 = Math.floor(Math.max(z0, z1) / GRID);
        for (let cx = cx0; cx <= cx1; cx++) {
          for (let cz = cz0; cz <= cz1; cz++) {
            const key = this.key(cx, cz);
            const list = this.cells.get(key);
            if (list) list.push(e, k);
            else this.cells.set(key, [e, k]);
          }
        }
      }
    }
  }

  /** Edges with a geometry segment in the box (world x/z; may include a few just outside), ascending. */
  edgesIn(x0: number, z0: number, x1: number, z1: number): number[] {
    const out = new Set<number>();
    for (let i = Math.floor(x0 / GRID); i <= Math.floor(x1 / GRID); i++) {
      for (let j = Math.floor(z0 / GRID); j <= Math.floor(z1 / GRID); j++) {
        const list = this.cells.get(this.key(i, j));
        if (!list) continue;
        for (let k = 0; k < list.length; k += 2) out.add(list[k]!);
      }
    }
    return [...out].sort((a, b) => a - b);
  }

  /** Nearest point on the network within maxDist (null if none). */
  nearest(x: number, z: number, maxDist = 200): Nearest | null {
    const { geomX, geomZ, edgeGeomStart } = this.a;
    const r = Math.ceil(maxDist / GRID);
    const cx = Math.floor(x / GRID);
    const cz = Math.floor(z / GRID);
    let best: Nearest | null = null;
    for (let i = cx - r; i <= cx + r; i++) {
      for (let j = cz - r; j <= cz + r; j++) {
        const list = this.cells.get(this.key(i, j));
        if (!list) continue;
        for (let k = 0; k < list.length; k += 2) {
          const e = list[k]!;
          const seg = list[k + 1]!;
          const g = edgeGeomStart[e]! + seg;
          const x0 = geomX[g]! / 100;
          const z0 = geomZ[g]! / 100;
          const dx = geomX[g + 1]! / 100 - x0;
          const dz = geomZ[g + 1]! / 100 - z0;
          const l2 = dx * dx + dz * dz;
          const f = l2 > 0 ? Math.min(1, Math.max(0, ((x - x0) * dx + (z - z0) * dz) / l2)) : 0;
          const d = Math.hypot(x0 + dx * f - x, z0 + dz * f - z);
          if (d <= maxDist && (!best || d < best.dist)) {
            const t = this.geomCum[g]! + f * Math.sqrt(l2);
            const gl = this.geomLen[e]!;
            best = { edge: e, s: gl > 0 ? (t * this.length(e)) / gl : 0, dist: d };
          }
        }
      }
    }
    return best;
  }
}
