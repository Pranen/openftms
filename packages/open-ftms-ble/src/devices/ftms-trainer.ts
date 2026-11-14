import {
  ConnectionError,
  ControlPointError,
  NotConnectedError,
  OpenFtmsError,
  UnsupportedFeatureError,
} from '../errors.js';
import {
  DEFAULT_SIMULATION_PARAMETERS,
  encodeRequestControl,
  encodeReset,
  encodeSetIndoorBikeSimulation,
  encodeSetTargetPower,
  encodeSetTargetResistanceLevel,
  encodeStartOrResume,
  encodeStopOrPause,
  type ControlPointResponse,
  type IndoorBikeSimulationParameters,
  type ResistanceEncoding,
} from '../protocol/ftms/control-point.js';
import { parseFitnessMachineFeatures, type FitnessMachineFeatures, type TargetSettingFeatures } from '../protocol/ftms/features.js';
import { parseIndoorBikeData, type IndoorBikeData } from '../protocol/ftms/indoor-bike-data.js';
import { parseMachineStatus, type MachineStatus } from '../protocol/ftms/machine-status.js';
import {
  parseSupportedHeartRateRange,
  parseSupportedInclinationRange,
  parseSupportedPowerRange,
  parseSupportedResistanceLevelRange,
  parseSupportedSpeedRange,
  type SupportedRange,
  type SupportedResistanceLevelRange,
} from '../protocol/ftms/supported-ranges.js';
import { parseTrainingStatus, type TrainingStatus } from '../protocol/ftms/training-status.js';
import { CHARACTERISTIC, SERVICE } from '../protocol/uuids.js';
import type { BleCharacteristic, BlePeripheral, DeviceRequest } from '../transport/transport.js';
import { BaseDevice, type BaseDeviceEvents, type BaseDeviceOptions, type ConnectionState } from './base-device.js';
import { ControlPointClient } from './control-point-client.js';
import type { DeviceInformation } from './device-information.js';

export interface FtmsTrainerOptions extends BaseDeviceOptions {
  /** Request control after every (re)connect and before commands. Default true. */
  autoRequestControl?: boolean;
  /** After a reconnect, re-send the last ERG/simulation/resistance target. Default true. */
  restoreOnReconnect?: boolean;
  /** Interval for re-requesting control while another app holds it. Default 10000 ms. */
  controlRetryIntervalMs?: number;
  /** Timeout for a control point response (0x80 indication). Default 3000 ms. */
  commandTimeoutMs?: number;
  /** Clamp targets to the supported power/resistance range. Default true. */
  clampToSupportedRange?: boolean;
  /** Width of the Resistance Level field in Indoor Bike Data. Default `sint16`. */
  resistanceLevelEncoding?: 'sint16' | 'uint8';
  /**
   * Factor from the raw Indoor Bike Data Resistance Level to
   * `telemetry.resistanceLevel`, so it matches {@link FtmsTrainer.setResistanceLevel}.
   * Default: 0.1 for `sint16` (the Tacx Flux 2 sends tenths: target 18.6 → 186),
   * 1 for `uint8`. `indoorBikeData.resistanceLevel` always stays raw.
   */
  resistanceLevelScale?: number;
  /** Wire format for Set Target Resistance Level. Default `sint16`. */
  targetResistanceEncoding?: ResistanceEncoding;
}

/**
 * - `none`: control not held.
 * - `requesting`: Request Control sent, waiting for the answer.
 * - `granted`: commands are accepted.
 * - `blocked`: the trainer refused (typically another app holds control).
 */
export type ControlState = 'none' | 'requesting' | 'granted' | 'blocked';

export type TrainerMode =
  | { readonly kind: 'none' }
  | { readonly kind: 'erg'; readonly targetPowerW: number }
  | { readonly kind: 'simulation'; readonly parameters: IndoorBikeSimulationParameters }
  | { readonly kind: 'resistance'; readonly level: number };

