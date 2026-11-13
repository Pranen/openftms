import './style.css';
import {
  FtmsTrainer,
  HeartRateMonitor,
  INDOOR_BIKE_DATA_FLAGS,
  LIBRARY_NAME,
  LIBRARY_VERSION,
  MACHINE_FEATURE_FLAGS,
  MockTransport,
  ReplayTransport,
  SessionRecorder,
  parseRecording,
  type Recording,
  SimulatedHeartRateMonitor,
  SimulatedTrainer,
  TARGET_SETTING_FEATURE_FLAGS,
  UserCancelledError,
  WebBluetoothTransport,
  fromHex,
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
import { IntervalWorkout, intervalSession } from '../../../packages/open-ftms-ble/examples/interval-workout';

type Source = 'ble' | 'sim' | 'replay';

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
/** Records every session; "Aufnahme herunterladen" saves it as JSON for replay. */
let recorder = new SessionRecorder();
let loadedRecording: Recording | undefined;

const SOURCE_LABEL: Record<Source, string> = { ble: 'Bluetooth', sim: 'Simulator', replay: 'Aufnahme' };
const KNOWN_KEY = { Trainer: 'open-ftms.knownTrainerId', Pulsgurt: 'open-ftms.knownHrmId' } as const;

function storage(): Storage | undefined {
  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

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
  } else if (source === 'replay' && loadedRecording) {
    const transport = new ReplayTransport(loadedRecording);
    s = { source, transport, trainer: new FtmsTrainer({ transport }), hrm: new HeartRateMonitor({ transport }) };
  } else {
    const transport = new WebBluetoothTransport();
    s = { source, transport, trainer: new FtmsTrainer({ transport }), hrm: new HeartRateMonitor({ transport }) };
  }
  bind(s);
  recorder.detach();
  recorder = new SessionRecorder();
  recorder.attach(s.trainer, 'Trainer');
  recorder.attach(s.hrm, 'Pulsgurt');
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
    if (e.state === 'ready') {
      remember('Trainer', trainer);
      if (source === 'ble' && trainer.peripheral) storage()?.setItem(KNOWN_KEY.Trainer, trainer.peripheral.id);
    }
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
    applyRanges(c);
    remember('Trainer', trainer);
  });

  hrm.on('connectionStateChange', (e) => {
    addEvent(`Pulsgurt: ${e.previous} → ${e.state}${e.error ? ` (${e.error.message})` : ''}`);
    hrmReady(e.state);
    if (e.state === 'ready') {
      remember('Pulsgurt', hrm);
      if (source === 'ble' && hrm.peripheral) storage()?.setItem(KNOWN_KEY.Pulsgurt, hrm.peripheral.id);
    }
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
    input.disabled = !(trainerIdle && hrmIdle) || (input.value === 'replay' && !loadedRecording);
  }
  $<HTMLButtonElement>('replay-load').disabled = !(trainerIdle && hrmIdle);
  const known = storage();
  $('trainer-known').hidden = session.source !== 'ble' || !known?.getItem(KNOWN_KEY.Trainer);
  $('hrm-known').hidden = session.source !== 'ble' || !known?.getItem(KNOWN_KEY.Pulsgurt);
  $<HTMLButtonElement>('trainer-known').disabled = !trainerIdle;
  $<HTMLButtonElement>('hrm-known').disabled = !hrmIdle;
  renderControls();
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

function connectKnown(label: keyof typeof KNOWN_KEY, device: FtmsTrainer | HeartRateMonitor): void {
  const id = storage()?.getItem(KNOWN_KEY[label]);
  if (!id) return;
  addEvent(`${label}: suche zuletzt verwendetes Gerät …`);
  device
    .connectKnown(id)
    .then((found) => {
      if (!found) {
        addEvent(`${label}: Gerät dem Browser nicht mehr bekannt – bitte normal verbinden`);
        storage()?.removeItem(KNOWN_KEY[label]);
      }
    })
    .catch((error: unknown) => addEvent(`${label}: ${error instanceof Error ? error.message : String(error)}`))
    .finally(render);
}
$('trainer-known').addEventListener('click', () => connectKnown('Trainer', session.trainer));
$('hrm-known').addEventListener('click', () => connectKnown('Pulsgurt', session.hrm));

function switchSource(source: Source): void {
  workout?.stop();
  session.trainer.removeAllListeners();
  session.hrm.removeAllListeners();
  session = createSession(source);
  lastBikeData = undefined;
  machineStatuses = [];
  $('sim-panel').hidden = session.source !== 'sim';
  $('ibd-hex').textContent = '–';
  $('ibd-flags').replaceChildren();
  $('capabilities').textContent = 'Noch nicht verbunden';
  $('capabilities').className = 'muted';
  addEvent(`Quelle: ${SOURCE_LABEL[session.source]}`);
  void updateEnvStatus();
  render();
}

for (const input of document.querySelectorAll<HTMLInputElement>('#source-select input')) {
  input.addEventListener('change', () => {
    if (input.checked) switchSource(input.value as Source);
  });
}

const replayFile = $<HTMLInputElement>('replay-file');
$('replay-load').addEventListener('click', () => replayFile.click());
replayFile.addEventListener('change', async () => {
  const file = replayFile.files?.[0];
  replayFile.value = '';
  if (!file) return;
  try {
    loadedRecording = parseRecording(JSON.parse(await file.text()));
  } catch (error) {
    addEvent(`Aufnahme ungültig: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }
  const names = loadedRecording.devices.map((d) => d.name ?? d.label).join(', ');
  addEvent(`Aufnahme geladen: ${file.name} (${names})`);
  if (session.trainer.connectionState !== 'disconnected') await session.trainer.disconnect();
  if (session.hrm.connectionState !== 'disconnected') await session.hrm.disconnect();
  const radio = document.querySelector<HTMLInputElement>('#source-select input[value="replay"]');
  if (radio) {
    radio.disabled = false;
    radio.checked = true;
  }
  switchSource('replay');
});

$('recording-download').addEventListener('click', () => {
  const json = JSON.stringify(recorder.toRecording(), null, 1);
  const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  const a = h('a', { href: url, download: `open-ftms-recording-${new Date().toISOString().replace(/[:.]/g, '-')}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  addEvent(`Aufnahme gespeichert (${recorder.packetCount} Pakete)`);
});

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

// ---------------------------------------------------------------------------
// Control column
// ---------------------------------------------------------------------------

const commands: Array<{ at: number; label: string; outcome: string; ok: boolean; ms: number }> = [];
/** Per coalescing key: only the newest call of a live slider burst is logged. */
const latestCall = new Map<string, number>();
let callCounter = 0;

function renderCommands(): void {
  $('command-list').replaceChildren(
    ...commands.map((c) =>
      h(
        'li',
        { class: c.ok ? 'ok' : 'error' },
        h('span', { class: 'mono muted' }, timeOfDay(c.at)),
        ' ',
        c.label,
        ' → ',
        c.outcome,
        h('span', { class: 'ms' }, `${c.ms} ms`),
      ),
    ),
  );
}

/** Runs a trainer command and logs its outcome; `key` groups live slider bursts. */
async function command(label: string, run: () => Promise<unknown>, key?: string): Promise<void> {
  const id = ++callCounter;
  if (key) latestCall.set(key, id);
  const started = performance.now();
  let outcome = 'success';
  let ok = true;
  try {
    const result = await run();
    if (result && typeof result === 'object' && 'result' in result && 'bytes' in result) {
      outcome = `${String(result.result)} · ${toHex(result.bytes as Uint8Array)}`;
    }
  } catch (error) {
    ok = false;
    outcome = error instanceof Error ? error.message : String(error);
  }
  if (key && latestCall.get(key) !== id) return; // superseded by a newer value
  commands.unshift({ at: Date.now(), label, outcome, ok, ms: Math.round(performance.now() - started) });
  commands.splice(12);
  addEvent(`Befehl: ${label} → ${outcome} (${commands[0]?.ms ?? 0} ms)`);
  renderCommands();
  render();
}

const ergSlider = $<HTMLInputElement>('erg-slider');
const ergInput = $<HTMLInputElement>('erg-input');
const gradeSlider = $<HTMLInputElement>('sim-grade');
const windSlider = $<HTMLInputElement>('sim-wind');
const crrInput = $<HTMLInputElement>('sim-crr');
const cwInput = $<HTMLInputElement>('sim-cw');
const resistanceSlider = $<HTMLInputElement>('resistance-slider');
const isLive = (id: string) => $<HTMLInputElement>(id).checked;

function sendErg(): void {
  const watts = Number(ergInput.value);
  void command(`ERG ${watts} W`, () => session.trainer.setTargetPower(watts), 'erg');
}

function setErg(watts: number, send: boolean): void {
  ergSlider.value = String(watts);
  ergInput.value = String(watts);
  $('erg-value').textContent = String(watts);
  if (send) sendErg();
}

function simulationValues() {
  return {
    gradePercent: Number(gradeSlider.value),
    windSpeedMps: Number(windSlider.value),
    crr: Number(crrInput.value),
    cw: Number(cwInput.value),
  };
}

function sendSimulation(): void {
  const p = simulationValues();
  void command(
    `Simulation ${p.gradePercent.toFixed(1)} % · Wind ${p.windSpeedMps.toFixed(1)} m/s · Crr ${p.crr} · Cw ${p.cw}`,
    () => session.trainer.setSimulation(p),
    'simulation',
  );
}

function updateSimulationLabels(): void {
  $('grade-value').textContent = Number(gradeSlider.value).toFixed(1);
  $('wind-value').textContent = Number(windSlider.value).toFixed(1);
}

function sendResistance(): void {
  const level = Number(resistanceSlider.value);
  void command(`Widerstand ${level.toFixed(1)}`, () => session.trainer.setResistanceLevel(level), 'resistance');
}

$('cmd-request-control').addEventListener('click', () => void command('Request Control', () => session.trainer.requestControl()));
$('cmd-reset').addEventListener('click', () => void command('Reset', () => session.trainer.reset()));
$('cmd-start').addEventListener('click', () => void command('Start', () => session.trainer.start()));
$('cmd-pause').addEventListener('click', () => void command('Pause', () => session.trainer.pause()));
$('cmd-stop').addEventListener('click', () => void command('Stop', () => session.trainer.stop()));

ergSlider.addEventListener('input', () => setErg(Number(ergSlider.value), isLive('erg-live')));
ergInput.addEventListener('change', () => setErg(Number(ergInput.value), false));
ergInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') setErg(Number(ergInput.value), true);
});
$('erg-send').addEventListener('click', () => setErg(Number(ergInput.value), true));
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-erg]')) {
  b.addEventListener('click', () => setErg(Number(b.dataset['erg']), true));
}

