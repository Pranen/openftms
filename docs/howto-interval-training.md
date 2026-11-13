# How-To: Ein kleines Intervall-Training

In diesem How-To baust du ein Intervall-Programm, das den Trainer im
**ERG-Modus** steuert: Einfahren, ein paar harte Intervalle mit Pausen
dazwischen, Ausfahren. Am Ende hast du rund 150 Zeilen Code. Den kannst du in
einem Spiel, einer Trainings-App oder einfach in einer HTML-Seite verwenden.

Der komplette Code liegt in
[`packages/open-ftms-ble/examples/interval-workout.ts`](../packages/open-ftms-ble/examples/interval-workout.ts).
Er wird von den Tests gegen den simulierten Trainer geprüft
([`test/interval-workout.test.ts`](../packages/open-ftms-ble/test/interval-workout.test.ts)).
In der Demo kannst du ihn im Panel **Intervall-Programm** ausprobieren, mit
«Zeitraffer ×10» auch ohne zu schwitzen.

## 1. Die Idee

Ein Training ist eine Liste von **Schritten**. Jeder Schritt hat eine Dauer und
eine Zielleistung, optional eine Rampe:

```ts
export interface WorkoutStep {
  readonly name: string;
  readonly durationS: number;
  readonly powerW: number;
  readonly rampToW?: number; // linear von powerW nach rampToW
}
```

Ein **Ticker** läuft jede Sekunde. Er rechnet aus, in welchem Schritt wir sind,
bestimmt die Zielleistung und schickt sie an den Trainer, aber nur wenn sie
sich geändert hat.

Den Rest übernimmt die Bibliothek:

| Thema | erledigt `FtmsTrainer` |
|---|---|
| Kontrolle anfordern | automatisch vor dem ersten Befehl |
| Schnelle Wertänderungen | werden zusammengefasst (der neueste Wert gewinnt) |
| Verbindungsabbruch | Wiederverbinden, danach wird das letzte ERG-Ziel wiederhergestellt |
| Unsinnige Ziele | werden auf den Leistungsbereich des Trainers begrenzt (Flux 2: 0–800 W) |

## 2. Das Programm aus dem FTP bauen

Statt Watt fest einzutragen, rechnen wir mit Prozent der FTP
(Functional Threshold Power). So passt dasselbe Programm für alle in der Familie:

```ts
export function intervalSession(options: {
  ftpW: number;
  repeats: number;
  workS: number;
  restS: number;
  workPercent?: number;   // Standard 110 %
  restPercent?: number;   // Standard 50 %
  warmupS?: number;
  cooldownS?: number;
}): WorkoutStep[] {
  const { ftpW, repeats, workS, restS } = options;
  // Auf 5 W runden: 213 W sieht komisch aus und bringt nichts.
  const watts = (percent: number) => Math.round((ftpW * percent) / 100 / 5) * 5;
  const steps: WorkoutStep[] = [];
  if (options.warmupS) {
    steps.push({ name: 'Einfahren', durationS: options.warmupS, powerW: watts(45), rampToW: watts(70) });
  }
  for (let i = 1; i <= repeats; i++) {
    steps.push({ name: `Intervall ${i}/${repeats}`, durationS: workS, powerW: watts(options.workPercent ?? 110) });
    if (i < repeats) steps.push({ name: `Pause ${i}/${repeats - 1}`, durationS: restS, powerW: watts(options.restPercent ?? 50) });
  }
  if (options.cooldownS) {
    steps.push({ name: 'Ausfahren', durationS: options.cooldownS, powerW: watts(60), rampToW: watts(40) });
  }
  return steps;
}
```

Zum Beispiel ergibt `intervalSession({ ftpW: 200, repeats: 4, workS: 60, restS: 60, warmupS: 300, cooldownS: 180 })`
diese Schritte:

