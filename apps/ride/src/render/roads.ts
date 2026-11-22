/**
 * Road bands, markings, kerb fillets and roundabouts from the ride graph (same profile as the physics),
 * built per L0 tile in the world worker (no Three.js scene objects here, only triangle arrays).
 */
import { Color } from 'three';
import { SEC_BRIDGE, SEC_TUNNEL, type RouteGraph } from 'route-graph';
import { GRAVEL_COLOR, JUNCTION, MARKING, RENDER, ROAD_COLOR, ROAD_COLOR_DEFAULT, ROUNDABOUT, SCENERY, TUNNEL } from '../config';

/** Lift of a road band above its profile: bigger roads lie on top where bands overlap. */
export function roadLift(cls: number): number {
  return RENDER.roadLift + cls * RENDER.roadClassLift;
}

const nodeRefs = new WeakMap<RouteGraph, Float64Array>();

/**
 * Height of the drawn road: the edge profile, bent near its ends to the height of the biggest road
 * at that node. The profiles are filtered per edge, so at a junction a minor road can otherwise
 * lie a few centimetres above the main road and show through it.
 */
export function roadHeight(g: RouteGraph, e: number, s: number): number {
  let ref = nodeRefs.get(g);
  if (!ref) {
    ref = new Float64Array(g.nodeCount).fill(NaN);
    nodeRefs.set(g, ref);
  }
  const L = g.length(e);
  let h = g.height(e, s);
  for (const [node, d, sEnd] of [
    [g.from(e), s, 0],
    [g.to(e), L - s, L],
  ] as const) {
    if (d >= RENDER.junctionBlend) continue;
    if (Number.isNaN(ref[node]!)) {
      let best = -1;
      let hb = 0;
      for (const x of g.exits(node)) {
        const c = g.edgeClass(x.edge);
        if (c > best) {
          best = c;
          hb = g.height(x.edge, x.dir > 0 ? 0 : g.length(x.edge));
        }
      }
      ref[node] = hb;
    }
    const t = 1 - Math.max(0, d) / RENDER.junctionBlend;
    h += (ref[node]! - g.height(e, sEnd)) * t * t * (3 - 2 * t);
  }
  return h;
}

/** Triangle buffers of one tile; geometry centred elsewhere goes to a scratch buffer that is thrown away. */
type Buffer = { pos: number[]; col: number[] };
type Sink = (x: number, z: number) => Buffer;

export interface RoadMesh {
  position: Float32Array;
  color: Float32Array;
}

/** Point and left normal at arc length s; the normal from a central difference (no kinks at polyline vertices). */
function frame(g: RouteGraph, e: number, s: number, L: number) {
  const p = g.point(e, s);
  const a = g.point(e, Math.max(0, s - 1.5));
  const b = g.point(e, Math.min(L, s + 1.5));
  let tx = b.x - a.x;
  let tz = b.z - a.z;
  const l = Math.hypot(tx, tz) || 1;
  tx /= l;
  tz /= l;
  return { x: p.x, z: p.z, nx: -tz, nz: tx };
}

/** Triangles of a band along edge e from s0 to s1, offset sideways (left +) with the given width. */
function band(
  g: RouteGraph,
  e: number,
  s0: number,
  s1: number,
  offset: number,
  width: number,
  lift: number,
  c: Color,
  sink: Sink,
  step = 3,
): void {
  const L = g.length(e);
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  let prev: number[] | null = null;
  for (let k = 0; k <= n; k++) {
    const s = s0 + ((s1 - s0) * k) / n;
    const f = frame(g, e, s, L);
    const y = roadHeight(g, e, s) + lift;
    const o1 = offset + width / 2;
    const o2 = offset - width / 2;
    const cur = [f.x + f.nx * o1, y, f.z + f.nz * o1, f.x + f.nx * o2, y, f.z + f.nz * o2];
    if (prev) {
      const [ax, ay, az, bx, by, bz] = prev as [number, number, number, number, number, number];
      const [cx, cy, cz, dx, dy, dz] = cur as [number, number, number, number, number, number];
      const { pos, col } = sink((ax + dx) / 2, (az + dz) / 2);
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, bx, by, bz, dx, dy, dz, cx, cy, cz);
      for (let v = 0; v < 6; v++) col.push(c.r, c.g, c.b);
    }
    prev = cur;
  }
}

