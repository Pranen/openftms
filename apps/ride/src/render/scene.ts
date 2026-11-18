import * as THREE from 'three/webgpu';
import { color, mix, positionLocal, smoothstep } from 'three/tsl';
import { SEC_TUNNEL, type RouteGraph } from 'route-graph';
import { GRAVEL_COLOR, MARKING, RENDER, ROAD_COLOR, ROAD_COLOR_DEFAULT, ROUNDABOUT } from '../config';
import type { TileMesh } from '../workers/world-worker';
import { retroMaterial } from './retro';

function lights(scene: THREE.Scene): void {
  scene.add(new THREE.HemisphereLight(0xd8e8ff, 0x55663a, 1.6));
  const sun = new THREE.DirectionalLight(0xfff1d6, 2.4);
  sun.position.set(...RENDER.sunDirection);
  scene.add(sun);
}

/**
 * Two scenes, drawn in two depth passes (PLAN.md, Renderer): `far` holds the sky and the
 * coarse levels (panorama), `near` the detailed L0 world, drawn on top. Both share the haze.
 */
export function createScenes(): { near: THREE.Scene; far: THREE.Scene } {
  const near = new THREE.Scene();
  const far = new THREE.Scene();
  for (const s of [near, far]) {
    s.fog = new THREE.Fog(RENDER.sky.horizon, RENDER.hazeNear, RENDER.hazeFar);
    lights(s);
  }
  far.background = new THREE.Color(RENDER.sky.horizon);
  // sky dome: gradient from the horizon (= haze colour) to the zenith; follows the camera
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(RENDER.farPassFar * 0.9, 16, 10),
    new THREE.MeshBasicNodeMaterial({ side: THREE.BackSide, fog: false, depthWrite: false }),
  );
  (sky.material as THREE.MeshBasicNodeMaterial).colorNode = mix(
    color(RENDER.sky.horizon),
    color(RENDER.sky.zenith),
    smoothstep(0.0, 0.45, positionLocal.normalize().y),
  );
  sky.name = 'sky';
  sky.renderOrder = -1;
  far.add(sky);
  return { near, far };
}

function geometry(position: Float32Array, col: Float32Array): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(position, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}

const terrainMat = retroMaterial();
const panoramaMat = retroMaterial({ curvature: true });
const buildingMat = retroMaterial({ side: THREE.DoubleSide });
const roadMat = retroMaterial({ side: THREE.DoubleSide, polygonOffset: 2, snap: false });

export function addTile(scene: THREE.Scene, t: TileMesh): void {
  scene.add(new THREE.Mesh(geometry(t.terrain.position, t.terrain.color), t.level === 0 ? terrainMat : panoramaMat));
  if (t.buildings.position.length) scene.add(new THREE.Mesh(geometry(t.buildings.position, t.buildings.color), buildingMat));
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
  c: THREE.Color,
  pos: number[],
  col: number[],
  step = 3,
): void {
  const L = g.length(e);
  const n = Math.max(1, Math.ceil((s1 - s0) / step));
  let prev: number[] | null = null;
  for (let k = 0; k <= n; k++) {
    const s = s0 + ((s1 - s0) * k) / n;
    const f = frame(g, e, s, L);
    const y = g.height(e, s) + lift;
    const o1 = offset + width / 2;
    const o2 = offset - width / 2;
    const cur = [f.x + f.nx * o1, y, f.z + f.nz * o1, f.x + f.nx * o2, y, f.z + f.nz * o2];
    if (prev) {
      const [ax, ay, az, bx, by, bz] = prev as [number, number, number, number, number, number];
      const [cx, cy, cz, dx, dy, dz] = cur as [number, number, number, number, number, number];
      pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, bx, by, bz, dx, dy, dz, cx, cy, cz);
      for (let v = 0; v < 6; v++) col.push(c.r, c.g, c.b);
    }
    prev = cur;
  }
}

/** Open stretches of an edge (outside tunnels), shortened by gapA / gapB at its start / end. */
function stretches(g: RouteGraph, e: number, gapA: number, gapB = gapA): [number, number][] {
  const L = g.length(e);
  let out: [number, number][] = [[gapA, L - gapB]];
  for (const t of g.sections(e)) {
    if (!(t.flags & SEC_TUNNEL)) continue;
    out = out.flatMap(([a, b]) => [[a, Math.min(b, t.start)], [Math.max(a, t.end), b]] as [number, number][]);
  }
  return out.filter(([a, b]) => b - a > 1);
}

/** Dashes from a to b (phase from the edge start, so dashes do not jump between frames). */
function dashes(a: number, b: number, dash: number, gap: number): [number, number][] {
  const out: [number, number][] = [];
  for (let s = Math.ceil(a / (dash + gap)) * (dash + gap); s < b; s += dash + gap) out.push([s, Math.min(b, s + dash)]);
  return out;
}

