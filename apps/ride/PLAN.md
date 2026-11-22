# Ride (Arbeitstitel) – Indoor-Cycling-PWA im Rheintal

**Status: M0–M3 umgesetzt (22.11.2026): die ganze Region Feldkirch – Landquart – Walenstadt – Oberriet fahrbar
(6'740 km Fahrnetz), mit Gebäuden aus swissBUILDINGS3D und Fassaden-Texturen, Kulisse (Autobahn, Bahn mit Zug,
Stromleitungen, Gewässer, Brücken) und Wahrzeichen. Offen: Messung auf echter Hardware, Navigator-HUD, M4–M7.** Nach jedem abgeschlossenen Meilenstein die Status-Spalte unten aktualisieren.

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
| bedingt | `track` ausser `tracktype=grade4–5` oder weichem Belag (Gras, Erde, Rasengitter …; ohne Angabe = befahrbar, im Riet der Normalfall); `service` ohne `service=*`-Untertyp und ohne Zugangssperre (Feld- und Gewerbezufahrten, als `track`-Klasse); `path`/`footway`/`pedestrian` mit `bicycle=yes\|designated\|permissive` |
| nein | `bicycle=no\|private` (`use_sidepath` ist befahrbar, der Begleitweg entfällt), `access=no` ohne Velo-Ausnahme, `motorroad=yes`, `steps`, `service=driveway\|parking_aisle\|…`, `construction`, `proposed` |
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
            geomStart    Uint32, geomCount Uint32
            profStart    Uint32 (Anzahl = Differenz zum nächsten Start; Proben bei 0, 5, 10 … m und am Ende)
            nameId       Uint32 → Stringtabelle
            osmWayId     Float64 (Debug/Attribution, abtrennbar)
 adjacency  offsets Uint32[N+1], entries Uint32 (edgeId << 1 | Richtung)   (CSR)
 geometry   x, z Int32 cm, vereinfacht (ca. 1 Punkt / 10–15 m)
 profile    h Uint16 × heightScale (0.05 m) + heightOffset, bereits geglättet – die einzige Wahrheit für Physik und Trainer
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
 LINE     Kulisse als Polylinien: Art (Autobahn, Bahn, Strom, Fluss/Bach/Kanal), Breite, Punkte
          (Int16 dm lokal, Höhe, Flags Brücke/Tunnel je Segment); Segment gehört der Kachel seiner Mitte   L0
 BLDG     Gebäude parametrisch (Grundriss Int16 dm, Trauf-/Firsthöhe, Dachform im unteren, Stil im oberen
          Halbbyte: Wohnhaus, Mehrfamilienhaus, Bauernhof, Gewerbe, Kirche, klein, offen, Gewächshaus; Farbklasse) L0
 BLDQ     Gebäude als Quader (Mitte, Drehung, Halbmasse, Sockel, Höhe, Farbe, Stil)          L1
 LMRK     Wahrzeichen {Stil, Mitte, Drehung, Halbmasse aus dem OSM-Grundriss, Sockel}; Modelle im Code
          (render/landmarks.ts), die Gebäude darunter fallen weg                              L0
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
| Bäume | instanzierte Low-Poly-Modelle mit Vertexfarben (`render/trees.ts`) | li-auto `trees.ts` |
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
| M0 | Gerüst | `apps/ride` (Vite, PWA, Three.js WebGPU), `packages/sim-core`, `packages/route-graph`, `tools/world-pipeline`; Deploy-Workflow noch offen (braucht Eintrag in pwa-infrastructure) | erledigt bis auf Deploy |
| M1 | Vertical Slice | **2 × 2 L0-Kacheln Eschen/Schellenberg** (siehe unten): Graph-Ausschnitt, Gelände 8 m mit Einschnitt, freies Fahren, Trainer-Steigung, Retro-Pass, HUD, Demo-Modus | erledigt (mit echtem Flux 2 noch nicht gefahren) |
| M2 | Graph der Region | ganzes Fahrnetz inkl. Vorarlberg, Prüfungen (Querprofile, Steigungs-Histogramm), Navigator an Kreuzungen | erledigt (22.11.2026) bis auf Querprofile; Navigator wie in M1 (Wahl im HUD) |
| M3 | Welt-Streaming | Pyramide L0–L4, Ringwahl, Worker, Service Worker, Gebäude, Kulisse, Gewässer, Bäume | erledigt (22.11.2026) bis auf Service Worker (offline) und Wasserflächen mit Pegel (WATR) |
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