export interface FtmsCapabilities {
  readonly features?: FitnessMachineFeatures;
  readonly powerRange?: SupportedRange;
  readonly resistanceRange?: SupportedResistanceLevelRange;
  readonly inclinationRange?: SupportedRange;
  readonly speedRange?: SupportedRange;
  readonly heartRateRange?: SupportedRange;
  readonly characteristics: {
    readonly indoorBikeData: boolean;
    readonly controlPoint: boolean;
    readonly machineStatus: boolean;
    readonly trainingStatus: boolean;
  };
  /** The device also offers the Cycling Power Service (0x1818). `false` until {@link complete}. */
  readonly hasCyclingPowerService: boolean;
  /** Empty until {@link complete}. */
  readonly deviceInformation: DeviceInformation;
  /**
   * `false` right after connecting: only the features (0x2ACC) and the
   * characteristic list are known. Ranges, device information and the
   * Cycling Power check are read after `ready` (they cost ~300 ms each on a
   * real trainer); a second `capabilities` event follows with `complete: true`.
   */
  readonly complete: boolean;
}

/** Static values that do not change between reconnects to the same device. */
interface DeviceDetails {
  readonly peripheralId: string;
  readonly powerRange?: SupportedRange;
  readonly resistanceRange?: SupportedResistanceLevelRange;
  readonly inclinationRange?: SupportedRange;
  readonly speedRange?: SupportedRange;
  readonly heartRateRange?: SupportedRange;
  readonly hasCyclingPowerService: boolean;
  readonly deviceInformation: DeviceInformation;
}

/** Latest known values, merged across Indoor Bike Data packets. */
export interface TrainerTelemetry {
  speedKmh?: number;
  averageSpeedKmh?: number;
  cadenceRpm?: number;
  averageCadenceRpm?: number;
  powerW?: number;
  averagePowerW?: number;
  totalDistanceM?: number;
  /** Same unit as `setResistanceLevel()` (see `resistanceLevelScale`). */
  resistanceLevel?: number;
  totalEnergyKcal?: number | null;
  energyPerHourKcal?: number | null;
  energyPerMinuteKcal?: number | null;
  heartRateBpm?: number;
  metabolicEquivalent?: number;
  elapsedTimeS?: number;
  remainingTimeS?: number;
  /** `Date.now()` of the last Indoor Bike Data packet. */
  updatedAt?: number;
}

export interface FtmsTrainerSnapshot {
  readonly connection: ConnectionState;
  readonly control: ControlState;
  readonly mode: TrainerMode;
  readonly telemetry: Readonly<TrainerTelemetry>;
  readonly capabilities: FtmsCapabilities | undefined;
  readonly machineStatus: MachineStatus | undefined;
  readonly trainingStatus: TrainingStatus | undefined;
}

export interface FtmsTrainerEvents extends BaseDeviceEvents {
  indoorBikeData: IndoorBikeData;
  /** Merged snapshot after each Indoor Bike Data packet. */
  telemetry: Readonly<TrainerTelemetry>;
  machineStatus: MachineStatus;
  trainingStatus: TrainingStatus;
  /** Every control point response, including unsolicited ones. */
  controlPointResponse: ControlPointResponse;
  controlStateChange: { state: ControlState; previous: ControlState };
  modeChange: TrainerMode;
  capabilities: FtmsCapabilities;
}

const TELEMETRY_FIELDS: ReadonlyArray<[keyof IndoorBikeData, keyof TrainerTelemetry]> = [
  ['instantaneousSpeedKmh', 'speedKmh'],
  ['averageSpeedKmh', 'averageSpeedKmh'],
  ['instantaneousCadenceRpm', 'cadenceRpm'],
  ['averageCadenceRpm', 'averageCadenceRpm'],
  ['instantaneousPowerW', 'powerW'],
  ['averagePowerW', 'averagePowerW'],
  ['totalDistanceM', 'totalDistanceM'],
  ['resistanceLevel', 'resistanceLevel'],
  ['totalEnergyKcal', 'totalEnergyKcal'],
  ['energyPerHourKcal', 'energyPerHourKcal'],
  ['energyPerMinuteKcal', 'energyPerMinuteKcal'],
  ['heartRateBpm', 'heartRateBpm'],
  ['metabolicEquivalent', 'metabolicEquivalent'],
  ['elapsedTimeS', 'elapsedTimeS'],
  ['remainingTimeS', 'remainingTimeS'],
];

function clamp(value: number, range: SupportedRange | undefined): number {
  if (!range || range.minimum === undefined || range.maximum === undefined) return value;
  if (range.minimum > range.maximum) return value; // implausible range — ignore
  return Math.min(range.maximum, Math.max(range.minimum, value));
}

