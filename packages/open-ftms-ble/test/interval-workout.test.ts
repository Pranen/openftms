import { afterEach, describe, expect, it } from 'vitest';
import { FtmsTrainer, MockTransport, SimulatedTrainer } from '../src/index.js';
import { IntervalWorkout, intervalSession } from '../examples/interval-workout.js';

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

async function setup(cadenceRpm = 90) {
  const sim = new SimulatedTrainer({ intervalMs: 10, latencyMs: 1, cadenceRpm });
  const trainer = new FtmsTrainer({ transport: new MockTransport([sim.peripheral]), commandTimeoutMs: 200 });
  cleanups.push(() => trainer.disconnect());
  await trainer.connect();
  await expect.poll(() => trainer.telemetry.cadenceRpm).toBeDefined();
  return { sim, trainer };
}

describe('How-To: interval workout example', () => {
  it('builds a classic interval session from FTP', () => {
    const steps = intervalSession({ ftpW: 200, repeats: 3, workS: 60, restS: 30, warmupS: 300, cooldownS: 120 });
    expect(steps.map((s) => s.name)).toEqual([
      'Einfahren',
      'Intervall 1/3',
      'Pause 1/2',
      'Intervall 2/3',
      'Pause 2/2',
      'Intervall 3/3',
      'Ausfahren',
    ]);
    expect(steps[1]).toMatchObject({ durationS: 60, powerW: 220 });
    expect(steps[2]).toMatchObject({ durationS: 30, powerW: 100 });
    expect(steps[0]).toMatchObject({ powerW: 90, rampToW: 140 });
  });

  it('runs the steps in ERG and finishes', async () => {
    const { sim, trainer } = await setup();
    const steps = intervalSession({ ftpW: 200, repeats: 2, workS: 2, restS: 2 });
    const workout = new IntervalWorkout(trainer, steps, { tickMs: 10, speed: 20 });
    cleanups.push(() => workout.stop());
    const seenSteps: string[] = [];
    const targets = new Set<number>();
    workout.on('step', (p) => seenSteps.push(p.step.name));
    workout.on('progress', () => {
      if (sim.mode.kind === 'erg') targets.add(sim.mode.targetPowerW);
    });
    const finished = new Promise<{ completed: boolean }>((resolve) => workout.once('finished', resolve));
    workout.start();
    await expect(finished).resolves.toEqual({ completed: true });
    expect(seenSteps).toEqual(['Intervall 1/2', 'Pause 1/1', 'Intervall 2/2']);
    expect(targets).toEqual(new Set([220, 100]));
  });

  it('pauses the clock while the rider does not pedal', async () => {
    const { sim, trainer } = await setup(0);
    await expect.poll(() => trainer.telemetry.cadenceRpm).toBe(0);
    const workout = new IntervalWorkout(trainer, [{ name: 'A', durationS: 1, powerW: 150 }], { tickMs: 10, speed: 10 });
    cleanups.push(() => workout.stop());
    const pauses: boolean[] = [];
    workout.on('autoPause', (e) => pauses.push(e.paused));
    let last = 0;
    workout.on('progress', (p) => (last = p.totalElapsedS));
    workout.start();
    await new Promise((r) => setTimeout(r, 80));
    expect(pauses).toEqual([true]);
    expect(last).toBe(0);

    sim.cadenceRpm = 90;
    const finished = new Promise((resolve) => workout.once('finished', resolve));
    await expect(finished).resolves.toEqual({ completed: true });
    expect(pauses).toEqual([true, false]);
  });
});
