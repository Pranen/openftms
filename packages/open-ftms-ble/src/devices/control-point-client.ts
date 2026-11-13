import { ControlPointError, OpenFtmsError, TimeoutError } from '../errors.js';
import {
  controlPointOpCodeName,
  parseControlPointResponse,
  type ControlPointResponse,
} from '../protocol/ftms/control-point.js';

interface Waiter {
  resolve: (response: ControlPointResponse) => void;
  reject: (error: unknown) => void;
}

interface Entry {
  bytes: Uint8Array;
  opCode: number;
  coalesceKey: string | undefined;
  waiters: Waiter[];
}

interface InFlight {
  entry: Entry;
  finish: (outcome: { response: ControlPointResponse } | { error: unknown }) => void;
}

/**
 * FTMS control point protocol: one command in flight, matched to its 0x80
 * indication by op code, with a response timeout.
 *
 * Commands sharing a `coalesceKey` are merged while waiting ("latest wins"):
 * the queued command takes the newest bytes, and every caller's promise
 * settles with the outcome of that newest command. This keeps a slider from
 * flooding the trainer.
 */
export class ControlPointClient {
  readonly #write: (bytes: Uint8Array) => Promise<void>;
  readonly #responseTimeoutMs: number;
  #queue: Entry[] = [];
  #inFlight: InFlight | undefined;

  constructor(write: (bytes: Uint8Array) => Promise<void>, options: { responseTimeoutMs?: number } = {}) {
    this.#write = write;
    this.#responseTimeoutMs = options.responseTimeoutMs ?? 3_000;
  }

  /** Commands queued or in flight. */
  get pending(): number {
    return this.#queue.length + (this.#inFlight ? 1 : 0);
  }

  send(bytes: Uint8Array, coalesceKey?: string): Promise<ControlPointResponse> {
    return new Promise<ControlPointResponse>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject };
      const opCode = bytes[0] ?? -1;
      if (coalesceKey !== undefined) {
        const queued = this.#queue.find((e) => e.coalesceKey === coalesceKey);
        if (queued) {
          queued.bytes = bytes;
          queued.opCode = opCode;
          queued.waiters.push(waiter);
          return;
        }
      }
      this.#queue.push({ bytes, opCode, coalesceKey, waiters: [waiter] });
      this.#pump();
    });
  }

  /**
   * Feed every value received on 0x2AD9. Settles the matching command and
   * returns the parsed response (or `undefined` if it is not a response).
   */
  handleIndication(bytes: Uint8Array): ControlPointResponse | undefined {
    const response = parseControlPointResponse(bytes);
    if (!response) return undefined;
    const inFlight = this.#inFlight;
    if (inFlight && response.requestOpCode === inFlight.entry.opCode) {
      inFlight.finish(response.success ? { response } : { error: new ControlPointError(response) });
    }
    return response;
  }

  /** Rejects everything queued or in flight (e.g. on disconnect). */
  reset(reason: OpenFtmsError): void {
    const entries = [...(this.#inFlight ? [this.#inFlight.entry] : []), ...this.#queue];
    this.#inFlight = undefined;
    this.#queue = [];
    for (const entry of entries) for (const w of entry.waiters) w.reject(reason);
  }

  #pump(): void {
    if (this.#inFlight) return;
    const entry = this.#queue.shift();
    if (!entry) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish: InFlight['finish'] = (outcome) => {
      if (this.#inFlight?.entry !== entry) return;
      clearTimeout(timer);
      this.#inFlight = undefined;
      for (const w of entry.waiters) {
        if ('response' in outcome) w.resolve(outcome.response);
        else w.reject(outcome.error);
      }
      this.#pump();
    };
    this.#inFlight = { entry, finish };
    timer = setTimeout(() => {
      finish({
        error: new TimeoutError(
          `No control point response to ${controlPointOpCodeName(entry.opCode)} within ${this.#responseTimeoutMs} ms`,
        ),
      });
    }, this.#responseTimeoutMs);
    this.#write(entry.bytes).catch((error: unknown) => finish({ error }));
  }
}