/** The drawn stretch of an edge (tunnels included: the road runs on inside the tube), shortened by gapA / gapB. */
function stretches(g: RouteGraph, e: number, gapA: number, gapB = gapA): [number, number][] {
  const L = g.length(e);
  return [[gapA, L - gapB] as [number, number]].filter(([a, b]) => b - a > 1);
}

const tubeColour = new Color(TUNNEL.wall);
const portalColour = new Color(TUNNEL.portal);
const lampColour = new Color(TUNNEL.lamp);

/**
 * Tunnel tube along a tunnel section: walls and a vaulted ceiling around the road (seen from inside; the
 * terrain above is culled from below), a row of lamps under the crown, and a concrete portal at each end.
 */
function tunnelBody(g: RouteGraph, e: number, s0: number, s1: number, hw: number, lift: number, sink: Sink): void {
  const T = TUNNEL;
  const L = g.length(e);
  const W = hw + T.sidewalk;
  // profile (offset left +, height above the road): walls, then the vault
  const prof = [
    [-W, -0.3],
    [-W, T.wallHeight],
    [-W * 0.72, T.wallHeight + (T.crown - T.wallHeight) * 0.7],
    [0, T.crown],
    [W * 0.72, T.wallHeight + (T.crown - T.wallHeight) * 0.7],
    [W, T.wallHeight],
    [W, -0.3],
  ];
  const quad = (a: number[], b: number[], c: number[], d: number[], k: Color) => {
    const { pos, col } = sink((a[0]! + c[0]!) / 2, (a[2]! + c[2]!) / 2);
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    for (let v = 0; v < 6; v++) col.push(k.r, k.g, k.b);
  };
  const n = Math.max(1, Math.ceil((s1 - s0) / 4));
  const at = (s: number) => ({ ...frame(g, e, s, L), y: roadHeight(g, e, s) + lift });
  const P = (f: ReturnType<typeof at>, o: number, h: number) => [f.x + f.nx * o, f.y + h, f.z + f.nz * o];
  let prev = at(s0);
  for (let k = 1; k <= n; k++) {
    const cur = at(s0 + ((s1 - s0) * k) / n);
    for (let i = 0; i + 1 < prof.length; i++) {
      const [o0, h0] = prof[i]!;
      const [o1, h1] = prof[i + 1]!;
      quad(P(prev, o0!, h0!), P(cur, o0!, h0!), P(cur, o1!, h1!), P(prev, o1!, h1!), tubeColour);
    }
    // raised walkways between the road and the walls
    for (const side of [1, -1]) quad(P(prev, side * (hw - 0.1), 0.15), P(cur, side * (hw - 0.1), 0.15), P(cur, side * W, 0.15), P(prev, side * W, 0.15), portalColour);
    // lamps: short bright strips under the crown every few metres
    if (k % 2 === 0) quad(P(prev, 0.35, T.crown - 0.05), P(cur, 0.35, T.crown - 0.05), P(cur, -0.35, T.crown - 0.05), P(prev, -0.35, T.crown - 0.05), lampColour);
    prev = cur;
  }
  // portals: a concrete face around the opening, set a little into the open
  for (const [s, dir] of [
    [s0, -1],
    [s1, 1],
  ] as const) {
    const f = at(s);
    const tx = -f.nz * dir;
    const tz = f.nx * dir;
    const Q = (o: number, h: number) => [f.x + f.nx * o + tx * 0.3, f.y + h, f.z + f.nz * o + tz * 0.3];
    const ow = W + T.portalSide;
    const top = T.crown + T.portalTop;
    // wing walls reach down into the slope (the terrain falls away beside the road)
    quad(Q(-ow, -T.portalFoot), Q(-W, -T.portalFoot), Q(-W, top), Q(-ow, top), portalColour);
    quad(Q(W, -T.portalFoot), Q(ow, -T.portalFoot), Q(ow, top), Q(W, top), portalColour);
    for (let i = 1; i + 1 < prof.length - 1; i++) {
      const [o0, h0] = prof[i]!;
      const [o1, h1] = prof[i + 1]!;
      quad(Q(o0!, h0!), Q(o1!, h1!), Q(o1!, top), Q(o0!, top), portalColour);
    }
  }
}