| Schritt | Dauer | Ziel |
|---|---|---|
| Einfahren | 5:00 | 90 → 140 W |
| Intervall 1/4 | 1:00 | 220 W |
| Pause 1/3 | 1:00 | 100 W |
| … | | |
| Intervall 4/4 | 1:00 | 220 W |
| Ausfahren | 3:00 | 120 → 80 W |

## 3. Der Runner

Der Runner ist ein `TypedEmitter`, so kann deine Oberfläche auf `step`,
`progress` und `finished` hören, genau wie bei den Geräten:

```ts
import { FtmsTrainer, TypedEmitter } from 'open-ftms-ble';

export interface WorkoutEvents {
  progress: WorkoutProgress;          // jeder Tick
  step: WorkoutProgress;              // neuer Schritt beginnt
  autoPause: { paused: boolean };     // aufgehört / wieder angefangen zu treten
  finished: { completed: boolean };
  error: unknown;                     // Ziel konnte nicht gesetzt werden
}

export class IntervalWorkout extends TypedEmitter<WorkoutEvents> {
  constructor(trainer: FtmsTrainer, steps: readonly WorkoutStep[], options: WorkoutOptions = {}) { … }
  start(): void { … }
  pause(): void { … }
  resume(): void { … }
  stop(): void { … }
}
```

### Der Tick

Das Herz des Programms. Die Zeit läuft nur, solange gefahren wird:

```ts
#tick(): void {
  const now = Date.now();
  const deltaS = ((now - this.#lastTick) / 1000) * this.#speed;
  this.#lastTick = now;

  // Auto-Pause: Ein Intervall herunterzuzählen, während niemand tritt, ist sinnlos.
  const cadence = this.#trainer.telemetry.cadenceRpm;
  if (this.#autoPauseBelowRpm > 0 && cadence !== undefined) {
    const shouldPause = cadence < this.#autoPauseBelowRpm;
    if (shouldPause !== this.#autoPaused) {
      this.#autoPaused = shouldPause;
      this.emit('autoPause', { paused: shouldPause });
    }
  }
  const paused = this.#paused || this.#autoPaused;
  if (!paused && this.#stepIndex >= 0) this.#elapsedS += deltaS;

  if (this.#elapsedS >= this.totalDurationS) {
    this.#finish(true);
    return;
  }

  const progress = this.#progressAt(this.#elapsedS, paused);
  if (progress.stepIndex !== this.#stepIndex) {
    this.#stepIndex = progress.stepIndex;
    this.emit('step', progress);
  }
  this.#send(progress.targetW);
  this.emit('progress', progress);
}
```

Drei Details, die man leicht übersieht:

1. **Zeit messen statt Ticks zählen.** `setInterval` ist nicht genau,
   besonders in Hintergrund-Tabs, wo Chrome Timer auf einmal pro Minute
   drosselt. Darum rechnen wir mit `Date.now()`. Ein verspäteter Tick holt
   die verlorene Zeit nach. Die Wechsel der Zielleistung kämen im Hintergrund
   trotzdem zu spät, deshalb sollte der Tab beim Training sichtbar bleiben.
   Ein `navigator.wakeLock.request('screen')` hält ausserdem den Bildschirm wach.
2. **`speed` ist Zeitraffer.** Mit `speed: 60` dauert eine Minute eine
   Sekunde. Das ist praktisch für Tests und für die Demo.
3. **Die Kadenz kommt aus `trainer.telemetry`.** Das ist ein synchroner
   Snapshot, den du jederzeit lesen kannst, ohne auf ein Event zu warten.

### Rampen

Pro Tick wird die Zielleistung linear interpoliert und auf 5 W gerundet. Eine
5-minütige Rampe von 90 auf 140 W schickt so nur etwa 10 Befehle statt 300:

```ts
const fraction = step.durationS > 0 ? Math.min(1, stepElapsedS / step.durationS) : 1;
const raw = step.rampToW === undefined ? step.powerW : step.powerW + (step.rampToW - step.powerW) * fraction;
const targetW = Math.round(raw / this.#roundToW) * this.#roundToW;
```

