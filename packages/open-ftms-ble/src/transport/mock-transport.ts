import { ConnectionError, UserCancelledError } from '../errors.js';
import type { Unsubscribe } from '../events/typed-emitter.js';
import { toBytes, type BytesLike } from '../protocol/bytes.js';
import { normalizeUuid } from '../protocol/uuids.js';
import { delay } from '../util/async.js';
import type {
  BleCharacteristic,
  BlePeripheral,
  BleService,
  BleTransport,
  BleUuid,
  CharacteristicProperties,
  DeviceRequest,
} from './transport.js';

/**
 * In-memory BLE transport for tests, demos and games without hardware.
 *
 * Behaves like Chrome where it matters: overlapping GATT operations on one
 * peripheral fail with "GATT operation already in progress", disconnecting
 * fires the disconnected listeners, and notifications are delivered
 * asynchronously (an indication can arrive before the write promise resolves).
 */

export interface MockCharacteristicInit {
  uuid: BleUuid;
  properties?: Partial<CharacteristicProperties>;
  value?: BytesLike;
  /** Called for every write; may notify/indicate in response. */
  onWrite?: (bytes: Uint8Array, characteristic: MockCharacteristic) => void | Promise<void>;
}

export interface MockServiceInit {
  uuid: BleUuid;
  characteristics: MockCharacteristicInit[];
}

export interface MockPeripheralInit {
  id?: string;
  name?: string;
  services: MockServiceInit[];
  /** Artificial latency per GATT operation and connect (ms). Default 1. */
  latencyMs?: number;
  /** Number of initial connect attempts that fail with a NetworkError. */
  failConnectTimes?: number;
}

let nextId = 1;

export class MockPeripheral implements BlePeripheral {
  readonly id: string;
  readonly name: string | undefined;
  readonly services = new Map<string, MockService>();
  latencyMs: number;
  failConnectTimes: number;
  connectAttempts = 0;
  #connected = false;
  #busy = false;
  readonly #disconnectListeners = new Set<() => void>();
  readonly #connectListeners = new Set<() => void>();

  constructor(init: MockPeripheralInit) {
    this.id = init.id ?? `mock-${nextId++}`;
    this.name = init.name;
    this.latencyMs = init.latencyMs ?? 1;
    this.failConnectTimes = init.failConnectTimes ?? 0;
    for (const s of init.services) {
      const service = new MockService(this, s);
      this.services.set(service.uuid, service);
    }
  }

  get connected(): boolean {
    return this.#connected;
  }