/**
 * Distance from `node` along edge e where its markings (centre and both edges) have left the bands
 * of all other roads at that node of the same or a bigger class (those are drawn on top), plus a
 * margin; at least MARKING.junctionGap. Sampled on the real geometry, so curved roads and shallow
 * angles (a side road merging at 20°) are covered too.
 */
function markingGap(g: RouteGraph, node: number, e: number): number {
  const L = g.length(e);
  const fromStart = g.from(e) === node;
  const cls = g.edgeClass(e);
  const hw = g.halfWidth(e);
  const reach = MARKING.maxJunctionGap + 10;
  // the other arms as polylines (sampled every 2 m up to `reach`) with their half width
  const arms: { xs: number[]; zs: number[]; r2: number }[] = [];
  for (const x of g.exits(node)) {
    if (x.edge === e || g.edgeClass(x.edge) < cls) continue;
    const Lf = g.length(x.edge);
    const xs: number[] = [];
    const zs: number[] = [];
    for (let d = 0; d <= Math.min(Lf, reach); d += 2) {
      const p = g.point(x.edge, x.dir > 0 ? d : Lf - d);
      xs.push(p.x);
      zs.push(p.z);
    }
    const r = g.halfWidth(x.edge) + MARKING.width;
    arms.push({ xs, zs, r2: r * r });
  }
  if (!arms.length) return MARKING.junctionGap;
  const inside = (px: number, pz: number) =>
    arms.some(({ xs, zs, r2 }) => {
      for (let i = 0; i + 1 < xs.length; i++) {
        const ax = xs[i]!;
        const az = zs[i]!;
        const dx = xs[i + 1]! - ax;
        const dz = zs[i + 1]! - az;
        const l2 = dx * dx + dz * dz || 1;
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
        const qx = ax + dx * t - px;
        const qz = az + dz * t - pz;
        if (qx * qx + qz * qz < r2) return true;
      }
      return false;
    });
  const max = Math.min(MARKING.maxJunctionGap, L / 2);
  let last = 0;
  for (let d = 0; d <= max; d += 0.5) {
    const f = frame(g, e, fromStart ? d : L - d, L);
    for (const o of [0, hw, -hw]) if (inside(f.x + f.nx * o, f.z + f.nz * o)) last = d;
  }
  return Math.max(MARKING.junctionGap, last + MARKING.junctionMargin);
}

const concrete = new Color(SCENERY.colours.concrete);
const pierColour = new Color(SCENERY.colours.pier);

/** Underside, parapets and piers of a bridge section of a ride edge (the deck is the road band). */
function bridgeBody(g: RouteGraph, e: number, s0: number, s1: number, hw: number, lift: number, sink: Sink, ground: (x: number, z: number) => number): void {
  const S = SCENERY.bridge;
  const L = g.length(e);
  const n = Math.max(1, Math.ceil((s1 - s0) / 3));
  const half = hw + S.overhang * 0.5;
  let prev: { x: number; z: number; nx: number; nz: number; y: number } | null = null;
  const quad = (a: number[], b: number[], c: number[], d: number[], k: Color) => {
    const { pos, col } = sink((a[0]! + c[0]!) / 2, (a[2]! + c[2]!) / 2);
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    for (let v = 0; v < 6; v++) col.push(k.r, k.g, k.b);
  };
  for (let k = 0; k <= n; k++) {
    const s = s0 + ((s1 - s0) * k) / n;
    const f = frame(g, e, s, L);
    const cur = { ...f, y: roadHeight(g, e, s) + lift };
    if (prev) {
      const p = prev;
      const P = (q: typeof p, o: number, dy: number) => [q.x + q.nx * o, q.y + dy, q.z + q.nz * o];
      quad(P(p, half, -S.deck), P(cur, half, -S.deck), P(cur, -half, -S.deck), P(p, -half, -S.deck), concrete);
      for (const side of [1, -1]) quad(P(p, side * half, -S.deck), P(cur, side * half, -S.deck), P(cur, side * half, S.parapet), P(p, side * half, S.parapet), concrete);
    }
    prev = cur;
  }
  // piers where the deck stands high enough above the ground
  for (let s = s0 + S.pierSpacing / 2; s < s1 - 4; s += S.pierSpacing) {
    const f = frame(g, e, s, L);
    const y = roadHeight(g, e, s) + lift - S.deck;
    const gy = ground(f.x, f.z) - 1;
    if (y - gy < 2.5) continue;
    const tx = f.nz;
    const tz = -f.nx;
    const C = (u: number, v: number, yy: number) => [f.x + tx * u + f.nx * v, yy, f.z + tz * u + f.nz * v];
    const pu = S.pier;
    const pv = hw * 0.7;
    const corners: [number, number][] = [
      [-pu, -pv],
      [pu, -pv],
      [pu, pv],
      [-pu, pv],
    ];
    for (let i = 0; i < 4; i++) {
      const [au, av] = corners[i]!;
      const [bu, bv] = corners[(i + 1) % 4]!;
      quad(C(au, av, gy), C(bu, bv, gy), C(bu, bv, y), C(au, av, y), pierColour);
    }
  }
}

