/// <reference lib="webworker" />
/**
 * Decodes tiles and builds their meshes off the main thread (Web Bluetooth lives
 * on the main thread; it must stay responsive). Returns transferable arrays.
 */
import { ShapeUtils, Vector2 } from 'three';
import { BUILDING, LANDCOVER, SCENERY, STREAM, TREES } from '../config';
import { STYLE, TEX } from '../world/atlas';
import { RouteGraph, type GraphMeta } from 'route-graph';
import { plantTile } from '../world/plant';
import { buildRoadTile, type RoadMesh } from '../render/roads';
import { buildScenery, type SceneryMesh } from '../render/scenery';
import { buildLandmark, churchTower, modelAt } from '../render/landmarks';
import { LINE_KIND, type LandmarkRecord, type SceneryLine } from '../world/tile';
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
  buildings: { position: Float32Array; color: Float32Array; tex: Float32Array };
  buildingCount: number;
  /** L0: planted trees (world/plant.ts, TREE_STRIDE floats each). */
  trees?: Float32Array;
  /** L0: road bands, kerb fillets, roundabouts (roads) and their markings (marks) of the ride network. */
  roads?: RoadMesh;
  marks?: RoadMesh;
  /** L0: motorways, railways, bridges, power lines, waterways (LINE section). */
  scenery?: SceneryMesh;
  /** L0: railway pieces as world x, y (rail top), z triples, for the trains. */
  rails?: Float32Array[];
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

/** Facade / roof texture tile, window axis width and storey height (m) per building style (world/atlas.ts). */
const LOOK: Record<number, { wall: number; axis: number; storey: number; roof: number; flat: number }> = {
  [STYLE.house]: { wall: TEX.house, axis: 3, storey: 2.9, roof: TEX.roofTiles, flat: TEX.roofFlat },
  [STYLE.apartment]: { wall: TEX.apartment, axis: 3.2, storey: 3, roof: TEX.roofTiles, flat: TEX.roofFlat },
  [STYLE.farm]: { wall: TEX.barn, axis: 2, storey: 2.6, roof: TEX.roofTiles, flat: TEX.roofMetal },
  [STYLE.commercial]: { wall: TEX.commercial, axis: 4, storey: 4, roof: TEX.roofMetal, flat: TEX.roofFlat },
  [STYLE.church]: { wall: TEX.stone, axis: 2.5, storey: 2.5, roof: TEX.roofSlate, flat: TEX.roofSlate },
  [STYLE.small]: { wall: TEX.shed, axis: 3, storey: 2.6, roof: TEX.roofMetal, flat: TEX.roofMetal },
  [STYLE.open]: { wall: TEX.plain, axis: 4, storey: 3, roof: TEX.roofMetal, flat: TEX.roofMetal },
  [STYLE.greenhouse]: { wall: TEX.glass, axis: 3, storey: 3, roof: TEX.glass, flat: TEX.glass },
};
/** Roof texture repeat (m per tile). */
const ROOF_TILE = 2;

/**
 * Walls, gables and roofs of a tile's buildings with texture coordinates: `tex` holds (u, v, atlas tile) per
 * vertex; u and v repeat the tile (the shader wraps them), whole window axes per wall and whole storeys up
 * to the eave, so no window is cut at a corner or under the roof.
 */