### Senden

```ts
#send(targetW: number): void {
  if (targetW === this.#sentW || !this.#trainer.isReady) return;
  this.#sentW = targetW;
  this.#trainer.setTargetPower(targetW).catch((error: unknown) => {
    this.#sentW = undefined; // beim nächsten Tick nochmals versuchen
    this.emit('error', error);
  });
}
```

Hier steckt keine Fehlerbehandlung für die Verbindung drin, und das ist
Absicht:

- **Während eines Reconnects** ist `isReady` false, der Runner sendet nichts,
  und die Zeit läuft weiter. Wird die Verbindung wiederhergestellt, setzt
  `FtmsTrainer` das letzte ERG-Ziel selbst wieder.
- **Hält eine andere App die Kontrolle** (zum Beispiel Zwift), wirft
  `setTargetPower` einen `ControlPointError`. Der Runner meldet ihn als
  `error`-Event und versucht es beim nächsten Tick wieder. Der Trainer
  fordert die Kontrolle ohnehin alle 10 s neu an.

## 4. Benutzen

```ts
import { FtmsTrainer } from 'open-ftms-ble';
import { IntervalWorkout, intervalSession } from './interval-workout';

const trainer = new FtmsTrainer();
connectButton.onclick = () => trainer.connect();          // Klick = User-Geste

startButton.onclick = () => {
  const steps = intervalSession({ ftpW: 200, repeats: 4, workS: 60, restS: 60, warmupS: 300, cooldownS: 180 });
  const workout = new IntervalWorkout(trainer, steps);

  workout.on('step', (p) => say(`${p.step.name}: ${p.targetW} Watt`));
  workout.on('progress', (p) => {
    progressBar.value = p.totalElapsedS / p.totalDurationS;
    label.textContent = `${p.step.name} · ${p.targetW} W · noch ${Math.ceil(p.stepRemainingS)} s`;
  });
  workout.on('autoPause', (e) => (pausedBanner.hidden = !e.paused));
  workout.on('finished', (e) => say(e.completed ? 'Geschafft!' : 'Abgebrochen'));

  workout.start();
};
```

## 5. Ohne Trainer entwickeln

Mit demselben Code und dem Simulator, ganz ohne Bluetooth:

```ts
import { FtmsTrainer, MockTransport, SimulatedTrainer } from 'open-ftms-ble';

const sim = new SimulatedTrainer({ cadenceRpm: 90 });
const trainer = new FtmsTrainer({ transport: new MockTransport([sim.peripheral]) });
await trainer.connect();                                   // kein Dialog, keine Geste nötig

const workout = new IntervalWorkout(trainer, steps, { speed: 60 });   // 1 min = 1 s
workout.start();
// sim.cadenceRpm = 0  → Auto-Pause testen
// sim.simulateConnectionLoss()  → Reconnect + Wiederherstellen des ERG-Ziels testen
```

Willst du echte Daten statt simulierter, nimm in der Demo eine Fahrt auf
(**Aufnahme herunterladen**) und spiele sie mit `ReplayTransport` ab, siehe
[API-Doku](api.md#aufnehmen-und-abspielen).

## 6. Ideen zum Weiterbauen

- **Simulation statt ERG:** Für eine «Strecke» bei jedem Schritt
  `trainer.setSimulation({ gradePercent })` statt `setTargetPower` aufrufen.
  Dann bestimmen Steigung, Gang und Kadenz die Leistung, wie draussen.
- **Herzfrequenz-Grenze:** Mit `hrm.heartRateBpm` die Pausen verlängern,
  bis der Puls unter einen Wert fällt.
- **Countdown-Ton** in den letzten 3 Sekunden vor einem Intervall:
  `p.stepRemainingS <= 3` im `progress`-Event.
- **Ergebnis speichern:** In `progress` Leistung und Puls mitschreiben und am
  Ende Durchschnitt und Normalized Power berechnen.