for (const el of [gradeSlider, windSlider]) {
  el.addEventListener('input', () => {
    updateSimulationLabels();
    if (isLive('sim-live')) sendSimulation();
  });
}
for (const el of [crrInput, cwInput]) {
  el.addEventListener('change', () => {
    if (isLive('sim-live')) sendSimulation();
  });
}
$('sim-send').addEventListener('click', sendSimulation);
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-grade]')) {
  b.addEventListener('click', () => {
    gradeSlider.value = b.dataset['grade'] ?? '0';
    updateSimulationLabels();
    sendSimulation();
  });
}

resistanceSlider.addEventListener('input', () => {
  $('resistance-value').textContent = Number(resistanceSlider.value).toFixed(1);
  if (isLive('resistance-live')) sendResistance();
});
$('resistance-send').addEventListener('click', sendResistance);

function sendRaw(): void {
  const text = $<HTMLInputElement>('raw-input').value;
  void command(`Raw ${text.trim()}`, () => session.trainer.sendRaw(fromHex(text)));
}
$('raw-send').addEventListener('click', sendRaw);
$<HTMLInputElement>('raw-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendRaw();
});

/** Adapts slider limits to the trainer's supported ranges. */
function applyRanges(c: FtmsCapabilities): void {
  const power = c.powerRange;
  if (power?.maximum !== undefined && power.minimum !== undefined && power.maximum > power.minimum) {
    for (const el of [ergSlider, ergInput]) {
      el.min = String(power.minimum);
      el.max = String(power.maximum);
    }
    $('erg-range').textContent = `(${power.minimum} … ${power.maximum} W)`;
  }
  const resistance = c.resistanceRange;
  if (resistance?.maximum !== undefined && resistance.minimum !== undefined && resistance.maximum > resistance.minimum) {
    resistanceSlider.min = String(resistance.minimum);
    resistanceSlider.max = String(resistance.maximum);
    resistanceSlider.step = String(resistance.increment && resistance.increment > 0 ? resistance.increment : 0.1);
    $('resistance-range').textContent = `(${resistance.minimum} … ${resistance.maximum})`;
  }
}

