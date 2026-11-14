# API-Doku: open-ftms-ble

Eine Bibliothek ohne Abhängigkeiten für Web Bluetooth: FTMS-Rollentrainer
(getestet mit Tacx Flux 2) und BLE-Pulsgurte. Sie läuft in Chrome und Edge über
`https://` oder `http://localhost`.

- [Schnellstart](#schnellstart)
- [FtmsTrainer](#ftmstrainer)
- [HeartRateMonitor](#heartratemonitor)
- [Gemeinsam: Verbindung, Events, Optionen](#gemeinsam-verbindung-events-optionen)
- [Fehler](#fehler)
- [Ohne Hardware: Simulator, Aufnahme, Replay](#ohne-hardware)
- [Protokoll-Ebene: Parser und Encoder](#protokoll-ebene)
- [How-To: Intervall-Training](howto-interval-training.md)
- [Fehlerbehebung](troubleshooting.md)

## Schnellstart

```ts
import { FtmsTrainer, HeartRateMonitor } from 'open-ftms-ble';

const trainer = new FtmsTrainer();
const hrm = new HeartRateMonitor();

trainer.on('telemetry', (t) => show(t.powerW, t.cadenceRpm, t.speedKmh));
hrm.on('heartRate', (m) => showHr(m.heartRateBpm));

connectButton.onclick = () => trainer.connect();   // muss in einem Klick-Handler laufen
hrmButton.onclick = () => hrm.connect();

await trainer.setTargetPower(200);                  // ERG
await trainer.setSimulation({ gradePercent: 4 });   // Steigung
```

Grundsätze:

- **Ereignisse oder Snapshots, wie es passt.** Jede Änderung kommt als Event.
  Für eine Spielschleife gibt es synchrone Getter wie `trainer.telemetry` oder
  `trainer.snapshot`.
- **Vernünftige Standardwerte.** Die Kontrolle wird automatisch angefordert,
  Verbindungsabbrüche werden mit Backoff behoben, das letzte Ziel wird danach
  wiederhergestellt, und Slider-Bursts werden zusammengefasst.
- **`undefined` heisst «Feld nicht gesendet», `null` heisst «Gerät sagt: nicht verfügbar».**

## FtmsTrainer

```ts
new FtmsTrainer(options?: FtmsTrainerOptions)
```

### Optionen

Zusätzlich zu den [gemeinsamen Optionen](#optionen):

| Option | Standard | Bedeutung |
|---|---|---|
| `autoRequestControl` | `true` | Kontrolle nach jedem (Re-)Connect und vor Befehlen anfordern |
| `restoreOnReconnect` | `true` | Nach einem Reconnect das letzte ERG-, Simulations- oder Widerstandsziel neu senden |
| `controlRetryIntervalMs` | `10000` | Wie oft die Kontrolle neu angefordert wird, solange eine andere App sie hält |
| `commandTimeoutMs` | `3000` | Wartezeit auf die Antwort des Control Points |
| `clampToSupportedRange` | `true` | Ziele auf den vom Trainer gemeldeten Bereich begrenzen |
| `resistanceLevelEncoding` | `'sint16'` | Breite des Widerstandsfelds in Indoor Bike Data (`'uint8'` für manche Geräte) |
| `resistanceLevelScale` | `0.1` bei `sint16`, `1` bei `uint8` | Umrechnung des gemeldeten Widerstands in `telemetry.resistanceLevel`, damit er dieselbe Einheit hat wie `setResistanceLevel()` (der Flux 2 meldet Zehntel). `indoorBikeData.resistanceLevel` bleibt der Rohwert |
| `targetResistanceEncoding` | `'sint16'` | Format von «Set Target Resistance Level» |

### Befehle

Alle Befehle sind `async`. Sie werfen `NotConnectedError`, wenn der Trainer
nicht bereit ist, und `ControlPointError`, wenn der Trainer ablehnt.

| Methode | Wirkung |
|---|---|
| `connect(peripheral?)` | Öffnet den Geräte-Dialog (nur in einer User-Geste) oder verbindet `peripheral` |
| `connectKnown(id, { advertisementTimeoutMs? })` | Verbindet ohne Dialog ein früher gewähltes Gerät. Gibt `false` zurück, wenn der Browser es nicht mehr kennt |
| `disconnect()` | Trennt; danach kein automatischer Reconnect |
| `requestControl()` | Fordert die Kontrolle an (gleichzeitige Aufrufe teilen sich eine Anfrage) |
| `setTargetPower(watts)` | ERG-Modus |
| `setSimulation({ gradePercent?, windSpeedMps?, crr?, cw? })` | Simulationsmodus. Weggelassene Felder behalten ihren letzten Wert (Start: crr 0.004, cw 0.51) |
| `setResistanceLevel(level)` | Widerstandsmodus, einheitslos mit Auflösung 0,1 |
| `start()` / `pause()` / `stop()` | Start or Resume / Stop or Pause |
| `reset()` | Setzt den Trainer zurück und fordert die Kontrolle danach neu an |
| `sendRaw(bytes)` | Beliebige Control-Point-Bytes ohne Feature-Prüfung (zum Debuggen) |

**Zusammenfassen («latest wins»):** Ruft ein Slider zum Beispiel
`setTargetPower` 30-mal pro Sekunde auf, sendet die Bibliothek nur, was der
Trainer abarbeiten kann. Der neueste Wert gewinnt, und alle wartenden Promises
erfüllen sich mit der Antwort auf den gesendeten Wert.

### Zustand (synchron)

| Getter | Typ | Inhalt |
|---|---|---|
| `connectionState` | `'disconnected' \| 'connecting' \| 'discovering' \| 'ready' \| 'reconnecting'` | Verbindungszustand |
| `isReady` | `boolean` | `connectionState === 'ready'` |
| `control` | `'none' \| 'requesting' \| 'granted' \| 'blocked'` | `blocked` heisst: eine andere App hält die Kontrolle |
| `mode` | `TrainerMode` | `{ kind: 'none' }`, `{ kind: 'erg', targetPowerW }`, `{ kind: 'simulation', parameters }` oder `{ kind: 'resistance', level }` |
| `telemetry` | `TrainerTelemetry` | Zusammengeführte letzte Werte: `powerW`, `cadenceRpm`, `speedKmh`, `totalDistanceM`, `heartRateBpm`, `elapsedTimeS`, `updatedAt`, … |
| `capabilities` | `FtmsCapabilities \| undefined` | Siehe unten |
| `snapshot` | `FtmsTrainerSnapshot` | Alles oben in einem Objekt |
| `deviceName`, `peripheral` | | Gewähltes Gerät; `peripheral.id` für `connectKnown` speichern |
| `supports(target)` | `boolean` | Ob das Ziel unterstützt wird, z. B. `supports('powerTarget')`. `true`, solange 0x2ACC unbekannt ist |

### Fähigkeiten

`capabilities` wird in zwei Stufen gefüllt, damit der Trainer schneller
«bereit» ist:

1. **Vor `ready`:** `features` (0x2ACC) und `characteristics` (welche
   Characteristics vorhanden sind). `complete: false`.
2. **Nach `ready`:** `powerRange`, `resistanceRange`, `inclinationRange`,
   `speedRange`, `heartRateRange`, `deviceInformation`,
   `hasCyclingPowerService`. Dann folgt ein zweites `capabilities`-Event mit
   `complete: true`. Bei einem Reconnect zum selben Gerät werden diese Werte
   nicht neu gelesen.

`connect()` erfüllt sich erst nach Stufe 2. Wer `await trainer.connect()`
schreibt, hat also immer die vollständigen Fähigkeiten.

### Events

Zusätzlich zu den [gemeinsamen Events](#events):

| Event | Payload | Wann |
|---|---|---|
| `telemetry` | `TrainerTelemetry` | Nach jedem Indoor-Bike-Data-Paket (Flux 2: ca. 1–4 Hz) |
| `indoorBikeData` | `IndoorBikeData` | Das geparste Paket inkl. Flags und Diagnose |
| `machineStatus` | `MachineStatus` | z. B. `targetPowerChanged`, `reset`, `controlPermissionLost` |
| `trainingStatus` | `TrainingStatus` | Falls vorhanden (der Flux 2 hat es nicht) |
| `controlPointResponse` | `ControlPointResponse` | Jede Antwort des Control Points |
| `controlStateChange` | `{ state, previous }` | `control` hat sich geändert |
| `modeChange` | `TrainerMode` | ERG, Simulation, Widerstand oder keiner |
| `capabilities` | `FtmsCapabilities` | Zweimal pro Verbindung, siehe oben |

## HeartRateMonitor

```ts
const hrm = new HeartRateMonitor(options?: BaseDeviceOptions);
hrm.on('heartRate', (m) => console.log(m.heartRateBpm, m.sensorContact, m.rrIntervalsMs));
```

| Getter | Inhalt |
|---|---|
| `heartRateBpm` | Letzter Puls |
| `snapshot` | `heartRateBpm`, `sensorContact` (`'detected' \| 'notDetected' \| 'notSupported'`), `rrIntervalsMs`, `energyExpendedKj`, `bodySensorLocation`, `deviceInformation`, `updatedAt` |

Uhren, die den Puls weitergeben (zum Beispiel Garmin «HR Broadcast»),
funktionieren auch. Sie liefern meist keine RR-Intervalle.

## Gemeinsam: Verbindung, Events, Optionen

### Optionen

| Option | Standard | Bedeutung |
|---|---|---|
| `transport` | `WebBluetoothTransport` | Austauschbar: `MockTransport`, `ReplayTransport` |
| `connectTimeoutMs` | `15000` | Timeout eines GATT-Connect-Versuchs |
| `connectRetries` | `2` | Zusätzliche Versuche bei typischen Chrome-Fehlern und bei Abbruch während der Service-Suche |
| `connectRetryDelayMs` | `600` | Pause zwischen diesen Versuchen |
| `operationTimeoutMs` | `10000` | Timeout einer GATT-Operation |
| `reconnect` | `{ enabled: true, maxAttempts: 10, initialDelayMs: 1000, maxDelayMs: 30000 }` | Automatischer Reconnect mit exponentiellem Backoff |

### Verbindungsablauf

```
disconnected → connecting → discovering → ready
                                            │ Verbindung verloren (nicht vom Benutzer)
                  discovering ← reconnecting ┘   Backoff, max. N Versuche
```

### Events

| Event | Payload | Wann |
|---|---|---|
| `connectionStateChange` | `{ state, previous, error? }` | Jeder Zustandswechsel |
| `reconnectScheduled` | `{ attempt, maxAttempts, delayMs }` | Vor jedem Reconnect-Versuch |
| `error` | `OpenFtmsError` | Fehler ohne Aufrufer, z. B. im Reconnect oder beim Auswerten von Notifications |
| `raw` | `RawPacket` | Jedes Paket: `direction`, `kind` (`read`, `notification`, `write`), `characteristic`, `hex`, `timestamp` |
| `gattOperation` | `GattOperationTrace` | Dauer jeder GATT-Operation (zur Diagnose) |

`on()` gibt eine Abmeldefunktion zurück. Dazu gibt es `once()`, `off()` und
`removeAllListeners()`.

### Wiederverbinden ohne Dialog

```ts
const saved = localStorage.getItem('trainerId');
if (saved && (await trainer.connectKnown(saved).catch(() => false))) {
  // verbunden, ohne Dialog
} else {
  connectButton.hidden = false;      // normaler Weg über einen Klick
}
trainer.on('connectionStateChange', (e) => {
  if (e.state === 'ready' && trainer.peripheral) localStorage.setItem('trainerId', trainer.peripheral.id);
});
```

Das braucht `navigator.bluetooth.getDevices()`. In aktuellen Chrome-Versionen
ist es vorhanden; falls nicht, gibt `connectKnown` `false` zurück. Die
Bibliothek wartet zuerst, bis das Gerät sendet (`watchAdvertisements`). Ist
es ausgeschaltet, kommt nach `advertisementTimeoutMs` (Standard 10 s) ein
`ConnectionError`.

## Fehler

Alle Fehler erben von `OpenFtmsError` und haben eine `cause`, wenn sie einen
Browser-Fehler einpacken.

| Klasse | Typischer Grund |
|---|---|
| `BluetoothUnavailableError` | Kein Web Bluetooth (Firefox/Safari, `http://` ausser localhost) |
| `UserCancelledError` | Geräte-Dialog geschlossen |
| `ConnectionError` | Verbinden fehlgeschlagen, Gerät hat kein FTMS, Verbindung verloren |
| `NotConnectedError` | Befehl, während der Trainer nicht `ready` ist |
| `GattOperationError` | Lesen, Schreiben oder Abonnieren fehlgeschlagen |
| `TimeoutError` | Keine Antwort in der Zeit |
| `ControlPointError` | Der Trainer lehnt ab. `error.result`: `'opCodeNotSupported'`, `'invalidParameter'`, `'operationFailed'`, `'controlNotPermitted'` |
| `UnsupportedFeatureError` | Laut 0x2ACC nicht unterstützt, oder kein Control Point vorhanden |
| `InvalidParameterError` | Wert ausserhalb dessen, was das Protokoll kodieren kann |

## Ohne Hardware

### Simulator

```ts
import { FtmsTrainer, HeartRateMonitor, MockTransport, SimulatedTrainer, SimulatedHeartRateMonitor } from 'open-ftms-ble';

const sim = new SimulatedTrainer({ cadenceRpm: 85 });
const simHr = new SimulatedHeartRateMonitor({ powerSource: () => sim.powerW });
const transport = new MockTransport([sim.peripheral, simHr.peripheral]);
const trainer = new FtmsTrainer({ transport });
const hrm = new HeartRateMonitor({ transport });
await trainer.connect();   // kein Dialog, keine User-Geste nötig
```

Der Simulator antwortet wie ein echter Trainer: Er verwaltet die Kontrolle,
schickt Machine Status und rechnet die Leistung mit einfacher Physik. Zum
Testen gibt es:

- `sim.cadenceRpm = 0`: der Fahrer hört auf zu treten
- `sim.controlHeldByOtherApp = true`: eine andere App hält die Kontrolle
- `sim.simulateControlLoss()`: Kontrollverlust
- `sim.simulateConnectionLoss()`: Verbindungsabbruch

### Aufnehmen und Abspielen

```ts
import { SessionRecorder, ReplayTransport, parseRecording } from 'open-ftms-ble';

// Aufnehmen
const recorder = new SessionRecorder();
recorder.attach(trainer, 'Trainer');
recorder.attach(hrm, 'Pulsgurt');
// … fahren …
const json = JSON.stringify(recorder.toRecording());

// Abspielen
const transport = new ReplayTransport(parseRecording(JSON.parse(json)), { speed: 1, loop: true });
const replayed = new FtmsTrainer({ transport });
await replayed.connect();
```

So funktioniert das Abspielen:

- Gelesene Werte aus der Aufnahme werden zu statischen Werten.
- Notifications werden im Originaltakt abgespielt.
- Befehle an den Control Point werden immer mit «success» beantwortet.

In der Demo heissen die Knöpfe **Aufnahme herunterladen** und **Aufnahme
laden…**. Eine Aufnahme vom echten Flux kann direkt als Test-Fixture dienen.

## Protokoll-Ebene

Reine Funktionen ohne Bluetooth, nützlich für eigene Transporte oder Tests:

| Funktion | Characteristic |
|---|---|
| `parseIndoorBikeData(bytes, { resistanceLevelEncoding? })` | 0x2AD2 Indoor Bike Data |
| `parseMachineStatus(bytes)` | 0x2ADA Fitness Machine Status |
| `parseFitnessMachineFeatures(bytes)` | 0x2ACC Features |
| `parseTrainingStatus(bytes)` | 0x2AD3 Training Status |
| `parseSupportedPowerRange` / `…ResistanceLevelRange` / `…InclinationRange` / `…SpeedRange` / `…HeartRateRange` | 0x2AD4–0x2AD8 |
| `parseControlPointResponse(bytes)` | 0x2AD9 Antwort (`0x80 …`) |
| `encodeRequestControl()`, `encodeReset()`, `encodeSetTargetPower(w)`, `encodeSetIndoorBikeSimulation(p)`, `encodeSetTargetResistanceLevel(l)`, `encodeStartOrResume()`, `encodeStopOrPause('stop' \| 'pause')`, … | 0x2AD9 Befehle |
| `parseHeartRateMeasurement(bytes)` | 0x2A37 Heart Rate Measurement |
| `toHex(bytes)`, `fromHex('05 c8 00')` | Hilfsfunktionen |

Jedes Ergebnis enthält `bytes` und `diagnostics` (`truncated`,
`trailingBytes`, `reservedFlags`). Ein kaputtes Paket wirft also nicht,
sondern wird markiert.

## Installation

Die Bibliothek ist (noch) nicht auf npm. Weitergeben lässt sie sich als
Tarball:

```bash
cd packages/open-ftms-ble
npm pack                       # baut und erzeugt open-ftms-ble-0.1.0.tgz
```

Im Zielprojekt:

```bash
npm install ./pfad/zu/open-ftms-ble-0.1.0.tgz
```

Das Paket ist reines ESM mit TypeScript-Typen und ohne Laufzeit-Abhängigkeiten.
Es funktioniert mit Vite, webpack und esbuild, aber auch direkt im Browser
über `<script type="module">`.
