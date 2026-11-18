/** All tuning values of the app (PLAN.md: no magic numbers elsewhere). */

export const RENDER = {
  /** Internal render height (px); width follows the aspect ratio. */
  internalHeight: 240,
  /** Colour levels per channel (32 = 15-bit colour like the PS1). */
  colorLevels: 32,
  dither: true,
  /** Vertex snapping grid as a fraction of the internal resolution (0.5 = half resolution, subtle); 0 = off. */
  vertexSnap: 0.5,
  fovDeg: 60,
  /** Near pass (L0 world). */
  near: 0.3,
  far: 9000,
  /** Far pass (panorama levels), drawn first with its own depth buffer. */
  farPassNear: 300,
  farPassFar: 130000,
  /** Haze shared by both passes (distance in m where it starts / is complete). */
  hazeNear: 5000,
  hazeFar: 95000,
  /** Earth curvature with refraction (apparent drop d²/2R·(1−k)), applied to the panorama. */
  earthRadius: 6371000,
  refraction: 0.13,
  sky: { horizon: 0xb3c8dc, zenith: 0x3d6ea8 },
  sunDirection: [-0.5, 0.8, 0.35] as const,
  /** Trees are drawn up to this distance (m); beyond, the forest colour of the ground carries it. */
  treeDistance: 4000,
  /** Road band height above the carved terrain (m). */
  roadLift: 0.08,
};

export const CAMERA = {
  /** Chase camera: distance behind and height above the rider (m). */
  behind: 6.5,
  height: 2.4,
  /** Point the camera looks at, ahead along the path (m), and its height. */
  lookAhead: 14,
  lookHeight: 1.1,
  /** How far behind the rider the camera sits on the path (it follows the road, not the rider's heading). */
  smoothing: 4,
};

export const SIM = {
  /** Physics step (s). */
  step: 1 / 20,
  /** Fallback trigger when no frames and no telemetry arrive (ms). */
  fallbackIntervalMs: 250,
  /** Power is held between trainer packets; after this long without one it drops to 0 (ms). */
  powerTimeoutMs: 3000,
  /** Grade look-ahead: latency (s) and averaging window (m). */
  gradeLatencyS: 1.2,
  gradeWindowM: 20,
  /** Auto pause below this speed with no power (km/h) for autoPauseS seconds. */
  autoPauseKmh: 1,
  autoPauseS: 3,
};

export const TRAINER = {
  difficulty: 0.5,
  descentFactor: 0.5,
  maxGradePercent: 16,
  minGradePercent: -5,
  ratePercentPerS: 2,
  minStepPercent: 0.1,
};

/** Land cover palette (sRGB), index = CODE value from the pipeline (tools/world-pipeline tiles.py). */
export const LANDCOVER = [
  [0x86ad55, 0x7ea34e], // meadow
  [0x2f5a2c, 0x376331], // forest
  [0x93a24e, 0x8a9a48], // orchard / vineyard
  [0x9c9a86, 0x8f8d7a], // settlement
  [0x8a8478, 0x7a756b], // rock
  [0x3f6f9e, 0x3a6896], // water
  [0xe2e8f0, 0xd6dee8], // glacier
  [0xa3b25c, 0x98a853], // farmland
] as const;

export const ROAD_COLOR: Record<number, number> = {
  0: 0x7a7a80, // cycleway
  1: 0xa39276, // path
  2: 0xa89a78, // track
};
/**
 * Road markings (after Swiss practice, simplified): dashed centre line on two-way roads from
 * `centreFromClass` up, solid edge lines from `edgeFromClass` up, yellow dashed cycle lanes.
 * Lengths in m; markings stop `junctionGap` short of a junction.
 */
export const MARKING = {
  white: 0xe8e8e0,
  yellow: 0xe0c040,
  width: 0.15,
  centreFromClass: 5,
  edgeFromClass: 6,
  edgeInset: 0.35,
  dash: 3,
  gap: 6,
  laneDash: 1.5,
  laneGap: 1.5,
  laneWidth: 1.5,
  junctionGap: 8,
  /** One-way pieces shorter than this (split approaches at islands) get no markings. */
  minOnewayLength: 80,
  lift: 0.03,
};

/** Roundabout drawing (the graph has one node per roundabout, with its radius). */
export const ROUNDABOUT = {
  lane: 7,
  minIsland: 3,
  island: 0x6f9a48,
  /** Above all road bands (the approaches end under the ring), island above the ring. */
  lift: 0.2,
  islandLift: 0.45,
  segments: 24,
};

export const ROAD_COLOR_DEFAULT = 0x66666c;
export const GRAVEL_COLOR = 0xa89a78;

export const BUILDING = {
  walls: [0xe9e1cf, 0xf2efe6, 0xd9c7a3, 0xcfb894, 0xe0d6c0, 0xd8d2c4, 0xc9b79a, 0xefe6d2],
  roofs: [0x8c3b2e, 0x6e2f27, 0x5a5550, 0x7a4a32, 0x8a4434, 0x4e4a48, 0x9a5a3a, 0x6a3a2c],
  flatRoof: 0x77736c,
  overhang: 0.35,
};

/**
 * Trees, scattered deterministically per land cover code (PLAN.md, Kachelformat: the client
 * plants them from CODE and a seed). spacing: candidate grid (m), density: share of candidates
 * planted, conifer: share of conifers (rises with height), clear: gap to road edges and houses (m).
 */
export const TREES = {
  forest: { spacing: 7, density: 0.8 },
  orchard: { spacing: 11, density: 0.75 },
  meadow: { spacing: 24, density: 0.06 },
  settlement: { spacing: 18, density: 0.12 },
  coniferLow: 0.35,
  coniferHigh: 0.9,
  coniferFrom: 600,
  coniferTo: 1300,
  clearRoad: 2.5,
  clearHouse: 2,
  /** Height range (m) of a conifer and a broadleaf tree; widths follow the shape. */
  coniferHeight: [14, 26] as const,
  broadleafHeight: [8, 17] as const,
  orchardHeight: [5, 8] as const,
  /** Chunk size for culling and the distance switch (m). */
  chunk: 500,
  colours: {
    trunk: 0x5a4330,
    conifer: [0x1f4424, 0x2a5530],
    broadleaf: [0x3d6b2c, 0x52803a],
    orchard: [0x5a8a3a, 0x6e9a44],
  },
};
