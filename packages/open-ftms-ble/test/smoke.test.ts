import { describe, expect, it } from 'vitest';
import { LIBRARY_NAME, isWebBluetoothAvailable } from '../src/index';

describe('scaffolding', () => {
  it('exports library metadata', () => {
    expect(LIBRARY_NAME).toBe('open-ftms-ble');
  });

  it('reports Web Bluetooth as unavailable in Node', () => {
    expect(isWebBluetoothAvailable()).toBe(false);
  });
});
