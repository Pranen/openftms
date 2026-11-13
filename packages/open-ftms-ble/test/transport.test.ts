import { describe, expect, it } from 'vitest';
import {
  BluetoothUnavailableError,
  CHARACTERISTIC,
  ConnectionError,
  GattQueue,
  MockPeripheral,
  MockTransport,
  SERVICE,
  TimeoutError,
  UserCancelledError,
  WebBluetoothTransport,
  delay,
  toHex,
} from '../src/index.js';

function makePeripheral(latencyMs = 5) {
  return new MockPeripheral({
    name: 'Mock Trainer',
    latencyMs,
    services: [
      {
        uuid: SERVICE.fitnessMachine,
        characteristics: [
          { uuid: CHARACTERISTIC.fitnessMachineFeature, properties: { read: true }, value: [1, 2, 3] },
          {
            uuid: CHARACTERISTIC.fitnessMachineControlPoint,
            properties: { write: true, indicate: true },
            onWrite: (bytes, c) => {
              c.notify([0x80, bytes[0] ?? 0, 0x01]);
            },
          },
        ],
      },
    ],
  });
}

describe('MockTransport', () => {
  it('finds peripherals by service filter', async () => {
    const p = makePeripheral();
    const t = new MockTransport([p]);
    await expect(t.requestDevice({ filters: [{ services: [SERVICE.fitnessMachine] }] })).resolves.toBe(p);
    await expect(t.requestDevice({ filters: [{ services: [SERVICE.heartRate] }] })).rejects.toBeInstanceOf(
      UserCancelledError,
    );
  });

  it('rejects overlapping GATT operations like Chrome', async () => {
    const p = makePeripheral();
    await p.connect();
    const c = p.characteristic(SERVICE.fitnessMachine, CHARACTERISTIC.fitnessMachineFeature);
    const first = c.read();
    await expect(c.read()).rejects.toThrow(/already in progress/);
    expect(toHex(await first)).toBe('01 02 03');
  });

  it('delivers an indication before the write promise resolves', async () => {
    const p = makePeripheral();
    await p.connect();
    const cp = p.characteristic(SERVICE.fitnessMachine, CHARACTERISTIC.fitnessMachineControlPoint);
    const order: string[] = [];
    cp.onValue((v) => order.push(`indication ${v.getUint8(1)}`));
    await cp.startNotifications();
    await cp.write(new Uint8Array([0x05, 0xc8, 0x00])).then(() => order.push('write resolved'));
    expect(order).toEqual(['indication 5', 'write resolved']);
  });

  it('fires disconnected listeners and fails operations afterwards', async () => {
    const p = makePeripheral();
    await p.connect();
    let fired = 0;
    p.onDisconnected(() => fired++);
    p.simulateConnectionLoss();
    expect(fired).toBe(1);
    await expect(p.getService(SERVICE.fitnessMachine)).rejects.toThrow(/disconnected/);
  });

  it('can fail the first connect attempts', async () => {
    const p = new MockPeripheral({ services: [], failConnectTimes: 1 });
    await expect(p.connect()).rejects.toThrow(/Connection attempt failed/);
    await expect(p.connect()).resolves.toBeUndefined();
    expect(p.connectAttempts).toBe(2);
  });
});

describe('GattQueue', () => {
  it('serialises operations so the mock never sees overlap', async () => {
    const p = makePeripheral();
    await p.connect();
    const c = p.characteristic(SERVICE.fitnessMachine, CHARACTERISTIC.fitnessMachineFeature);
    const q = new GattQueue();
    const results = await Promise.all([1, 2, 3, 4].map(() => q.run('read', () => c.read())));
    expect(results).toHaveLength(4);
    expect(q.pending).toBe(0);
  });

  it('keeps going after a failed operation', async () => {
    const q = new GattQueue();
    const a = q.run('a', async () => {
      throw new Error('a failed');
    });
    const b = q.run('b', async () => 'b');
    await expect(a).rejects.toThrow('a failed');
    await expect(b).resolves.toBe('b');
  });

  it('times out slow operations', async () => {
    const q = new GattQueue();
    await expect(q.run('slow', () => delay(50), 10)).rejects.toBeInstanceOf(TimeoutError);
  });

  it('reports the timing of every settled operation', async () => {
    const traces: Array<{ label: string; error?: string }> = [];
    const q = new GattQueue((t) => traces.push(t));
    await q.run('ok', async () => 1);
    await expect(
      q.run('bad', async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    await delay(0);
    expect(traces.map((t) => t.label)).toEqual(['ok', 'bad']);
    expect(traces[0]?.error).toBeUndefined();
    expect(traces[1]?.error).toBe('Error: boom');
  });

  it('cancels queued operations on reset', async () => {
    const q = new GattQueue();
    const first = q.run('first', () => delay(20).then(() => 1));
    const second = q.run('second', async () => 2);
    await delay(5); // let "first" start; "second" is still queued
    q.reset();
    const third = q.run('third', async () => 3);
    await expect(third).resolves.toBe(3);
    await expect(first).resolves.toBe(1);
    await expect(second).rejects.toBeInstanceOf(ConnectionError);
  });
});

describe('WebBluetoothTransport', () => {
  it('reports unavailability without navigator.bluetooth', async () => {
    const t = new WebBluetoothTransport(undefined);
    await expect(t.isAvailable()).resolves.toBe(false);
    await expect(t.requestDevice({ filters: [] })).rejects.toBeInstanceOf(BluetoothUnavailableError);
    await expect(t.getKnownDevices()).resolves.toEqual([]);
  });

  it('maps a cancelled chooser to UserCancelledError', async () => {
    const fake = {
      getAvailability: async () => true,
      requestDevice: async () => {
        throw new DOMException('User cancelled the requestDevice() chooser.', 'NotFoundError');
      },
    } as unknown as Bluetooth;
    const t = new WebBluetoothTransport(fake);
    await expect(t.requestDevice({ filters: [{ services: [0x1826] }] })).rejects.toBeInstanceOf(UserCancelledError);
  });

  it('discovers all characteristics of a service in one round trip', async () => {
    const calls = { all: 0, single: 0 };
    const char = (short: number) => ({
      uuid: `0000${short.toString(16).padStart(4, '0')}-0000-1000-8000-00805f9b34fb`,
      properties: { read: true, write: false, writeWithoutResponse: false, notify: true, indicate: false },
    });
    const service = {
      uuid: '00001826-0000-1000-8000-00805f9b34fb',
      getCharacteristics: async () => {
        calls.all++;
        return [char(0x2acc), char(0x2ad2)];
      },
      getCharacteristic: async () => {
        calls.single++;
        throw new DOMException('not found', 'NotFoundError');
      },
    };
    const server = { connected: true, getPrimaryService: async () => service };
    const device = {
      id: 'flux',
      name: 'Tacx Flux 2',
      gatt: { connected: true, connect: async () => server, disconnect: () => undefined },
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    };
    const fake = { getAvailability: async () => true, requestDevice: async () => device } as unknown as Bluetooth;
    const peripheral = await new WebBluetoothTransport(fake).requestDevice({ filters: [] });
    await peripheral.connect();
    const ftms = await peripheral.getService(0x1826);
    expect(await ftms?.getCharacteristic(0x2acc)).toBeDefined();
    expect(await ftms?.getCharacteristic('00002ad2-0000-1000-8000-00805f9b34fb')).toBeDefined();
    expect(await ftms?.getCharacteristic(0x2ad6)).toBeUndefined();
    expect(calls).toEqual({ all: 1, single: 0 });
  });
});
