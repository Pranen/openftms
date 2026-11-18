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
  near: 0.3,
  far: 9000,
  /** Detail fog (distance in m where it starts / is complete). */
  fogNear: 1200,
  fogFar: 4200,
  sky: { horizon: 0xb3c8dc, zenith: 0x3d6ea8 },
  sunDirection: [-0.5, 0.8, 0.35] as const,
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
export const ROAD_COLOR_DEFAULT = 0x66666c;
export const GRAVEL_COLOR = 0xa89a78;

export const BUILDING = {
  walls: [0xe9e1cf, 0xf2efe6, 0xd9c7a3, 0xcfb894, 0xe0d6c0, 0xd8d2c4, 0xc9b79a, 0xefe6d2],
  roofs: [0x8c3b2e, 0x6e2f27, 0x5a5550, 0x7a4a32, 0x8a4434, 0x4e4a48, 0x9a5a3a, 0x6a3a2c],
  flatRoof: 0x77736c,
  overhang: 0.35,
};
