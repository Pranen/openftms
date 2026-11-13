import { describe, expect, it } from 'vitest';
import {
  ConnectionError,
  ControlPointClient,
  ControlPointError,
  TimeoutError,
  delay,
  encodeSetTargetPower,
  toHex,
} from '../src/index.js';

/** Fake trainer: records writes and answers each op code after `latency` ms. */
function setup(answer: (op: number) => number | undefined = () => 0x01, latency = 2) {
  const writes: string[] = [];
  let client!: ControlPointClient;
  client = new ControlPointClient(
    async (bytes) => {
      writes.push(toHex(bytes));
      const op = bytes[0] ?? 0;
      const result = answer(op);
      if (result !== undefined) setTimeout(() => client.handleIndication(new Uint8Array([0x80, op, result])), latency);
    },
    { responseTimeoutMs: 50 },
  );
  return { client, writes };
}

describe('ControlPointClient', () => {
  it('resolves with the matching success response', async () => {
    const { client } = setup();
    const response = await client.send(encodeSetTargetPower(200));
    expect(response.request).toBe('setTargetPower');
    expect(response.success).toBe(true);
  });

  it('rejects with ControlPointError on a failure result', async () => {
    const { client } = setup(() => 0x05);
    const error = await client.send(encodeSetTargetPower(200)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ControlPointError);
    expect((error as ControlPointError).result).toBe('controlNotPermitted');
  });

  it('times out when no indication arrives', async () => {
    const { client } = setup(() => undefined);
    await expect(client.send(encodeSetTargetPower(200))).rejects.toBeInstanceOf(TimeoutError);
    expect(client.pending).toBe(0);
  });

  it('sends one command at a time', async () => {
    const { client, writes } = setup();
    const a = client.send(new Uint8Array([0x00]));
    const b = client.send(new Uint8Array([0x07]));
    expect(writes).toEqual(['00']);
    await a;
    await b;
    expect(writes).toEqual(['00', '07']);
  });

  it('ignores responses for other op codes', async () => {
    const { client } = setup(() => undefined);
    const pending = client.send(encodeSetTargetPower(100));
    await delay(1);
    client.handleIndication(new Uint8Array([0x80, 0x07, 0x01]));
    client.handleIndication(new Uint8Array([0x80, 0x05, 0x01]));
    await expect(pending).resolves.toMatchObject({ request: 'setTargetPower' });
  });

  it('coalesces queued commands with the same key (latest wins)', async () => {
    const { client, writes } = setup();
    const first = client.send(encodeSetTargetPower(100), 'power');
    const mid = client.send(encodeSetTargetPower(150), 'power');
    const last = client.send(encodeSetTargetPower(200), 'power');
    await Promise.all([first, mid, last]);
    // 100 was already in flight; 150 was replaced by 200 while waiting.
    expect(writes).toEqual(['05 64 00', '05 c8 00']);
  });

  it('rejects everything on reset', async () => {
    const { client } = setup(() => undefined);
    const a = client.send(new Uint8Array([0x00]));
    const b = client.send(new Uint8Array([0x07]));
    client.reset(new ConnectionError('gone'));
    await expect(a).rejects.toBeInstanceOf(ConnectionError);
    await expect(b).rejects.toBeInstanceOf(ConnectionError);
    expect(client.pending).toBe(0);
  });
});
