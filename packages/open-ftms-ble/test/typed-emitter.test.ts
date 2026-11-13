import { describe, expect, it, vi } from 'vitest';
import { TypedEmitter } from '../src/index';

interface Events {
  tick: number;
  name: string;
}

class Emitter extends TypedEmitter<Events> {
  fire<K extends keyof Events>(event: K, payload: Events[K]): void {
    this.emit(event, payload);
  }
}

describe('TypedEmitter', () => {
  it('delivers payloads and unsubscribes', () => {
    const e = new Emitter();
    const seen: number[] = [];
    const off = e.on('tick', (n) => seen.push(n));
    e.fire('tick', 1);
    off();
    e.fire('tick', 2);
    expect(seen).toEqual([1]);
    expect(e.listenerCount('tick')).toBe(0);
  });

  it('once fires a single time', () => {
    const e = new Emitter();
    const fn = vi.fn();
    e.once('name', fn);
    e.fire('name', 'a');
    e.fire('name', 'b');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith('a');
  });

  it('keeps notifying other listeners when one throws', async () => {
    const e = new Emitter();
    const fn = vi.fn();
    const errors: unknown[] = [];
    const original = globalThis.queueMicrotask;
    globalThis.queueMicrotask = (cb) =>
      original(() => {
        try {
          cb();
        } catch (error) {
          errors.push(error);
        }
      });
    try {
      e.on('tick', () => {
        throw new Error('boom');
      });
      e.on('tick', fn);
      e.fire('tick', 1);
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      globalThis.queueMicrotask = original;
    }
    expect(fn).toHaveBeenCalledWith(1);
    expect(errors).toHaveLength(1);
  });
});