  async connect(): Promise<void> {
    this.connectAttempts++;
    await delay(this.latencyMs);
    if (this.failConnectTimes > 0) {
      this.failConnectTimes--;
      throw new DOMException('Connection attempt failed.', 'NetworkError');
    }
    if (this.#connected) return;
    this.#connected = true;
    for (const l of [...this.#connectListeners]) l();
  }

  disconnect(): void {
    if (!this.#connected) return;
    this.#connected = false;
    this.#busy = false;
    for (const service of this.services.values()) {
      for (const c of service.characteristics.values()) c.notifying = false;
    }
    for (const l of [...this.#disconnectListeners]) l();
  }

  /** Whether the device "advertises" (is switched on and in range). Default true. */
  advertising = true;

  async waitForAdvertisement(timeoutMs: number): Promise<boolean> {
    if (this.advertising) return true;
    await delay(timeoutMs);
    return this.advertising;
  }

  /** Simulates an unexpected link loss (same effect as a remote disconnect). */
  simulateConnectionLoss(): void {
    this.disconnect();
  }

  async getService(uuid: BleUuid): Promise<BleService | undefined> {
    this.#assertConnected();
    await delay(this.latencyMs);
    this.#assertConnected();
    return this.services.get(normalizeUuid(uuid));
  }

  onDisconnected(listener: () => void): Unsubscribe {
    this.#disconnectListeners.add(listener);
    return () => this.#disconnectListeners.delete(listener);
  }

  /** For simulators: called after every successful connect. */
  onConnected(listener: () => void): Unsubscribe {
    this.#connectListeners.add(listener);
    return () => this.#connectListeners.delete(listener);
  }

  /** Test helper: direct access to a characteristic. */
  characteristic(service: BleUuid, characteristic: BleUuid): MockCharacteristic {
    const c = this.services.get(normalizeUuid(service))?.characteristics.get(normalizeUuid(characteristic));
    if (!c) throw new Error(`Mock characteristic ${String(characteristic)} not found`);
    return c;
  }

  /** Runs one GATT operation exclusively, failing like Chrome on overlap. */
  async exclusive<T>(operation: () => T | Promise<T>): Promise<T> {
    this.#assertConnected();
    if (this.#busy) throw new DOMException('GATT operation already in progress.', 'NetworkError');
    this.#busy = true;
    try {
      await delay(this.latencyMs);
      this.#assertConnected();
      return await operation();
    } finally {
      this.#busy = false;
    }
  }

  #assertConnected(): void {
    if (!this.#connected) throw new DOMException('GATT Server is disconnected.', 'NetworkError');
  }
}

export class MockService implements BleService {
  readonly uuid: string;
  readonly characteristics = new Map<string, MockCharacteristic>();

  constructor(peripheral: MockPeripheral, init: MockServiceInit) {
    this.uuid = normalizeUuid(init.uuid);
    for (const c of init.characteristics) {
      const characteristic = new MockCharacteristic(peripheral, c);
      this.characteristics.set(characteristic.uuid, characteristic);
    }
  }

  async getCharacteristic(uuid: BleUuid): Promise<BleCharacteristic | undefined> {
    return this.characteristics.get(normalizeUuid(uuid));
  }
}

export class MockCharacteristic implements BleCharacteristic {
  readonly uuid: string;
  readonly properties: CharacteristicProperties;
  value: Uint8Array;
  notifying = false;
  /** Every value written, oldest first. */
  readonly writes: Uint8Array[] = [];
  readonly #peripheral: MockPeripheral;
  readonly #onWrite: MockCharacteristicInit['onWrite'];
  readonly #listeners = new Set<(value: DataView) => void>();

  constructor(peripheral: MockPeripheral, init: MockCharacteristicInit) {
    this.#peripheral = peripheral;
    this.uuid = normalizeUuid(init.uuid);
    this.properties = {
      read: false,
      write: false,
      writeWithoutResponse: false,
      notify: false,
      indicate: false,
      ...init.properties,
    };
    this.value = init.value === undefined ? new Uint8Array() : toBytes(init.value);
    this.#onWrite = init.onWrite;
  }

  read(): Promise<DataView> {
    return this.#peripheral.exclusive(() => {
      const copy = this.value.slice();
      return new DataView(copy.buffer);
    });
  }

  write(value: Uint8Array, _withResponse = true): Promise<void> {
    return this.#peripheral.exclusive(async () => {
      const bytes = value.slice();
      this.writes.push(bytes);
      await this.#onWrite?.(bytes, this);
    });
  }

  startNotifications(): Promise<void> {
    return this.#peripheral.exclusive(() => {
      this.notifying = true;
    });
  }

  stopNotifications(): Promise<void> {
    return this.#peripheral.exclusive(() => {
      this.notifying = false;
    });
  }

  onValue(listener: (value: DataView) => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Sends a notification/indication (asynchronously, like a real stack).
   * Returns false if the client has not subscribed or the link is down.
   */
  notify(data: BytesLike): boolean {
    if (!this.notifying || !this.#peripheral.connected) return false;
    const bytes = toBytes(data);
    this.value = bytes;
    queueMicrotask(() => {
      if (!this.notifying) return;
      for (const l of [...this.#listeners]) l(new DataView(bytes.slice().buffer));
    });
    return true;
  }
}

function matches(peripheral: MockPeripheral, request: DeviceRequest): boolean {
  return request.filters.some((f) => {
    const servicesOk = (f.services ?? []).every((s) => peripheral.services.has(normalizeUuid(s)));
    const nameOk = f.name === undefined || f.name === peripheral.name;
    const prefixOk = f.namePrefix === undefined || (peripheral.name ?? '').startsWith(f.namePrefix);
    return servicesOk && nameOk && prefixOk;
  });
}

/** Transport that "finds" the first registered peripheral matching the request. */
export class MockTransport implements BleTransport {
  readonly kind = 'mock';
  readonly peripherals: MockPeripheral[];

  constructor(peripherals: MockPeripheral[] = []) {
    this.peripherals = peripherals;
  }

  add(peripheral: MockPeripheral): this {
    this.peripherals.push(peripheral);
    return this;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async requestDevice(request: DeviceRequest): Promise<BlePeripheral> {
    const match = this.peripherals.find((p) => matches(p, request));
    if (!match) throw new UserCancelledError('No matching mock device');
    if (!(match instanceof MockPeripheral)) throw new ConnectionError('Invalid mock peripheral');
    return match;
  }

  async getKnownDevices(): Promise<BlePeripheral[]> {
    return [...this.peripherals];
  }
}
