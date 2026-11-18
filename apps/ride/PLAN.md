# Ride (Arbeitstitel) – Indoor-Cycling-PWA im Rheintal

**Status: Planung abgeschlossen (18.11.2026), noch kein Code.** Nach jedem abgeschlossenen Meilenstein die
Status-Spalte unten aktualisieren.

Webbasierte Indoor-Cycling-App wie Zwift, aber lokal, unabhängig und im PS1-Retro-Look. Statt einer Fantasiewelt
die echte Region Feldkirch – Landquart – Walenstadt – Oberriet (ca. 40 × 40 km). Aufrufen, Smart Trainer verbinden,
losfahren: komplett client-seitig, keine Installation.

**Stack:** TypeScript · Vite · Three.js (`WebGPURenderer` + TSL, Rückfall WebGL2) · vite-plugin-pwa · Vitest ·
Python (Geodaten-Pipeline) · `open-ftms-ble` (dieses Repo) · `@pranen/activelook`
**Deployment:** GitHub Actions baut, zentraler Caddy liefert aus (Vorlage aus pwa-infrastructure mit
`output: apps/ride/dist`, `build: npm run build -w ride`, `paths`-Filter auf `apps/ride/**` und `packages/**`)
**Zielgeräte:** Desktop/Laptop mit Chrome oder Edge (Web Bluetooth), Android-Tablet. Kein iOS-Safari.
**Vorbilder:** `C:\data\li-auto` (Strasse/Gelände, Brücken, Gebäude) und `C:\data\ski` (Quellen, Kacheln,
Panorama, Retro-Renderer). Code von dort **kopieren** und die Herkunft im Dateikopf vermerken; die gemeinsame
Python-Bibliothek wird erst nach dem Vertical Slice herausgelöst.

---

## Entscheide

| Thema | Entscheid |
|---|---|
| Repo | Monorepo openftms: `apps/ride`, `packages/sim-core`, `packages/route-graph`, `tools/world-pipeline` |
| Code aus li-auto/ski | erst kopieren, später gemeinsame Python-Bibliothek herauslösen |
| Pipeline | Python (GDAL/rasterio, numpy, pyosmium), offline, erzeugt statische Assets |
| Weltformat | Spezifikation (dieses Dokument); Python schreibt, TS liest, Golden-File-Tests auf beiden Seiten |
| Koordinaten | LV95 (EPSG:2056) in Metern, im Client relativ zu Ursprüngen; x = Ost, y = Höhe, z = Süd |
| Strassennetz | OSM, global als `graph.bin`; Fahrnetz (Graph) getrennt vom Kulissennetz (nur in Kacheln) |
| Gelände | Höhenpyramide, L0 = 2-km-Kacheln mit **8 m** Raster; kein 2-m-Detailgelände im Client |
| Gebäude | parametrisch (Grundriss, Trauf-/Firsthöhe, Dachform, Farbklasse) wie li-auto |
| Bodenbedeckung | OSM (einheitlich über die Grenzen), swissTLM3D eventuell später |
| Weltdaten | **in Git**, unter den Regeln im Abschnitt «Weltdaten in Git» |
| Physik | virtuelle Geschwindigkeit aus der Leistung; die Trainer-Geschwindigkeit wird nicht verwendet |
| Trainer | SIM-Modus; GradeController mit Vorausschau, Schwierigkeit k = 50 %, Ratenbegrenzung |
| Renderer | `WebGPURenderer` + TSL wie ski, 240 px Höhe, zwei Tiefen-Durchgänge, Vertex-Wackeln schwach und abschaltbar |
| Leistungsmesser ohne Smart Trainer (CPS 0x1818) | später, nicht im MVP |

---

## Architektur

