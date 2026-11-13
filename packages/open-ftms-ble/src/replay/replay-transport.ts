import { fromHex } from '../protocol/bytes.js';
import { CHARACTERISTIC, SERVICE, normalizeUuid } from '../protocol/uuids.js';
import type { CharacteristicProperties } from '../transport/transport.js';
import { MockPeripheral, MockTransport, type MockCharacteristic, type MockCharacteristicInit } from '../transport/mock-transport.js';
import type { RecordedDevice, Recording } from './recording.js';

export interface ReplayOptions {
  /** Playback speed factor. Default 1. */
  speed?: number;
  /** Start over after the last notification. Default true. */
  loop?: boolean;
  /** GATT latency of the replayed peripherals. Default 5 ms. */
  latencyMs?: number;
}

const SERVICE_OF: ReadonlyMap<string, number> = new Map(
  (
    [
      [SERVICE.fitnessMachine, [
        CHARACTERISTIC.fitnessMachineFeature,
        CHARACTERISTIC.indoorBikeData,
        CHARACTERISTIC.trainingStatus,
        CHARACTERISTIC.supportedSpeedRange,
        CHARACTERISTIC.supportedInclinationRange,
        CHARACTERISTIC.supportedResistanceLevelRange,
        CHARACTERISTIC.supportedHeartRateRange,
        CHARACTERISTIC.supportedPowerRange,
        CHARACTERISTIC.fitnessMachineControlPoint,
        CHARACTERISTIC.fitnessMachineStatus,
      ]],
      [SERVICE.heartRate, [CHARACTERISTIC.heartRateMeasurement, CHARACTERISTIC.bodySensorLocation]],
      [SERVICE.cyclingPower, [CHARACTERISTIC.cyclingPowerMeasurement, CHARACTERISTIC.cyclingPowerFeature]],
      [SERVICE.deviceInformation, [
        CHARACTERISTIC.modelNumber,
        CHARACTERISTIC.serialNumber,
        CHARACTERISTIC.firmwareRevision,
        CHARACTERISTIC.hardwareRevision,
        CHARACTERISTIC.softwareRevision,
        CHARACTERISTIC.manufacturerName,
      ]],
    ] as const
  ).flatMap(([service, chars]) => chars.map((c) => [normalizeUuid(c), service] as const)),
);

const CONTROL_POINT = normalizeUuid(CHARACTERISTIC.fitnessMachineControlPoint);

/**
 * Builds a peripheral from a recorded device: recorded reads become static
 * values, recorded notifications are played back with their original timing
 * once something subscribes, and control point writes are answered with
 * "success" (so a recording without control traffic still accepts commands).
 */
export class ReplayPeripheral {
  readonly peripheral: MockPeripheral;
  readonly #notifications: ReadonlyArray<{ t: number; uuid: string; bytes: Uint8Array }>;
  readonly #speed: number;
  readonly #loop: boolean;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #index = 0;
  #cycleStart = 0;

  constructor(device: RecordedDevice, options: ReplayOptions = {}) {
    this.#speed = options.speed && options.speed > 0 ? options.speed : 1;
    this.#loop = options.loop ?? true;

    const reads = new Map<string, Uint8Array>();
    const notified = new Set<string>();
    const written = new Set<string>();
    for (const p of device.packets) {
      if (p.kind === 'read' && !reads.has(p.uuid)) reads.set(p.uuid, fromHex(p.hex));
      if (p.kind === 'notification') notified.add(p.uuid);
      if (p.kind === 'write') written.add(p.uuid);
    }
    // Control point responses are generated, not replayed.
    const notifications = device.packets
      .filter((p) => p.kind === 'notification' && p.uuid !== CONTROL_POINT)
      .map((p) => ({ t: p.t, uuid: p.uuid, bytes: fromHex(p.hex) }));
    const first = notifications[0]?.t ?? 0;
    this.#notifications = notifications.map((n) => ({ ...n, t: n.t - first }));

    const services = new Map<string, MockCharacteristicInit[]>();
    for (const uuid of new Set([...reads.keys(), ...notified, ...written])) {
      const service = normalizeUuid(SERVICE_OF.get(uuid) ?? SERVICE.fitnessMachine);
      const isControlPoint = uuid === CONTROL_POINT;
      const properties: Partial<CharacteristicProperties> = {
        read: reads.has(uuid),
        notify: notified.has(uuid) && !isControlPoint,
        indicate: isControlPoint,
        write: written.has(uuid) || isControlPoint,
      };
      const value = reads.get(uuid);
      const init: MockCharacteristicInit = {
        uuid,
        properties,
        ...(value ? { value } : {}),
        ...(isControlPoint
          ? { onWrite: (bytes: Uint8Array, c: MockCharacteristic) => void c.notify([0x80, bytes[0] ?? 0, 0x01]) }
          : {}),
      };
      services.set(service, [...(services.get(service) ?? []), init]);
    }

    this.peripheral = new MockPeripheral({
      name: device.name ?? device.label,
      latencyMs: options.latencyMs ?? 5,
      services: [...services].map(([uuid, characteristics]) => ({ uuid, characteristics })),
    });
    this.peripheral.onConnected(() => this.#start());
    this.peripheral.onDisconnected(() => this.#stop());
  }

  #start(): void {
    this.#stop();
    this.#index = 0;
    this.#cycleStart = Date.now();
    this.#schedule();
  }

  #stop(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #schedule(): void {
    const next = this.#notifications[this.#index];
    if (!next) {
      if (!this.#loop || this.#notifications.length === 0) return;
      this.#index = 0;
      this.#cycleStart = Date.now() + 1000 / this.#speed; // short pause between loops
      this.#schedule();
      return;
    }
    const dueIn = this.#cycleStart + next.t / this.#speed - Date.now();
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      const service = SERVICE_OF.get(next.uuid) ?? SERVICE.fitnessMachine;
      this.peripheral.characteristic(service, next.uuid).notify(next.bytes);
      this.#index++;
      this.#schedule();
    }, Math.max(0, dueIn));
  }
}

/**
 * Transport that replays a {@link Recording}: one peripheral per recorded
 * device, usable with FtmsTrainer/HeartRateMonitor like real hardware.
 *
 * ```ts
 * const transport = new ReplayTransport(parseRecording(JSON.parse(text)));
 * const trainer = new FtmsTrainer({ transport });
 * await trainer.connect(); // picks the first recorded FTMS device
 * ```
 */
export class ReplayTransport extends MockTransport {
  readonly replays: readonly ReplayPeripheral[];

  constructor(recording: Recording, options: ReplayOptions = {}) {
    const replays = recording.devices.map((d) => new ReplayPeripheral(d, options));
    super(replays.map((r) => r.peripheral));
    this.replays = replays;
  }
}
