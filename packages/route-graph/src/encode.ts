import { ATTR_ACCESS_BWD, ATTR_ACCESS_FWD, type GraphMeta } from './format.js';

/** Input for {@link encodeGraph}: a small graph described in world metres (tests, tools). */
export interface GraphSpec {
  nodes: { x: number; z: number; flags?: number }[];
  edges: {
    from: number;
    to: number;
    /** Interior points (the node positions are added at both ends). */
    via?: [number, number][];
    /** Height at arc length s (default: flat 450 m). */
    height?: (s: number) => number;
    cls?: number;
    surface?: number;
    oneway?: boolean;
    routes?: number;
    name?: string;
    sections?: { start: number; end: number; flags: number }[];
  }[];
}

const STEP = 5;
const SCALE = 0.05;

/**
 * Writes the same binary layout as tools/world-pipeline (ride_pipeline/graph.py),
 * so tests can build graphs without the Python pipeline.
 */
export function encodeGraph(spec: GraphSpec): { meta: GraphMeta; buffer: ArrayBuffer } {
  const gx: number[] = [];
  const gz: number[] = [];
  const gstart: number[] = [];
  const gcount: number[] = [];
  const pstart: number[] = [];
  const prof: number[] = [];
  const lengths: number[] = [];
  const names = [...new Set(['', ...spec.edges.map((e) => e.name ?? '')])].sort();
  for (const e of spec.edges) {
    const a = spec.nodes[e.from]!;
    const b = spec.nodes[e.to]!;
    const pts: [number, number][] = [[a.x, a.z], ...(e.via ?? []), [b.x, b.z]];
    let L = 0;
    for (let k = 1; k < pts.length; k++) L += Math.hypot(pts[k]![0] - pts[k - 1]![0], pts[k]![1] - pts[k - 1]![1]);
    lengths.push(L);
    gstart.push(gx.length);
    gcount.push(pts.length);
    for (const [x, z] of pts) {
      gx.push(x);
      gz.push(z);
    }
    pstart.push(prof.length);
    const height = e.height ?? (() => 450);
    const ss: number[] = [];
    for (let s = 0; s < L - 1e-6; s += STEP) ss.push(s);
    ss.push(L);
    for (const s of ss) prof.push(height(s));
  }
  const hOffset = Math.floor(Math.min(...prof)) - 10;
  const secs = spec.edges.flatMap((e, i) => (e.sections ?? []).map((s) => [i, s.start, s.end, s.flags] as const));
  const adj: number[][] = spec.nodes.map(() => []);
  spec.edges.forEach((e, i) => {
    adj[e.from]!.push(i << 1);
    adj[e.to]!.push((i << 1) | 1);
  });
  const offsets = [0];
  const entries: number[] = [];
  for (const list of adj) {
    entries.push(...list.sort((p, q) => p - q));
    offsets.push(entries.length);
  }
  const enc = new TextEncoder();
  const nameBytes = names.map((n) => enc.encode(n));
  const nameOffsets = [0];
  for (const b of nameBytes) nameOffsets.push(nameOffsets[nameOffsets.length - 1]! + b.length);

  const cm = (v: number[]) => Int32Array.from(v, (x) => Math.round(x * 100));
  const sections: [string, Int32Array | Uint32Array | Uint16Array | Uint8Array, GraphMeta['sections'][string][2]][] = [
    ['nodeX', cm(spec.nodes.map((n) => n.x)), 'i4'],
    ['nodeZ', cm(spec.nodes.map((n) => n.z)), 'i4'],
    ['nodeFlags', Uint8Array.from(spec.nodes.map((n) => n.flags ?? 0)), 'u1'],
    ['edgeFrom', Uint32Array.from(spec.edges.map((e) => e.from)), 'u4'],
    ['edgeTo', Uint32Array.from(spec.edges.map((e) => e.to)), 'u4'],
    ['edgeLength', Uint32Array.from(lengths.map((l) => Math.round(l * 100))), 'u4'],
    [
      'edgeAttrs',
      Uint32Array.from(
        spec.edges.map((e) => (e.cls ?? 3) | ((e.surface ?? 0) << 4) | ATTR_ACCESS_FWD | (e.oneway ? 0 : ATTR_ACCESS_BWD)),
      ),
      'u4',
    ],
    ['edgeRoutes', Uint32Array.from(spec.edges.map((e) => e.routes ?? 0)), 'u4'],
    ['edgeGeomStart', Uint32Array.from(gstart), 'u4'],
    ['edgeGeomCount', Uint32Array.from(gcount), 'u4'],
    ['edgeProfStart', Uint32Array.from(pstart), 'u4'],
    ['edgeName', Uint32Array.from(spec.edges.map((e) => names.indexOf(e.name ?? ''))), 'u4'],
    ['adjOffsets', Uint32Array.from(offsets), 'u4'],
    ['adjEntries', Uint32Array.from(entries), 'u4'],
    ['geomX', cm(gx), 'i4'],
    ['geomZ', cm(gz), 'i4'],
    ['profile', Uint16Array.from(prof, (h) => Math.round((h - hOffset) / SCALE)), 'u2'],
    ['secEdge', Uint32Array.from(secs.map((s) => s[0])), 'u4'],
    ['secStart', Uint32Array.from(secs.map((s) => Math.round(s[1] * 100))), 'u4'],
    ['secEnd', Uint32Array.from(secs.map((s) => Math.round(s[2] * 100))), 'u4'],
    ['secFlags', Uint32Array.from(secs.map((s) => s[3])), 'u4'],
    ['nameOffsets', Uint32Array.from(nameOffsets), 'u4'],
    ['nameBytes', Uint8Array.from(nameBytes.flatMap((b) => [...b])), 'u1'],
  ];
  let size = 0;
  const table: GraphMeta['sections'] = {};
  for (const [name, arr, dtype] of sections) {
    size = Math.ceil(size / 8) * 8;
    table[name] = [size, arr.length, dtype];
    size += arr.byteLength;
  }
  const buffer = new ArrayBuffer(Math.ceil(size / 8) * 8);
  for (const [name, arr] of sections) new Uint8Array(buffer, table[name]![0], arr.byteLength).set(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
  const meta: GraphMeta = {
    format: 1,
    nodes: spec.nodes.length,
    edges: spec.edges.length,
    profileStep: STEP,
    heightScale: SCALE,
    heightOffset: hOffset,
    origin: [2754000, 1222000],
    classes: ['cycleway', 'path', 'track', 'residential', 'living_street', 'unclassified', 'tertiary', 'secondary', 'primary'],
    surfaces: ['asphalt', 'concrete', 'paving', 'fine_gravel', 'gravel', 'unpaved', 'unknown'],
    roadHalfWidth: [1.5, 1.2, 1.6, 2.6, 2.4, 2.6, 3.0, 3.3, 3.6],
    routes: [],
    sections: table,
    buildHash: 'synthetic',
  };
  return { meta, buffer };
}