```
┌──────────── OFFLINE (tools/world-pipeline, Python) ─────────────┐
│ Ingest → Normalize (LV95) → Graph / Terrain / Gebäude → Pack    │
└───────────────────────────────┬─────────────────────────────────┘
          Weltformat: manifest.json · graph.bin/.json · tiles/L*/…
┌───────────────────────────────┴─────────────────────────────────┐
│ CLIENT (apps/ride)                                              │
│ Presentation : Renderer (Three.js) · DOM-HUD · Brillen-HUD      │
│ Application  : Session-Automat · Store (hot/cold) · Event-Bus   │
│ Domain       : sim-core (Physik, Position, Navigator, Grade,    │
│                Recorder) · route-graph (Graph, Routing, Match)  │
│ Platform     : open-ftms-ble · activelook · AssetLoader (SW)    │
│                Storage (IndexedDB) · FileIO (GPX/FIT)           │
└─────────────────────────────────────────────────────────────────┘
```

### Ordnerstruktur

```
openftms/
├─ packages/open-ftms-ble      (besteht, npm)
├─ packages/sim-core           Physik, Navigator, GradeController, Recorder – TS ohne DOM/Three.js
├─ packages/route-graph        graph.bin lesen, räumlicher Index, Routing, Map-Matching – TS
├─ apps/demo                   (besteht) Prüfstand der Library
├─ apps/ride                   die PWA
│  ├─ src/platform/            Geräte, AssetLoader, Storage, FileIO
│  ├─ src/app/                 Session-Automat, Store, Befehle
│  ├─ src/render/              Renderer, Kacheln, Strassen, Gebäude, Fahrer, Kamera, Retro-Pass
│  ├─ src/workers/             world-worker (Dekodieren + Meshes), route-worker (Matching)
│  ├─ src/ui/                  HUD, Menüs, Brillen-HUD
│  └─ public/world/            Weltdaten (von der Pipeline, eingecheckt)
└─ tools/world-pipeline        Python: Rohdaten → Weltformat
```

### Grundsätze

1. **Die Pipeline rechnet, der Client zeichnet** (li-auto): In den Dateien stehen Parameter, keine Dreiecke.
   Der Client macht aus Rastern Gitter, aus Mittellinien Bänder und aus Grundrissen Häuser.
2. **Der Graph ist das Rückgrat:** Physik, Steigung am Trainer, Navigation, Routing, GPX-Matching,
   Strassenbänder und der Einschnitt ins Gelände kommen alle aus denselben Kanten.
3. **Physik unabhängig vom Laden:** Fehlt eine Kachel, zeigt der Renderer die gröbere Stufe; die Fahrt läuft weiter.
4. **Reine Logik ohne Three.js und ohne DOM** (`sim-core`, `route-graph`), mit Vitest getestet.
5. **Main Thread schonen:** Web Bluetooth gibt es nur dort. Dekodieren, Mesh-Bau und Map-Matching laufen im Worker.
6. **Alle Tuning-Werte in einer `config.ts`**, keine Magic Numbers.
7. **Kein Allokieren im Frame-Loop.**

---

## Datenpipeline (`tools/world-pipeline`)

**Region:** LV95-Box um (9.28, 46.95) – (9.72, 47.36) WGS84; die li-auto-Box reicht weder bis Oberriet noch bis Feldkirch.
Panorama-Stufen reichen weiter (ca. 64 km um die Region).

| Quelle | Inhalt | Herkunft im Code |
|---|---|---|
| swissALTI3D 2 m (STAC-API) | Höhen CH/FL | `ski/pipeline/lib/sources.py` |
| BEV-Laserscan 1 m (COG) | Höhen Vorarlberg | `ski/pipeline/lib/sources.py` |
| Copernicus GLO-30/90 | Panorama | `ski/pipeline/lib/panorama.py` |
| Geofabrik CH, LI, AT | Strassen, Bodenbedeckung, Gewässer, Grundrisse AT | `ski/.../sources.py`, `li-auto/pipeline/osm.py` |
| swissBUILDINGS3D | Gebäude CH/FL | `li-auto/pipeline/sb3d.py` |