function buildings(list: Building[], x0: number, z0: number, landmarks: LandmarkRecord[] = []) {
  const pos: number[] = [];
  const col: number[] = [];
  const tex: number[] = [];
  const tri = (a: number[], b: number[], c: number[], colour: [number, number, number], ta: number[], tb: number[], tc: number[], tile: number) => {
    pos.push(...a, ...b, ...c);
    col.push(...colour, ...colour, ...colour);
    tex.push(ta[0]!, ta[1]!, tile, tb[0]!, tb[1]!, tile, tc[0]!, tc[1]!, tile);
  };
  for (const l of landmarks) buildLandmark(tri, l, x0, z0);
  for (const b of list) {
    const form = b.roof & 15;
    const look = LOOK[b.roof >> 4] ?? LOOK[STYLE.house]!;
    const wall = WALLS[b.colour % WALLS.length]!;
    const roofC = form === 0 ? FLAT : ROOFS[b.colour % ROOFS.length]!;
    const nv = b.ring.length / 2;
    const y0 = b.base;
    const ground = b.base + 0.3;
    const y1 = ground + b.eave;
    const storey = b.eave / Math.max(1, Math.round(b.eave / look.storey));
    const P = (k: number, y: number) => [x0 + b.ring[k * 2]!, y, z0 + b.ring[k * 2 + 1]!];
    const vOf = (y: number) => (y - ground) / storey;
    for (let k = 0; k < nv; k++) {
      const k2 = (k + 1) % nv;
      const len = Math.hypot(b.ring[k2 * 2]! - b.ring[k * 2]!, b.ring[k2 * 2 + 1]! - b.ring[k * 2 + 1]!);
      const u1 = Math.max(1, Math.round(len / look.axis));
      const a = P(k, y0);
      const c = P(k2, y0);
      const a1 = P(k, y1);
      const c1 = P(k2, y1);
      tri(a, c, a1, wall, [0, vOf(y0)], [u1, vOf(y0)], [0, vOf(y1)], look.wall);
      tri(c, c1, a1, wall, [u1, vOf(y0)], [u1, vOf(y1)], [0, vOf(y1)], look.wall);
    }
    if (form === 0) {
      const pts = [];
      for (let k = 0; k < nv; k++) pts.push(new Vector2(b.ring[k * 2]!, b.ring[k * 2 + 1]!));
      const uv = (k: number) => [b.ring[k * 2]! / (ROOF_TILE * 2), b.ring[k * 2 + 1]! / (ROOF_TILE * 2)];
      for (const t of ShapeUtils.triangulateShape(pts, []))
        tri(P(t[0]!, y1), P(t[1]!, y1), P(t[2]!, y1), roofC, uv(t[0]!), uv(t[1]!), uv(t[2]!), look.flat);
      continue;
    }
    // gabled / hipped / shed roof on the oriented box, with a little overhang
    const o = BUILDING.overhang;
    const ux = Math.cos(b.angle);
    const uz = Math.sin(b.angle);
    const vx = -uz;
    const vz = ux;
    const hl = b.halfLength + o;
    const hw = b.halfWidth + o;
    const cx = x0 + b.cx;
    const cz = z0 + b.cz;
    const yr = ground + b.ridge;
    const corner = (su: number, sv: number) => [cx + ux * hl * su + vx * hw * sv, y1, cz + uz * hl * su + vz * hw * sv];
    const rl = form === 2 ? Math.max(0, hl - hw) : hl;
    // shed roof: the ridge runs along one long side
    const rs = form === 3 ? 1 : 0;
    const ridge = (su: number) => [cx + ux * rl * su + vx * hw * rs, yr, cz + uz * rl * su + vz * hw * rs];
    const A = corner(-1, -1);
    const B = corner(1, -1);
    const C = corner(1, 1);
    const D = corner(-1, 1);
    const R0 = ridge(-1);
    const R1 = ridge(1);
    const slope = Math.hypot(hw * (form === 3 ? 2 : 1), yr - y1) / ROOF_TILE;
    const U = (s: number) => s / ROOF_TILE;
    const rt = look.roof;
    tri(A, B, R1, roofC, [U(-hl), 0], [U(hl), 0], [U(rl), slope], rt);
    tri(A, R1, R0, roofC, [U(-hl), 0], [U(rl), slope], [U(-rl), slope], rt);
    if (form !== 3) {
      tri(C, D, R0, roofC, [U(hl), 0], [U(-hl), 0], [U(-rl), slope], rt);
      tri(C, R0, R1, roofC, [U(hl), 0], [U(-rl), slope], [U(rl), slope], rt);
    } else {
      // shed: the high wall above the eave on the ridge side
      const C1 = [C[0]!, yr, C[2]!];
      const D1 = [D[0]!, yr, D[2]!];
      tri(C, D, D1, wall, [0, 0], [U(2 * hl), 0], [U(2 * hl), (yr - y1) / ROOF_TILE], TEX.plain);
      tri(C, D1, C1, wall, [0, 0], [U(2 * hl), (yr - y1) / ROOF_TILE], [0, (yr - y1) / ROOF_TILE], TEX.plain);
    }
    const gable = form === 2 ? roofC : wall;
    const gt = form === 2 ? rt : TEX.plain;
    const gh = (yr - y1) / (form === 2 ? ROOF_TILE : storey);
    const gw = (2 * hw) / (form === 2 ? ROOF_TILE : look.axis);
    tri(B, C, R1, gable, [0, 0], [gw, 0], [gw / 2, gh], gt);
    tri(D, A, R0, gable, [0, 0], [gw, 0], [gw / 2, gh], gt);
    // village churches get a tower with a spire (or an onion dome) at one end
    if (b.roof >> 4 === STYLE.church && b.halfLength * b.halfWidth * 4 > BUILDING.churchTowerArea) {
      const r = (Math.abs(Math.sin(b.cx * 12.9898 + b.cz * 78.233)) * 43758.5453) % 1;
      const m = modelAt(tri, x0, z0, b.cx, b.cz, b.angle, ground);
      churchTower(m, b.halfLength, b.halfWidth, Math.min(55, Math.max(20, b.ridge * 1.9)), r < 0.5 ? -1 : 1, r > 0.8);
    }
  }
  return { position: new Float32Array(pos), color: new Float32Array(col), tex: new Float32Array(tex) };
}

