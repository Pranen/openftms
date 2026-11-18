import { SURFACE } from 'route-graph';

export const G = 9.81;

export interface RiderParams {
  /** Rider + bike (kg). */
  massKg: number;
  /** Drag area (m²). */
  cda: number;
  /** Extra inertia of the wheels as mass (kg). */
  wheelInertiaKg: number;
  /** Lateral acceleration the virtual rider accepts in curves (m/s²). */
  maxLateralAccel: number;
  /** Deceleration of the virtual rider's brakes (m/s²). */
  brakeDecel: number;
}

export const DEFAULT_RIDER: RiderParams = {
  massKg: 83,
  cda: 0.32,
  wheelInertiaKg: 1,
  maxLateralAccel: 4,
  brakeDecel: 3,
};

/** Rolling resistance per surface (route-graph SURFACE codes). */
export function crrForSurface(surface: number): number {
  switch (surface) {
    case SURFACE.asphalt:
      return 0.004;
    case SURFACE.concrete:
      return 0.0045;
    case SURFACE.paving:
      return 0.006;
    case SURFACE.fineGravel:
      return 0.008;
    case SURFACE.gravel:
      return 0.012;
    case SURFACE.unpaved:
      return 0.014;
    default:
      return 0.008;
  }
}

/** Air density at height h (m), barometric approximation. */
export function airDensity(h: number): number {
  return 1.225 * Math.exp(-h / 8400);
}

export interface Forces {
  powerW: number;
  /** Grade as a fraction (rise / run). */
  grade: number;
  crr: number;
  rho: number;
}

/**
 * One integration step of the longitudinal model
 *   m·dv/dt = P/max(v, 1) − m·g·(sin θ + crr·cos θ) − ½·ρ·CdA·v²
 * Returns the new speed (m/s, never negative). `vCap` (curves ahead) is enforced
 * with the virtual brakes.
 */
export function stepSpeed(v: number, f: Forces, rider: RiderParams, dt: number, vCap = Infinity): number {
  const theta = Math.atan(f.grade);
  const m = rider.massKg;
  const drive = f.powerW > 0 ? f.powerW / Math.max(v, 1) : 0;
  const gravity = m * G * Math.sin(theta);
  const rolling = v > 0.05 || drive > m * G * f.crr ? m * G * f.crr * Math.cos(theta) : 0;
  const air = 0.5 * f.rho * rider.cda * v * v;
  let a = (drive - gravity - rolling - air) / (m + rider.wheelInertiaKg);
  if (v > vCap) a = Math.min(a, -rider.brakeDecel);
  let next = v + a * dt;
  if (v > vCap && next < vCap) next = vCap;
  return Math.max(0, next);
}

/** Speed on the flat at which the power just balances the resistances (for tests and estimates). */
export function steadySpeed(powerW: number, grade: number, crr: number, rho: number, rider: RiderParams = DEFAULT_RIDER): number {
  let lo = 0;
  let hi = 40;
  for (let i = 0; i < 60; i++) {
    const v = (lo + hi) / 2;
    const theta = Math.atan(grade);
    const need = (rider.massKg * G * (Math.sin(theta) + crr * Math.cos(theta)) + 0.5 * rho * rider.cda * v * v) * v;
    if (need > powerW) hi = v;
    else lo = v;
  }
  return (lo + hi) / 2;
}