**Stufen** (jede gecacht und deterministisch):
Ingest → Normalize (Mosaik in LV95, PBF auf die Box zuschneiden) → Graph → Terrain (Pyramide, Strassen einschneiden)
→ Gebäude → Kulisse/Gewässer → Pack (Manifest, Hashes) → Prüfen (Querprofile wie `li-auto/pipeline/check_profiles.py`,
Steigungs-Histogramm: über 25 % auf Asphalt ist verdächtig).

---

## Strassengraph

### Filter (Fahrnetz)

Gezählt im Rheintal-Auszug (CH+LI, Box 9.30–9.66 / 47.02–47.30): track 2'286 km, path 1'506 km, primary 797 km,
motorway 690 km, residential 616 km, service 592 km, unclassified 553 km, footway 459 km, tertiary/secondary 156/135 km,
cycleway 105 km; 2'845 Brücken, 478 Tunnel, 292 Kreisel. Hochgerechnet auf die Region: ca. 6'000–8'000 km Fahrnetz,
40–60k Kanten.

| | Regel |
|---|---|
| ja | `cycleway`, `residential`, `living_street`, `unclassified`, `tertiary`, `secondary`, `primary`, `*_link` |
| bedingt | `track` mit `tracktype=grade1–3` oder befestigtem Belag (grade3 als Kies markiert); `path`/`footway`/`pedestrian` mit `bicycle=yes\|designated\|permissive` |
| nein | `bicycle=no\|use_sidepath\|private`, `access=no` ohne Velo-Ausnahme, `motorroad=yes`, `steps`, `service`, `construction`, `proposed` |
| Kulisse | `motorway`, `trunk`, Bahn, `service` – nur als Bänder in den Kacheln, nicht befahrbar |

Danach nur die grösste zusammenhängende Komponente behalten. Alp- und Forststrassen (grade1–3) gehören dazu:
die besten Anstiege für den Trainer.

### Vereinfachungen

1. Kreisel (`junction=roundabout`) als **ein** Knoten.
2. Knoten innerhalb von 15 m zu einem Entscheidungspunkt zusammenfassen; Stichkanten unter 20 m entfernen.
3. Grad-2-Knoten auflösen: eine Kante reicht von Entscheidungspunkt zu Entscheidungspunkt. Attributwechsel
   (Brücke, Tunnel) als Abschnitte innerhalb der Kante.
4. Höhe alle 5 m aus swissALTI3D/BEV; Brücken und Tunnel linear zwischen den Enden (`li-auto/pipeline/route.py`);
   glätten; an Knoten die Endhöhen aller Kanten auf denselben Wert ziehen.
5. Einbahn: ungerichtet gespeichert mit Zugangsflags pro Richtung; im Spiel standardmässig ignoriert (Einstellung).

### Format: `graph.bin` + `graph.json`

Little-Endian, Abschnitte 4-Byte-ausgerichtet (TypedArray-Views ohne Kopie), Struct-of-Arrays.

```
graph.json   version, buildHash, Region, Ursprung E0/N0, Quellen + ODbL-Hinweis,
             Velorouten-Tabelle [{bit, network, ref, name}], Abschnittstabelle {name: [offset, length, type]}

graph.bin
 nodes      x, z         Int32 cm (relativ zum Ursprung)
            flags        Uint8 (Kreisel, Grenze, …)
 edges      from, to     Uint32
            lengthCm     Uint32
            attrs        Uint32 – Klasse 4 Bit, Belag 3 Bit, Zugang vor/rück, Velostreifen, Kreisel, Reserve
            routes       Uint32 Bitmaske → Velorouten-Tabelle
            geomStart    Uint32, geomCount Uint16
            profStart    Uint32 (Anzahl = ceil(Länge / 5 m) + 1)
            nameId       Uint32 → Stringtabelle
            osmWayId     Float64 (Debug/Attribution, abtrennbar)
 adjacency  offsets Uint32[N+1], entries Uint32 (edgeId << 1 | Richtung)   (CSR)
 geometry   x, z Int32 cm, vereinfacht (ca. 1 Punkt / 10–15 m)
 profiles   h Uint16 cm + Offset, bereits geglättet – die einzige Wahrheit für Physik und Trainer
 sections   edgeId, sStart, sEnd, flags (Brücke/Tunnel/Galerie)
 strings    UTF-8 + Offsets
```

