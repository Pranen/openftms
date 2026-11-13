/**
 * open-ftms-ble — zero-dependency Web Bluetooth library for FTMS trainers
 * and BLE heart-rate monitors.
 *
 * Layers (dependencies point downwards only):
 *   devices/   high-level device API (FtmsTrainer, HeartRateMonitor)
 *   protocol/  pure parsers/encoders (bytes <-> typed objects, no BLE)
 *   transport/ BLE access (Web Bluetooth, mock/replay)
 */

export * from './errors';
export * from './protocol';

export const LIBRARY_NAME = 'open-ftms-ble';
export const LIBRARY_VERSION = '0.0.0';

/** True if the current runtime exposes the Web Bluetooth API. */
export function isWebBluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}
