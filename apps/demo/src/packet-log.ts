import type { RawPacket } from 'open-ftms-ble';
import { h, rafThrottle, timeOfDay } from './dom';
import { summarizePacket } from './format';

export type DeviceLabel = 'Trainer' | 'Pulsgurt';

export interface LoggedPacket extends RawPacket {
  readonly device: DeviceLabel;
  readonly summary: string;
}

const STREAM = new Set(['indoorBikeData', 'heartRateMeasurement']);
const MAX_STORED = 5000;
const MAX_ROWS = 300;

/** Keeps every packet for the report and renders the newest ones as table rows. */
export class PacketLog {
  readonly packets: LoggedPacket[] = [];
  paused = false;
  hideStream = false;
  #pendingRows: LoggedPacket[] = [];
  #total = 0;
  readonly #body: HTMLTableSectionElement;
  readonly #meta: HTMLElement;
  readonly #schedule: () => void;

  constructor(body: HTMLTableSectionElement, meta: HTMLElement) {
    this.#body = body;
    this.#meta = meta;
    this.#schedule = rafThrottle(() => this.#render());
  }

  add(device: DeviceLabel, packet: RawPacket): void {
    const logged: LoggedPacket = { ...packet, device, summary: summarizePacket(packet) };
    this.#total++;
    this.packets.push(logged);
    if (this.packets.length > MAX_STORED) this.packets.splice(0, this.packets.length - MAX_STORED);
    if (!this.paused && !(this.hideStream && STREAM.has(packet.characteristic))) this.#pendingRows.push(logged);
    this.#schedule();
  }

  clear(): void {
    this.packets.length = 0;
    this.#pendingRows = [];
    this.#total = 0;
    this.#body.replaceChildren();
    this.#schedule();
  }

  /** Packets per second of one characteristic over the last `windowMs`. */
  rate(characteristic: string, windowMs = 5000): number {
    const since = Date.now() - windowMs;
    let count = 0;
    for (let i = this.packets.length - 1; i >= 0; i--) {
      const p = this.packets[i];
      if (!p || p.timestamp < since) break;
      if (p.characteristic === characteristic && p.direction === 'in') count++;
    }
    return count / (windowMs / 1000);
  }

  #render(): void {
    const rows = this.#pendingRows.slice(-MAX_ROWS).map((p) =>
      h(
        'tr',
        { class: p.direction === 'out' ? 'out' : undefined },
        h('td', { class: 'mono' }, timeOfDay(p.timestamp)),
        h('td', {}, p.direction === 'out' ? '→' : '←'),
        h('td', {}, p.device),
        h('td', {}, p.characteristic),
        h('td', { class: 'mono' }, p.hex || '(leer)'),
        h('td', {}, p.summary),
      ),
    );
    this.#pendingRows = [];
    this.#body.prepend(...rows.reverse());
    while (this.#body.rows.length > MAX_ROWS) this.#body.deleteRow(-1);
    this.#meta.textContent = `${this.#total} Pakete${this.paused ? ' · pausiert' : ''}`;
  }
}