Grösse: ca. 3–5 MB roh, 1.5–2.5 MB über HTTP. Der räumliche Index (Raster 250 m → Kanten) entsteht beim Laden im Worker.

**Kanten-IDs sind nicht stabil.** Gespeicherte Routen und Fahrten speichern die Polylinie in LV95 plus `buildHash`;
ändert sich der Hash, wird beim Laden neu gematcht (gleicher Code wie GPX-Import).

---

## Kachelformat

### Höhenpyramide

Jede Kachel hat 257 × 257 Knoten (eine geteilte Randzeile; Flat Shading braucht keine stetigen Normalen).

| Stufe | Kachel | Raster | Quelle | Anzahl |
|---|---|---|---|---|
| L0 | 2 km | 8 m | swissALTI3D / BEV | 400 |
| L1 | 4 km | 16 m | dto. | 100 |
| L2 | 8 km | 32 m | dto. | 25 |
| L3 | 16 km | 64 m | + Copernicus ausserhalb | ca. 16 |
| L4 | 64 km | 250 m | Copernicus (Panorama) | 4 |

Das Panorama ist die oberste Stufe der Pyramide, kein eigenes System (kein Polar-Ring wie in ski: man entfernt sich
bis 20 km vom Zentrum). Client wählt Stufen pro Ring (CDLOD): 3 × 3 L0, dann Ringe L1, L2, …; Risse mit Schürzen.

Die 2-m-Daten dienen nur der Pipeline (Profil im Graphen, Einschnitt ins 8-m-Raster). Der Client baut zwischen
Strassenrand und Gelände einen Böschungsstreifen. Reicht das im Vertical Slice nicht, kommt ein Detail-Abschnitt dazu.

### Datei

```
public/world/tiles/L{lvl}/{ix}_{iy}.{hash8}.bin
 Header   magic "RIDE", version, lvl, ix, iy, Ursprung (LV95, SW-Ecke), n = 257, cell,
          Höhen-scale/offset, Abschnittszahl
 Tabelle  [{id, offset, length}]
 HGHT     257² × Uint16, Delta 2. Ordnung (wie ski .sk2)              alle Stufen
 CODE     257² × Uint8: Wald, Wiese, Reben, Siedlung, Fels, Wasser, Gletscher …
 LINE     Kulissennetz als Polylinie (Int16 dm lokal) + Höhe + Breitenklasse + Brücke/Tunnel   L0, L1
 WATR     Wasserflächen mit Pegel, Flüsse als Band                    L0–L2
 BLDG     Gebäude parametrisch (Grundriss Int16 dm, Trauf-/Firsthöhe, Dachform, Farbklasse)  L0; L1 Quader
 LMRK     Wahrzeichen {assetId, Position, Drehung} → glTF in /landmarks/                     L0, L1
```

Nicht in den Kacheln: das Fahrnetz (kommt aus `graph.bin`) und alles, was die Physik braucht.
Bäume streut der Client deterministisch aus `CODE` und Seed (wie `generateVegetation` in ski).
`manifest.json` ordnet jedem Kachelschlüssel (`L0/12_7`) seinen Hash zu; der Service Worker lädt nach einem
Welt-Update nur geänderte Kacheln.

### Grössen (geschätzt)

| | roh (Git) | HTTP (brotli) |
|---|---|---|
| L0 gesamt (400 × ca. 230 KB) | ca. 90 MB | ca. 30 MB |
| L1–L4 | ca. 30 MB | ca. 10 MB |
| `graph.bin` | ca. 4 MB | ca. 2 MB |
| **Ganze Welt** | **ca. 125 MB** | **ca. 40–45 MB** |

---

## Weltdaten in Git