let graph: RouteGraph | null = null;

/**
 * Coarse tiles: buildings as plain boxes (walls in the wall colour, top in the roof colour), appended to the
 * terrain chunk they stand in, so they share its material (earth curvature) and hide with it.
 */
function addBoxes(chunks: { position: Float32Array; color: Uint8Array }[], boxes: Float32Array, x0: number, z0: number, chunkSize: number, per: number) {
  if (!boxes.length) return chunks;
  const extra = chunks.map(() => ({ pos: [] as number[], col: [] as number[] }));
  const c8 = (c: [number, number, number]) => c.map((v) => Math.round(v * 255));
  for (let k = 0; k < boxes.length; k += 9) {
    const [bx, bz, a, hl, hw, base, height, colour, style] = boxes.subarray(k, k + 9) as unknown as number[];
    const ci = Math.min(per - 1, Math.floor(bx! / chunkSize));
    const cj = Math.min(per - 1, Math.floor(bz! / chunkSize));
    const e = extra[cj * per + ci]!;
    const wall = c8(WALLS[colour! % WALLS.length]!);
    const roof = c8(style === STYLE.commercial || style === STYLE.apartment ? FLAT : ROOFS[colour! % ROOFS.length]!);
    const ux = Math.cos(a!);
    const uz = Math.sin(a!);
    const P = (su: number, sv: number, y: number) => [x0 + bx! + ux * hl! * su - uz * hw! * sv, y, z0 + bz! + uz * hl! * su + ux * hw! * sv];
    const y0 = base!;
    const y1 = base! + Math.max(3, height!);
    const corners: [number, number][] = [
      [-1, -1],
      [1, -1],
      [1, 1],
      [-1, 1],
    ];
    const push = (v: number[][], c: number[]) => {
      for (const p of v) e.pos.push(p[0]!, p[1]!, p[2]!);
      for (let i = 0; i < v.length; i++) e.col.push(c[0]!, c[1]!, c[2]!, 255);
    };
    for (let i = 0; i < 4; i++) {
      const [au, av] = corners[i]!;
      const [bu, bv] = corners[(i + 1) % 4]!;
      push([P(au, av, y0), P(bu, bv, y0), P(bu, bv, y1), P(au, av, y0), P(bu, bv, y1), P(au, av, y1)], wall);
    }
    push([P(-1, -1, y1), P(1, -1, y1), P(1, 1, y1), P(-1, -1, y1), P(1, 1, y1), P(-1, 1, y1)], roof);
  }
  return chunks.map((c, i) => {
    const e = extra[i]!;
    if (!e.pos.length) return c;
    const position = new Float32Array(c.position.length + e.pos.length);
    position.set(c.position);
    position.set(e.pos, c.position.length);
    const color = new Uint8Array(c.color.length + e.col.length);
    color.set(c.color);
    color.set(e.col, c.color.length);
    return { position, color };
  });
}

/** Trees stay off motorways, railways, waterways (band plus a gap) and landmark footprints. */
function lineBlocker(lines: SceneryLine[], x0: number, z0: number, landmarks: LandmarkRecord[]): (x: number, z: number) => boolean {
  const B = 25;
  const cells = new Map<number, number[]>(); // [ax, az, bx, bz, r, ...]
  const key = (i: number, j: number) => i * 65536 + j;
  const add = (ax: number, az: number, bx: number, bz: number, r: number) => {
    for (let i = Math.floor((Math.min(ax, bx) - r) / B); i <= Math.floor((Math.max(ax, bx) + r) / B); i++)
      for (let j = Math.floor((Math.min(az, bz) - r) / B); j <= Math.floor((Math.max(az, bz) + r) / B); j++) {
        const l = cells.get(key(i, j)) ?? [];
        l.push(ax, az, bx, bz, r);
        cells.set(key(i, j), l);
      }
  };
  for (const l of lines) {
    if (l.kind === LINE_KIND.power || l.kind === LINE_KIND.minorPower) continue;
    const r = l.width / 2 + TREES.clearRoad + (l.kind === LINE_KIND.rail ? 2 : 0);
    for (let i = 0; i + 1 < l.x.length; i++) add(x0 + l.x[i]!, z0 + l.z[i]!, x0 + l.x[i + 1]!, z0 + l.z[i + 1]!, r);
  }
  for (const m of landmarks) {
    const r = Math.max(m.hl, m.hw) + 4;
    add(x0 + m.cx, z0 + m.cz, x0 + m.cx, z0 + m.cz, r);
  }
  return (x, z) => {
    const l = cells.get(key(Math.floor(x / B), Math.floor(z / B)));
    if (!l) return false;
    for (let k = 0; k < l.length; k += 5) {
      const ax = l[k]!;
      const az = l[k + 1]!;
      const dx = l[k + 2]! - ax;
      const dz = l[k + 3]! - az;
      const l2 = dx * dx + dz * dz;
      const f = l2 > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
      if (Math.hypot(ax + dx * f - x, az + dz * f - z) < l[k + 4]!) return true;
    }
    return false;
  };
}