/** Dashes from a to b (phase from the edge start, so dashes do not jump between frames). */
function dashes(a: number, b: number, dash: number, gap: number): [number, number][] {
  const out: [number, number][] = [];
  for (let s = Math.ceil(a / (dash + gap)) * (dash + gap); s < b; s += dash + gap) out.push([s, Math.min(b, s + dash)]);
  return out;
}

/**
 * Road bands of one L0 tile (ix, iy) with markings, kerb fillets and roundabouts. Triangles belong to the
 * tile that holds their centre, so roads come and go with their tile and nothing is drawn twice.
 */
export function buildRoadTile(
  g: RouteGraph,
  origin: [number, number],
  size: number,
  ix: number,
  iy: number,
  ground?: (x: number, z: number) => number,
): { road: RoadMesh; mark: RoadMesh } {
  const roadBuf: Buffer = { pos: [], col: [] };
  const markBuf: Buffer = { pos: [], col: [] };
  const scratch: Buffer = { pos: [], col: [] };
  const inTile = (x: number, z: number) => Math.floor((x + origin[0]) / size) === ix && Math.floor((origin[1] - z) / size) === iy;
  const sinkOf =
    (b: Buffer): Sink =>
    (x, z) => {
      if (inTile(x, z)) return b;
      scratch.pos.length = 0;
      scratch.col.length = 0;
      return scratch;
    };
  const road = sinkOf(roadBuf);
  const mark = sinkOf(markBuf);
  const x0 = ix * size - origin[0];
  const z0 = origin[1] - (iy + 1) * size;
  const pad = 40;
  const order = g.edgesIn(x0 - pad, z0 - pad, x0 + size + pad, z0 + size + pad).sort((a, b) => g.edgeClass(a) - g.edgeClass(b) || a - b);
  const nodes = [...new Set(order.flatMap((e) => [g.from(e), g.to(e)]))].sort((a, b) => a - b);
  const rbRadius = new Map(g.meta.roundabouts ?? []);
  const white = new Color(MARKING.white);
  const yellow = new Color(MARKING.yellow);
  // markings stop short of junctions (clear of every other road band there that is drawn on top),
  // and outside the drawn ring of a roundabout
  const gapAt = (node: number, e: number) => {
    const r = rbRadius.get(node);
    return r === undefined ? markingGap(g, node, e) : r + ROUNDABOUT.lane + 2;
  };
  for (const e of order) {
    const hw = g.halfWidth(e);
    const cls = g.edgeClass(e);
    const surf = g.surface(e);
    const c = new Color(surf >= 3 && surf <= 5 ? GRAVEL_COLOR : (ROAD_COLOR[cls] ?? ROAD_COLOR_DEFAULT));
    const lift = roadLift(cls);
    for (const [a, b] of stretches(g, e, 0)) band(g, e, a, b, 0, hw * 2, lift, c, road, 4);
    for (const t of g.sections(e)) {
      if (t.flags & SEC_TUNNEL) tunnelBody(g, e, t.start, t.end, hw, lift, road);
      else if (ground && t.flags & SEC_BRIDGE) bridgeBody(g, e, t.start, t.end, hw, lift, road, ground);
    }
    // markings only on paved roads
    if (surf > 2 || cls < 3) continue;
    const ml = lift + MARKING.lift;
    const W = MARKING.width;
    const oneway = g.oneway(e);
    // short one-way pieces (the split approaches at islands and roundabouts) stay unmarked
    if (oneway && g.length(e) < MARKING.minOnewayLength) continue;
    const twoWay = !oneway;
    const lane = g.cycleLane(e);
    for (const [a, b] of stretches(g, e, gapAt(g.from(e), e), gapAt(g.to(e), e))) {
      if (cls >= MARKING.centreFromClass && twoWay)
        for (const [d0, d1] of dashes(a, b, MARKING.dash, MARKING.gap)) band(g, e, d0, d1, 0, W, ml, white, mark);
      for (const side of [1, -1]) {
        if (lane && (twoWay || side === -1)) {
          const o = side * (hw - MARKING.laneWidth);
          for (const [d0, d1] of dashes(a, b, MARKING.laneDash, MARKING.laneGap)) band(g, e, d0, d1, o, W, ml, yellow, mark);
        } else if (cls >= MARKING.edgeFromClass) {
          band(g, e, a, b, side * (hw - MARKING.edgeInset), W, ml, white, mark);
        }
      }
    }
  }
  fillets(g, rbRadius, road, nodes);
  roundabouts(g, rbRadius, road, mark, nodes);
  const mesh = (b: Buffer): RoadMesh => ({ position: new Float32Array(b.pos), color: new Float32Array(b.col) });
  return { road: mesh(roadBuf), mark: mesh(markBuf) };
}