1. **Eigene Lizenz:** `public/world/LICENSE` (ODbL für den aus OSM abgeleiteten Graphen und die Kacheln) und
   `ATTRIBUTION.md`: «© swisstopo» (OGD), BEV (CC BY 4.0), Copernicus-Hinweis (DLR/Airbus, EU/ESA), © OpenStreetMap-Mitwirkende.
   Das Wurzel-README hält fest: Code MIT, Weltdaten ODbL + Quellen. `open-ftms-ble` auf npm ist nicht betroffen.
2. **Deterministische Pipeline:** gleiche Eingabe → byteidentische Ausgabe (sortiert, keine Zeitstempel, feste Rundung).
3. **Unkomprimiert einchecken** (Git kann dann Deltas bilden); komprimiert wird beim Ausliefern.
4. **Nur an Meilensteinen einchecken.** Beim Iterieren ist der Ausgabeordner in `.gitignore`.
5. **Pipeline-Cache nie in Git.**

---

## Client

### Session und Store

- **Session-Automat:** Kopplung → Modus/Route wählen → Fahrt → Pause → Abschluss/Export.
- **Hot State** (Position, Geschwindigkeit, Leistung): mutierbares Objekt, vom Renderer pro Frame gelesen.
- **Cold State** (Verbindungen, Einstellungen, Route, Session-Phase): kleiner reaktiver Store (Signals).
- DOM-HUD und Brillen-HUD sind zwei gleichwertige Views auf denselben Cold State.
- Tastatur, Touch und Brillengesten erzeugen dieselben Befehle (z. B. `ChooseTurn`).

### Speicher

- Kacheln und Graph: Cache Storage über den Service Worker (unveränderliche Dateien mit Hash).
- Benutzerdaten (Fahrten, Routen, Einstellungen, gekoppelte Geräte): IndexedDB.
- Knopf «Region offline speichern» (ca. 40–45 MB).

---

## Physik und Trainer

### Bewegungsmodell (`sim-core`, eindimensional entlang des Graphen)

```
m·dv/dt = P/max(v, 1 m/s) − m·g·(sin θ + crr·cos θ) − ½·ρ(h)·CdA·v² − F_brems
```

| Grösse | Wert |
|---|---|
| m | Fahrer + Velo, Standard 75 + 8 kg (Einstellung) |
| θ | aus dem geglätteten Profil des Graphen (echte Steigung) |
| crr | nach Belag: Asphalt 0.004, Pflaster 0.006, Naturstrasse fein 0.008, Kies 0.012 – geht auch an den Trainer |
| ρ(h) | 1.225 · e^(−h/8400) |
| CdA | 0.32 (Einstellung), Windschatten später |
| F_brems | automatisch vor engen Kurven: v_max = √(a_quer · r), a_quer = 4 m/s² |

Position = `(edgeId, Richtung, s)`; Überschuss am Kantenende geht auf die vom Navigator gewählte nächste Kante.

### Taktgeber

- Fester Schritt **20 Hz** mit Accumulator, Zeit aus `performance.now()`.
- Auslöser: `requestAnimationFrame`, **jedes Telemetrie-Event** (kommt auch im Hintergrund-Tab), Intervall 250 ms.
- Leistung zwischen Paketen gehalten (Flux 2: 1–4 Hz); nach 3 s ohne Paket P = 0 und HUD «Signal verloren».
- Auto-Pause bei P = 0 und v < 1 km/h während 3 s. Screen Wake Lock während der Fahrt.

### GradeController

1. **Vorausschau:** mittlere Steigung über `[s + v·1.2 s, s + v·1.2 s + 20 m]` (BLE ca. 300 ms + Bremse ca. 1 s).
2. **Schwierigkeit k** (0–100 %, Standard 50 %): bergauf `k · θ`, bergab `0.5 · k · θ`.
3. **Begrenzen:** bergauf auf das Trainer-Maximum (FTMS-Bereiche, Flux 2 ca. 16 %), bergab auf −5 %.
4. **Ratenbegrenzung:** höchstens 2 Prozentpunkte/s; senden ab 0.1 % Änderung (Bündeln macht die Library).

