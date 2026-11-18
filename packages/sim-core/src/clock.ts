/**
 * Fixed-step clock with an accumulator. Any number of triggers (animation
 * frame, trainer telemetry event, fallback interval) call `advanceTo(now)`; the
 * simulation catches up in fixed steps, so the result does not depend on how
 * often or how late it is called (e.g. in a background tab).
 */
export class FixedStepClock {
  private last: number | null = null;
  private acc = 0;
  /** Simulation time in seconds. */
  time = 0;

  constructor(
    /** Step length (s). Default 1/20 s. */
    readonly step = 0.05,
    /** Longer gaps (s) are not simulated (e.g. the laptop slept). */
    readonly maxCatchUp = 120,
  ) {}

  /** Advance to wall time `nowMs` (ms), calling `stepFn(dt)` per fixed step. Returns the number of steps. */
  advanceTo(nowMs: number, stepFn: (dt: number, time: number) => void): number {
    if (this.last === null) {
      this.last = nowMs;
      return 0;
    }
    let dt = (nowMs - this.last) / 1000;
    this.last = nowMs;
    if (dt <= 0) return 0;
    if (dt > this.maxCatchUp) dt = 0; // too long: treat as a pause
    this.acc += dt;
    let n = 0;
    while (this.acc >= this.step - 1e-9) {
      this.acc -= this.step;
      this.time += this.step;
      stepFn(this.step, this.time);
      n++;
    }
    return n;
  }

  /** Fraction of the next step already elapsed (0..1), for render interpolation. */
  get alpha(): number {
    return this.acc / this.step;
  }

  /** Stop accumulating until the next call (pause/resume without a jump). */
  hold(): void {
    this.last = null;
    this.acc = 0;
  }
}
