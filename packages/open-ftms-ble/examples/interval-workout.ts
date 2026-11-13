/**
 * A small interval-training runner on top of FtmsTrainer (ERG mode).
 *
 * This file is the code of docs/howto-interval-training.md. It is
 * type-checked and tested (test/interval-workout.test.ts) and used by the demo.
 */
import { FtmsTrainer, TypedEmitter } from 'open-ftms-ble';

/** One block of the workout. With `rampToW` the target moves linearly from `powerW`. */
export interface WorkoutStep {
  readonly name: string;
  readonly durationS: number;
  readonly powerW: number;
  readonly rampToW?: number;
}

/** Classic interval session: warm-up ramp, N × (work + rest), cool-down ramp. */
export function intervalSession(options: {
  ftpW: number;
  repeats: number;
  workS: number;
  restS: number;
  workPercent?: number;
  restPercent?: number;
  warmupS?: number;
  cooldownS?: number;
}): WorkoutStep[] {
  const { ftpW, repeats, workS, restS } = options;
  const watts = (percent: number) => Math.round((ftpW * percent) / 100 / 5) * 5;
  const steps: WorkoutStep[] = [];
  if (options.warmupS) {
    steps.push({ name: 'Einfahren', durationS: options.warmupS, powerW: watts(45), rampToW: watts(70) });
  }
  for (let i = 1; i <= repeats; i++) {
    steps.push({ name: `Intervall ${i}/${repeats}`, durationS: workS, powerW: watts(options.workPercent ?? 110) });
    if (i < repeats) steps.push({ name: `Pause ${i}/${repeats - 1}`, durationS: restS, powerW: watts(options.restPercent ?? 50) });
  }
  if (options.cooldownS) {
    steps.push({ name: 'Ausfahren', durationS: options.cooldownS, powerW: watts(60), rampToW: watts(40) });
  }
  return steps;
}

export interface WorkoutProgress {
  readonly stepIndex: number;
  readonly step: WorkoutStep;
  /** Seconds into the current step / remaining in it. */
  readonly stepElapsedS: number;
  readonly stepRemainingS: number;
  readonly totalElapsedS: number;
  readonly totalDurationS: number;
  readonly targetW: number;
  readonly paused: boolean;
}

export interface WorkoutEvents {
  /** Every tick (default once per second). */
  progress: WorkoutProgress;
  /** A new step began. */
  step: WorkoutProgress;
  /** The rider stopped pedalling (auto-pause) or pedals again (resume). */
  autoPause: { paused: boolean };
  finished: { completed: boolean };
  /** A target could not be sent; the workout keeps running and retries. */
  error: unknown;
}

export interface WorkoutOptions {
  /** Tick interval in ms. Default 1000. */
  tickMs?: number;
  /** Time-lapse factor, e.g. 60 = one minute per second. Default 1. */
  speed?: number;
  /** Pause the clock below this cadence (rpm); 0 disables. Default 20. */
  autoPauseBelowRpm?: number;
  /** Targets are rounded to this step to avoid sending every watt of a ramp. Default 5 W. */
  roundToW?: number;
}

export class IntervalWorkout extends TypedEmitter<WorkoutEvents> {
  readonly steps: readonly WorkoutStep[];
  readonly totalDurationS: number;
  readonly #trainer: FtmsTrainer;
  readonly #tickMs: number;
  readonly #speed: number;
  readonly #autoPauseBelowRpm: number;
  readonly #roundToW: number;

  #timer: ReturnType<typeof setInterval> | undefined;
  #elapsedS = 0;
  #lastTick = 0;
  #stepIndex = -1;
  #sentW: number | undefined;
  #paused = false;
  #autoPaused = false;

  constructor(trainer: FtmsTrainer, steps: readonly WorkoutStep[], options: WorkoutOptions = {}) {
    super();
    if (steps.length === 0) throw new Error('A workout needs at least one step');
    this.#trainer = trainer;
    this.steps = steps;
    this.totalDurationS = steps.reduce((sum, s) => sum + s.durationS, 0);
    this.#tickMs = options.tickMs ?? 1000;
    this.#speed = options.speed ?? 1;
    this.#autoPauseBelowRpm = options.autoPauseBelowRpm ?? 20;
    this.#roundToW = options.roundToW ?? 5;
  }

  get running(): boolean {
    return this.#timer !== undefined;
  }

  start(): void {
    if (this.running) return;
    this.#lastTick = Date.now();
    this.#timer = setInterval(() => this.#tick(), this.#tickMs);
    this.#tick();
  }

  /** Manual pause: the clock stops, the trainer keeps the last target. */
  pause(): void {
    this.#paused = true;
  }

  resume(): void {
    this.#paused = false;
  }

  /** Stops early. The trainer stays in ERG at the last target — set a new mode if needed. */
  stop(): void {
    this.#finish(false);
  }

  #tick(): void {
    const now = Date.now();
    const deltaS = ((now - this.#lastTick) / 1000) * this.#speed;
    this.#lastTick = now;

    // Auto-pause: no point in counting down an interval while the rider is not pedalling.
    const cadence = this.#trainer.telemetry.cadenceRpm;
    if (this.#autoPauseBelowRpm > 0 && cadence !== undefined) {
      const shouldPause = cadence < this.#autoPauseBelowRpm;
      if (shouldPause !== this.#autoPaused) {
        this.#autoPaused = shouldPause;
        this.emit('autoPause', { paused: shouldPause });
      }
    }
    const paused = this.#paused || this.#autoPaused;
    if (!paused && this.#stepIndex >= 0) this.#elapsedS += deltaS;

    if (this.#elapsedS >= this.totalDurationS) {
      this.#finish(true);
      return;
    }

    const progress = this.#progressAt(this.#elapsedS, paused);
    if (progress.stepIndex !== this.#stepIndex) {
      this.#stepIndex = progress.stepIndex;
      this.emit('step', progress);
    }
    this.#send(progress.targetW);
    this.emit('progress', progress);
  }

  #progressAt(elapsedS: number, paused: boolean): WorkoutProgress {
    let stepStart = 0;
    let stepIndex = 0;
    while (stepIndex < this.steps.length - 1 && elapsedS >= stepStart + this.steps[stepIndex]!.durationS) {
      stepStart += this.steps[stepIndex]!.durationS;
      stepIndex++;
    }
    const step = this.steps[stepIndex]!;
    const stepElapsedS = elapsedS - stepStart;
    const fraction = step.durationS > 0 ? Math.min(1, stepElapsedS / step.durationS) : 1;
    const raw = step.rampToW === undefined ? step.powerW : step.powerW + (step.rampToW - step.powerW) * fraction;
    return {
      stepIndex,
      step,
      stepElapsedS,
      stepRemainingS: Math.max(0, step.durationS - stepElapsedS),
      totalElapsedS: elapsedS,
      totalDurationS: this.totalDurationS,
      targetW: Math.round(raw / this.#roundToW) * this.#roundToW,
      paused,
    };
  }

  #send(targetW: number): void {
    // Only send changes. The library coalesces bursts, requests control when
    // needed and restores the target after a reconnect, so this stays simple.
    if (targetW === this.#sentW || !this.#trainer.isReady) return;
    this.#sentW = targetW;
    this.#trainer.setTargetPower(targetW).catch((error: unknown) => {
      this.#sentW = undefined; // retry on the next tick
      this.emit('error', error);
    });
  }

  #finish(completed: boolean): void {
    if (this.#timer === undefined) return;
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.emit('finished', { completed });
  }
}
