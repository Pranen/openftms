import { describe, expect, it } from 'vitest';
import { RouteGraph, encodeGraph, SURFACE } from 'route-graph';
import {
  DEFAULT_LINE,
  rightOffset,
  DEFAULT_RIDER,
  FixedStepClock,
  GradeController,
  Recorder,
  Ride,
  airDensity,
  crrForSurface,
  steadySpeed,
  stepSpeed,
} from '../src/index.js';

const kmh = (v: number) => v * 3.6;

describe('physics', () => {
  it('reaches the steady speed on the flat (200 W ≈ 34 km/h)', () => {
    const f = { powerW: 200, grade: 0, crr: 0.004, rho: airDensity(450) };
    let v = 0;
    for (let i = 0; i < 20 * 120; i++) v = stepSpeed(v, f, DEFAULT_RIDER, 0.05);
    expect(kmh(v)).toBeGreaterThan(33);
    expect(kmh(v)).toBeLessThan(36);
    expect(v).toBeCloseTo(steadySpeed(200, 0, 0.004, airDensity(450)), 1);
  });

  it('is slow uphill and rolls downhill without power', () => {
    expect(kmh(steadySpeed(250, 0.08, 0.004, 1.17))).toBeLessThan(14);
    let v = 0;
    const down = { powerW: 0, grade: -0.06, crr: 0.004, rho: 1.17 };
    for (let i = 0; i < 20 * 60; i++) v = stepSpeed(v, down, DEFAULT_RIDER, 0.05);
    expect(kmh(v)).toBeGreaterThan(45);
  });

  it('brakes down to the curve limit', () => {
    let v = 15;
    const f = { powerW: 300, grade: 0, crr: 0.004, rho: 1.17 };
    for (let i = 0; i < 20 * 5; i++) v = stepSpeed(v, f, DEFAULT_RIDER, 0.05, 8);
    expect(v).toBeLessThanOrEqual(8.05);
  });

  it('knows thinner air and rougher surfaces', () => {
    expect(airDensity(1600) / airDensity(0)).toBeCloseTo(0.83, 2);
    expect(crrForSurface(SURFACE.gravel)).toBeGreaterThan(crrForSurface(SURFACE.asphalt));
  });
});

describe('GradeController', () => {
  it('scales, clamps and rate-limits', () => {
    const c = new GradeController();
    expect(c.target(8)).toBe(4);
    expect(c.target(-8)).toBe(-2);
    expect(c.target(40)).toBe(16);
    expect(c.target(-30)).toBe(-5);
    expect(c.update(0, 0)).toBe(0);
    // a step to 10 % true (5 % scaled) arrives at 2 %-points per second
    expect(c.update(1, 10)).toBe(2);
    expect(c.update(2, 10)).toBe(4);
    expect(c.update(3, 10)).toBe(5);
    expect(c.update(4, 10)).toBeNull(); // unchanged: nothing to send
  });

  it('only sends changes of at least 0.1 %', () => {
    const c = new GradeController({ difficulty: 1 });
    c.update(0, 1);
    expect(c.update(10, 1.05)).toBeNull();
    expect(c.update(20, 1.12)).toBe(1.12);
  });
});

describe('FixedStepClock', () => {
  it('gives the same steps for many small and one large advance', () => {
    const a = new FixedStepClock(0.05);
    const b = new FixedStepClock(0.05);
    let na = 0;
    let nb = 0;
    a.advanceTo(0, () => na++);
    b.advanceTo(0, () => nb++);
    for (let t = 16; t <= 10000; t += 16) a.advanceTo(t, () => na++);
    b.advanceTo(10000, () => nb++);
    expect(Math.abs(na - nb)).toBeLessThanOrEqual(1);
    expect(nb).toBe(200);
  });

  it('skips gaps longer than maxCatchUp', () => {
    const c = new FixedStepClock(0.05, 10);
    let n = 0;
    c.advanceTo(0, () => n++);
    c.advanceTo(60_000, () => n++);
    expect(n).toBe(0);
  });
});

// A crossing: 0 -> 1 (west-east, 200 m, 5 % up), at 1: straight to 2, left (north) to 3, right (south) to 4;
// 5 is a dead end south of 4.
function crossing(): RouteGraph {
  const { meta, buffer } = encodeGraph({
    nodes: [
      { x: 0, z: 0 },
      { x: 200, z: 0 },
      { x: 400, z: 0 },
      { x: 200, z: -200 },
      { x: 200, z: 200 },
    ],
    edges: [
      { from: 0, to: 1, height: (s) => 450 + s * 0.05, name: 'Hauptstrasse' },
      { from: 1, to: 2, height: () => 460, name: 'Hauptstrasse' },
      { from: 1, to: 3, height: () => 460, name: 'Nord' },
      { from: 4, to: 1, height: () => 460, name: 'Süd' },
    ],
  });
  return new RouteGraph(meta, buffer);
}

