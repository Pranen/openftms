import { BluetoothUnavailableError, ConnectionError, UserCancelledError, wrapError } from '../errors';
import type { Unsubscribe } from '../events/typed-emitter';
import { normalizeUuid } from '../protocol/uuids';
import type {
  BleCharacteristic,
  BlePeripheral,
  BleService,
  BleTransport,
  BleUuid,
  CharacteristicProperties,
  DeviceRequest,
} from './transport';

function isDomError(error: unknown, ...names: string[]): boolean {
  return error instanceof Error && names.includes(error.name);
}

/** Transport backed by `navigator.bluetooth` (Chrome, Edge, Opera; https or localhost). */
export class WebBluetoothTransport implements BleTransport {
  readonly kind = 'web-bluetooth';
  readonly #bluetooth: Bluetooth | undefined;

  constructor(bluetooth: Bluetooth | undefined = globalThis.navigator?.bluetooth) {
    this.#bluetooth = bluetooth;
  }

  async isAvailable(): Promise<boolean> {
    if (!this.#bluetooth) return false;
    try {
      return await this.#bluetooth.getAvailability();
    } catch {
      return true;
    }
  }

  async requestDevice(request: DeviceRequest): Promise<BlePeripheral> {
    const bluetooth = this.#requireBluetooth();
    try {
      const device = await bluetooth.requestDevice({
        filters: request.filters,
        optionalServices: request.optionalServices ?? [],
      });
      return new WebBluetoothPeripheral(device);
    } catch (error) {
      if (isDomError(error, 'NotFoundError')) {
        throw new UserCancelledError('No device selected', { cause: error });
      }
      throw wrapError(ConnectionError, 'requestDevice failed', error);
    }
  }

  async getKnownDevices(): Promise<BlePeripheral[]> {
    const bluetooth = this.#bluetooth;
    if (!bluetooth || typeof bluetooth.getDevices !== 'function') return [];
    try {
      return (await bluetooth.getDevices()).map((d) => new WebBluetoothPeripheral(d));
    } catch {
      return [];
    }
  }

  #requireBluetooth(): Bluetooth {
    if (!this.#bluetooth) {
      throw new BluetoothUnavailableError(
        'Web Bluetooth is not available (use Chrome/Edge via https or localhost)',
      );
    }
    return this.#bluetooth;
  }
}

class WebBluetoothPeripheral implements BlePeripheral {
  readonly #device: BluetoothDevice;
  #server: BluetoothRemoteGATTServer | undefined;

  constructor(device: BluetoothDevice) {
    this.#device = device;
  }

  get id(): string {
    return this.#device.id;
  }

  get name(): string | undefined {
    return this.#device.name;
  }

  get connected(): boolean {
    return this.#device.gatt?.connected ?? false;
  }

  async connect(): Promise<void> {
    const gatt = this.#device.gatt;
    if (!gatt) throw new ConnectionError('Device has no GATT server');
    this.#server = await gatt.connect();
  }

  disconnect(): void {
    this.#device.gatt?.disconnect();
  }

  async getService(uuid: BleUuid): Promise<BleService | undefined> {
    const server = this.#server;
    if (!server?.connected) throw new ConnectionError('Not connected');
    try {
      return new WebBluetoothService(await server.getPrimaryService(uuid));
    } catch (error) {
      // NotFoundError: not offered. SecurityError: not in optionalServices / blocklisted.
      if (isDomError(error, 'NotFoundError', 'SecurityError')) return undefined;
      throw error;
    }
  }

  onDisconnected(listener: () => void): Unsubscribe {
    const handler = () => listener();
    this.#device.addEventListener('gattserverdisconnected', handler);
    return () => this.#device.removeEventListener('gattserverdisconnected', handler);
  }
}

class WebBluetoothService implements BleService {
  readonly #service: BluetoothRemoteGATTService;

  #all: Promise<Map<string, BluetoothRemoteGATTCharacteristic> | undefined> | undefined;

  constructor(service: BluetoothRemoteGATTService) {
    this.#service = service;
  }

  /** All characteristics by UUID, or `undefined` to fall back to single lookups. */
  async #discoverAll(): Promise<Map<string, BluetoothRemoteGATTCharacteristic> | undefined> {
    try {
      const list = await this.#service.getCharacteristics();
      return new Map(list.map((c) => [normalizeUuid(c.uuid), c]));
    } catch (error) {
      if (isDomError(error, 'NotFoundError')) return new Map(); // service has no characteristics
      return undefined;
    }
  }

  get uuid(): string {
    return normalizeUuid(this.#service.uuid);
  }

  async getCharacteristic(uuid: BleUuid): Promise<BleCharacteristic | undefined> {
    // One discovery round trip per service instead of one per lookup; on some
    // platforms (Windows) every single lookup is noticeably slow.
    const all = await (this.#all ??= this.#discoverAll());
    if (all) {
      const characteristic = all.get(normalizeUuid(uuid));
      return characteristic ? new WebBluetoothCharacteristic(characteristic) : undefined;
    }
    try {
      return new WebBluetoothCharacteristic(await this.#service.getCharacteristic(uuid));
    } catch (error) {
      if (isDomError(error, 'NotFoundError', 'SecurityError')) return undefined;
      throw error;
    }
  }
}

class WebBluetoothCharacteristic implements BleCharacteristic {
  readonly #c: BluetoothRemoteGATTCharacteristic;
  readonly properties: CharacteristicProperties;

  constructor(characteristic: BluetoothRemoteGATTCharacteristic) {
    this.#c = characteristic;
    const p = characteristic.properties;
    this.properties = {
      read: p.read,
      write: p.write,
      writeWithoutResponse: p.writeWithoutResponse,
      notify: p.notify,
      indicate: p.indicate,
    };
  }

  get uuid(): string {
    return normalizeUuid(this.#c.uuid);
  }

  read(): Promise<DataView> {
    return this.#c.readValue();
  }

  async write(value: Uint8Array, withResponse = true): Promise<void> {
    const data = value as Uint8Array<ArrayBuffer>;
    if (withResponse && typeof this.#c.writeValueWithResponse === 'function') {
      await this.#c.writeValueWithResponse(data);
    } else if (!withResponse && typeof this.#c.writeValueWithoutResponse === 'function') {
      await this.#c.writeValueWithoutResponse(data);
    } else {
      await this.#c.writeValue(data);
    }
  }

  async startNotifications(): Promise<void> {
    await this.#c.startNotifications();
  }

  async stopNotifications(): Promise<void> {
    await this.#c.stopNotifications();
  }

  onValue(listener: (value: DataView) => void): Unsubscribe {
    const handler = (event: Event) => {
      const value = (event.target as BluetoothRemoteGATTCharacteristic | null)?.value;
      if (value) listener(value);
    };
    this.#c.addEventListener('characteristicvaluechanged', handler);
    return () => this.#c.removeEventListener('characteristicvaluechanged', handler);
  }
}