const roadMarkMat = retroMaterial({ side: THREE.DoubleSide, polygonOffset: 4, snap: false });

/** Road bands of the whole ride network, built from the graph (same profile as the physics), with markings. */
export function addRoads(scene: THREE.Scene, g: RouteGraph): void {
  const pos: number[] = [];
  const col: number[] = [];
  const mpos: number[] = [];
  const mcol: number[] = [];
  const white = new THREE.Color(MARKING.white);
  const yellow = new THREE.Color(MARKING.yellow);
  const order = [...Array(g.edgeCount).keys()].sort((a, b) => g.edgeClass(a) - g.edgeClass(b));
  const rbRadius = new Map(g.meta.roundabouts ?? []);
  // markings stop short of junctions, and outside the drawn ring of a roundabout
  const gapAt = (node: number) => {
    const r = rbRadius.get(node);
    return r === undefined ? MARKING.junctionGap : r + ROUNDABOUT.lane + 2;
  };
  for (const e of order) {
    const hw = g.halfWidth(e);
    const cls = g.edgeClass(e);
    const surf = g.surface(e);
    const c = new THREE.Color(surf >= 3 && surf <= 5 ? GRAVEL_COLOR : (ROAD_COLOR[cls] ?? ROAD_COLOR_DEFAULT));
    const lift = RENDER.roadLift + cls * 0.01;
    for (const [a, b] of stretches(g, e, 0)) band(g, e, a, b, 0, hw * 2, lift, c, pos, col, 4);
    // markings only on paved roads
    if (surf > 2 || cls < 3) continue;
    const ml = lift + MARKING.lift;
    const W = MARKING.width;
    const oneway = g.oneway(e);
    // short one-way pieces (the split approaches at islands and roundabouts) stay unmarked
    if (oneway && g.length(e) < MARKING.minOnewayLength) continue;
    const twoWay = !oneway;
    const lane = g.cycleLane(e);
    for (const [a, b] of stretches(g, e, gapAt(g.from(e)), gapAt(g.to(e)))) {
      if (cls >= MARKING.centreFromClass && twoWay)
        for (const [d0, d1] of dashes(a, b, MARKING.dash, MARKING.gap)) band(g, e, d0, d1, 0, W, ml, white, mpos, mcol);
      for (const side of [1, -1]) {
        if (lane && (twoWay || side === -1)) {
          const o = side * (hw - MARKING.laneWidth);
          for (const [d0, d1] of dashes(a, b, MARKING.laneDash, MARKING.laneGap)) band(g, e, d0, d1, o, W, ml, yellow, mpos, mcol);
        } else if (cls >= MARKING.edgeFromClass) {
          band(g, e, a, b, side * (hw - MARKING.edgeInset), W, ml, white, mpos, mcol);
        }
      }
    }
  }
  roundabouts(g, rbRadius, pos, col, mpos, mcol);
  scene.add(new THREE.Mesh(geometry(new Float32Array(pos), new Float32Array(col)), roadMat));
  if (mpos.length) scene.add(new THREE.Mesh(geometry(new Float32Array(mpos), new Float32Array(mcol)), roadMarkMat));
}

/** Height of a node (start or end of one of its edges). */
function nodeHeight(g: RouteGraph, n: number): number {
  const x = g.exits(n)[0];
  if (!x) return 0;
  return g.height(x.edge, x.dir > 0 ? 0 : g.length(x.edge));
}

/** Disc (or ring from r0 to r1) at height y, as triangles. */
function disc(cx: number, cz: number, y: number, r0: number, r1: number, c: THREE.Color, pos: number[], col: number[]): void {
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
function roundabouts(g: RouteGraph, radius: Map<number, number>, pos: number[], col: number[], mpos: number[], mcol: number[]): void {
  const asphalt = new THREE.Color(ROAD_COLOR[8] ?? ROAD_COLOR_DEFAULT);
  const island = new THREE.Color(ROUNDABOUT.island);
  const white = new THREE.Color(MARKING.white);
  for (const [n, r] of radius) {
    const x = g.nodeX(n);
    const z = g.nodeZ(n);
    const y = nodeHeight(g, n) + RENDER.roadLift;
    const ri = Math.max(ROUNDABOUT.minIsland, r - ROUNDABOUT.lane / 2);
    const ro = ri + ROUNDABOUT.lane;
    disc(x, z, y + ROUNDABOUT.lift, ri, ro, asphalt, pos, col);
    disc(x, z, y + ROUNDABOUT.islandLift, 0, ri, island, pos, col);
    disc(x, z, y + ROUNDABOUT.lift + MARKING.lift, ri + 0.3, ri + 0.3 + MARKING.width, white, mpos, mcol);
  }
}
