import type { Unsubscribe } from '../events/typed-emitter.js';
import { fromHex, toHex } from '../protocol/bytes.js';
import type { BaseDeviceEvents, RawPacket } from '../devices/base-device.js';

/**
 * A recorded session: what one or more devices sent and received, enough to
 * replay it later without hardware (see {@link ReplayTransport}).
 *
 * Plain JSON, so it can be downloaded, attached to an issue and committed as
 * a test fixture.
 */
export interface Recording {
  readonly format: 'open-ftms-recording';
  readonly version: 1;
  /** ISO timestamp of the first packet. */
  readonly startedAt: string;
  readonly devices: readonly RecordedDevice[];
}

export interface RecordedDevice {
  /** Peripheral name as advertised, e.g. "Tacx Flux-2 26370". */
  readonly name: string | undefined;
  /** Free label, e.g. "Trainer". */
  readonly label: string;
  readonly packets: readonly RecordedPacket[];
}

export interface RecordedPacket {
  /** Milliseconds since the recording started. */
  readonly t: number;
  readonly kind: RawPacket['kind'];
  /** Lowercase 128-bit characteristic UUID. */
  readonly uuid: string;
  readonly hex: string;
}

/** Anything that emits `raw` packets: FtmsTrainer, HeartRateMonitor, … */
export interface RawPacketSource {
  readonly deviceName: string | undefined;
  on(event: 'raw', listener: (packet: BaseDeviceEvents['raw']) => void): Unsubscribe;
}

/**
 * Records the raw traffic of devices.
 *
 * ```ts
 * const recorder = new SessionRecorder();
 * recorder.attach(trainer, 'Trainer');
 * recorder.attach(hrm, 'Pulsgurt');
 * // … ride …
 * const json = JSON.stringify(recorder.toRecording());
 * ```
 */
export class SessionRecorder {
  readonly #maxPackets: number;
  readonly #devices: Array<{ label: string; name: string | undefined; packets: RecordedPacket[] }> = [];
  readonly #offs: Unsubscribe[] = [];
  #startedAt: number | undefined;

  /** `maxPackets` per device; the oldest notifications are dropped first (reads are kept). */
  constructor(options: { maxPackets?: number } = {}) {
    this.#maxPackets = options.maxPackets ?? 50_000;
  }

  attach(source: RawPacketSource, label: string): void {
    const entry = { label, name: source.deviceName, packets: [] as RecordedPacket[] };
    this.#devices.push(entry);
    this.#offs.push(
      source.on('raw', (p) => {
        this.#startedAt ??= p.timestamp;
        entry.name = source.deviceName ?? entry.name; // the name is gone after disconnecting
        entry.packets.push({ t: p.timestamp - this.#startedAt, kind: p.kind, uuid: p.uuid, hex: p.hex });
        if (entry.packets.length > this.#maxPackets) {
          const i = entry.packets.findIndex((x) => x.kind !== 'read');
          entry.packets.splice(i < 0 ? 0 : i, 1);
        }
      }),
    );
  }

  /** Stops recording (listeners removed); the data stays available. */
  detach(): void {
    for (const off of this.#offs.splice(0)) off();
  }

  clear(): void {
    for (const d of this.#devices) d.packets.length = 0;
    this.#startedAt = undefined;
  }

  get packetCount(): number {
    return this.#devices.reduce((n, d) => n + d.packets.length, 0);
  }

  toRecording(): Recording {
    return {
      format: 'open-ftms-recording',
      version: 1,
      startedAt: new Date(this.#startedAt ?? Date.now()).toISOString(),
      devices: this.#devices
        .filter((d) => d.packets.length > 0)
        .map((d) => ({ name: d.name, label: d.label, packets: [...d.packets] })),
    };
  }
}

/** Validates parsed JSON; throws a readable error for anything else. */
export function parseRecording(json: unknown): Recording {
  const r = json as Partial<Recording> | null;
  if (!r || r.format !== 'open-ftms-recording' || r.version !== 1 || !Array.isArray(r.devices)) {
    throw new Error('Not an open-ftms recording (format/version mismatch)');
  }
  for (const d of r.devices) {
    if (!Array.isArray(d.packets)) throw new Error('Recording device without packets');
    for (const p of d.packets) {
      if (typeof p.t !== 'number' || typeof p.uuid !== 'string' || typeof p.hex !== 'string') {
        throw new Error('Malformed recorded packet');
      }
      toHex(fromHex(p.hex)); // throws on invalid hex
    }
  }
  return r as Recording;
}