function renderControls(): void {
  const { trainer } = session;
  const ready = trainer.isReady;
  $<HTMLFieldSetElement>('controls').disabled = !ready;
  const hasControlPoint = trainer.capabilities?.characteristics.controlPoint ?? true;
  $('control-hint').textContent = !ready
    ? '– Trainer nicht bereit'
    : !hasControlPoint
      ? '– kein Control Point'
      : trainer.control === 'blocked'
        ? '– eine andere App hält die Kontrolle'
        : '';
  const panels: Array<[string, Parameters<FtmsTrainer['supports']>[0]]> = [
    ['erg-panel', 'powerTarget'],
    ['sim-control-panel', 'indoorBikeSimulation'],
    ['resistance-panel', 'resistanceTarget'],
  ];
  for (const [id, feature] of panels) {
    const supported = trainer.supports(feature);
    const panel = $(id);
    panel.classList.toggle('unsupported-panel', !supported);
    const note = panel.querySelector<HTMLElement>('.unsupported');
    if (note) note.hidden = supported;
  }
}

// ---------------------------------------------------------------------------
// Interval workout (the How-To example from docs/howto-interval-training.md)
// ---------------------------------------------------------------------------

let workout: IntervalWorkout | undefined;
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

function renderWorkoutButtons(): void {
  const running = workout?.running ?? false;
  $<HTMLButtonElement>('wo-start').disabled = running;
  $<HTMLButtonElement>('wo-pause').disabled = !running;
  $<HTMLButtonElement>('wo-stop').disabled = !running;
  for (const id of ['wo-ftp', 'wo-repeats', 'wo-work', 'wo-rest', 'wo-warmup', 'wo-cooldown', 'wo-fast']) {
    $<HTMLInputElement>(id).disabled = running;
  }
}

