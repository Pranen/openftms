import {
  ConnectionError,
  GattOperationError,
  NotConnectedError,
  OpenFtmsError,
  TimeoutError,
  wrapError,
} from '../errors.js';
import { TypedEmitter, type Unsubscribe } from '../events/typed-emitter.js';
import { toBytes, toHex } from '../protocol/bytes.js';
import { uuidName } from '../protocol/uuids.js';
import { GattQueue, type GattOperationTrace } from '../transport/gatt-queue.js';
import type { BleCharacteristic, BlePeripheral, BleService, BleTransport, BleUuid, DeviceRequest } from '../transport/transport.js';
import { WebBluetoothTransport } from '../transport/web-bluetooth.js';
import { delay, withTimeout } from '../util/async.js';
import { readDeviceInformation, type DeviceInformation } from './device-information.js';

/**
 * ```
 * disconnected → connecting → discovering → ready
 *                                             │ link lost (not user-initiated)
 *                   discovering ← reconnecting ┘   backoff, max N attempts
 * ```
 */
export type ConnectionState = 'disconnected' | 'connecting' | 'discovering' | 'ready' | 'reconnecting';

export interface ReconnectOptions {
  /** Reconnect automatically after an unexpected link loss. Default true. */
  enabled: boolean;
  /** Attempts before giving up (state → disconnected). Default 10. */
  maxAttempts: number;
  /** Delay before the first attempt; doubles per attempt. Default 1000 ms. */
  initialDelayMs: number;
  /** Upper bound for the delay. Default 30000 ms. */
  maxDelayMs: number;
}

export interface BaseDeviceOptions {
  /** Defaults to {@link WebBluetoothTransport}. */
  transport?: BleTransport;
  /** Timeout of a single GATT connect attempt. Default 15000 ms. */
  connectTimeoutMs?: number;
  /** Extra connect attempts on retryable errors (Chrome often fails the first one). Default 2. */
  connectRetries?: number;
  /** Delay between connect retries. Default 600 ms. */
  connectRetryDelayMs?: number;
  /** Timeout of a single GATT read/write/subscribe. Default 10000 ms. */
  operationTimeoutMs?: number;
  reconnect?: Partial<ReconnectOptions>;
}

/** One packet on the wire, for logging and debugging. */
export interface RawPacket {
  readonly direction: 'in' | 'out';
  /** `read` and `notification` (incl. indications) are incoming, `write` is outgoing. */
  readonly kind: 'read' | 'notification' | 'write';
  /** Lowercase 128-bit UUID. */
  readonly uuid: string;
  /** Known characteristic name, or the UUID. */
  readonly characteristic: string;
  readonly bytes: Uint8Array;
  readonly hex: string;
  /** `Date.now()` when sent/received. */
  readonly timestamp: number;
}

export interface BaseDeviceEvents {
  connectionStateChange: { state: ConnectionState; previous: ConnectionState; error?: OpenFtmsError };
  reconnectScheduled: { attempt: number; maxAttempts: number; delayMs: number };
  raw: RawPacket;
  /** Errors without a caller to reject (reconnect, notification handling …). */
  error: OpenFtmsError;
  /** Timing of every GATT operation (lookup, read, write, subscribe), for diagnostics. */
  gattOperation: GattOperationTrace;
}

interface SessionContext {
  /** True when this session re-establishes a lost connection. */
  readonly isReconnect: boolean;
}

function uuidLabel(uuid: BleUuid): string {
  return uuidName(uuid) ?? (typeof uuid === 'number' ? `0x${uuid.toString(16).padStart(4, '0')}` : uuid);
}

function isRetryable(error: unknown): boolean {
  if (error instanceof TimeoutError) return true;
  if (!(error instanceof Error)) return false;
  return (
    ['NetworkError', 'UnknownError', 'InvalidStateError'].includes(error.name) ||
    /gatt|in progress|connection attempt failed/i.test(error.message)
  );
}

/**
 * Shared connection handling: connect with timeout and retries, a serialised
 * GATT queue, notification bookkeeping, and automatic reconnects.
 */
export abstract class BaseDevice<E extends BaseDeviceEvents> extends TypedEmitter<E> {
  protected readonly transport: BleTransport;
  protected readonly gatt = new GattQueue((trace) => this.emitBase('gattOperation', trace));
  readonly #connectTimeoutMs: number;
  readonly #connectRetries: number;
  readonly #connectRetryDelayMs: number;
  protected readonly operationTimeoutMs: number;
  readonly #reconnect: ReconnectOptions;

