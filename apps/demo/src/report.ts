import { LIBRARY_VERSION, type FtmsTrainer, type HeartRateMonitor } from 'open-ftms-ble';
import { timeOfDay } from './dom';
import type { PacketLog } from './packet-log';

export interface ReportContext {
  source: string;
  trainer: FtmsTrainer;
  hrm: HeartRateMonitor;
  log: PacketLog;
  events: readonly string[];
  /** Last snapshot of every device seen in this page session (survives disconnects). */
  knownDevices: Record<string, unknown>;
  /** Timing of GATT operations (lookups, reads, writes, subscribes). */
  gattTraces: readonly string[];
}

function replacer(_key: string, value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return Array.from(value, (b) => b.toString(16).padStart(2, '0')).join(' ');
  }
  return value;
}

/**
 * Plain-text diagnostics report: environment, device snapshots, events and
 * the most recent packets. Meant to be pasted into an issue or chat.
 */
export function buildReport(ctx: ReportContext, maxPackets = 400): string {
  const { trainer, hrm } = ctx;
  const header = {
    generatedAt: new Date().toISOString(),
    library: `open-ftms-ble ${LIBRARY_VERSION}`,
    userAgent: navigator.userAgent,
    source: ctx.source,
    trainer: { name: trainer.deviceName, ...trainer.snapshot },
    heartRateMonitor: { name: hrm.deviceName, ...hrm.snapshot },
    knownDevices: ctx.knownDevices,
  };
  const packets = ctx.log.packets
    .slice(-maxPackets)
    .map(
      (p) =>
        `${timeOfDay(p.timestamp)} ${p.direction === 'out' ? '->' : '<-'} ${p.device.padEnd(8)} ${p.characteristic.padEnd(30)} ${p.hex.padEnd(40)} ${p.summary}`,
    );
  return [
    '# open-ftms-ble Diagnosebericht',
    '',
    JSON.stringify(header, replacer, 2),
    '',
    `## Ereignisse (${ctx.events.length})`,
    ...ctx.events,
    '',
    `## GATT-Operationen (letzte ${ctx.gattTraces.length})`,
    ...ctx.gattTraces,
    '',
    `## Pakete (letzte ${packets.length} von ${ctx.log.packets.length})`,
    ...packets,
    '',
  ].join('\n');
}
