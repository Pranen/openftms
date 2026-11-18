import {
  FtmsTrainer,
  MockTransport,
  SimulatedTrainer,
  WebBluetoothTransport,
  type ConnectionState,
} from 'open-ftms-ble';
import { SIM } from '../config';

/** Where the power comes from, and where the grade goes to. */
export interface PowerSource {
  readonly label: string;
  /** Current power (W), or 0 when no fresh data. */
  power(nowMs: number): number;
  cadence(): number | null;
  heartRate(): number | null;
  /** Grade for the trainer (%), already scaled and rate limited. */
  setGrade(percent: number): void;
  /** Rolling resistance and wind coefficient for the trainer's simulation model. */
  setResistance(crr: number, cw: number): void;
  /** Called on every telemetry packet (drives the simulation clock, also in background tabs). */
  onTelemetry(cb: () => void): void;
  /** Keyboard adjustment (+1 / −1): autopilot power, simulator cadence. */
  adjust(delta: 1 | -1): void;
  readonly state: () => string;
  dispose(): void;
}

/** FTMS trainer via Web Bluetooth, or the library's simulator on the mock transport. */
export class TrainerSource implements PowerSource {
  readonly label: string;
  private readonly trainer: FtmsTrainer;
  private readonly sim: SimulatedTrainer | null;
  private lastPacket = 0;
  private connection: ConnectionState = 'disconnected';
  private cbs: (() => void)[] = [];

  constructor(kind: 'bluetooth' | 'simulator') {
    if (kind === 'simulator') {
      this.sim = new SimulatedTrainer({ cadenceRpm: 85 });
      this.trainer = new FtmsTrainer({ transport: new MockTransport([this.sim.peripheral]) });
      this.label = 'SIMULATOR';
    } else {
      this.sim = null;
      this.trainer = new FtmsTrainer({ transport: new WebBluetoothTransport() });
      this.label = 'TRAINER';
    }
    this.trainer.on('telemetry', () => {
      this.lastPacket = performance.now();
      for (const cb of this.cbs) cb();
    });
    this.trainer.on('connectionStateChange', (e) => (this.connection = e.state));
  }

  /** Must run inside a user gesture (Bluetooth chooser). */
  async connect(): Promise<void> {
    await this.trainer.connect();
  }

  get deviceName(): string | undefined {
    return this.trainer.deviceName;
  }

  power(nowMs: number): number {
    if (nowMs - this.lastPacket > SIM.powerTimeoutMs) return 0;
    return this.trainer.telemetry.powerW ?? 0;
  }

  cadence(): number | null {
    return this.trainer.telemetry.cadenceRpm ?? null;
  }

  heartRate(): number | null {
    return this.trainer.telemetry.heartRateBpm ?? null;
  }

  setGrade(percent: number): void {
    this.trainer.setSimulation({ gradePercent: percent }).catch(() => undefined);
  }

  setResistance(crr: number, cw: number): void {
    this.trainer.setSimulation({ crr, cw }).catch(() => undefined);
  }

  onTelemetry(cb: () => void): void {
    this.cbs.push(cb);
  }

  adjust(delta: 1 | -1): void {
    if (this.sim) this.sim.cadenceRpm = Math.max(0, Math.min(130, this.sim.cadenceRpm + delta * 5));
  }

  readonly state = (): string =>
    performance.now() - this.lastPacket > SIM.powerTimeoutMs && this.connection === 'ready' ? 'KEIN SIGNAL' : this.connection.toUpperCase();

  dispose(): void {
    this.cbs = [];
    this.trainer.disconnect().catch(() => undefined);
  }
}

/** Demo autopilot: constant power (adjustable), no hardware. */
export class AutopilotSource implements PowerSource {
  readonly label = 'AUTOPILOT';
  watts = 200;

  power(): number {
    return this.watts;
  }

  cadence(): number {
    return this.watts > 0 ? 80 + Math.min(15, this.watts / 40) : 0;
  }

  heartRate(): null {
    return null;
  }

  setGrade(): void {}

  setResistance(): void {}

  onTelemetry(): void {}

  adjust(delta: 1 | -1): void {
    this.watts = Math.max(0, Math.min(600, this.watts + delta * 25));
  }

  readonly state = (): string => `${this.watts} W (+/−)`;

  dispose(): void {}
}