/**
 * Whether a building stands on a road band (OSM footprints and road centre lines do not always
 * agree, and the pipeline moves roads slightly): probed on a 2 m grid over its box and at its corners.
 */
function onRoad(b: Building, x0: number, z0: number, g: RouteGraph): boolean {
  const ux = Math.cos(b.angle);
  const uz = Math.sin(b.angle);
  const hit = (x: number, z: number) => {
    const r = g.nearest(x, z, 12);
    return r !== null && r.dist < g.halfWidth(r.edge) - BUILDING.roadTolerance;
  };
  const nl = Math.max(1, Math.ceil(b.halfLength));
  const nw = Math.max(1, Math.ceil(b.halfWidth));
  for (let i = -nl; i <= nl; i++) {
    for (let j = -nw; j <= nw; j++) {
      const u = (i / nl) * b.halfLength;
      const v = (j / nw) * b.halfWidth;
      if (hit(x0 + b.cx + ux * u - uz * v, z0 + b.cz + uz * u + ux * v)) return true;
    }
  }
  for (let k = 0; k < b.ring.length; k += 2) if (hit(x0 + b.ring[k]!, z0 + b.ring[k + 1]!)) return true;
  return false;
}

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
  if (graph) {
    const g = graph;
    t.buildings = t.buildings.filter((b) => !onRoad(b, x0, z0, g));
  }
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
    terrain: addBoxes(
      terrain(t.heights, t.codes, n, cell, x0, z0, t.header.ix, t.header.iy, chunks, STREAM.skirt[level] ?? 50, STREAM.step[level] ?? 1),
      t.boxes,
      x0,
      z0,
      ((n - 1) * cell) / chunks,
      chunks,
    ),
    chunks,
    buildings: buildings(t.buildings, x0, z0, t.landmarks),
    buildingCount: t.buildings.length,
  };
  // terrain height (bilinear on the node grid) for piers and draped water
  const ground = (x: number, z: number) => {
    const fx = Math.min(n - 1.001, Math.max(0, (x - x0) / cell));
    const fz = Math.min(n - 1.001, Math.max(0, (z - z0) / cell));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const u = fx - i;
    const v = fz - j;
    const h = (a: number, b: number) => t.heights[b * n + a]!;
    return (h(i, j) * (1 - u) + h(i + 1, j) * u) * (1 - v) + (h(i, j + 1) * (1 - u) + h(i + 1, j + 1) * u) * v;
  };
  if (level === 0 && graph) {
    mesh.trees = plantTile({ ...mesh, blocked: lineBlocker(t.lines, x0, z0, t.landmarks) }, graph);
    const r = buildRoadTile(graph, [e0, n0], cell * (n - 1), t.header.ix, t.header.iy, ground);
    mesh.roads = r.road;
    mesh.marks = r.mark;
  }
  if (level === 0 && t.lines.length) {
    mesh.scenery = buildScenery(t.lines, x0, z0, ground);
    mesh.rails = t.lines
      .filter((l) => l.kind === LINE_KIND.rail)
      .map((l) => {
        const a = new Float32Array(l.x.length * 3);
        for (let i = 0; i < l.x.length; i++) a.set([x0 + l.x[i]!, l.h[i]! + SCENERY.rail.lift + SCENERY.rail.railHeight, z0 + l.z[i]!], i * 3);
        return a;
      });
  }

  (self as unknown as Worker).postMessage(mesh, [
    ...(mesh.trees ? [mesh.trees.buffer] : []),
    ...(mesh.rails ?? []).map((r) => r.buffer),
    ...[mesh.roads, mesh.marks, mesh.scenery].flatMap((m) => (m ? [m.position.buffer, m.color.buffer] : [])),
    mesh.heights.buffer,
    mesh.codes.buffer,
    mesh.boxes.buffer,
    ...mesh.terrain.flatMap((c) => [c.position.buffer, c.color.buffer]),
    mesh.buildings.position.buffer,
    mesh.buildings.color.buffer,
    mesh.buildings.tex.buffer,
  ]);
};