  #state: ConnectionState = 'disconnected';
  #peripheral: BlePeripheral | undefined;
  #offDisconnected: Unsubscribe | undefined;
  #subscriptions: Unsubscribe[] = [];
  #establishing = false;
  #userDisconnect = false;
  #reconnectAttempt = 0;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: BaseDeviceOptions = {}) {
    super();
    this.transport = options.transport ?? new WebBluetoothTransport();
    this.#connectTimeoutMs = options.connectTimeoutMs ?? 15_000;
    this.#connectRetries = options.connectRetries ?? 2;
    this.#connectRetryDelayMs = options.connectRetryDelayMs ?? 600;
    this.operationTimeoutMs = options.operationTimeoutMs ?? 10_000;
    this.#reconnect = {
      enabled: true,
      maxAttempts: 10,
      initialDelayMs: 1_000,
      maxDelayMs: 30_000,
      ...options.reconnect,
    };
  }

  get connectionState(): ConnectionState {
    return this.#state;
  }

  get isReady(): boolean {
    return this.#state === 'ready';
  }

  /** The selected peripheral (kept while reconnecting). */
  get peripheral(): BlePeripheral | undefined {
    return this.#peripheral;
  }

  get deviceName(): string | undefined {
    return this.#peripheral?.name;
  }

  /** Filters and optional services for the device chooser. */
  protected abstract deviceRequest(): DeviceRequest;

  /** Discover services, read static values, subscribe. Runs on every (re)connect. */
  protected abstract setup(peripheral: BlePeripheral, context: SessionContext): Promise<void>;

  /** Runs after the state became `ready` (e.g. request control). Must not throw. */
  protected async afterReady(_context: SessionContext): Promise<void> {}

  /** The session ended (link lost or user disconnect): reject pending work, stop timers. */
  protected abstract sessionEnded(reason: OpenFtmsError): void;

  /**
   * Connects to `peripheral`, or opens the device chooser if omitted.
   * Web Bluetooth: call directly from a user gesture (click handler).
   */
  async connect(peripheral?: BlePeripheral): Promise<void> {
    if (this.#state !== 'disconnected') {
      throw new ConnectionError(`Cannot connect while ${this.#state}`);
    }
    this.#userDisconnect = false;
    const target = peripheral ?? (await this.transport.requestDevice(this.deviceRequest()));
    this.#attach(target);
    try {
      await this.#establish({ isReconnect: false });
    } catch (error) {
      const err = wrapError(ConnectionError, 'Connect failed', error);
      this.#endSession(err);
      this.#detach();
      try {
        target.disconnect();
      } catch {
        // ignore
      }
      this.#setState('disconnected', err);
      throw err;
    }
  }

  /**
   * Connects to a device the user already picked in an earlier visit, without
   * the chooser (and without a user gesture). Store `trainer.peripheral.id`
   * after a successful {@link connect} and pass it here next time.
   *
   * Returns `false` if the browser does not know the device (permission not
   * persisted, or `getDevices()` unsupported) — fall back to {@link connect}
   * from a click handler then. Throws a ConnectionError if the device does
   * not advertise within `advertisementTimeoutMs` (switched off, out of range)
   * or the connection fails.
   */
  async connectKnown(id: string, options: { advertisementTimeoutMs?: number } = {}): Promise<boolean> {
    if (this.#state !== 'disconnected') {
      throw new ConnectionError(`Cannot connect while ${this.#state}`);
    }
    const known = await this.transport.getKnownDevices();
    const peripheral = known.find((p) => p.id === id);
    if (!peripheral) return false;
    if (peripheral.waitForAdvertisement) {
      const seen = await peripheral.waitForAdvertisement(options.advertisementTimeoutMs ?? 10_000);
      if (!seen) throw new ConnectionError('Device not found: it is not advertising (switched off or out of range?)');
    }
    await this.connect(peripheral);
    return true;
  }

  /** User-initiated disconnect; never triggers a reconnect. */
  async disconnect(): Promise<void> {
    this.#userDisconnect = true;
    this.#clearReconnectTimer();
    const peripheral = this.#peripheral;
    this.#endSession(new ConnectionError('Disconnected by user'));
    this.#detach();
    try {
      peripheral?.disconnect();
    } catch {
      // ignore
    }
    this.#setState('disconnected');
  }

  // -------------------------------------------------------------------------
  // Helpers for subclasses
  // -------------------------------------------------------------------------

  protected emitBase<K extends keyof BaseDeviceEvents>(event: K, payload: BaseDeviceEvents[K]): void {
    this.emit(event, payload as E[K]);
  }

  protected reportError(error: unknown, context: string): void {
    this.emitBase('error', wrapError(OpenFtmsError, context, error));
  }

  protected requireReady(): BlePeripheral {
    const p = this.#peripheral;
    if (this.#state !== 'ready' || !p) throw new NotConnectedError(`Device is not ready (${this.#state})`);
    return p;
  }

  protected async getService(peripheral: BlePeripheral, uuid: BleUuid): Promise<BleService | undefined> {
    return this.gatt.run(`getService ${uuidLabel(uuid)}`, () => peripheral.getService(uuid), this.operationTimeoutMs);
  }

  protected async getCharacteristic(
    service: BleService | undefined,
    uuid: BleUuid,
  ): Promise<BleCharacteristic | undefined> {
    if (!service) return undefined;
    return this.gatt.run(
      `getCharacteristic ${uuidLabel(uuid)}`,
      () => service.getCharacteristic(uuid),
      this.operationTimeoutMs,
    );
  }

  protected async readValue(characteristic: BleCharacteristic): Promise<Uint8Array> {
    const name = this.#nameOf(characteristic);
    try {
      const value = await this.gatt.run(`read ${name}`, () => characteristic.read(), this.operationTimeoutMs);
      const bytes = toBytes(value);
      this.#emitRaw('in', 'read', characteristic, bytes);
      return bytes;
    } catch (error) {
      throw wrapError(GattOperationError, `Reading ${name} failed`, error);
    }
  }

  /** Like {@link readValue}, but returns `undefined` (and reports) on failure. */
  protected async tryReadValue(characteristic: BleCharacteristic | undefined): Promise<Uint8Array | undefined> {
    if (!characteristic?.properties.read) return undefined;
    try {
      return await this.readValue(characteristic);
    } catch (error) {
      this.reportError(error, 'Optional read failed');
      return undefined;
    }
  }

  /** Reads the Device Information Service (0x180A), if offered. */
  protected readDeviceInformation(peripheral: BlePeripheral): Promise<DeviceInformation> {
    return readDeviceInformation(
      {
        getService: (p, uuid) => this.getService(p, uuid),
        getCharacteristic: (s, uuid) => this.getCharacteristic(s, uuid),
        tryReadValue: (c) => this.tryReadValue(c),
      },
      peripheral,
    );
  }

  protected async writeValue(characteristic: BleCharacteristic, bytes: Uint8Array, withResponse = true): Promise<void> {
    const name = this.#nameOf(characteristic);
    this.#emitRaw('out', 'write', characteristic, bytes);
    try {
      await this.gatt.run(`write ${name}`, () => characteristic.write(bytes, withResponse), this.operationTimeoutMs);
    } catch (error) {
      throw wrapError(GattOperationError, `Writing ${name} failed`, error);
    }
  }

  /** Registers `handler` and enables notifications/indications. Cleared automatically per session. */
  protected async subscribe(characteristic: BleCharacteristic, handler: (bytes: Uint8Array) => void): Promise<void> {
    const name = this.#nameOf(characteristic);
    const off = characteristic.onValue((value) => {
      const bytes = toBytes(value);
      this.#emitRaw('in', 'notification', characteristic, bytes);
      try {
        handler(bytes);
      } catch (error) {
        this.reportError(error, `Handling ${name} failed`);
      }
    });
    this.#subscriptions.push(off);
    try {
      await this.gatt.run(`subscribe ${name}`, () => characteristic.startNotifications(), this.operationTimeoutMs);
    } catch (error) {
      throw wrapError(GattOperationError, `Subscribing to ${name} failed`, error);
    }
  }

  // -------------------------------------------------------------------------
  // Connection lifecycle
  // -------------------------------------------------------------------------

  #attach(peripheral: BlePeripheral): void {
    this.#detach();
    this.#peripheral = peripheral;
    this.#offDisconnected = peripheral.onDisconnected(() => this.#handleLinkLoss());
  }

  #detach(): void {
    this.#offDisconnected?.();
    this.#offDisconnected = undefined;
    this.#peripheral = undefined;
  }

  async #establish(context: SessionContext): Promise<void> {
    const peripheral = this.#peripheral;
    if (!peripheral) throw new ConnectionError('No peripheral selected');
    this.#establishing = true;
    try {
      for (let attempt = 0; ; attempt++) {
        this.#setState(context.isReconnect ? 'reconnecting' : 'connecting');
        await this.#connectWithRetry(peripheral);
        this.#setState('discovering');
        this.gatt.reset();
        try {
          await this.setup(peripheral, context);
          if (this.#userDisconnect) throw new ConnectionError('Disconnected by user');
          if (!peripheral.connected) throw new ConnectionError('Connection lost during setup');
          break;
        } catch (error) {
          // The link often drops right after connecting (Windows, or another tab
          // releasing the device). Retry connect + discovery as one unit.
          const linkLost = !peripheral.connected || isRetryable(error);
          if (this.#userDisconnect || !linkLost || attempt >= this.#connectRetries) throw error;
          this.#endSession(wrapError(ConnectionError, 'Connection lost during discovery', error));
          this.reportError(error, `Connection lost during discovery, retrying (${attempt + 1}/${this.#connectRetries})`);
          try {
            peripheral.disconnect();
          } catch {
            // ignore
          }
          // Growing pause: a trainer that just dropped the link often needs a moment.
          await delay(this.#connectRetryDelayMs * 2 ** attempt);
        }
      }
    } finally {
      this.#establishing = false;
    }
    this.#setState('ready');
    await this.afterReady(context);
  }

  async #connectWithRetry(peripheral: BlePeripheral): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await withTimeout(peripheral.connect(), this.#connectTimeoutMs, 'GATT connect timed out');
        return;
      } catch (error) {
        try {
          peripheral.disconnect();
        } catch {
          // ignore
        }
        if (this.#userDisconnect) throw new ConnectionError('Disconnected by user');
        if (attempt >= this.#connectRetries || !isRetryable(error)) throw error;
        await delay(this.#connectRetryDelayMs);
      }
    }
  }

  #handleLinkLoss(): void {
    if (this.#establishing || this.#userDisconnect) return;
    if (this.#state !== 'ready') return;
    const reason = new ConnectionError('Connection lost');
    this.#endSession(reason);
    if (!this.#reconnect.enabled) {
      this.#detach();
      this.#setState('disconnected', reason);
      return;
    }
    this.#reconnectAttempt = 0;
    this.#setState('reconnecting', reason);
    this.#scheduleReconnect();
  }

  #scheduleReconnect(): void {
    const { maxAttempts, initialDelayMs, maxDelayMs } = this.#reconnect;
    if (this.#reconnectAttempt >= maxAttempts) {
      const error = new ConnectionError(`Reconnect failed after ${maxAttempts} attempts`);
      this.#detach();
      this.emitBase('error', error);
      this.#setState('disconnected', error);
      return;
    }
    const delayMs = Math.min(initialDelayMs * 2 ** this.#reconnectAttempt, maxDelayMs);
    this.#reconnectAttempt++;
    this.emitBase('reconnectScheduled', { attempt: this.#reconnectAttempt, maxAttempts, delayMs });
    this.#reconnectTimer = setTimeout(() => void this.#attemptReconnect(), delayMs);
  }

  async #attemptReconnect(): Promise<void> {
    this.#reconnectTimer = undefined;
    if (this.#userDisconnect || !this.#peripheral) return;
    try {
      await this.#establish({ isReconnect: true });
      this.#reconnectAttempt = 0;
    } catch (error) {
      if (this.#userDisconnect) return;
      this.#endSession(wrapError(ConnectionError, 'Reconnect attempt failed', error));
      try {
        this.#peripheral?.disconnect();
      } catch {
        // ignore
      }
      this.#setState('reconnecting');
      this.#scheduleReconnect();
    }
  }

  #clearReconnectTimer(): void {
    if (this.#reconnectTimer !== undefined) clearTimeout(this.#reconnectTimer);
    this.#reconnectTimer = undefined;
  }

  #endSession(reason: OpenFtmsError): void {
    for (const off of this.#subscriptions) off();
    this.#subscriptions = [];
    this.gatt.reset();
    this.sessionEnded(reason);
  }

  #setState(state: ConnectionState, error?: OpenFtmsError): void {
    const previous = this.#state;
    if (previous === state) return;
    this.#state = state;
    this.emitBase('connectionStateChange', { state, previous, ...(error ? { error } : {}) });
  }

  #nameOf(characteristic: BleCharacteristic): string {
    return uuidName(characteristic.uuid) ?? characteristic.uuid;
  }

  #emitRaw(direction: 'in' | 'out', kind: RawPacket['kind'], characteristic: BleCharacteristic, bytes: Uint8Array): void {
    this.emitBase('raw', {
      direction,
      kind,
      uuid: characteristic.uuid,
      characteristic: this.#nameOf(characteristic),
      bytes,
      hex: toHex(bytes),
      timestamp: Date.now(),
    });
  }
}
