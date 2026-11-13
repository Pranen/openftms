import {
  controlPointOpCodeName,
  hasParseIssues,
  parseControlPointResponse,
  parseFitnessMachineFeatures,
  parseHeartRateMeasurement,
  parseIndoorBikeData,
  parseMachineStatus,
  parseSupportedPowerRange,
  parseSupportedResistanceLevelRange,
  parseTrainingStatus,
  toHex,
  type MachineStatus,
  type ParseDiagnostics,
  type RawPacket,
  type TrainerMode,
} from 'open-ftms-ble';

export function num(value: number | null | undefined, digits = 0): string {
  if (value === undefined) return '–';
  if (value === null) return 'n/a';
  return value.toFixed(digits);
}

export function duration(seconds: number | undefined): string {
  if (seconds === undefined) return '–';
  const s = Math.round(seconds);
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return hh > 0 ? `${hh}:${two(mm)}:${two(ss)}` : `${mm}:${two(ss)}`;
}

export function modeLabel(mode: TrainerMode): string {
  switch (mode.kind) {
    case 'none':
      return 'frei';
    case 'erg':
      return `ERG ${mode.targetPowerW} W`;
    case 'resistance':
      return `Widerstand ${mode.level}`;
    case 'simulation': {
      const p = mode.parameters;
      return `Sim ${p.gradePercent} % · Wind ${p.windSpeedMps} m/s · Crr ${p.crr} · Cw ${p.cw}`;
    }
  }
}

export function diagnosticsLabel(d: ParseDiagnostics): string {
  if (!hasParseIssues(d)) return '';
  const parts: string[] = [];
  if (d.truncated) parts.push('abgeschnitten');
  if (d.trailingBytes > 0) parts.push(`${d.trailingBytes} Byte(s) übrig`);
  if (d.reservedFlags !== 0) parts.push(`reservierte Bits 0x${d.reservedFlags.toString(16)}`);
  return `⚠ ${parts.join(', ')}`;
}

export function machineStatusLabel(s: MachineStatus): string {
  const details = [
    s.stopAction && `action=${s.stopAction}`,
    s.targetPowerW !== undefined && `${s.targetPowerW} W`,
    s.targetResistanceLevel !== undefined && `level ${s.targetResistanceLevel}`,
    s.targetInclinationPercent !== undefined && `${s.targetInclinationPercent} %`,
    s.targetSpeedKmh !== undefined && `${s.targetSpeedKmh} km/h`,
    s.simulation &&
      `grade ${s.simulation.gradePercent} %, wind ${s.simulation.windSpeedMps} m/s, crr ${s.simulation.crr}, cw ${s.simulation.cw}`,
    s.spinDownStatus && `spin down ${s.spinDownStatus}`,
    s.type === 'unknown' && s.parameters.length > 0 && toHex(s.parameters),
  ].filter(Boolean);
  return details.length > 0 ? `${s.type} (${details.join(', ')})` : s.type;
}

/** Human-readable one-liner for the packet log. */
export function summarizePacket(p: RawPacket): string {
  try {
    switch (p.characteristic) {
      case 'indoorBikeData': {
        const d = parseIndoorBikeData(p.bytes);
        const parts = [
          d.instantaneousPowerW !== undefined && `${d.instantaneousPowerW} W`,
          d.instantaneousCadenceRpm !== undefined && `${num(d.instantaneousCadenceRpm, 1)} rpm`,
          d.instantaneousSpeedKmh !== undefined && `${num(d.instantaneousSpeedKmh, 2)} km/h`,
          d.heartRateBpm !== undefined && `${d.heartRateBpm} bpm`,
          d.flags.moreData && 'more data',
        ].filter(Boolean);
        return [parts.join(' · '), diagnosticsLabel(d.diagnostics)].filter(Boolean).join(' ');
      }
      case 'heartRateMeasurement': {
        const hr = parseHeartRateMeasurement(p.bytes);
        return `${num(hr.heartRateBpm)} bpm · contact ${hr.sensorContact}${hr.rrIntervalsMs.length ? ` · RR ${hr.rrIntervalsMs.map((r) => Math.round(r)).join('/')} ms` : ''}`;
      }
      case 'fitnessMachineStatus':
        return machineStatusLabel(parseMachineStatus(p.bytes));
      case 'trainingStatus': {
        const t = parseTrainingStatus(p.bytes);
        return t.statusString ? `${t.status} "${t.statusString}"` : t.status;
      }
      case 'fitnessMachineControlPoint': {
        if (p.direction === 'out') return `→ ${controlPointOpCodeName(p.bytes[0] ?? -1)}`;
        const r = parseControlPointResponse(p.bytes);
        return r ? `← ${r.request}: ${r.result}` : 'unerwartete Indication';
      }
      case 'fitnessMachineFeature': {
        const f = parseFitnessMachineFeatures(p.bytes);
        const on = (o: object) =>
          Object.entries(o)
            .filter(([, v]) => v)
            .map(([k]) => k)
            .join(', ');
        return `machine: ${on(f.machine) || '–'} | targets: ${on(f.targetSetting) || '–'}`;
      }
      case 'supportedPowerRange': {
        const r = parseSupportedPowerRange(p.bytes);
        return `${r.minimum} … ${r.maximum} W, Schritt ${r.increment}`;
      }
      case 'supportedResistanceLevelRange': {
        const r = parseSupportedResistanceLevelRange(p.bytes);
        return `${r.minimum} … ${r.maximum}, Schritt ${r.increment} (${r.encoding})`;
      }
      default:
        if (/^[\x20-\x7e]+$/.test(new TextDecoder().decode(p.bytes))) {
          return `"${new TextDecoder().decode(p.bytes)}"`;
        }
        return '';
    }
  } catch (error) {
    return `Parse-Fehler: ${String(error)}`;
  }
}