describe('Ride', () => {
  it('offers left/straight/right and defaults to straight', () => {
    const r = new Ride(crossing(), { edge: 0, dir: 1, s: 0 });
    const n = r.upcoming!;
    expect(n.node).toBe(1);
    expect(n.options.map((o) => o.turn)).toEqual(['left', 'straight', 'right']);
    expect(n.options[n.selected]!.name).toBe('Hauptstrasse');
    expect(n.distance).toBeCloseTo(200, 1);
  });

  it('follows the chosen turn and travels edges backwards', () => {
    const g = crossing();
    const r = new Ride(g, { edge: 0, dir: 1, s: 170 });
    expect(r.choose('right')).toBe(true);
    for (let i = 0; i < 500; i++) r.step(0.05, 250);
    expect(r.pos.edge).toBe(3);
    expect(r.pos.dir).toBe(-1); // edge 3 runs 4 -> 1, we ride 1 -> 4
    expect(r.distance).toBeGreaterThan(10);
  });

  it('turns around at a dead end', () => {
    const g = crossing();
    const r = new Ride(g, { edge: 1, dir: 1, s: 180 });
    r.v = 5;
    for (let i = 0; i < 200; i++) r.step(0.05, 150);
    expect(r.pos.edge).toBe(1);
    expect(r.pos.dir).toBe(-1);
  });

  it('measures the grade ahead and the true grade under the rider', () => {
    const r = new Ride(crossing(), { edge: 0, dir: 1, s: 50 });
    expect(r.grade).toBeCloseTo(0.05, 3);
    expect(r.gradeAhead(10, 20)).toBeCloseTo(5, 1);
    // across the junction onto the flat: average drops
    const near = new Ride(crossing(), { edge: 0, dir: 1, s: 190 });
    expect(near.gradeAhead(0, 20)).toBeCloseTo(2.5, 1);
  });

  it('slows down before a right-angle turn', () => {
    const r = new Ride(crossing(), { edge: 0, dir: 1, s: 150 });
    r.choose('left');
    r.v = 14;
    const caps: number[] = [];
    for (let i = 0; i < 20 * 6; i++) {
      r.step(0.05, 400);
      caps.push(r.v);
    }
    // the corner (radius ~ a few metres) is taken at walking-to-jogging pace, not at 50 km/h
    expect(Math.min(...caps)).toBeLessThan(8);
    expect(r.pos.edge).toBe(2);
  });
});

describe('DrivenLine', () => {
  it('keeps right on a two-way road and rounds a right-angle corner', () => {
    const g = crossing(); // residential (half width 2.6 m): ridden 1.6 m right of the centre
    const r = new Ride(g, { edge: 0, dir: 1, s: 100 });
    const p = r.lineAt(0);
    // heading east: right is south (+z)
    expect(p.z).toBeCloseTo(rightOffset(g, 0, DEFAULT_LINE), 1);
    expect(p.tx).toBeCloseTo(1, 3);
    // a left turn at the crossing: the line bends gently (radius of several metres), no kink
    const t = new Ride(g, { edge: 0, dir: 1, s: 150 });
    t.choose('left');
    let maxK = 0;
    for (let d = 0; d < 100; d += 0.5) maxK = Math.max(maxK, Math.abs(t.lineAt(d).k));
    expect(1 / maxK).toBeGreaterThan(4);
    expect(1 / maxK).toBeLessThan(15);
  });

  it('rides round a roundabout anticlockwise on the ring, not through the island', () => {
    // a roundabout node 1 at (200, 0) with radius 12; approach from the west, exit north (a left turn)
    const { meta, buffer } = encodeGraph({
      nodes: [
        { x: 0, z: 0 },
        { x: 200, z: 0 },
        { x: 400, z: 0 },
        { x: 200, z: -200 },
        { x: 200, z: 200 },
      ],
      edges: [
        { from: 0, to: 1, cls: 5 },
        { from: 1, to: 2, cls: 5 },
        { from: 1, to: 3, cls: 5 },
        { from: 1, to: 4, cls: 5 },
      ],
    });
    meta.roundabouts = [[1, 12]];
    const g = new RouteGraph(meta, buffer);
    const r = new Ride(g, { edge: 0, dir: 1, s: 120 });
    expect(r.choose('left')).toBe(true);
    const ring = 12 - 3.5 + 7 * 0.55;
    const angles: number[] = [];
    let minR = Infinity;
    for (let i = 0; i < 20 * 60; i++) {
      r.step(0.05, 200);
      const p = r.lineAt(0);
      const d = Math.hypot(p.x - 200, p.z);
      minR = Math.min(minR, d);
      if (d < ring + 1) angles.push(Math.atan2(p.z, p.x - 200));
      if (r.pos.edge === 2 && r.pos.s > 60) break;
    }
    expect(r.pos.edge).toBe(2); // north: 1 -> 3
    expect(minR).toBeGreaterThan(ring - 1);
    // anticlockwise seen from above with z south: the angle atan2(z, x) decreases
    expect(angles.length).toBeGreaterThan(10);
    let turned = 0;
    for (let k = 1; k < angles.length; k++) turned += Math.atan2(Math.sin(angles[k]! - angles[k - 1]!), Math.cos(angles[k]! - angles[k - 1]!));
    expect(turned).toBeLessThan(-Math.PI); // a left turn goes three quarters round
  });
});

describe('Recorder', () => {
  it('keeps one sample per second', () => {
    const rec = new Recorder();
    for (let i = 0; i < 60; i++) rec.offer({ t: i * 0.05, x: 0, z: 0, h: 0, v: 0, distance: 0, powerW: 0, cadenceRpm: null, heartRateBpm: null });
    expect(rec.samples.length).toBe(3);
  });
});
