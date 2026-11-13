import { ConnectionError } from '../errors';
import { withTimeout } from '../util/async';

/**
 * Serialises GATT operations of one connection.
 *
 * Chrome rejects overlapping GATT operations ("GATT operation already in
 * progress"), and FTMS allows only one outstanding control point command.
 * Every read, write and (un)subscribe of a device therefore runs through
 * one queue, one at a time.
 */
export class GattQueue {
  #tail: Promise<unknown> = Promise.resolve();
  #generation = 0;
  #pending = 0;

  /** Number of queued or running operations. */
  get pending(): number {
    return this.#pending;
  }

  /**
   * Queues `operation`. It starts after all previously queued operations have
   * settled and fails with a TimeoutError after `timeoutMs` (≤ 0 disables).
   */
  run<T>(label: string, operation: () => Promise<T>, timeoutMs = 0): Promise<T> {
    const generation = this.#generation;
    this.#pending++;
    const result = this.#tail.then(() => {
      if (generation !== this.#generation) {
        throw new ConnectionError(`${label} cancelled: connection was reset`);
      }
      return withTimeout(operation(), timeoutMs, `${label} timed out after ${timeoutMs} ms`);
    });
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tail = settled;
    void settled.then(() => {
      this.#pending--;
    });
    return result;
  }

  /** Cancels all queued operations (e.g. after a disconnect); new ones start immediately. */
  reset(): void {
    this.#generation++;
    this.#tail = Promise.resolve();
  }
}
