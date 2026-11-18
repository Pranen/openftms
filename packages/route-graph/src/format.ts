/**
 * Binary road graph written by tools/world-pipeline (ride_pipeline/graph.py):
 * graph.json (metadata + section table) and graph.bin (little-endian typed arrays,
 * 8-byte aligned). Spec: apps/ride/PLAN.md, "Strassengraph".
 */

export const CLASS = {
  cycleway: 0,
  path: 1,
  track: 2,
  residential: 3,
  livingStreet: 4,
  unclassified: 5,
  tertiary: 6,
  secondary: 7,
  primary: 8,
} as const;

export const SURFACE = {
  asphalt: 0,
  concrete: 1,
  paving: 2,
  fineGravel: 3,
  gravel: 4,
  unpaved: 5,
  unknown: 6,
} as const;

export const ATTR_ACCESS_FWD = 1 << 7;
export const ATTR_ACCESS_BWD = 1 << 8;
export const ATTR_CYCLELANE = 1 << 9;
/** One carriageway of a one-way road (dual carriageway, ramp, roundabout): narrower band, no centre line. */
export const ATTR_ONEWAY = 1 << 10;

export const SEC_BRIDGE = 1;
export const SEC_TUNNEL = 2;
export const SEC_GALLERY = 4;

export const NODE_ROUNDABOUT = 1;
export const NODE_BOUNDARY = 2;

type DType = 'i4' | 'u4' | 'u2' | 'u1' | 'f8';

export interface GraphMeta {
  format: number;
  nodes: number;
  edges: number;
  profileStep: number;
  heightScale: number;
  heightOffset: number;
  origin: [number, number];
  classes: string[];
  surfaces: string[];
  roadHalfWidth: number[];
  /** Band width factor of one-way carriageways (ATTR_ONEWAY). */
  onewayWidth?: number;
  /** Roundabouts collapsed into one node: [node, radius in m]. */
  roundabouts?: [node: number, radius: number][];
  routes: { bit: number; network: string; ref: string; name: string }[];
  sections: Record<string, [offset: number, count: number, dtype: DType]>;
  buildHash: string;
}

export interface GraphArrays {
  nodeX: Int32Array;
  nodeZ: Int32Array;
  nodeFlags: Uint8Array;
  edgeFrom: Uint32Array;
  edgeTo: Uint32Array;
  edgeLength: Uint32Array;
  edgeAttrs: Uint32Array;
  edgeRoutes: Uint32Array;
  edgeGeomStart: Uint32Array;
  edgeGeomCount: Uint32Array;
  edgeProfStart: Uint32Array;
  edgeName: Uint32Array;
  adjOffsets: Uint32Array;
  adjEntries: Uint32Array;
  geomX: Int32Array;
  geomZ: Int32Array;
  profile: Uint16Array;
  secEdge: Uint32Array;
  secStart: Uint32Array;
  secEnd: Uint32Array;
  secFlags: Uint32Array;
  nameOffsets: Uint32Array;
  nameBytes: Uint8Array;
}

const CTOR = { i4: Int32Array, u4: Uint32Array, u2: Uint16Array, u1: Uint8Array, f8: Float64Array } as const;

const REQUIRED: (keyof GraphArrays)[] = [
  'nodeX', 'nodeZ', 'nodeFlags', 'edgeFrom', 'edgeTo', 'edgeLength', 'edgeAttrs', 'edgeRoutes',
  'edgeGeomStart', 'edgeGeomCount', 'edgeProfStart', 'edgeName', 'adjOffsets', 'adjEntries',
  'geomX', 'geomZ', 'profile', 'secEdge', 'secStart', 'secEnd', 'secFlags', 'nameOffsets', 'nameBytes',
];

/** Typed-array views onto the buffer (no copies). */
export function parseArrays(meta: GraphMeta, buffer: ArrayBuffer): GraphArrays {
  if (meta.format !== 1) throw new Error(`unsupported graph format ${meta.format}`);
  const out: Partial<Record<keyof GraphArrays, unknown>> = {};
  for (const name of REQUIRED) {
    const entry = meta.sections[name];
    if (!entry) throw new Error(`graph section ${name} missing`);
    const [offset, count, dtype] = entry;
    out[name] = new CTOR[dtype](buffer, offset, count);
  }
  return out as GraphArrays;
}
