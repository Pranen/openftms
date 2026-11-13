import { ConnectionError, type OpenFtmsError } from '../errors';
import { parseHeartRateMeasurement, type HeartRateMeasurement, type SensorContact } from '../protocol/hrs/heart-rate-measurement';
import { CHARACTERISTIC, SERVICE } from '../protocol/uuids';
import type { BlePeripheral, DeviceRequest } from '../transport/transport';
import { BaseDevice, type BaseDeviceEvents, type BaseDeviceOptions, type ConnectionState } from './base-device';
import type { DeviceInformation } from './device-information';

export const BODY_SENSOR_LOCATIONS = ['other', 'chest', 'wrist', 'finger', 'hand', 'earLobe', 'foot'] as const;
export type BodySensorLocation = (typeof BODY_SENSOR_LOCATIONS)[number] | 'unknown';

export interface HeartRateSnapshot {
  readonly connection: ConnectionState;
  readonly heartRateBpm?: number;
  readonly sensorContact?: SensorContact;
  /** RR intervals of the last packet in ms. */
  readonly rrIntervalsMs?: readonly number[];
  readonly energyExpendedKj?: number;
  readonly bodySensorLocation?: BodySensorLocation;
  readonly deviceInformation?: DeviceInformation;
  readonly updatedAt?: number;
}

export interface HeartRateMonitorEvents extends BaseDeviceEvents {
  heartRate: HeartRateMeasurement;
}

/** Standard BLE heart-rate strap (Heart Rate Service 0x180D). */
export class HeartRateMonitor extends BaseDevice<HeartRateMonitorEvents> {
  #last: HeartRateMeasurement | undefined;
  #updatedAt: number | undefined;
  #bodySensorLocation: BodySensorLocation | undefined;
  #deviceInformation: DeviceInformation | undefined;

  constructor(options: BaseDeviceOptions = {}) {
    super(options);
  }

  get heartRateBpm(): number | undefined {
    return this.#last?.heartRateBpm;
  }

  get snapshot(): HeartRateSnapshot {
    const last = this.#last;
    return {
      connection: this.connectionState,
      ...(last?.heartRateBpm !== undefined ? { heartRateBpm: last.heartRateBpm } : {}),
      ...(last ? { sensorContact: last.sensorContact, rrIntervalsMs: last.rrIntervalsMs } : {}),
      ...(last?.energyExpendedKj !== undefined ? { energyExpendedKj: last.energyExpendedKj } : {}),
      ...(this.#bodySensorLocation ? { bodySensorLocation: this.#bodySensorLocation } : {}),
      ...(this.#deviceInformation ? { deviceInformation: this.#deviceInformation } : {}),
      ...(this.#updatedAt !== undefined ? { updatedAt: this.#updatedAt } : {}),
    };
  }

  protected deviceRequest(): DeviceRequest {
    return {
      filters: [{ services: [SERVICE.heartRate] }],
      optionalServices: [SERVICE.deviceInformation],
    };
  }

  protected async setup(peripheral: BlePeripheral): Promise<void> {
    const hrs = await this.getService(peripheral, SERVICE.heartRate);
    if (!hrs) throw new ConnectionError('Device does not offer the Heart Rate Service (0x180D)');
    const measurement = await this.getCharacteristic(hrs, CHARACTERISTIC.heartRateMeasurement);
    if (!measurement) throw new ConnectionError('Heart Rate Measurement (0x2A37) not found');

    const location = await this.tryReadValue(await this.getCharacteristic(hrs, CHARACTERISTIC.bodySensorLocation));
    if (location && location.length > 0) {
      this.#bodySensorLocation = BODY_SENSOR_LOCATIONS[location[0] ?? 0xff] ?? 'unknown';
    }
    this.#deviceInformation = await this.readDeviceInformation(peripheral);

    await this.subscribe(measurement, (bytes) => {
      const hr = parseHeartRateMeasurement(bytes);
      this.#last = hr;
      this.#updatedAt = Date.now();
      this.emit('heartRate', hr);
    });
  }

  protected sessionEnded(_reason: OpenFtmsError): void {}
}