Physik rechnet mit der echten Steigung, der Trainer bekommt die skalierte. Dazu `cw = ½·ρ(h)·CdA` bei grösseren
Höhenwechseln, `crr` beim Belagswechsel, `windSpeedMps = 0`.

### Navigator

- Ca. 150 m vor einer Kreuzung: Optionen links / geradeaus / rechts im HUD und auf der Brille.
- Vorgabe: im Strecken-Modus die Route, im freien Modus «möglichst geradeaus», bei Gleichstand die Velo-Route.
- An der Kreuzung ist die Wahl fest; die Physik bekommt nur die nächste Kante.

### Aufzeichnung und Export

- 1-Hz-Samples: Zeit, WGS84-Position, Höhe aus dem Profil, virtuelle Geschwindigkeit/Distanz, Leistung, Kadenz, Puls.
- FIT/TCX im Browser; FIT mit `sport=cycling`, `sub_sport=virtual_activity` (Strava «Virtual Ride»), damit die
  echte GPS-Spur nicht in Segment-Bestenlisten landet.

---

## Renderer

| Baustein | Umsetzung | Herkunft |
|---|---|---|
| Backend | `WebGPURenderer` + TSL, automatischer Rückfall WebGL2 | ski |
| Auflösung | Canvas mit **240 px** Höhe (Einstellung 180–360), Breite nach Seitenverhältnis, `image-rendering: pixelated` | ski/li-auto |
| Farben | 15 Bit (32 Stufen pro Kanal) + Bayer 4 × 4 | `ski/src/render/retro-pass.ts` |
| Shading | Flat, eine Palettenfarbe pro Dreieck aus `CODE`; Normale aus `dFdx/dFdy`, Gitter bleibt indexiert | ski + neu |
| Vertex-Wackeln | Clip-Space auf halbe interne Auflösung runden; **schwach und abschaltbar** (Seekrankheit bei langen Fahrten) | neu |
| Affine Texturen | `uv·w` und `w` als Varying, im Fragment teilen; nur Markierungen, Fassaden, Schilder | neu |
| Tiefe | **zwei Durchgänge:** fern (L2–L4, near 400 m / far 100 km), Tiefe löschen, nah (near 0.3 m / far 6 km) | neu |
| Nebel | Detail-Nebel ab ca. 2.5 km in Geländefarbe (verdeckt Laden/Entladen); Dunst bis ca. 60 km, höhenabhängig | li-auto `daytime.ts`, ski `panorama.ts` |
| Bäume | instanzierte Sprites/Low-Poly mit Alpha-Test | li-auto `trees.ts` |
| Himmel | Farbverlauf, Sprite-Wolken; Tageszeit später | li-auto `daytime.ts` |
| Schatten | keine, Fleck unter dem Fahrer | – |
| Fahrer | Low-Poly, Kurbelwinkel aus der Kadenz integriert | neu |
| Kamera | folgt der geglätteten Strecke aus dem Graphen (vorausschauend), nicht dem Fahrer; kein Kamerawackeln | neu |
| Strasse | Band 5 cm über dem eingeschnittenen Gelände, Polygon-Offset; Böschungsstreifen zum 8-m-Raster | li-auto |

**Budget:** 60 FPS (begrenzt), ≤ 1 Mio. Dreiecke, ≤ 300 Draw-Calls, Main Thread ≤ 8 ms pro Frame,
1–2 Geometrie-Uploads pro Frame, ein Atlas 512 × 512 (Nearest, keine Mipmaps). Bei zu langsamen Frames L0 mit
16 m vermaschen, die Auflösung bleibt.

**Erkenntnisse aus dem Mockup** (18.11.2026, Wegwerf-Prototyp mit Copernicus 100 m + OSM): Der Look trägt;
100 m Raster ist im Talboden zu grob (bestätigt 8 m); Strassenbänder überlappen an Kreuzungen sichtbar
(flache Kreuzungsflächen und Zeichenreihenfolge nötig); Gebäude brauchen Dachformen.

---

## Offene Themen