/**
 * FTMS indoor bike trainer (e.g. Tacx Flux 2).
 *
 * ```ts
 * const trainer = new FtmsTrainer();
 * trainer.on('telemetry', (t) => console.log(t.powerW, t.cadenceRpm));
 * button.onclick = () => trainer.connect();   // user gesture
 * await trainer.setTargetPower(200);           // ERG
 * await trainer.setSimulation({ gradePercent: 4 });
 * ```
 */
export class FtmsTrainer extends BaseDevice<FtmsTrainerEvents> {
  readonly #autoRequestControl: boolean;
  readonly #restoreOnReconnect: boolean;
  readonly #controlRetryIntervalMs: number;
  readonly #commandTimeoutMs: number;
  readonly #clampToRange: boolean;
  readonly #resistanceLevelEncoding: 'sint16' | 'uint8';
  readonly #resistanceLevelScale: number;
  readonly #targetResistanceEncoding: ResistanceEncoding;

  #controlPoint: ControlPointClient | undefined;
  #control: ControlState = 'none';
  #controlRequest: Promise<void> | undefined;
  #controlRetryTimer: ReturnType<typeof setTimeout> | undefined;
  #mode: TrainerMode = { kind: 'none' };
  #lastSimulation: IndoorBikeSimulationParameters = { ...DEFAULT_SIMULATION_PARAMETERS };
  #telemetry: TrainerTelemetry = {};
  #capabilities: FtmsCapabilities | undefined;
  #details: DeviceDetails | undefined;
  #readCharacteristic: ((uuid: number) => Promise<BleCharacteristic | undefined>) | undefined;
  #machineStatus: MachineStatus | undefined;
  #trainingStatus: TrainingStatus | undefined;

  constructor(options: FtmsTrainerOptions = {}) {
    super(options);
    this.#autoRequestControl = options.autoRequestControl ?? true;
    this.#restoreOnReconnect = options.restoreOnReconnect ?? true;
    this.#controlRetryIntervalMs = options.controlRetryIntervalMs ?? 10_000;
    this.#commandTimeoutMs = options.commandTimeoutMs ?? 3_000;
    this.#clampToRange = options.clampToSupportedRange ?? true;
    this.#resistanceLevelEncoding = options.resistanceLevelEncoding ?? 'sint16';
    this.#resistanceLevelScale = options.resistanceLevelScale ?? (this.#resistanceLevelEncoding === 'sint16' ? 0.1 : 1);
    this.#targetResistanceEncoding = options.targetResistanceEncoding ?? 'sint16';
  }

  // -------------------------------------------------------------------------
  // State
  // -------------------------------------------------------------------------

  get control(): ControlState {
    return this.#control;
  }

  get mode(): TrainerMode {
    return this.#mode;
  }

  get telemetry(): Readonly<TrainerTelemetry> {
    return this.#telemetry;
  }

  get capabilities(): FtmsCapabilities | undefined {
    return this.#capabilities;
  }

  /** Synchronous snapshot, e.g. for a game loop. */
  get snapshot(): FtmsTrainerSnapshot {
    return {
      connection: this.connectionState,
      control: this.#control,
      mode: this.#mode,
      telemetry: this.#telemetry,
      capabilities: this.#capabilities,
      machineStatus: this.#machineStatus,
      trainingStatus: this.#trainingStatus,
    };
  }

