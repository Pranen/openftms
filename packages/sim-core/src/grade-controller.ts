export interface GradeControllerOptions {
  /** Trainer difficulty 0..1 (Zwift-like); uphill grades are multiplied by it. Default 0.5. */
  difficulty: number;
  /** Factor on `difficulty` for descents. Default 0.5. */
  descentFactor: number;
  /** Highest grade the trainer can simulate (%). Default 16 (Tacx Flux 2). */
  maxGradePercent: number;
  /** Lowest grade sent (%); the Flux cannot drive the wheel, so less is useless. Default −5. */
  minGradePercent: number;
  /** Rate limit (percentage points per second). Default 2. */
  ratePercentPerS: number;
  /** Minimum change before a new value is sent (%). Default 0.1. */
  minStepPercent: number;
}

export const DEFAULT_GRADE_CONTROLLER: GradeControllerOptions = {
  difficulty: 0.5,
  descentFactor: 0.5,
  maxGradePercent: 16,
  minGradePercent: -5,
  ratePercentPerS: 2,
  minStepPercent: 0.1,
};

/**
 * Turns the true grade ahead into the grade sent to the trainer: scaled by the
 * difficulty, clamped to the trainer's range, rate limited, and only sent when it
 * changed enough. The physics always uses the true grade.
 */
export class GradeController {
  readonly options: GradeControllerOptions;
  private current: number | null = null;
  private lastSent: number | null = null;
  private lastT: number | null = null;

  constructor(options: Partial<GradeControllerOptions> = {}) {
    this.options = { ...DEFAULT_GRADE_CONTROLLER, ...options };
  }

  /** The grade the trainer should feel for a true grade (%), before rate limiting. */
  target(trueGradePercent: number): number {
    const o = this.options;
    const scaled = trueGradePercent >= 0 ? trueGradePercent * o.difficulty : trueGradePercent * o.difficulty * o.descentFactor;
    return Math.min(o.maxGradePercent, Math.max(o.minGradePercent, scaled));
  }

  /** Last value handed out for sending (null before the first). */
  get sent(): number | null {
    return this.lastSent;
  }

  /** Rate-limited value right now (null before the first update). */
  get value(): number | null {
    return this.current;
  }

  /**
   * Feed the true look-ahead grade (%) at time t (s). Returns a grade to send
   * (rounded to 0.01 %), or null when nothing needs to be sent.
   */
  update(t: number, trueGradePercent: number): number | null {
    const target = this.target(trueGradePercent);
    if (this.current === null || this.lastT === null) {
      this.current = target;
    } else {
      const dt = Math.max(0, t - this.lastT);
      const max = this.options.ratePercentPerS * dt;
      this.current += Math.min(max, Math.max(-max, target - this.current));
    }
    this.lastT = t;
    const value = Math.round(this.current * 100) / 100;
    if (this.lastSent === null || Math.abs(value - this.lastSent) >= this.options.minStepPercent - 1e-9) {
      this.lastSent = value;
      return value;
    }
    return null;
  }

  /** Forget the history (e.g. after a reconnect the library restores the last target itself). */
  reset(): void {
    this.current = this.lastSent = this.lastT = null;
  }
}
