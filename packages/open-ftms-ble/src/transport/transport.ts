import type { Unsubscribe } from '../events/typed-emitter.js';

/**
 * Transport abstraction: a thin, promise-based mirror of the Web Bluetooth GATT
 * API. Devices only talk to these interfaces, so a mock or replay transport can
 * stand in for real hardware.
 *
 * Implementations do NOT serialise operations; the device layer does that.
 */

/** 16-bit SIG UUID as number, or a UUID string. */
export type BleUuid = number | string;

export interface DeviceFilter {
  services?: BleUuid[];
  name?: string;
  namePrefix?: string;
}

export interface DeviceRequest {
  filters: DeviceFilter[];
  /** Services accessed later but not used for filtering (required by Web Bluetooth). */
  optionalServices?: BleUuid[];
}

export interface BleTransport {
  /** Short identifier, e.g. `web-bluetooth` or `mock`. */
  readonly kind: string;
  /** Whether a Bluetooth adapter is usable at all. */
  isAvailable(): Promise<boolean>;
  /** Lets the user pick a device. Web Bluetooth: must run inside a user gesture. */
  requestDevice(request: DeviceRequest): Promise<BlePeripheral>;
  /** Devices the user granted earlier (no chooser). May be empty if unsupported. */
  getKnownDevices(): Promise<BlePeripheral[]>;
}

export interface BlePeripheral {
  readonly id: string;
  readonly name: string | undefined;
  readonly connected: boolean;
  connect(): Promise<void>;
  /** Fires the disconnected listeners as well (like Web Bluetooth). */
  disconnect(): void;
  /** `undefined` if the device does not offer the service. */
  getService(uuid: BleUuid): Promise<BleService | undefined>;
  onDisconnected(listener: () => void): Unsubscribe;
  /**
   * Resolves `true` once the device advertises (it is switched on and in
   * range), `false` after `timeoutMs`. Optional: transports without
   * advertisement support omit it. Web Bluetooth needs this before
   * connecting to a device from `getKnownDevices()` on some platforms.
   */
  waitForAdvertisement?(timeoutMs: number): Promise<boolean>;
}

export interface BleService {
  /** Lowercase 128-bit UUID. */
  readonly uuid: string;
  /** `undefined` if the service does not contain the characteristic. */
  getCharacteristic(uuid: BleUuid): Promise<BleCharacteristic | undefined>;
}

export interface CharacteristicProperties {
  readonly read: boolean;
  readonly write: boolean;
  readonly writeWithoutResponse: boolean;
  readonly notify: boolean;
  readonly indicate: boolean;
}

export interface BleCharacteristic {
  /** Lowercase 128-bit UUID. */
  readonly uuid: string;
  readonly properties: CharacteristicProperties;
  read(): Promise<DataView>;
  write(value: Uint8Array, withResponse?: boolean): Promise<void>;
  startNotifications(): Promise<void>;
  stopNotifications(): Promise<void>;
  /** Notifications and indications. Register before `startNotifications()`. */
  onValue(listener: (value: DataView) => void): Unsubscribe;
}