$('wo-start').addEventListener('click', () => {
  const value = (id: string) => Number($<HTMLInputElement>(id).value);
  const steps = intervalSession({
    ftpW: value('wo-ftp'),
    repeats: value('wo-repeats'),
    workS: value('wo-work'),
    restS: value('wo-rest'),
    warmupS: value('wo-warmup'),
    cooldownS: value('wo-cooldown'),
  });
  const w = new IntervalWorkout(session.trainer, steps, { speed: $<HTMLInputElement>('wo-fast').checked ? 10 : 1 });
  workout = w;
  w.on('step', (p) => addEvent(`Programm: ${p.step.name} · ${p.targetW} W · ${mmss(p.step.durationS)}`));
  w.on('autoPause', (e) => addEvent(e.paused ? 'Programm: angehalten (nicht am Treten)' : 'Programm: weiter'));
  w.on('error', (e) => addEvent(`Programm: Ziel nicht gesetzt – ${e instanceof Error ? e.message : String(e)}`));
  w.on('progress', (p) => {
    $<HTMLProgressElement>('wo-progress').value = p.totalElapsedS / p.totalDurationS;
    $('wo-step').textContent = `${p.step.name}${p.paused ? ' (Pause)' : ''}`;
    $('wo-status').textContent = `${p.targetW} W · noch ${mmss(p.stepRemainingS)} · gesamt ${mmss(p.totalElapsedS)}/${mmss(p.totalDurationS)}`;
  });
  w.on('finished', (e) => {
    addEvent(e.completed ? 'Programm: fertig 🎉' : 'Programm: abgebrochen');
    $('wo-step').textContent = e.completed ? 'Fertig' : 'Abgebrochen';
    renderWorkoutButtons();
  });
  w.start();
  renderWorkoutButtons();
});
$('wo-pause').addEventListener('click', () => {
  if (!workout) return;
  const pausing = $('wo-pause').textContent === 'Pause';
  if (pausing) workout.pause();
  else workout.resume();
  $('wo-pause').textContent = pausing ? 'Weiter' : 'Pause';
});
$('wo-stop').addEventListener('click', () => {
  workout?.stop();
  $('wo-pause').textContent = 'Pause';
});

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
  const label =
    session.source === 'sim'
      ? 'Simulator aktiv'
      : session.source === 'replay'
        ? 'Aufnahme wird abgespielt'
        : available
          ? 'Web Bluetooth verfügbar'
          : 'Web Bluetooth nicht verfügbar';
  badge.textContent = `${label} · ${LIBRARY_NAME} ${LIBRARY_VERSION}`;
  badge.className = `badge ${session.source !== 'ble' ? 'warn' : available ? 'ok' : 'error'}`;
  $('connection-hint').hidden = session.source !== 'ble';
}

// The browser may restore the radio selection on reload; start with whatever is checked.
const initialSource: Source =
  document.querySelector<HTMLInputElement>('#source-select input:checked')?.value === 'sim' ? 'sim' : 'ble';
for (const input of document.querySelectorAll<HTMLInputElement>('#source-select input')) {
  input.checked = input.value === initialSource; // a restored "replay" selection has no recording
}
session = createSession(initialSource);
$('sim-panel').hidden = session.source !== 'sim';
// Re-render once a second so ages/rates stay current without new packets.
setInterval(render, 1000);
void updateEnvStatus();
render();
