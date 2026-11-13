import { ByteWriter } from '../protocol/bytes.js';
import { CHARACTERISTIC, SERVICE } from '../protocol/uuids.js';
import { MockPeripheral, type MockCharacteristic } from '../transport/mock-transport.js';

export interface SimulatedHeartRateMonitorOptions {
  name?: string;
  /** Measurement interval. Default 1000 ms. */
  intervalMs?: number;
  latencyMs?: number;
  /** Resting heart rate. Default 70 bpm. */
  restingBpm?: number;
  /** Optional power source (e.g. a simulated trainer); heart rate follows it. */
  powerSource?: () => number;
}

/** A software BLE heart-rate strap (0x180D) with contact detection and RR intervals. */
export class SimulatedHeartRateMonitor {
  readonly peripheral: MockPeripheral;
  /** Set to false to simulate a strap that lost skin contact. */
  contact = true;
  powerSource: (() => number) | undefined;
  #bpm: number;
  readonly #restingBpm: number;
  readonly #intervalMs: number;
  readonly #measurement: MockCharacteristic;
  #timer: ReturnType<typeof setInterval> | undefined;

  constructor(options: SimulatedHeartRateMonitorOptions = {}) {
    this.#restingBpm = options.restingBpm ?? 70;
    this.#bpm = this.#restingBpm + 30;
    this.#intervalMs = options.intervalMs ?? 1000;
    this.powerSource = options.powerSource;
    this.peripheral = new MockPeripheral({
      name: options.name ?? 'Simulated HR Strap',
      latencyMs: options.latencyMs ?? 5,
      services: [
        {
          uuid: SERVICE.heartRate,
          characteristics: [
            { uuid: CHARACTERISTIC.heartRateMeasurement, properties: { notify: true } },
            { uuid: CHARACTERISTIC.bodySensorLocation, properties: { read: true }, value: [0x01] },
          ],
        },
      ],
    });
    this.#measurement = this.peripheral.characteristic(SERVICE.heartRate, CHARACTERISTIC.heartRateMeasurement);
    this.peripheral.onConnected(() => {
      this.#stop();
      this.#timer = setInterval(() => this.#tick(), this.#intervalMs);
    });
    this.peripheral.onDisconnected(() => this.#stop());
  }

  get bpm(): number {
    return Math.round(this.#bpm);
  }

  #stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  #tick(): void {
    const power = this.powerSource?.() ?? 120;
    const target = this.#restingBpm + power * 0.35;
    this.#bpm += (target - this.#bpm) * 0.08 + (Math.random() - 0.5);
    const bpm = Math.max(30, Math.min(220, Math.round(this.#bpm)));
    const rr = Math.round((60 / bpm) * 1024);
    // flags: uint8 HR, contact supported (+ detected), RR intervals present
    const flags = 0x04 | (this.contact ? 0x02 : 0) | 0x10;
    this.#measurement.notify(new ByteWriter().uint8(flags).uint8(bpm).uint16(rr).toBytes());
  }
}
