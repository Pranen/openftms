/**
 * open-ftms-ble — zero-dependency Web Bluetooth library for FTMS trainers
 * and BLE heart-rate monitors.
 *
 * Layers (dependencies point downwards only):
 *   devices/   high-level device API (FtmsTrainer, HeartRateMonitor)
 *   protocol/  pure parsers/encoders (bytes <-> typed objects, no BLE)
 *   transport/ BLE access (Web Bluetooth, mock)
 *   simulator/, replay/  software devices and recorded sessions on the mock transport
 */

export * from './errors.js';
export * from './events/typed-emitter.js';
export * from './protocol/index.js';
export * from './transport/index.js';
export * from './devices/index.js';
export * from './simulator/index.js';
export * from './replay/index.js';
export { delay, withTimeout } from './util/async.js';

export const LIBRARY_NAME = 'open-ftms-ble';
export const LIBRARY_VERSION = '0.1.0';

/** True if the current runtime exposes the Web Bluetooth API. */
export function isWebBluetoothAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'bluetooth' in navigator;
}
