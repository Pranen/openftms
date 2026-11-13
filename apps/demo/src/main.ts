import './style.css';
import {
  FtmsTrainer,
  HeartRateMonitor,
  INDOOR_BIKE_DATA_FLAGS,
  LIBRARY_NAME,
  LIBRARY_VERSION,
  MACHINE_FEATURE_FLAGS,
  MockTransport,
  SimulatedHeartRateMonitor,
  SimulatedTrainer,
  TARGET_SETTING_FEATURE_FLAGS,
  UserCancelledError,
  WebBluetoothTransport,
  toHex,
  type BleTransport,
  type ConnectionState,
  type ControlState,
  type FtmsCapabilities,
  type GattOperationTrace,
  type IndoorBikeData,
  type MachineStatus,
  type SupportedRange,
} from 'open-ftms-ble';
import { $, h, rafThrottle, timeOfDay } from './dom';
import { diagnosticsLabel, duration, machineStatusLabel, modeLabel, num } from './format';
import { PacketLog } from './packet-log';
import { buildReport } from './report';

type Source = 'ble' | 'sim';

interface Session {
  readonly source: Source;
  readonly transport: BleTransport;
  readonly trainer: FtmsTrainer;
  readonly hrm: HeartRateMonitor;
  readonly simTrainer?: SimulatedTrainer;
  readonly simHrm?: SimulatedHeartRateMonitor;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const log = new PacketLog($<HTMLTableSectionElement>('log-body'), $('log-meta'));
const events: string[] = [];
let lastBikeData: IndoorBikeData | undefined;
let machineStatuses: Array<{ at: number; status: MachineStatus }> = [];
/** Timing of every GATT operation, for the report. */
const gattTraces: string[] = [];
/** Last known snapshot per device, kept across disconnects and source switches. */
const knownDevices = new Map<string, unknown>();
// Assigned at the bottom, once `render` and all handlers exist.
let session: Session;

function createSession(source: Source): Session {
  let s: Session;
  if (source === 'sim') {
    const simTrainer = new SimulatedTrainer({ cadenceRpm: Number($<HTMLInputElement>('sim-cadence').value) });
    const simHrm = new SimulatedHeartRateMonitor({ powerSource: () => simTrainer.powerW });
    const transport = new MockTransport([simTrainer.peripheral, simHrm.peripheral]);
    s = {
      source,
      transport,
      trainer: new FtmsTrainer({ transport }),
      hrm: new HeartRateMonitor({ transport }),
      simTrainer,
      simHrm,
    };
  } else {
    const transport = new WebBluetoothTransport();
    s = { source, transport, trainer: new FtmsTrainer({ transport }), hrm: new HeartRateMonitor({ transport }) };
  }
  bind(s);
  return s;
}

function bind({ source, trainer, hrm }: Session): void {
  const remember = (label: string, device: FtmsTrainer | HeartRateMonitor) =>
    knownDevices.set(`${label} (${source}, ${device.deviceName ?? '?'})`, {
      name: device.deviceName,
      seenAt: new Date().toISOString(),
      ...device.snapshot,
    });
  const traceGatt = (label: string) => (t: GattOperationTrace) => {
    gattTraces.push(
      `${timeOfDay(t.startedAt)} ${label.padEnd(8)} ${t.label.padEnd(44)} ${String(t.durationMs).padStart(5)} ms${t.error ? `  ${t.error}` : ''}`,
    );
    if (gattTraces.length > 400) gattTraces.shift();
  };
  const timeToReady = (label: string) => {
    let startedAt = 0;
    return (state: ConnectionState) => {
      if (state === 'connecting' || state === 'reconnecting') startedAt = Date.now();
      if (state === 'ready' && startedAt) {
        addEvent(`${label}: bereit nach ${((Date.now() - startedAt) / 1000).toFixed(1)} s`);
        startedAt = 0;
      }
    };
  };
  const trainerReady = timeToReady('Trainer');
  const hrmReady = timeToReady('Pulsgurt');

  trainer.on('gattOperation', traceGatt('Trainer'));
  hrm.on('gattOperation', traceGatt('Pulsgurt'));
  trainer.on('connectionStateChange', (e) => {
    addEvent(`Trainer: ${e.previous} → ${e.state}${e.error ? ` (${e.error.message})` : ''}`);
    trainerReady(e.state);
    if (e.state === 'ready') remember('Trainer', trainer);
    render();
  });
  trainer.on('reconnectScheduled', (e) =>
    addEvent(`Trainer: Reconnect-Versuch ${e.attempt}/${e.maxAttempts} in ${e.delayMs} ms`),
  );
  trainer.on('controlStateChange', (e) => {
    addEvent(`Trainer: Kontrolle ${e.previous} → ${e.state}`);
    render();
  });
  trainer.on('error', (e) => addEvent(`Trainer-Fehler: ${e.message}`));
  trainer.on('raw', (p) => log.add('Trainer', p));
  trainer.on('indoorBikeData', (d) => {
    lastBikeData = d;
    render();
  });
  trainer.on('machineStatus', (status) => {
    machineStatuses = [{ at: Date.now(), status }, ...machineStatuses].slice(0, 12);
    render();
  });
  trainer.on('trainingStatus', render);
  trainer.on('modeChange', render);
  trainer.on('capabilities', (c) => {
    renderCapabilities(c);
    remember('Trainer', trainer);
  });

  hrm.on('connectionStateChange', (e) => {
    addEvent(`Pulsgurt: ${e.previous} → ${e.state}${e.error ? ` (${e.error.message})` : ''}`);
    hrmReady(e.state);
    if (e.state === 'ready') remember('Pulsgurt', hrm);
    render();
  });
  hrm.on('reconnectScheduled', (e) =>
    addEvent(`Pulsgurt: Reconnect-Versuch ${e.attempt}/${e.maxAttempts} in ${e.delayMs} ms`),
  );
  hrm.on('error', (e) => addEvent(`Pulsgurt-Fehler: ${e.message}`));
  hrm.on('raw', (p) => log.add('Pulsgurt', p));
  hrm.on('heartRate', render);
}

function addEvent(text: string): void {
  events.push(`${timeOfDay(Date.now())} ${text}`);
  if (events.length > 500) events.shift();
  const list = $('event-list');
  list.replaceChildren(...events.slice(-15).reverse().map((e) => h('li', {}, e)));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

const STATE_CLASS: Record<ConnectionState, string> = {
  disconnected: '',
  connecting: 'warn',
  discovering: 'warn',
  reconnecting: 'warn',
  ready: 'ok',
};

const CONTROL_CLASS: Record<ControlState, string> = {
  none: '',
  requesting: 'warn',
  granted: 'ok',
  blocked: 'error',
};

function chip(el: HTMLElement, text: string, cls: string): void {
  el.textContent = text;
  el.className = `chip ${cls}`.trim();
}

function metric(label: string, value: string, unit = '', note = '', noteClass = 'warn'): HTMLElement {
  return h(
    'div',
    { class: 'metric' },
    h('div', { class: 'metric-label' }, label),
    h('div', { class: 'metric-value' }, value, unit && h('span', { class: 'unit' }, ` ${unit}`)),
    note && h('div', { class: `metric-note ${noteClass}` }, note),
  );
}

const render = rafThrottle(() => {
  const { trainer, hrm } = session;
  const t = trainer.telemetry;

  // Device status
  $('trainer-name').textContent = trainer.deviceName ?? '';
  $('hrm-name').textContent = hrm.deviceName ?? '';
  chip($('trainer-state'), trainer.connectionState, STATE_CLASS[trainer.connectionState]);
  chip($('trainer-control'), `control: ${trainer.control}`, CONTROL_CLASS[trainer.control]);
  chip($('hrm-state'), hrm.connectionState, STATE_CLASS[hrm.connectionState]);
  const contact = hrm.snapshot.sensorContact;
  chip($('hrm-contact'), `contact: ${contact ?? '–'}`, contact === 'detected' ? 'ok' : contact === 'notDetected' ? 'error' : '');

  // Metrics
  const ageMs = t.updatedAt !== undefined ? Date.now() - t.updatedAt : undefined;
  const stale = ageMs !== undefined && ageMs > 3000 ? 'veraltet' : '';
  const hrFromStrap = hrm.heartRateBpm;
  const heartRate = hrFromStrap ?? t.heartRateBpm;
  $('metrics').replaceChildren(
    metric('Leistung', num(t.powerW), 'W', stale),
    metric('Kadenz', num(t.cadenceRpm, 1), 'rpm', stale),
    metric('Geschwindigkeit', num(t.speedKmh, 1), 'km/h', stale),
    metric(
      'Herzfrequenz',
      num(heartRate),
      'bpm',
      hrFromStrap !== undefined ? 'Pulsgurt' : t.heartRateBpm !== undefined ? 'Trainer' : '',
      'muted',
    ),
    metric('Distanz', t.totalDistanceM !== undefined ? num(t.totalDistanceM / 1000, 2) : '–', 'km'),
    metric('Zeit', duration(t.elapsedTimeS)),
    metric('Datenrate', num(log.rate('indoorBikeData'), 1), 'Hz'),
    metric('Modus', modeLabel(trainer.mode)),
  );

  // Indoor Bike Data
  const d = lastBikeData;
  if (d) {
    $('ibd-hex').textContent = toHex(d.bytes);
    $('ibd-meta').textContent = `flags 0x${d.rawFlags.toString(16).padStart(4, '0')}`;
    $('ibd-flags').replaceChildren(
      ...INDOOR_BIKE_DATA_FLAGS.map((name, bit) => {
        const on = d.flags[name];
        // Bit 0 is inverted: clear means "speed present".
        const label = bit === 0 ? `0 moreData${on ? '' : ' (speed present)'}` : `${bit} ${name.replace(/Present$/, '')}`;
        return h('span', { class: `flag ${on ? 'on' : ''}` }, label);
      }),
    );
    $('ibd-diag').textContent = diagnosticsLabel(d.diagnostics);
  }

  // Training + machine status
  const ts = trainer.snapshot.trainingStatus;
  $('training-status').textContent = ts ? `${ts.status}${ts.statusString ? ` "${ts.statusString}"` : ''}` : '–';
  if (machineStatuses.length > 0) {
    $('machine-status-list').replaceChildren(
      ...machineStatuses.map(({ at, status }) =>
        h(
          'li',
          { class: status.type === 'controlPermissionLost' ? 'error' : undefined },
          h('span', { class: 'mono muted' }, timeOfDay(at)),
          ' ',
          machineStatusLabel(status),
        ),
      ),
    );
  }

  // Buttons
  const trainerIdle = trainer.connectionState === 'disconnected';
  const hrmIdle = hrm.connectionState === 'disconnected';
  $<HTMLButtonElement>('trainer-connect').disabled = !trainerIdle;
  $<HTMLButtonElement>('trainer-disconnect').disabled = trainerIdle;
  $<HTMLButtonElement>('hrm-connect').disabled = !hrmIdle;
  $<HTMLButtonElement>('hrm-disconnect').disabled = hrmIdle;
  for (const input of document.querySelectorAll<HTMLInputElement>('#source-select input')) {
    input.disabled = !(trainerIdle && hrmIdle);
  }
});

function rangeLabel(r: SupportedRange | undefined, unit: string): string {
  if (!r) return '–';
  return `${num(r.minimum, 1)} … ${num(r.maximum, 1)} ${unit} (Schritt ${r.increment ?? '–'})`;
}

function renderCapabilities(c: FtmsCapabilities): void {
  const info = c.deviceInformation;
  const kv = (k: string, v: string) => h('div', { class: 'kv' }, h('span', {}, k), h('span', {}, v));
  const flagList = (names: readonly string[], set: Record<string, boolean> | undefined) =>
    h(
      'div',
      { class: 'flags' },
      ...names.map((n) => h('span', { class: `flag ${set?.[n] ? 'on' : ''}` }, n)),
    );
  const present = Object.entries(c.characteristics)
    .map(([k, v]) => `${k} ${v ? '✓' : '✗'}`)
    .join(' · ');
  $('capabilities').className = '';
  $('capabilities').replaceChildren(
    kv('Hersteller', info.manufacturerName ?? '–'),
    kv('Modell', info.modelNumber ?? '–'),
    kv('Firmware', info.firmwareRevision ?? info.softwareRevision ?? '–'),
    kv('Seriennummer', info.serialNumber ?? '–'),
    kv('Characteristics', present),
    kv('Cycling Power Service', c.hasCyclingPowerService ? 'vorhanden' : 'nicht vorhanden'),
    kv('Leistung', rangeLabel(c.powerRange, 'W')),
    kv(
      'Widerstand',
      c.resistanceRange ? `${rangeLabel(c.resistanceRange, '')} · ${c.resistanceRange.encoding}` : '–',
    ),
    kv('Steigung', rangeLabel(c.inclinationRange, '%')),
    h('h4', {}, 'Machine Features', c.features ? ` · 0x${c.features.rawMachineFeatures.toString(16)}` : ' (nicht gelesen)'),
    flagList(MACHINE_FEATURE_FLAGS, c.features?.machine),
    h('h4', {}, 'Target Setting Features', c.features ? ` · 0x${c.features.rawTargetSettingFeatures.toString(16)}` : ''),
    flagList(TARGET_SETTING_FEATURE_FLAGS, c.features?.targetSetting),
  );
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

function connectHandler(label: string, connect: () => Promise<void>) {
  return () => {
    // Must call connect() synchronously inside the click (user gesture).
    connect().catch((error: unknown) => {
      if (error instanceof UserCancelledError) addEvent(`${label}: Auswahl abgebrochen`);
      else addEvent(`${label}: Verbinden fehlgeschlagen – ${error instanceof Error ? error.message : String(error)}`);
      render();
    });
  };
}

$('trainer-connect').addEventListener('click', connectHandler('Trainer', () => session.trainer.connect()));
$('trainer-disconnect').addEventListener('click', () => void session.trainer.disconnect());
$('hrm-connect').addEventListener('click', connectHandler('Pulsgurt', () => session.hrm.connect()));
$('hrm-disconnect').addEventListener('click', () => void session.hrm.disconnect());

for (const input of document.querySelectorAll<HTMLInputElement>('#source-select input')) {
  input.addEventListener('change', () => {
    if (!input.checked) return;
    session.trainer.removeAllListeners();
    session.hrm.removeAllListeners();
    session = createSession(input.value as Source);
    lastBikeData = undefined;
    machineStatuses = [];
    $('sim-panel').hidden = session.source !== 'sim';
    $('ibd-hex').textContent = '–';
    $('ibd-flags').replaceChildren();
    $('capabilities').textContent = 'Noch nicht verbunden';
    $('capabilities').className = 'muted';
    addEvent(`Quelle: ${session.source === 'sim' ? 'Simulator' : 'Bluetooth'}`);
    void updateEnvStatus();
    render();
  });
}

const cadence = $<HTMLInputElement>('sim-cadence');
cadence.addEventListener('input', () => {
  $('sim-cadence-value').textContent = cadence.value;
  if (session.simTrainer) session.simTrainer.cadenceRpm = Number(cadence.value);
});
$<HTMLInputElement>('sim-foreign-control').addEventListener('change', (e) => {
  if (session.simTrainer) session.simTrainer.controlHeldByOtherApp = (e.target as HTMLInputElement).checked;
});
$('sim-link-loss').addEventListener('click', () => session.simTrainer?.simulateConnectionLoss());
$('sim-control-loss').addEventListener('click', () => session.simTrainer?.simulateControlLoss());

$<HTMLInputElement>('log-pause').addEventListener('change', (e) => {
  log.paused = (e.target as HTMLInputElement).checked;
});
$<HTMLInputElement>('log-hide-stream').addEventListener('change', (e) => {
  log.hideStream = (e.target as HTMLInputElement).checked;
});
$('log-clear').addEventListener('click', () => log.clear());

function report(): string {
  return buildReport({
    source: session.source,
    trainer: session.trainer,
    hrm: session.hrm,
    log,
    events,
    knownDevices: Object.fromEntries(knownDevices),
    gattTraces,
  });
}

$('report-copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(report());
    addEvent('Bericht in die Zwischenablage kopiert');
  } catch (error) {
    addEvent(`Kopieren fehlgeschlagen (${String(error)}) – bitte «Bericht herunterladen» verwenden`);
  }
});
$('report-download').addEventListener('click', () => {
  const url = URL.createObjectURL(new Blob([report()], { type: 'text/plain' }));
  const a = h('a', { href: url, download: `open-ftms-report-${new Date().toISOString().replace(/[:.]/g, '-')}.txt` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

async function updateEnvStatus(): Promise<void> {
  const badge = $('env-status');
  const available = await session.transport.isAvailable();
  const label = session.source === 'sim' ? 'Simulator aktiv' : available ? 'Web Bluetooth verfügbar' : 'Web Bluetooth nicht verfügbar';
  badge.textContent = `${label} · ${LIBRARY_NAME} ${LIBRARY_VERSION}`;
  badge.className = `badge ${session.source === 'sim' ? 'warn' : available ? 'ok' : 'error'}`;
  $('connection-hint').hidden = session.source === 'sim';
}

// The browser may restore the radio selection on reload; start with whatever is checked.
const initialSource =
  document.querySelector<HTMLInputElement>('#source-select input:checked')?.value === 'sim' ? 'sim' : 'ble';
session = createSession(initialSource);
$('sim-panel').hidden = session.source !== 'sim';
// Re-render once a second so ages/rates stay current without new packets.
setInterval(render, 1000);
void updateEnvStatus();
render();
