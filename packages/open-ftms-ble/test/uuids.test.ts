import { describe, expect, it } from 'vitest';
import { CHARACTERISTIC, SERVICE, toFullUuid, uuidName } from '../src/index.js';

describe('uuids', () => {
  it('expands 16-bit UUIDs', () => {
    expect(toFullUuid(SERVICE.fitnessMachine)).toBe('00001826-0000-1000-8000-00805f9b34fb');
  });

  it('names known UUIDs in both forms', () => {
    expect(uuidName(CHARACTERISTIC.indoorBikeData)).toBe('indoorBikeData');
    expect(uuidName('00002AD9-0000-1000-8000-00805F9B34FB')).toBe('fitnessMachineControlPoint');
    expect(uuidName(0x1234)).toBeUndefined();
  });
});
