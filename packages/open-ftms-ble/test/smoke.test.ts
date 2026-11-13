import { describe, expect, it } from 'vitest';
import { LIBRARY_NAME, isWebBluetoothAvailable } from '../src/index.js';

describe('scaffolding', () => {
  it('exports library metadata', () => {
    expect(LIBRARY_NAME).toBe('open-ftms-ble');
  });

  it('reports Web Bluetooth as unavailable in Node', () => {
    expect(isWebBluetoothAvailable()).toBe(false);
  });
});

describe('package metadata', () => {
  it('LIBRARY_VERSION matches package.json', async () => {
    const { readFile } = await import('node:fs/promises');
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string };
    const { LIBRARY_VERSION } = await import('../src/index.js');
    expect(LIBRARY_VERSION).toBe(pkg.version);
  });
});