/**
 * Kerb radii at junctions: the corner between two neighbouring roads is filled with asphalt up to an
 * arc, as on real junctions (the ridden line rounds its corners and would otherwise cut the grass).
 */
function fillets(g: RouteGraph, rings: Map<number, number>, sink: Sink, nodes: number[]): void {
  for (const node of nodes) {
    if (rings.has(node)) continue;
    const ex = g.exits(node);
    if (ex.length < 2) continue;
    const nx = g.nodeX(node);
    const nz = g.nodeZ(node);
    const all = ex
      .map((x) => {
        const L = g.length(x.edge);
        const p = g.point(x.edge, x.dir > 0 ? Math.min(8, L / 2) : L - Math.min(8, L / 2));
        const dx = p.x - nx;
        const dz = p.z - nz;
        const l = Math.hypot(dx, dz) || 1;
        return {
          e: x.edge,
          dx: dx / l,
          dz: dz / l,
          a: Math.atan2(dz, dx),
          hw: g.halfWidth(x.edge),
          cls: g.edgeClass(x.edge),
          L,
        };
      })
      .sort((p, q) => p.a - q.a);
    const y = roadHeight(g, all[0]!.e, g.from(all[0]!.e) === node ? 0 : all[0]!.L);
    // roads among themselves (paths between them do not shrink their kerbs), then every pair of neighbours
    for (const arms of [all.filter((a) => a.cls >= 3), all]) {
      if (arms.length < 2) continue;
      for (let i = 0; i < arms.length; i++) {
        const A = arms[i]!;
        const B = arms[(i + 1) % arms.length]!;
        let theta = B.a - A.a;
        if (theta <= 0) theta += Math.PI * 2;
        if (theta < JUNCTION.minAngle || theta > JUNCTION.maxAngle) continue;
        // edge lines facing the wedge: A's left side (turning towards B), B's right side
        const nA = [-A.dz, A.dx]; // rotate +90° (towards increasing angle)
        const nB = [B.dz, -B.dx];
        const cls = Math.min(A.cls, B.cls);
        let rk = cls >= 3 ? JUNCTION.kerbRadius : JUNCTION.pathKerbRadius;
        // inner corner P: intersection of the two edge lines
        const sinT = Math.sin(theta);
        const tA = (B.hw + A.hw * Math.cos(theta)) / sinT;
        const P = [nx + A.dx * tA + nA[0]! * A.hw, nz + A.dz * tA + nA[1]! * A.hw];
        const tanH = Math.tan(theta / 2);
        let t = rk / tanH;
        const tMax = Math.min(JUNCTION.maxLeg, A.L / 2, B.L / 2);
        if (t > tMax) {
          t = tMax;
          rk = t * tanH;
        }
        if (rk < 0.5) continue;
        const Ta = [P[0]! + A.dx * t, P[1]! + A.dz * t];
        const Tb = [P[0]! + B.dx * t, P[1]! + B.dz * t];
        // arc centre: inside the wedge, rk from both edge lines
        const O = [Ta[0]! + nA[0]! * rk, Ta[1]! + nA[1]! * rk];
        const a0 = Math.atan2(Ta[1]! - O[1]!, Ta[0]! - O[0]!);
        const a1 = Math.atan2(Tb[1]! - O[1]!, Tb[0]! - O[0]!);
        let sweep = a1 - a0;
        while (sweep > Math.PI) sweep -= 2 * Math.PI;
        while (sweep < -Math.PI) sweep += 2 * Math.PI;
        const c = new Color(ROAD_COLOR[cls] ?? ROAD_COLOR_DEFAULT);
        const yy = y + roadLift(cls) - 0.005;
        const { pos, col } = sink(P[0]!, P[1]!);
        const n = 6;
        for (let k = 0; k < n; k++) {
          const p0 = a0 + (sweep * k) / n;
          const p1 = a0 + (sweep * (k + 1)) / n;
          pos.push(
            P[0]!,
            yy,
            P[1]!,
            O[0]! + rk * Math.cos(p0),
            yy,
            O[1]! + rk * Math.sin(p0),
            O[0]! + rk * Math.cos(p1),
            yy,
            O[1]! + rk * Math.sin(p1),
          );
          for (let v = 0; v < 3; v++) col.push(c.r, c.g, c.b);
        }
      }
    }
  }
}

