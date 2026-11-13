import { ByteReader, ByteWriter } from '../protocol/bytes';
import {
  CONTROL_POINT_OPCODE as OP,
  CONTROL_POINT_RESULT as RESULT,
  DEFAULT_SIMULATION_PARAMETERS,
  readSimulationParameters,
  writeSimulationParameters,
  type IndoorBikeSimulationParameters,
} from '../protocol/ftms/control-point';
import { MACHINE_STATUS_OPCODE as STATUS } from '../protocol/ftms/machine-status';
import { TRAINING_STATUS } from '../protocol/ftms/training-status';
import { CHARACTERISTIC, SERVICE } from '../protocol/uuids';
import { MockPeripheral, type MockCharacteristic } from '../transport/mock-transport';

export interface SimulatedTrainerOptions {
  name?: string;
  /** Indoor Bike Data interval. Default 250 ms (4 Hz). */
  intervalMs?: number;
  /** GATT latency of the mock peripheral. Default 5 ms. */
  latencyMs?: number;
  /** Rider cadence; 0 = not pedalling. Default 85 rpm. */
  cadenceRpm?: number;
  /** Rider + bike mass for simulation mode. Default 85 kg. */
  massKg?: number;
  /** Initial connect attempts that fail. Default 0. */
  failConnectTimes?: number;
}

type SimMode =
  | { kind: 'none' }
  | { kind: 'erg'; targetPowerW: number }
  | { kind: 'simulation'; parameters: IndoorBikeSimulationParameters }
  | { kind: 'resistance'; level: number };

const KMH_PER_RPM = 0.35; // fixed gear: 85 rpm ≈ 30 km/h

/**
 * A software FTMS indoor bike on top of {@link MockPeripheral}: answers the
 * control point like a real trainer (incl. control handling), sends Indoor
 * Bike Data and Machine Status, and models power with simple physics.
 *
 * ```ts
 * const sim = new SimulatedTrainer();
 * const trainer = new FtmsTrainer({ transport: new MockTransport([sim.peripheral]) });
 * ```
 */
export class SimulatedTrainer {
  readonly peripheral: MockPeripheral;
  /** When true, Request Control is refused (another app "holds" the trainer). */
  controlHeldByOtherApp = false;
  cadenceRpm: number;
  readonly massKg: number;

  #controlGranted = false;
  #mode: SimMode = { kind: 'none' };
  #powerW = 0;
  #distanceM = 0;
  #elapsedS = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #lastTick = 0;
  readonly #intervalMs: number;
  readonly #bikeData: MockCharacteristic;
  readonly #controlPoint: MockCharacteristic;
  readonly #status: MockCharacteristic;
  readonly #training: MockCharacteristic;

  constructor(options: SimulatedTrainerOptions = {}) {
    this.#intervalMs = options.intervalMs ?? 250;
    this.cadenceRpm = options.cadenceRpm ?? 85;
    this.massKg = options.massKg ?? 85;

    const features = new ByteWriter()
      .uint32(0x5006) // cadence, total distance, elapsed time, power measurement
      .uint32(0x200c) // resistance target, power target, indoor bike simulation
      .toBytes();

    this.peripheral = new MockPeripheral({
      name: options.name ?? 'Simulated FTMS Trainer',
      latencyMs: options.latencyMs ?? 5,
      failConnectTimes: options.failConnectTimes ?? 0,
      services: [
        {
          uuid: SERVICE.fitnessMachine,
          characteristics: [
            { uuid: CHARACTERISTIC.fitnessMachineFeature, properties: { read: true }, value: features },
            { uuid: CHARACTERISTIC.supportedPowerRange, properties: { read: true }, value: [0, 0, 0xd0, 0x07, 1, 0] },
            {
              uuid: CHARACTERISTIC.supportedResistanceLevelRange,
              properties: { read: true },
              value: [0, 0, 0xe8, 0x03, 0x0a, 0],
            },
            { uuid: CHARACTERISTIC.indoorBikeData, properties: { notify: true } },
            {
              uuid: CHARACTERISTIC.trainingStatus,
              properties: { read: true, notify: true },
              value: [0x00, TRAINING_STATUS.idle],
            },
            { uuid: CHARACTERISTIC.fitnessMachineStatus, properties: { notify: true } },
            {
              uuid: CHARACTERISTIC.fitnessMachineControlPoint,
              properties: { write: true, indicate: true },
              onWrite: (bytes) => this.#handleControlPoint(bytes),
            },
          ],
        },
        {
          uuid: SERVICE.deviceInformation,
          characteristics: [
            { uuid: CHARACTERISTIC.manufacturerName, properties: { read: true }, value: new TextEncoder().encode('open-ftms') },
            { uuid: CHARACTERISTIC.modelNumber, properties: { read: true }, value: new TextEncoder().encode('Simulator') },
            { uuid: CHARACTERISTIC.firmwareRevision, properties: { read: true }, value: new TextEncoder().encode('0.0.0') },
          ],
        },
      ],
    });

    const c = (uuid: number) => this.peripheral.characteristic(SERVICE.fitnessMachine, uuid);
    this.#bikeData = c(CHARACTERISTIC.indoorBikeData);
    this.#controlPoint = c(CHARACTERISTIC.fitnessMachineControlPoint);
    this.#status = c(CHARACTERISTIC.fitnessMachineStatus);
    this.#training = c(CHARACTERISTIC.trainingStatus);

    this.peripheral.onConnected(() => this.#start());
    this.peripheral.onDisconnected(() => {
      // Like a real trainer: losing the link ends the controlled session.
      this.#stop();
      this.#mode = { kind: 'none' };
    });
  }

  get controlGranted(): boolean {
    return this.#controlGranted;
  }

  get mode(): Readonly<SimMode> {
    return this.#mode;
  }

  get powerW(): number {
    return this.#powerW;
  }

  /** Simulates the trainer revoking control (Machine Status 0xFF). */
  simulateControlLoss(): void {
    this.#controlGranted = false;
    this.#status.notify([STATUS.controlPermissionLost]);
  }

  /** Simulates the BLE link dropping. */
  simulateConnectionLoss(): void {
    this.peripheral.simulateConnectionLoss();
  }

  #start(): void {
    this.#stop();
    this.#lastTick = Date.now();
    this.#timer = setInterval(() => this.#tick(), this.#intervalMs);
  }