### M1: Stand und Erkenntnisse (18.11.2026)

- **Graph:** 655 Knoten, 815 Kanten, 125 km, 18 Brücken/Tunnel; steilste 20-m-Abschnitte 28 % (Fusswege am Eschnerberg).
- **Weltdaten:** 1.2 MB (Graph + 4 Kacheln mit 4'500 OSM-Gebäuden; mit Panorama 2.0 MB); zweiter Pipeline-Lauf byteidentisch.
- **Gebäude** in M1 aus OSM-Grundrissen (Höhe aus `building:levels`/Typ), Sattel-/Walmdach auf dem orientierten Rechteck;
  swissBUILDINGS3D-Höhen kommen mit M3.
- **Copernicus-Panorama vorgezogen:** Stufe L4 (4 Kacheln zu 64 km, 250 m Raster, Höhen in 0.1-m-Schritten für Gipfel
  bis 6'553 m; Tödi 3'587 m) aus GLO-30, Bodenbedeckung aus Höhe und Neigung, unter den L0-Kacheln abgesenkt.
  Renderer mit den geplanten zwei Tiefen-Durchgängen (fern 300 m – 130 km mit Himmel und Panorama, nah 0.3 m – 9 km),
  gemeinsamer Dunst 5–95 km, Erdkrümmung mit Refraktion im Vertex-Shader relativ zur Kamera. Ohne L1–L3 wirkt das
  Panorama in den ersten Kilometern um den Ausschnitt noch grob; Seen (Walensee, Bodensee) fehlen noch.
- **Bäume vorgezogen:** der Client streut sie beim Laden deterministisch aus `CODE` auf einem globalen,
  verrüttelten Raster (Wald 7 m, Obstgarten 11 m in Reihen, einzeln auf Wiesen und in Dörfern), mit Abstand zu
  Fahrbahnrand und Gebäuden; Nadelbaum-Anteil steigt mit der Höhe, Bestände über Rauschen. Low-Poly-Modelle mit
  Vertexfarben (statt Sprites mit Alpha-Test: passt zum flachen PS1-Look, keine Textur) als `InstancedMesh` in
  500-m-Blöcken, die ab 4 km ausgeschaltet werden. M1: 37'000 Bäume, ca. 0.2 s beim Laden.
- **Noch nicht in M1:** Kulissennetz (`LINE`), Gewässer (`WATR`), Hecken und Ufergehölz, Böschungsstreifen, Stufen L1–L3,
  Brückenkörper (Fahrbahn schwebt über dem Gelände).
- **Demo-Modus** (Wunsch während M1): «Autopilot» fährt mit einstellbarer Leistung ohne Trainer, «Fliegen» ist eine
  freie Kamera (WASD, Q/E, Maus); `F` schaltet beim Fahren zwischen Verfolger und Freiflug um.
- **Bildrate:** im eingebetteten Vorschau-Browser 30 FPS bei ca. 0.1 ms Renderaufruf und 0.03 ms Physikschritt
  (384k Dreiecke, 20 Draw-Calls); in Chrome direkt noch zu messen.
- **Kreuzungen:** Bänder überlappen sichtbar wie erwartet; Kreuzungsflächen bleiben offen.
- **Strassenbild nachgebessert** (Rückmeldung «Strassen krumm», Essanestrasse Eschen): die Geometrie war treu, krumm
  wirkten (1) Gelände, das an den Rändern durch das Band stach – der Einschnitt deckt jetzt eine ganze Zelle ab
  (Kern 8 m, Übergang bis 22 m, Gelände 0.3 m unter der Fahrbahn) –, (2) das Vertex-Snapping, das lange dünne Bänder
  zum Zickzack verbiegt – Strassen und Markierungen sind davon ausgenommen – und (3) Knicke an Polylinien-Ecken –
  die Bandnormale kommt jetzt aus einer zentralen Differenz. Dazu Markierung nach Schweizer Muster, vereinfacht:
  Leitlinie (3 m Strich, 6 m Lücke) ab `unclassified` auf Zweirichtungsstrassen, Randlinien ab `tertiary`, gelbe
  gestrichelte Velostreifen, Abstand 8 m vor Knoten. Graphfilter um Feldwege ohne `tracktype` und einfache
  `service`-Strassen erweitert (Riet): M1-Graph 1'526 Kanten, 161.5 km (vorher 815, 125 km).
- **Knoten und Kreisel** (Rückmeldung Essanestrasse, Eintracht-Kreisel): Die Knoten-Zusammenfassung schob bisher nur
  den letzten Stützpunkt einer Kante auf den Knotenschwerpunkt – bis 11 m bei Kreiseln, dadurch S-Kurven und Knicke.
  Jetzt wird die Verschiebung über die letzten 35 m weich verteilt (dort auf 2 m verdichtet). Einbahn-Fahrbahnen
  (getrennte Zufahrten an Inseln, Rampen, Kreisel; neues Bit `ATTR_ONEWAY` = 1<<10) werden mit 60 % Breite gezeichnet
  und eingeschnitten, kurze Stücke unter 80 m bleiben unmarkiert. Kreisel bleiben im Graphen ein Entscheidungspunkt;
  `graph.json` führt ihren Radius (`roundabouts`), der Client zeichnet Fahrbahnring, Grasinsel und Randlinie darüber.
  Der Knoten selbst liegt jetzt auf der wichtigsten Strasse des Clusters (Kreisel: Mitte des Rings) statt im
  Schwerpunkt aller Clusterpunkte: Kurze Verbindungen zu parallelen Velowegen und Zufahrten zogen die Hauptstrasse
  sonst bei jeder Querung bis 7 m zur Seite (Essanestrasse Eschen–Nendeln). Geprüft gegen OSM: Die Essanestrasse
  weicht nur noch an den Kreiselzufahrten (unter der Insel) mehr als 1.5 m ab.
- **Ein Netz, die grössere Strasse gewinnt** (Entscheid 18.11.2026): Velowege und Wege mit Velofreigabe, die auf
  mindestens 30 m höchstens 12 m neben einer Strasse (ab `residential`) und in gleicher Richtung (±25°) verlaufen,
  fallen dort aus Graph und Darstellung weg (als Begleitweg/Trottoir getaggte bis 20 m). Biegt der Weg ab, bleibt
  der Rest und wird an den nächsten Strassenknoten (≤ 25 m) angeschlossen. Strassen mit `bicycle=use_sidepath` sind
  dafür befahrbar. Die zwei Einbahn-Hälften an Inseln (≤ 250 m, Enden ≤ 30 m auseinander, gleicher Name und Klasse)
  werden zu einer Zweirichtungsstrasse auf der Mittellinie zusammengelegt. M1: 1'499 Kanten, 153 km (8 km
  Begleitwege weniger); Kreisel haben jetzt saubere vier Arme.

