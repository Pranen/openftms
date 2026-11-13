import { ConnectionError } from '../errors';
import { withTimeout } from '../util/async';

/** Timing of one settled GATT operation (queue wait excluded). */
export interface GattOperationTrace {
  readonly label: string;
  /** `Date.now()` when the operation started (after waiting in the queue). */
  readonly startedAt: number;
  readonly durationMs: number;
  /** Error name/message if it failed. */
  readonly error?: string;
}

/**
 * Serialises GATT operations of one connection.
 *
 * Chrome rejects overlapping GATT operations ("GATT operation already in
 * progress"), and FTMS allows only one outstanding control point command.
 * Every read, write and (un)subscribe of a device therefore runs through
 * one queue, one at a time.
 */
export class GattQueue {
  readonly #onSettled: ((trace: GattOperationTrace) => void) | undefined;
  #tail: Promise<unknown> = Promise.resolve();
  #generation = 0;
  #pending = 0;

  constructor(onSettled?: (trace: GattOperationTrace) => void) {
    this.#onSettled = onSettled;
  }

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
      const startedAt = Date.now();
      const op = withTimeout(operation(), timeoutMs, `${label} timed out after ${timeoutMs} ms`);
      if (this.#onSettled) {
        const report = (error?: unknown) => {
          const trace: GattOperationTrace = { label, startedAt, durationMs: Date.now() - startedAt };
          this.#onSettled?.(
            error === undefined
              ? trace
              : { ...trace, error: error instanceof Error ? `${error.name}: ${error.message}` : String(error) },
          );
        };
        void op.then(
          () => report(),
          (error: unknown) => report(error),
        );
      }
      return op;
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