  #stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    this.#controlGranted = false;
  }

  #tick(): void {
    const now = Date.now();
    const dt = Math.max(0, (now - this.#lastTick) / 1000);
    this.#lastTick = now;

    const wobble = this.cadenceRpm > 0 ? Math.sin(now / 1500) * 2 : 0;
    const cadence = Math.max(0, this.cadenceRpm + wobble);
    const speedKmh = cadence * KMH_PER_RPM;
    const target = this.#targetPower(cadence, speedKmh / 3.6);
    // First-order response, like a flywheel/brake settling (~1 s).
    this.#powerW += (target - this.#powerW) * Math.min(1, dt / 1);
    this.#distanceM += (speedKmh / 3.6) * dt;
    this.#elapsedS += dt;

    const w = new ByteWriter()
      .uint16(0x0854) // speed (bit 0 clear), cadence, total distance, power, elapsed time
      .uint16(Math.round(speedKmh * 100))
      .uint16(Math.round(cadence * 2))
      .uint24(Math.round(this.#distanceM) & 0xffffff)
      .sint16(Math.round(this.#powerW))
      .uint16(Math.round(this.#elapsedS) & 0xffff);
    this.#bikeData.notify(w.toBytes());
  }

  #targetPower(cadence: number, speedMps: number): number {
    if (cadence <= 0) return 0;
    const mode = this.#mode;
    switch (mode.kind) {
      case 'erg':
        return mode.targetPowerW;
      case 'resistance':
        return 20 + mode.level * 3 * (cadence / 85);
      case 'simulation':
      case 'none': {
        const p = mode.kind === 'simulation' ? mode.parameters : DEFAULT_SIMULATION_PARAMETERS;
        const relativeAir = speedMps + p.windSpeedMps;
        const force =
          this.massKg * 9.81 * (p.crr + p.gradePercent / 100) + p.cw * relativeAir * Math.abs(relativeAir);
        return Math.max(0, force * speedMps);
      }
    }
  }

  async #handleControlPoint(bytes: Uint8Array): Promise<void> {
    const r = new ByteReader(bytes);
    const op = r.uint8() ?? -1;
    const respond = (result: number) => this.#controlPoint.notify([OP.responseCode, op & 0xff, result]);

    if (op === OP.requestControl) {
      if (this.controlHeldByOtherApp) return void respond(RESULT.controlNotPermitted);
      this.#controlGranted = true;
      return void respond(RESULT.success);
    }
    if (!this.#controlGranted) return void respond(RESULT.controlNotPermitted);

    switch (op) {
      case OP.reset:
        this.#mode = { kind: 'none' };
        this.#controlGranted = false;
        respond(RESULT.success);
        this.#status.notify([STATUS.reset]);
        this.#setTrainingStatus(TRAINING_STATUS.idle);
        return;
      case OP.setTargetPower: {
        const watts = r.sint16();
        if (watts === undefined || watts < 0 || watts > 2000) return void respond(RESULT.invalidParameter);
        this.#mode = { kind: 'erg', targetPowerW: watts };
        respond(RESULT.success);
        this.#status.notify(new ByteWriter().uint8(STATUS.targetPowerChanged).sint16(watts).toBytes());
        this.#setTrainingStatus(TRAINING_STATUS.wattControl);
        return;
      }
      case OP.setIndoorBikeSimulationParameters: {
        const parameters = readSimulationParameters(r);
        if (!parameters) return void respond(RESULT.invalidParameter);
        this.#mode = { kind: 'simulation', parameters };
        respond(RESULT.success);
        const w = new ByteWriter().uint8(STATUS.indoorBikeSimulationParametersChanged);
        writeSimulationParameters(w, parameters);
        this.#status.notify(w.toBytes());
        this.#setTrainingStatus(TRAINING_STATUS.manualMode);
        return;
      }
      case OP.setTargetResistanceLevel: {
        const raw = r.remaining >= 2 ? r.sint16() : r.uint8();
        if (raw === undefined || raw < 0 || raw > 1000) return void respond(RESULT.invalidParameter);
        this.#mode = { kind: 'resistance', level: raw / 10 };
        respond(RESULT.success);
        this.#status.notify(new ByteWriter().uint8(STATUS.targetResistanceLevelChanged).sint16(raw).toBytes());
        return;
      }
      case OP.startOrResume:
        respond(RESULT.success);
        this.#status.notify([STATUS.startedOrResumedByUser]);
        return;
      case OP.stopOrPause: {
        const action = r.uint8();
        if (action !== 0x01 && action !== 0x02) return void respond(RESULT.invalidParameter);
        respond(RESULT.success);
        this.#status.notify([STATUS.stoppedOrPausedByUser, action]);
        return;
      }
      default:
        respond(RESULT.opCodeNotSupported);
    }
  }

  #setTrainingStatus(code: number): void {
    this.#training.value = Uint8Array.from([0x00, code]);
    this.#training.notify(this.#training.value);
  }
}