### M3 vorgezogen: Streaming-Test mit erweitertem Ausschnitt (19.11.2026)

Ziel: das ganze L0–L4-Streaming testen, ohne schon die ganze Region (M2) zu bauen. Karte: `docs/ausbau-m3.svg`.

| Stufe | Gebiet (LV95) | Kacheln | Quelle |
|---|---|---|---|
| L0 (2 km, 8 m) | E 2'756'000–2'762'000, N 1'226'000–1'234'000 (6 × 8 km) | 12 | swissALTI3D, Österreich-Rand (1.2 %) aus Copernicus; Graph, Gebäude, Bäume |
| L1 (4 km, 16 m) | E 2'752'000–2'768'000, N 1'220'000–1'236'000 | 16 | Copernicus, Bodenbedeckung aus OSM (LI/CH), weit weg von OSM-Flächen geschätzt |
| L2 (8 km, 32 m) | E 2'744'000–2'776'000, N 1'216'000–1'248'000 | 16 | Copernicus, Bodenbedeckung aus Höhe/Neigung |
| L3 (16 km, 64 m) | E 2'720'000–2'784'000, N 1'200'000–1'264'000 | 16 | dto. |
| L4 (64 km, 250 m) | wie bisher | 4 | dto. |

- **Ausschnitt:** Eschen, Mauren, Schellenberg, Nendeln, Schaanwald, Paulahütte (1'008 m), Planken, Gafadura
  (1'420 m), Fuss der Drei Schwestern. Anstiege Schaan → Planken → Gafadura (Planknerstrasse ca. 10 %,
  Gafadurastrasse bis 16 %) und Nendeln → Paulahütte. Graph 2'173 Knoten, 2'566 Kanten, 323 km.
- **Weltdaten:** 14 MB (L0 2.7, L1–L3 je 3.1, L4 0.8, Graph 0.4); Pipeline-Lauf 35 s (erster Lauf mit
  Schweiz-Zuschnitt für L1 ca. 8 min), byteidentisch wiederholbar. OSM-Zuschnitte tragen den Ausschnitt im
  Dateinamen (alter Zuschnitt wurde sonst wiederverwendet).
- **Pipeline:** `panorama.py` baut alle groben Stufen (`build_level`); L1–L3 Mittel über die Zelle, L4 wie bisher
  Max/Mittel. Copernicus ist ein Oberflächenmodell: Wald in L1–L3 um 12 m abgesenkt, sonst stünden Wälder als
  Plateaus neben den L0-Kacheln. Höhen der groben Stufen in 0.1-m-Schritten. Die Absenkung des Panoramas unter
  dem Detailausschnitt entfällt (der Client blendet aus).
- **Steile Wege:** Mit Planken/Gafadura kamen Bergwege dazu (bis 104 % über 20 m). Wege mit `sac_scale` über
  `hiking` oder `mtb:scale` ≥ 2 fallen weg, Wege/Feldwege über 40 % ebenfalls; Profile werden nachgeglättet, bis
  Strassen ≤ 18 %, Wege ≤ 28 % (über 20 m) haben, und vorher mit einem Median von DEM-Stufen (Durchlässe) befreit.
  Steilstes Stück jetzt 28.7 %.
- **Client-Streaming** (`world/world.ts`, `world/select.ts`): pro Stufe die 3 × 3 Kacheln um die Kamera
  (Chebyshev-Abstand der Kachelmitte < 1.5 Kachelgrössen), behalten bis 1.9 (Hysterese), L4 immer; nächste
  zuerst, bei Gleichstand die gröbere; 3 gleichzeitig, ein Worker. Ankommende Kacheln kommen höchstens 6 ms pro
  Frame in die Szene.
- **Ausblenden statt Absenken:** Grobe Kacheln sind in Viertel geteilt (L4: 4 × 4), passend zur nächstfeineren
  Stufe; ein Viertel ist unsichtbar, sobald die feinere Kachel in der Szene ist. Schürzen an allen Viertelrändern
  (L0 12 m … L4 300 m) verdecken die Fugen. L0/L1 im Nah-Durchgang (Fernebene jetzt 16 km), L2–L4 im Fern-Durchgang.
- **Pro Kachel:** Strassen (nach L0-Kachel gebündelt), Gebäude und Bäume kommen und gehen mit ihrer Kachel. Bäume
  pflanzt jetzt der Worker (er bekommt den Graphen einmal), sonst stockte das Bild bis 1 s.
- **Speicher:** L2/L3 mit jedem zweiten Knoten (jenseits 4–8 km reicht das), Geländefarben als RGBA-Bytes.
- **Debug:** Taste `K` zeigt eine Karte der Kacheln pro Stufe (gefüllt = geladen, gestrichelt = lädt) und die
  geladenen MB.
- **Geprüft:** Start in 1.6–2.8 s (37 Kacheln), Freiflug Schellenberg ↔ Gafadura hin und zurück ohne Fehler und
  ohne Ruckler über 80 ms ausser einmal ca. 1 s beim ersten Mal (vermutlich Shader-Kompilierung); Autopilot auf
  Plankner- und Gafadurastrasse. Tests für die Kachelwahl (`apps/ride/test/select.test.ts`).
- **Offen:** swissALTI3D statt Copernicus für L1 (Downloads ca. 1 GB), Österreich (BEV, OSM), Gebäude als Quader
  in L1, Streaming des Graphen (heute eine Datei für den Ausschnitt), Messung auf schwächerer Hardware.

### M2 + M3: Entscheide (21.11.2026)

Umsetzung auf Branch `ride-m2-m3` in Etappen (je Commit, Browser-Prüfung), Weltdaten am Schluss in eigenem Commit;
pushen, kein PR/Merge ohne Rückfrage.

| Thema | Entscheid |
|---|---|
| Gebiet | ganze Region (Feldkirch – Landquart – Walenstadt – Oberriet), L0 aus swissALTI3D bzw. BEV in Österreich; L1/L2 im Gebiet aus denselben Daten, L3/L4 ausserhalb Copernicus |
| Österreich | BEV-Laserscan (Code aus ski), OSM-Auszug Österreich; Gebäude dort aus OSM |
| Gebäude CH | swissBUILDINGS3D **3.0** (GDB) – Höhen, Dachform |
| Gebäude FL | swissBUILDINGS3D **2.0** (DXF, wie li-auto) – 3.0 enthält Liechtenstein nicht; Zuordnung nach Landesgrenze |
| Gebäude L1 | Quader |
| Fassaden | einfache Pixel-Texturen (aus `li-auto/src/render/textures.ts`) je Typ, Dächer mit Ziegel/Blech; ein Atlas, Nearest; affin mit Unterteilung grosser Wände, abschaltbar |
| Kulisse | Autobahn/Trunk als Bänder mit Leitplanken (nicht befahrbar); Brückenkörper mit Pfeilern und Geländer |
| Gewässer | Rhein als breites Band mit Pegel, Seen (Walensee), Kanäle/Bäche als Bänder |
| Eisenbahn | statisch: Schotterbett, Schienen, Fahrleitungsmasten, Bahnübergänge, Bahnhöfe; fahrender Zug nur, wenn Zeit bleibt |
| Stromleitungen | Hochspannungsmasten und Seile aus OSM |
| Wahrzeichen | aus li-auto: Gutenberg, Kathedrale, Regierung, Kunstmuseum, Hilti Art, Rotes Haus, St. Laurentius, Kirche Triesenberg; jede OSM-Kirche als generische Kirche; neu: Schloss Vaduz, Schattenburg + Dom Feldkirch, Schloss Werdenberg, Schloss Sargans, Ruinen Schellenberg, Kirchhügel Bendern, Alte Rheinbrücke Vaduz–Sevelen |
| Client | Strassen, Markierungen und Kreuzungsflächen baut der Worker pro L0-Kachel (nicht mehr alle beim Start) |
| Pipeline | wiederaufnehmbar und parallel pro Kachel; Prüfungen (Querprofile, Steigungs-Histogramm) |

### M2 + M3: Stand (22.11.2026)

- **Region:** L0 E 2'740'000–2'774'000, N 1'202'000–1'248'000 (17 × 23 = 391 Kacheln), L1 108, L2 56, L3 42, L4 4.
  Weltdaten **137 MB** unkomprimiert (L0 87, L1 23, L2 11, L3 8, Graph 8 MB). Pipeline-Lauf **61 min** (davon L0
  21 min, OSM lesen 1.5 min, Graph 6 min, Gebäude aus dem Cache); erster Lauf mit Downloads (swissALTI3D 1.5 GB,
  swissBUILDINGS3D 1.5 GB, BEV-Fenster, OSM Österreich 780 MB) deutlich länger.
- **Graph:** 37'345 Knoten, 44'261 Kanten, 6'740 km, 1'893 Brücken/Tunnel. Steigungs-Histogramm (20 m) Strassen:
  0–4 % 1'825 km, 4–8 % 362, 8–12 % 409, 12–16 % 146, 16–20 % 21, 20–25 % 1; über 25 % nur 6 kurze Stellen
  (Liste im Build-Log). Wege: 21 km über 25 %, steilste Stelle 44.9 % (Bergweg; Grenze 40 % gilt für die geglättete
  Kante, kurze Spitzen bleiben). Querprofile noch nicht gezeichnet.
- **Höhenmodell blockweise:** die Region mit 2 m wären ca. 6 GB; `dem.py` lädt 2-km-Blöcke mit 64 m Rand bei Bedarf
  (LRU), Punkte werden blockweise sortiert abgefragt. Österreich aus BEV (1 m auf 2 m gemittelt, 11 s pro Block über
  HTTP), Rest Copernicus. L1/L2 innerhalb der Region aus diesem Modell (ohne Kronen-Abzug), ausserhalb Copernicus.
- **OSM-Zuschnitt** in zwei Durchläufen ohne Positionsindex (Österreich brauchte sonst über 7 GB), 12 min für
  Österreich. Zwei Graph-Schritte waren quadratisch (Knoten-Verschmelzen, Einbahn-Paare) – für die Region Stunden,
  jetzt linear bzw. mit KD-Baum; M1 gibt byteidentisch denselben Graphen wie vorher.
- **Gebäude:** swissBUILDINGS3D 3.0 für die Schweiz (GDB mit Multipatch/TIN; pyogrio kennt den Typ nicht, deshalb
  `gdal_raw.py` über ctypes mit dem GDAL aus pyogrio), 2.0 für Liechtenstein (3.0 enthält es nur teilweise: um Eschen
  672 statt 1'070 Gebäude), Grenze aus OSM; OSM-Grundrisse in Österreich und wo swissBUILDINGS3D fehlt. 65'070 + 22'010
  Gebäude aus swissBUILDINGS3D. Stil (Wohnhaus, Mehrfamilienhaus, Bauernhof, Gewerbe, Kirche, klein, offen,
  Gewächshaus) aus OSM-Typ, Fläche und Höhe. L1 zeigt Gebäude ab 50 m² als Quader (BLDQ) im Gelände-Viertel.
- **Fassaden:** Pixel-Atlas 128 × 32 (16 px je Kachel, im Code gezeichnet wie in li-auto) mit Fensterachsen pro
  Stil, Ziegel-, Blech-, Schiefer- und Kiesdach. Ganze Fensterachsen pro Wand und ganze Geschosse bis zur Traufe.
  Affin wie die PS1 (uv·w und w perspektivisch interpoliert, dann geteilt), schaltet mit dem Vertex-Wackeln (`W`) um.
  **Wieder abgeschaltet (22.11.2026, Rückmeldung «alle gleich, sehr unruhig»):** `BUILDING.textures = false`,
  Häuser in Wand- und Dachfarben; Code und UVs bleiben für einen zweiten Anlauf.
- **Kulisse (LINE):** 235 km Autobahn (Band, Randlinien, Leitplanken), 263 km Bahn (Schotter, Schienen,
  Fahrleitungsmasten alle 55 m), 547 km Stromleitungen (Gittermasten bzw. Holzmasten, durchhängende Seile), 2'771 km
  Gewässerlinien (Bäche und Kanäle als Band; Flüsse sind Flächen im CODE). Autobahn und Bahn werden ins Gelände
  geschnitten, Brücken und Tunnel geradlinig zwischen den Enden. Bäume halten Abstand.
- **Brücken:** Unterseite, Brüstung und Pfeiler (alle 32 m, wo die Fahrbahn über 2.5 m über Grund liegt) für das
  Fahrnetz, Autobahn und Bahn.
- **Wahrzeichen (LMRK):** nach OSM-Namen gefunden, Modelle im Code: Schloss Vaduz, Kathedrale St. Florin, Rotes Haus,
  Burg Gutenberg, St. Laurentius Schaan, Kirche Triesenberg (Zwiebelhaube), Kunstmuseum (schwarzer Kubus), Hilti Art
  Foundation, Schattenburg, Dom Feldkirch, Schloss Werdenberg, Schloss Sargans, Ruinen Alt- und Neu-Schellenberg,
  Kirchhügel Bendern, Alte Rheinbrücke (gedeckte Holzbrücke). Jede Kirche aus swissBUILDINGS3D/OSM über 140 m²
  bekommt einen Turm mit Spitzhelm (jede fünfte eine Zwiebelhaube). Das Regierungsgebäude bleibt ein normales Gebäude.
- **Zug:** alle 45 s ein Zug mit vier roten Wagen auf der Bahnlinie nahe der Kamera (Gleisstücke der geladenen
  Kacheln an gemeinsamen Endpunkten verkettet), 100 km/h, verschwindet am Ende der Kette.
- **Client:** Strassen, Markierungen, Kreuzungsflächen, Kreisel und Brücken baut der Worker pro L0-Kachel (vorher
  alle beim Start; mit 44'000 Kanten nicht mehr machbar). Start bis Menü **7.2 s** (Graph 8 MB), Autopilot fährt.
- **Messung (eingebettete Vorschau):** um Buchs 2.06 Mio. Dreiecke, 191 Draw-Calls, 0.1–0.5 ms Renderaufruf,
  163 MB Geometrie auf der GPU. Das Dreiecksbudget (1 Mio.) ist überschritten, vor allem durch 9 L0-Geländekacheln
  zu 131'000 Dreiecken; auf echter Hardware messen, sonst äussere L0-Kacheln mit 16 m vermaschen.
- **Offen:** Querprofile, Wasserflächen mit Pegel (WATR), Bahnübergänge und Bahnhöfe (OSM-Punkte sind schon
  eingelesen), Service Worker / Offline-Region, Streaming des Graphen, Determinismus-Lauf (zweiter Lauf
  byteidentisch) für die Region, mehr als 32 Velorouten (Bitmaske).
