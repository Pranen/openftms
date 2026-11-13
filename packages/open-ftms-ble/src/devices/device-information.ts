import { CHARACTERISTIC, SERVICE } from '../protocol/uuids';
import type { BleCharacteristic, BlePeripheral, BleService, BleUuid } from '../transport/transport';

/** Device Information Service (0x180A) strings; fields are absent if not offered. */
export interface DeviceInformation {
  manufacturerName?: string;
  modelNumber?: string;
  serialNumber?: string;
  hardwareRevision?: string;
  firmwareRevision?: string;
  softwareRevision?: string;
}

/** GATT access used for reading; supplied by the device so its queue stays in charge. */
export interface GattReader {
  getService(peripheral: BlePeripheral, uuid: BleUuid): Promise<BleService | undefined>;
  getCharacteristic(service: BleService | undefined, uuid: BleUuid): Promise<BleCharacteristic | undefined>;
  tryReadValue(characteristic: BleCharacteristic | undefined): Promise<Uint8Array | undefined>;
}

const FIELDS: ReadonlyArray<[keyof DeviceInformation, number]> = [
  ['manufacturerName', CHARACTERISTIC.manufacturerName],
  ['modelNumber', CHARACTERISTIC.modelNumber],
  ['serialNumber', CHARACTERISTIC.serialNumber],
  ['hardwareRevision', CHARACTERISTIC.hardwareRevision],
  ['firmwareRevision', CHARACTERISTIC.firmwareRevision],
  ['softwareRevision', CHARACTERISTIC.softwareRevision],
];

export async function readDeviceInformation(reader: GattReader, peripheral: BlePeripheral): Promise<DeviceInformation> {
  const info: DeviceInformation = {};
  const service = await reader.getService(peripheral, SERVICE.deviceInformation);
  if (!service) return info;
  const decoder = new TextDecoder();
  for (const [field, uuid] of FIELDS) {
    const bytes = await reader.tryReadValue(await reader.getCharacteristic(service, uuid));
    if (bytes && bytes.length > 0) info[field] = decoder.decode(bytes).replace(/\0+$/, '').trim();
  }
  return info;
}
