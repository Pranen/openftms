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
  /** Near pass (levels L0, L1: up to ~11 km). */
  near: 0.3,
  far: 16000,
  /** Far pass (levels L2–L4), drawn first with its own depth buffer. */
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
  /** Extra lift per road class (bigger roads on top) and the distance over which a road's height
   * bends to the biggest road at a junction (m). */
  roadClassLift: 0.015,
  junctionBlend: 15,
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

/**
 * The cyclist (render/rider.ts). Colours in one place so outfits can be swapped later.
 * Motion: lean = atan(v²·κ/g) with κ the curvature a little ahead, smoothed; standing on steep
 * slow climbs, on the drops when fast, tucked when coasting fast, a foot on the ground when stopped.
 */
export const RIDER = {
  outfit: {
    jersey: 0xd42a2a,
    jerseySide: 0xf2f2f2,
    shorts: 0x1a1a20,
    skin: 0xe2b48c,
    socks: 0xf4f4f4,
    shoes: 0xf0f0f0,
    gloves: 0x26262c,
    helmet: 0xf4f4f4,
    helmetStripe: 0xd42a2a,
    glasses: 0x141418,
  },
  bike: {
    frame: 0x1f4fb4,
    frameAccent: 0xf2f2f2,
    fork: 0x1f4fb4,
    tyre: 0x141414,
    rim: 0x303036,
    decal: 0xf2f2f2,
    metal: 0xb8bcc4,
    bar: 0x202024,
    saddle: 0x18181c,
    bottle: 0x40a0e0,
  },
  /** Seconds to follow lean / steer / pose changes (time constants). */
  leanTau: 0.18,
  steerTau: 0.12,
  poseTau: 0.6,
  maxLean: 0.75,
  /** Look-ahead for the lean (s of travel): riders lean into a curve before it starts. */
  leanLeadS: 0.35,
  /** Standing on climbs steeper than standGrade below standSpeed (m/s); sits again with hysteresis. */
  standGrade: 0.075,
  sitGrade: 0.055,
  standSpeed: 4.5,
  /** Bike rock when standing (rad, peak). */
  rock: 0.13,
  /** Hands on the drops from this speed (m/s), tuck when coasting faster than tuckSpeed. */
  dropsSpeed: 11,
  tuckSpeed: 13,
  /** Below this speed (m/s) for stopDelay s: foot on the ground. */
  stopSpeed: 0.3,
  stopDelay: 0.6,
  /** Depth bias of the rider (above roads 2 and markings 4) and clearance above the drawn surface (m). */
  depthBias: 6,
  clearance: 0.02,
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
  /** Beyond the minimum gap, markings also stop this far after leaving the band of a road of the
   * same or a bigger class at the junction (checked up to maxJunctionGap). */
  junctionMargin: 2,
  maxJunctionGap: 60,
  /** One-way pieces shorter than this (split approaches at islands) get no markings. */
  minOnewayLength: 80,
  lift: 0.03,
};

/** Kerb radii filled with asphalt between neighbouring roads at junctions (m, rad). */
export const JUNCTION = {
  kerbRadius: 6,
  pathKerbRadius: 2.5,
  maxLeg: 15,
  minAngle: 0.35,
  maxAngle: 2.8,
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
  /** Buildings reaching further than this into a road band (m from its edge, inwards) are left out. */
  roadTolerance: 0.3,
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

/**
 * Tile streaming (PLAN.md, Höhenpyramide): per level the 3 × 3 tiles around the camera's
 * tile are wanted (`want`: max distance of the tile centre in tile sizes, Chebyshev), kept
 * until `keep` (hysteresis), L4 always. Coarse tiles are split into chunks matching the next
 * finer level, hidden where that level is loaded.
 */
export const STREAM = {
  want: 1.5,
  keep: 1.9,
  /** Chunks per tile side: L1–L3 have 2 × 2 children, L4 has 4 × 4 L3 tiles. */
  chunks: [1, 2, 2, 2, 4] as readonly number[],
  /** Skirt depth per level (m): covers cracks to coarser neighbours (Copernicus vs swissALTI3D). */
  skirt: [12, 40, 80, 150, 300] as readonly number[],
  /** Every step-th node per level: L2/L3 lie beyond 4–8 km, half resolution is plenty there (GPU memory). */
  step: [1, 1, 2, 2, 1] as readonly number[],
  /** Levels drawn in the near pass; the others go to the far pass. */
  nearLevels: 2,
  /** Tiles decoded at the same time. */
  parallel: 3,
  /** How often the wanted set is recomputed (ms). */
  intervalMs: 250,
};