/** Height of a node (start or end of one of its edges). */
export function nodeHeight(g: RouteGraph, n: number): number {
  const x = g.exits(n)[0];
  if (!x) return 0;
  return g.height(x.edge, x.dir > 0 ? 0 : g.length(x.edge));
}

/** Disc (or ring from r0 to r1) at height y, as triangles. */
function disc(cx: number, cz: number, y: number, r0: number, r1: number, c: Color, sink: Sink): void {
  const { pos, col } = sink(cx, cz);
  const n = ROUNDABOUT.segments;
  for (let k = 0; k < n; k++) {
    const a0 = (k / n) * Math.PI * 2;
    const a1 = ((k + 1) / n) * Math.PI * 2;
    const P = (r: number, a: number) => [cx + Math.cos(a) * r, y, cz + Math.sin(a) * r];
    const tris = r0 > 0 ? [P(r1, a0), P(r0, a0), P(r1, a1), P(r0, a0), P(r0, a1), P(r1, a1)] : [P(r1, a0), [cx, y, cz], P(r1, a1)];
    for (const v of tris) {
      pos.push(...v);
      col.push(c.r, c.g, c.b);
    }
  }
}

/**
 * Roundabouts are one node in the graph (one decision); drawn as an asphalt ring around a
 * grass island that hides where the approaches meet, with white edge lines.
 */
function roundabouts(g: RouteGraph, radius: Map<number, number>, road: Sink, mark: Sink, nodes: number[]): void {
  const here = new Set(nodes);
  const asphalt = new Color(ROAD_COLOR[8] ?? ROAD_COLOR_DEFAULT);
  const island = new Color(ROUNDABOUT.island);
  const white = new Color(MARKING.white);
  for (const [n, r] of radius) {
    if (!here.has(n)) continue;
    const x = g.nodeX(n);
    const z = g.nodeZ(n);
    const y = nodeHeight(g, n) + RENDER.roadLift;
    const ri = Math.max(ROUNDABOUT.minIsland, r - ROUNDABOUT.lane / 2);
    const ro = ri + ROUNDABOUT.lane;
    disc(x, z, y + ROUNDABOUT.lift, ri, ro, asphalt, road);
    disc(x, z, y + ROUNDABOUT.islandLift, 0, ri, island, road);
    disc(x, z, y + ROUNDABOUT.lift + MARKING.lift, ri + 0.3, ri + 0.3 + MARKING.width, white, mark);
  }
}
