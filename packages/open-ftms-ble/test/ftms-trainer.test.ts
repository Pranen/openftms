import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ConnectionError,
  FtmsTrainer,
  HeartRateMonitor,
  MockTransport,
  NotConnectedError,
  SimulatedHeartRateMonitor,
  SimulatedTrainer,
  type ConnectionState,
  type FtmsTrainerOptions,
} from '../src/index.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

function create(options: FtmsTrainerOptions = {}, simOptions: ConstructorParameters<typeof SimulatedTrainer>[0] = {}) {
  const sim = new SimulatedTrainer({ intervalMs: 10, latencyMs: 1, ...simOptions });
  const trainer = new FtmsTrainer({
    transport: new MockTransport([sim.peripheral]),
    connectRetryDelayMs: 5,
    commandTimeoutMs: 200,
    controlRetryIntervalMs: 30,
    reconnect: { initialDelayMs: 10, maxDelayMs: 20, maxAttempts: 3 },
    ...options,
  });
  const states: ConnectionState[] = [];
  trainer.on('connectionStateChange', (e) => states.push(e.state));
  cleanups.push(() => trainer.disconnect());
  return { sim, trainer, states };
}

describe('FtmsTrainer', () => {
  it('connects, reads capabilities and requests control', async () => {
    const { trainer, sim, states } = create();
    await trainer.connect();
    expect(states).toEqual(['connecting', 'discovering', 'ready']);
    expect(trainer.control).toBe('granted');
    expect(sim.controlGranted).toBe(true);
    const caps = trainer.capabilities;
    expect(caps?.features?.targetSetting.powerTarget).toBe(true);
    expect(caps?.features?.targetSetting.speedTarget).toBe(false);
    expect(caps?.powerRange).toMatchObject({ minimum: 0, maximum: 2000 });
    expect(caps?.deviceInformation.modelNumber).toBe('Simulator');
    expect(caps?.hasCyclingPowerService).toBe(false);
  });

  it('emits telemetry from Indoor Bike Data', async () => {
    const { trainer } = create();
    await trainer.connect();
    await vi.waitFor(() => expect(trainer.telemetry.cadenceRpm).toBeGreaterThan(0));
    expect(trainer.telemetry.speedKmh).toBeGreaterThan(0);
    expect(trainer.telemetry.updatedAt).toBeDefined();
  });

  it('sets ERG target power and follows it', async () => {
    const { trainer, sim } = create();
    await trainer.connect();
    const statuses: string[] = [];
    trainer.on('machineStatus', (s) => statuses.push(s.type));
    await trainer.setTargetPower(250);
    expect(trainer.mode).toEqual({ kind: 'erg', targetPowerW: 250 });
    expect(sim.mode).toEqual({ kind: 'erg', targetPowerW: 250 });
    await vi.waitFor(() => expect(statuses).toContain('targetPowerChanged'));
  });

  it('clamps ERG targets to the supported power range', async () => {
    const { trainer } = create();
    await trainer.connect();
    await trainer.setTargetPower(5000);
    expect(trainer.mode).toEqual({ kind: 'erg', targetPowerW: 2000 });
  });

  it('merges simulation parameters', async () => {
    const { trainer, sim } = create();
    await trainer.connect();
    await trainer.setSimulation({ gradePercent: 5, windSpeedMps: 2 });
    await trainer.setSimulation({ gradePercent: -1 });
    expect(sim.mode).toEqual({
      kind: 'simulation',
      parameters: { windSpeedMps: 2, gradePercent: -1, crr: 0.004, cw: 0.51 },
    });
  });

  it('coalesces slider bursts', async () => {
    const { trainer, sim } = create();
    await trainer.connect();
    const cp = sim.peripheral.characteristic(0x1826, 0x2ad9);
    const before = cp.writes.length;
    await Promise.all([100, 120, 140, 160, 180, 200].map((w) => trainer.setTargetPower(w)));
    expect(cp.writes.length - before).toBe(2);
    expect(sim.mode).toEqual({ kind: 'erg', targetPowerW: 200 });
    expect(trainer.mode).toEqual({ kind: 'erg', targetPowerW: 200 });
  });

  it('rejects commands when not connected', async () => {
    const { trainer } = create();
    await expect(trainer.setTargetPower(100)).rejects.toBeInstanceOf(NotConnectedError);
  });

  it('degrades to data-only when another app holds control, and retries', async () => {
    const { trainer, sim } = create();
    sim.controlHeldByOtherApp = true;
    const controlStates: string[] = [];
    trainer.on('controlStateChange', (e) => controlStates.push(e.state));
    await trainer.connect();
    expect(trainer.connectionState).toBe('ready');
    expect(controlStates.slice(0, 2)).toEqual(['requesting', 'blocked']);
    expect(trainer.control).not.toBe('granted');
    await vi.waitFor(() => expect(trainer.telemetry.powerW).toBeDefined());
    sim.controlHeldByOtherApp = false;
    await vi.waitFor(() => expect(trainer.control).toBe('granted'));
  });

  it('re-acquires control after Machine Status "control permission lost"', async () => {
    const { trainer, sim } = create();
    await trainer.connect();
    await trainer.setTargetPower(180);
    const controlStates: string[] = [];
    trainer.on('controlStateChange', (e) => controlStates.push(e.state));
    sim.simulateControlLoss();
    await vi.waitFor(() => expect(controlStates).toEqual(['none', 'requesting', 'granted']));
    expect(sim.controlGranted).toBe(true);
  });

  it('reconnects after link loss and restores the ERG target', async () => {
    const { trainer, sim, states } = create();
    await trainer.connect();
    await trainer.setTargetPower(220);
    states.length = 0;
    sim.simulateConnectionLoss();
    expect(trainer.connectionState).toBe('reconnecting');
    expect(trainer.control).toBe('none');
    expect(sim.mode).toEqual({ kind: 'none' });
    await vi.waitFor(() => expect(trainer.connectionState).toBe('ready'));
    // 'ready' comes first (data flows), then control and the restored target.
    await vi.waitFor(() => expect(sim.mode).toEqual({ kind: 'erg', targetPowerW: 220 }));
    expect(states).toEqual(['reconnecting', 'discovering', 'ready']);
    expect(trainer.control).toBe('granted');
    // Exactly one listener per characteristic after resubscribing.
    const before = trainer.telemetry.updatedAt ?? 0;
    await vi.waitFor(() => expect(trainer.telemetry.updatedAt ?? 0).toBeGreaterThan(before));
  });

  it('gives up after maxAttempts', async () => {
    const { trainer, sim } = create();
    await trainer.connect();
    const errors: string[] = [];
    trainer.on('error', (e) => errors.push(e.message));
    sim.peripheral.failConnectTimes = 1000;
    sim.simulateConnectionLoss();
    await vi.waitFor(() => expect(trainer.connectionState).toBe('disconnected'), { timeout: 3000 });
    expect(errors.some((m) => m.includes('Reconnect failed after 3 attempts'))).toBe(true);
  });

  it('does not reconnect after a user disconnect', async () => {
    const { trainer, sim, states } = create();
    await trainer.connect();
    await trainer.disconnect();
    expect(trainer.connectionState).toBe('disconnected');
    expect(sim.peripheral.connected).toBe(false);
    await new Promise((r) => setTimeout(r, 50));
    expect(states.at(-1)).toBe('disconnected');
  });

  it('retries a failing first connect', async () => {
    const { trainer, sim } = create({}, { failConnectTimes: 1 });
    await trainer.connect();
    expect(sim.peripheral.connectAttempts).toBe(2);
    expect(trainer.isReady).toBe(true);
  });

  it('fails connect after exhausting retries', async () => {
    const { trainer } = create({ connectRetries: 1 }, { failConnectTimes: 5 });
    await expect(trainer.connect()).rejects.toBeInstanceOf(ConnectionError);
    expect(trainer.connectionState).toBe('disconnected');
  });

  it('emits raw packets in both directions', async () => {
    const { trainer } = create();
    const raw: string[] = [];
    trainer.on('raw', (p) => raw.push(`${p.direction} ${p.characteristic} ${p.hex}`));
    await trainer.connect();
    await trainer.setTargetPower(200);
    expect(raw).toContain('out fitnessMachineControlPoint 05 c8 00');
    expect(raw).toContain('in fitnessMachineControlPoint 80 05 01');
  });

  it('start / pause / stop / reset', async () => {
    const { trainer, sim } = create();
    await trainer.connect();
    await trainer.setTargetPower(150);
    await trainer.start();
    await trainer.pause();
    await trainer.stop();
    await trainer.reset();
    expect(trainer.mode).toEqual({ kind: 'none' });
    expect(sim.mode).toEqual({ kind: 'none' });
    await vi.waitFor(() => expect(trainer.control).toBe('granted'));
  });
  it('retries connect and discovery when the link drops during setup', async () => {
    const { trainer, sim, states } = create({}, { latencyMs: 5 });
    let first = true;
    sim.peripheral.onConnected(() => {
      if (!first) return;
      first = false;
      setTimeout(() => sim.peripheral.simulateConnectionLoss(), 2); // during service discovery
    });
    const errors: string[] = [];
    trainer.on('error', (e) => errors.push(e.message));
    await trainer.connect();
    expect(trainer.connectionState).toBe('ready');
    expect(states.slice(0, 4)).toEqual(['connecting', 'discovering', 'connecting', 'discovering']);
    expect(errors.some((m) => m.includes('retrying'))).toBe(true);
    await expect.poll(() => trainer.control).toBe('granted');
  });

  it('is ready before ranges and device information are read, and reuses them on reconnect', async () => {
    const { trainer, sim } = create();
    const order: string[] = [];
    const complete: boolean[] = [];
    trainer.on('connectionStateChange', (e) => e.state === 'ready' && order.push('ready'));
    trainer.on('gattOperation', (t) => t.label.startsWith('read ') && order.push(t.label));
    trainer.on('capabilities', (c) => complete.push(c.complete));
    await trainer.connect();
    expect(order.indexOf('ready')).toBeGreaterThan(order.indexOf('read fitnessMachineFeature'));
    expect(order.indexOf('ready')).toBeLessThan(order.indexOf('read supportedPowerRange'));
    expect(order.indexOf('ready')).toBeLessThan(order.indexOf('read manufacturerName'));
    expect(complete).toEqual([false, true]);
    expect(trainer.capabilities?.powerRange?.maximum).toBe(2000);
    expect(trainer.capabilities?.deviceInformation.manufacturerName).toBe('open-ftms');

    order.length = 0;
    sim.simulateConnectionLoss();
    await expect.poll(() => trainer.connectionState).toBe('ready');
    await expect.poll(() => trainer.control).toBe('granted');
    expect(order).not.toContain('read manufacturerName');
    expect(order).not.toContain('read supportedPowerRange');
    expect(trainer.capabilities?.complete).toBe(true);
    expect(trainer.capabilities?.powerRange?.maximum).toBe(2000);
  });

  it('connects to a known device without the chooser', async () => {
    const { trainer, sim } = create();
    await expect(trainer.connectKnown('unknown-id')).resolves.toBe(false);
    expect(trainer.connectionState).toBe('disconnected');

    sim.peripheral.advertising = false;
    await expect(trainer.connectKnown(sim.peripheral.id, { advertisementTimeoutMs: 10 })).rejects.toBeInstanceOf(
      ConnectionError,
    );

    sim.peripheral.advertising = true;
    await expect(trainer.connectKnown(sim.peripheral.id)).resolves.toBe(true);
    expect(trainer.connectionState).toBe('ready');
  });

  it('reports the resistance level in the unit of setResistanceLevel', async () => {
    const { trainer } = create();
    await trainer.connect();
    await trainer.setResistanceLevel(18.6);
    await expect.poll(() => trainer.telemetry.resistanceLevel).toBe(18.6);
  });

  it('honours an explicit resistanceLevelScale', async () => {
    const { trainer } = create({ resistanceLevelScale: 1 });
    const raw: number[] = [];
    trainer.on('indoorBikeData', (d) => d.resistanceLevel !== undefined && raw.push(d.resistanceLevel));
    await trainer.connect();
    await trainer.setResistanceLevel(18.6);
    await expect.poll(() => trainer.telemetry.resistanceLevel).toBe(186);
    expect(raw).toContain(186);
  });
});

describe('HeartRateMonitor', () => {
  it('connects and reports heart rate', async () => {
    const sim = new SimulatedHeartRateMonitor({ intervalMs: 10, latencyMs: 1 });
    const hrm = new HeartRateMonitor({ transport: new MockTransport([sim.peripheral]) });
    cleanups.push(() => hrm.disconnect());
    await hrm.connect();
    await vi.waitFor(() => expect(hrm.heartRateBpm).toBeGreaterThan(30));
    expect(hrm.snapshot.sensorContact).toBe('detected');
    expect(hrm.snapshot.bodySensorLocation).toBe('chest');
    expect(hrm.snapshot.rrIntervalsMs?.length).toBe(1);
  });
});