  /** True unless 0x2ACC was read and explicitly lacks the target setting. */
  supports(target: keyof TargetSettingFeatures): boolean {
    const features = this.#capabilities?.features;
    return features ? features.targetSetting[target] : true;
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  /** Requests control. Concurrent calls share one request. */
  requestControl(): Promise<void> {
    this.#controlRequest ??= this.#doRequestControl().finally(() => {
      this.#controlRequest = undefined;
    });
    return this.#controlRequest;
  }

  /** ERG mode. Clamped to the supported power range unless disabled. */
  async setTargetPower(watts: number): Promise<void> {
    this.#requireTarget('powerTarget', 'target power (ERG)');
    const target = this.#clampToRange ? clamp(Math.round(watts), this.#capabilities?.powerRange) : watts;
    await this.#command(encodeSetTargetPower(target), 'power');
    this.#setMode({ kind: 'erg', targetPowerW: target });
  }

  /** Simulation mode; omitted fields keep their last value (defaults: crr 0.004, cw 0.51). */
  async setSimulation(parameters: Partial<IndoorBikeSimulationParameters>): Promise<void> {
    this.#requireTarget('indoorBikeSimulation', 'indoor bike simulation');
    const merged = { ...this.#lastSimulation, ...parameters };
    await this.#command(encodeSetIndoorBikeSimulation(merged), 'simulation');
    this.#lastSimulation = merged;
    this.#setMode({ kind: 'simulation', parameters: merged });
  }

  /** Resistance mode (unitless level, resolution 0.1). */
  async setResistanceLevel(level: number): Promise<void> {
    this.#requireTarget('resistanceTarget', 'target resistance level');
    const target = this.#clampToRange ? clamp(level, this.#capabilities?.resistanceRange) : level;
    await this.#command(encodeSetTargetResistanceLevel(target, this.#targetResistanceEncoding), 'resistance');
    this.#setMode({ kind: 'resistance', level: target });
  }

  async start(): Promise<void> {
    await this.#command(encodeStartOrResume());
  }

  async stop(): Promise<void> {
    await this.#command(encodeStopOrPause('stop'));
  }

  async pause(): Promise<void> {
    await this.#command(encodeStopOrPause('pause'));
  }

  /** Resets the trainer. Control is released by the trainer; re-requested if auto mode is on. */
  async reset(): Promise<void> {
    await this.#command(encodeReset());
    this.#setMode({ kind: 'none' });
    this.#setControl('none');
    if (this.#autoRequestControl) await this.requestControl().catch(() => undefined);
  }

  /** Sends arbitrary control point bytes (debugging). No feature checks, no coalescing. */
  async sendRaw(bytes: Uint8Array): Promise<ControlPointResponse> {
    return this.#command(bytes);
  }

  // -------------------------------------------------------------------------
  // Session
  // -------------------------------------------------------------------------

  protected deviceRequest(): DeviceRequest {
    return {
      filters: [{ services: [SERVICE.fitnessMachine] }],
      optionalServices: [SERVICE.deviceInformation, SERVICE.cyclingPower],
    };
  }

  protected async setup(peripheral: BlePeripheral): Promise<void> {
    const ftms = await this.getService(peripheral, SERVICE.fitnessMachine);
    if (!ftms) throw new ConnectionError('Device does not offer the Fitness Machine Service (0x1826)');

    const lookups = new Map<number, Promise<BleCharacteristic | undefined>>();
    const get = (uuid: number): Promise<BleCharacteristic | undefined> => {
      let lookup = lookups.get(uuid);
      if (!lookup) lookups.set(uuid, (lookup = this.getCharacteristic(ftms, uuid)));
      return lookup;
    };
    const bikeData = await get(CHARACTERISTIC.indoorBikeData);
    const controlPoint = await get(CHARACTERISTIC.fitnessMachineControlPoint);
    const machineStatus = await get(CHARACTERISTIC.fitnessMachineStatus);
    const trainingStatus = await get(CHARACTERISTIC.trainingStatus);

    const features = this.#parse(await this.tryReadValue(await get(CHARACTERISTIC.fitnessMachineFeature)), parseFitnessMachineFeatures);
    this.#readCharacteristic = get;
    const characteristics = {
      indoorBikeData: bikeData !== undefined,
      controlPoint: controlPoint !== undefined,
      machineStatus: machineStatus !== undefined,
      trainingStatus: trainingStatus !== undefined,
    };
    // Reconnect to the same device: the static details are still valid.
    const details = this.#details?.peripheralId === peripheral.id ? this.#details : undefined;
    this.#details = details;
    this.#publishCapabilities(features, characteristics, details);

    // Subscribe to data first: if control is refused later, telemetry still flows.
    if (bikeData && this.#canNotify(bikeData)) await this.subscribe(bikeData, (b) => this.#handleBikeData(b));
    if (machineStatus && this.#canNotify(machineStatus)) {
      await this.subscribe(machineStatus, (b) => this.#handleMachineStatus(b));
    }
    if (trainingStatus && this.#canNotify(trainingStatus)) {
      await this.subscribe(trainingStatus, (b) => this.#handleTrainingStatus(b));
    }
    if (controlPoint) {
      const client = new ControlPointClient((bytes) => this.writeValue(controlPoint, bytes), {
        responseTimeoutMs: this.#commandTimeoutMs,
      });
      await this.subscribe(controlPoint, (bytes) => {
        const response = client.handleIndication(bytes);
        if (response) this.emit('controlPointResponse', response);
      });
      this.#controlPoint = client;
    }
  }

  protected override async afterReady(context: { isReconnect: boolean }): Promise<void> {
    if (this.#autoRequestControl && this.#controlPoint) {
      try {
        await this.requestControl();
        if (context.isReconnect && this.#restoreOnReconnect) await this.#restoreMode();
      } catch {
        // state is 'blocked' or 'none'; the retry timer handles 'blocked'
      }
    }
    await this.#readDetails().catch((error: unknown) => {
      if (this.isReady) this.reportError(error, 'Reading trainer details failed');
    });
  }

  /** Ranges, training status, device information and the CPS check — after `ready`. */
  async #readDetails(): Promise<void> {
    const peripheral = this.peripheral;
    const get = this.#readCharacteristic;
    const current = this.#capabilities;
    if (!peripheral || !get || !current) return;
    const read = async <T>(uuid: number, parse: (b: Uint8Array) => T): Promise<T | undefined> =>
      this.#parse(await this.tryReadValue(await get(uuid)), parse);

    const trainingStatus = await this.tryReadValue(await get(CHARACTERISTIC.trainingStatus));
    if (trainingStatus) this.#handleTrainingStatus(trainingStatus);
    if (this.#details) return; // already known from an earlier session with this device

    const powerRange = await read(CHARACTERISTIC.supportedPowerRange, parseSupportedPowerRange);
    const resistanceRange = await read(CHARACTERISTIC.supportedResistanceLevelRange, parseSupportedResistanceLevelRange);
    const inclinationRange = await read(CHARACTERISTIC.supportedInclinationRange, parseSupportedInclinationRange);
    const speedRange = await read(CHARACTERISTIC.supportedSpeedRange, parseSupportedSpeedRange);
    const heartRateRange = await read(CHARACTERISTIC.supportedHeartRateRange, parseSupportedHeartRateRange);
    const deviceInformation = await this.readDeviceInformation(peripheral);
    const hasCyclingPowerService = (await this.getService(peripheral, SERVICE.cyclingPower)) !== undefined;
    if (!this.isReady || this.peripheral !== peripheral) return;

    this.#details = {
      peripheralId: peripheral.id,
      ...(powerRange ? { powerRange } : {}),
      ...(resistanceRange ? { resistanceRange } : {}),
      ...(inclinationRange ? { inclinationRange } : {}),
      ...(speedRange ? { speedRange } : {}),
      ...(heartRateRange ? { heartRateRange } : {}),
      hasCyclingPowerService,
      deviceInformation,
    };
    this.#publishCapabilities(current.features, current.characteristics, this.#details);
  }

  #publishCapabilities(
    features: FitnessMachineFeatures | undefined,
    characteristics: FtmsCapabilities['characteristics'],
    details: DeviceDetails | undefined,
  ): void {
    const { peripheralId: _id, ...rest } = details ?? { peripheralId: '', hasCyclingPowerService: false, deviceInformation: {} };
    this.#capabilities = {
      ...(features ? { features } : {}),
      ...rest,
      characteristics,
      complete: details !== undefined,
    };
    this.emit('capabilities', this.#capabilities);
  }

  #parse<T>(bytes: Uint8Array | undefined, parse: (b: Uint8Array) => T): T | undefined {
    if (!bytes) return undefined;
    try {
      return parse(bytes);
    } catch (error) {
      this.reportError(error, 'Parsing a static value failed');
      return undefined;
    }
  }

  protected sessionEnded(reason: OpenFtmsError): void {
    this.#controlPoint?.reset(reason);
    this.#controlPoint = undefined;
    this.#readCharacteristic = undefined;
    this.#stopControlRetry();
    this.#setControl('none');
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  #canNotify(c: BleCharacteristic): boolean {
    return c.properties.notify || c.properties.indicate;
  }

  #requireControlPoint(): ControlPointClient {
    this.requireReady();
    const client = this.#controlPoint;
    if (!client) throw new UnsupportedFeatureError('Trainer has no Fitness Machine Control Point (0x2AD9)');
    return client;
  }

  #requireTarget(target: keyof TargetSettingFeatures, label: string): void {
    if (this.isReady && !this.supports(target)) {
      throw new UnsupportedFeatureError(`Trainer does not support ${label} (0x2ACC)`);
    }
  }

  async #command(bytes: Uint8Array, coalesceKey?: string): Promise<ControlPointResponse> {
    this.#requireControlPoint();
    if (this.#autoRequestControl && this.#control !== 'granted' && bytes[0] !== 0x00) {
      await this.requestControl();
    }
    try {
      return await this.#requireControlPoint().send(bytes, coalesceKey);
    } catch (error) {
      // Control silently lost (e.g. trainer reset): re-acquire once and retry.
      if (this.#autoRequestControl && error instanceof ControlPointError && error.result === 'controlNotPermitted') {
        this.#setControl('none');
        await this.requestControl();
        return this.#requireControlPoint().send(bytes, coalesceKey);
      }
      throw error;
    }
  }

  async #doRequestControl(): Promise<void> {
    const client = this.#requireControlPoint();
    this.#setControl('requesting');
    try {
      await client.send(encodeRequestControl());
      this.#setControl('granted');
      this.#stopControlRetry();
    } catch (error) {
      if (error instanceof ControlPointError && error.result === 'controlNotPermitted') {
        this.#setControl('blocked');
        this.#scheduleControlRetry();
      } else if (this.isReady) {
        this.#setControl('none');
      }
      throw error;
    }
  }

  #scheduleControlRetry(): void {
    if (this.#controlRetryTimer !== undefined || !this.#autoRequestControl) return;
    this.#controlRetryTimer = setTimeout(() => {
      this.#controlRetryTimer = undefined;
      if (!this.isReady || this.#control === 'granted') return;
      this.requestControl()
        .then(() => this.#restoreMode())
        .catch(() => undefined);
    }, this.#controlRetryIntervalMs);
  }

  #stopControlRetry(): void {
    if (this.#controlRetryTimer !== undefined) clearTimeout(this.#controlRetryTimer);
    this.#controlRetryTimer = undefined;
  }

  async #restoreMode(): Promise<void> {
    const mode = this.#mode;
    try {
      if (mode.kind === 'erg') await this.setTargetPower(mode.targetPowerW);
      else if (mode.kind === 'simulation') await this.setSimulation(mode.parameters);
      else if (mode.kind === 'resistance') await this.setResistanceLevel(mode.level);
    } catch (error) {
      if (!(error instanceof NotConnectedError)) this.reportError(error, 'Restoring trainer mode failed');
    }
  }

  #setControl(state: ControlState): void {
    const previous = this.#control;
    if (previous === state) return;
    this.#control = state;
    this.emit('controlStateChange', { state, previous });
  }

  #setMode(mode: TrainerMode): void {
    this.#mode = mode;
    this.emit('modeChange', mode);
  }

  #handleBikeData(bytes: Uint8Array): void {
    const data = parseIndoorBikeData(bytes, { resistanceLevelEncoding: this.#resistanceLevelEncoding });
    const next: TrainerTelemetry = { ...this.#telemetry, updatedAt: Date.now() };
    for (const [from, to] of TELEMETRY_FIELDS) {
      const value = data[from];
      if (value !== undefined) (next as Record<string, unknown>)[to] = value;
    }
    if (data.resistanceLevel !== undefined) {
      // Same unit as setResistanceLevel(); rounded to drop float noise (186 × 0.1).
      next.resistanceLevel = Math.round(data.resistanceLevel * this.#resistanceLevelScale * 1000) / 1000;
    }
    this.#telemetry = next;
    this.emit('indoorBikeData', data);
    this.emit('telemetry', next);
  }

  #handleMachineStatus(bytes: Uint8Array): void {
    const status = parseMachineStatus(bytes);
    this.#machineStatus = status;
    this.emit('machineStatus', status);
    if (status.type === 'controlPermissionLost' || status.type === 'reset') {
      if (status.type === 'reset') this.#setMode({ kind: 'none' });
      this.#setControl('none');
      if (this.#autoRequestControl && this.isReady && !this.#controlRequest) {
        // Re-acquire; if another app holds control we end up 'blocked' and retry later.
        this.requestControl()
          .then(() => this.#restoreMode())
          .catch(() => undefined);
      }
    }
  }

  #handleTrainingStatus(bytes: Uint8Array): void {
    const status = parseTrainingStatus(bytes);
    this.#trainingStatus = status;
    this.emit('trainingStatus', status);
  }
}