- ActiveLook-HUD: Layout, 1-Hz-Aktualisierung nur bei Änderung, Gesten → Befehle
- GPX-Import: HMM/Viterbi-Matching im Worker, Rückfall bei Wegen ausserhalb des Fahrnetzes (temporäre Kante auf dem Gelände)
- Kreuzungsgeometrie im Rendering
- Wahrzeichen (Schloss Vaduz, Schattenburg, …) als glTF
- Strava-Upload (OAuth) oder nur Datei-Export
- Leistungsmesser ohne Smart Trainer (CPS 0x1818) als Erweiterung von `open-ftms-ble`

---

## Meilensteine

| | Meilenstein | Inhalt | Status |
|---|---|---|---|
| M0 | Gerüst | `apps/ride` (Vite, PWA, Three.js WebGPU), `packages/sim-core`, `packages/route-graph`, `tools/world-pipeline`, Deploy-Workflow | offen |
| M1 | Vertical Slice | **2 × 2 L0-Kacheln Eschen/Schellenberg** (siehe unten): Graph-Ausschnitt, Gelände 8 m mit Einschnitt, freies Fahren, Trainer-Steigung, Retro-Pass, HUD | offen |
| M2 | Graph der Region | ganzes Fahrnetz inkl. Vorarlberg, Prüfungen (Querprofile, Steigungs-Histogramm), Navigator an Kreuzungen | offen |
| M3 | Welt-Streaming | Pyramide L0–L4, Ringwahl, Worker, Service Worker, Gebäude, Kulisse, Gewässer, Bäume | offen |
| M4 | Routen | GPX-Import mit Map-Matching, Routenwahl, Routen speichern | offen |
| M5 | Brille | ActiveLook-HUD mit Navigation und Gesten | offen |
| M6 | Export | FIT/TCX, Strava | offen |
| M7 | Feinschliff | Wahrzeichen, Tageszeit, Offline-Region, Einstellungen | offen |
| – | Gemeinsame Bibliothek | Python-Geodaten-Code aus li-auto/ski/ride herauslösen | nach M1 |

### M1: Gebiet Eschen/Schellenberg

Das L0-Raster ist global an LV95 ausgerichtet (Kachelecken auf geraden Kilometern). Eschen (LV95 ca. 2'757'850 /
1'230'990) und Schellenberg (ca. 2'759'570 / 1'233'430) liegen 3 km auseinander und damit in verschiedenen Kacheln.
Deshalb ist der Vertical Slice **2 × 2 Kacheln = 4 × 4 km**:

| | E | N |
|---|---|---|
| SW-Ecke | 2'756'000 | 1'230'000 |
| NO-Ecke | 2'760'000 | 1'234'000 |

Darin liegen Eschen, Gamprin, Mauren, Schellenberg und der Eschnerberg; Nendeln liegt knapp südlich ausserhalb.
Der Ausschnitt deckt damit Flachstück **und** Anstieg ab und testet nebenbei Kachelgrenzen und Nachladen.

- **Anstiege:** Mauren → Schellenberg (wie li-auto-Level `schellenberg`), Eschen → Eschnerberg, Gamprin → Schellenberg
- **Daten:** swissALTI3D 2 m, swissBUILDINGS3D, OSM (CH/LI); Österreich (Hinterschellenberg/Grenze) liegt voraussichtlich
  östlich ausserhalb, vor dem Bau prüfen
- **Vergleich:** li-auto hat dort schon Levels (`eschen`, `schellenberg`, `ruggell-schellenberg`) und ein Querprofil
  (`pipeline/cache/eschen-schellenberg-profile.png`), gut zum Gegenprüfen von Brücken und Einschnitt
- **Ränder:** Am Rand des Ausschnitts endet der Graph; der Navigator wendet dort (oder Kanten bis zur Grenze kappen)
- **Fertig, wenn:** man mit dem Flux 2 (oder `SimulatedTrainer`) frei durch das Gebiet fährt, an Kreuzungen
  abbiegt, die Steigung am Anstieg nach Schellenberg spürbar und glatt ankommt, und 60 FPS im Retro-Look hält
