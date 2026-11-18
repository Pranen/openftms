export interface Sample {
  /** Seconds since the start of the ride. */
  t: number;
  x: number;
  z: number;
  h: number;
  /** Virtual speed (m/s). */
  v: number;
  distance: number;
  powerW: number;
  cadenceRpm: number | null;
  heartRateBpm: number | null;
}

/** 1 Hz samples of a ride, the source for FIT/TCX export (M6). */
export class Recorder {
  readonly samples: Sample[] = [];
  private nextT = 0;

  /** Offer the current state at simulation time t; keeps one sample per second. */
  offer(s: Sample): void {
    if (s.t + 1e-9 < this.nextT) return;
    this.samples.push(s);
    this.nextT = Math.floor(s.t + 1e-6) + 1;
  }
}
