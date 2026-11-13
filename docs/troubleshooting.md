# Fehlerbehebung

Gesammelte Erfahrungen, vor allem mit dem Tacx Flux 2 unter Windows und Chrome.
Am schnellsten kommst du in der Demo weiter: **Bericht herunterladen** enthält
Ereignisse, GATT-Zeiten und die letzten Pakete.

## Der Trainer erscheint nicht im Geräte-Dialog

- **Falscher Browser:** Web Bluetooth gibt es nur in Chrome, Edge und Opera.
  Firefox und Safari (auch Chrome auf iOS) können es nicht.
- **Keine sichere Verbindung:** Die Seite muss über `https://` oder
  `http://localhost` laufen. Eine IP wie `http://192.168.…` geht nicht.
- **Trainer ist mit etwas anderem verbunden:** Der Flux hält meist nur eine
  Verbindung pro Protokoll. Zwift, die Tacx-App oder das Handy trennen.
- **Unter Windows in den Bluetooth-Einstellungen gekoppelt:** Den Trainer
  dort **nicht** koppeln. Ist er gekoppelt, unter «Bluetooth & Geräte» das
  Gerät entfernen.
- **Trainer schläft:** Einmal kurz pedalen.

## «GATT Server is disconnected. Cannot retrieve services.»

Die Verbindung ist während der Service-Suche abgebrochen. Gesehen haben wir
das, als ein **anderer Tab mit der Demo** den Trainer noch hielt.

Chrome teilt eine Bluetooth-Verbindung zwischen allen Tabs derselben Seite.
Schliesst oder trennt ein Tab, ist die Verbindung für alle weg. Die Bibliothek
versucht es inzwischen automatisch nochmals (`connectRetries`, Standard 2).
Sauberer ist es trotzdem, nur einen Tab offen zu haben.

## Verbinden dauert 5 bis 8 Sekunden

Das ist normal. Gemessen am Flux 2 unter Windows:

| Schritt | Dauer |
|---|---|
| Erste Service-Suche (Windows liest die ganze GATT-Datenbank) | 4,5–5 s |
| Jede weitere Lese- oder Abonnier-Operation | ~300 ms (Verbindungsintervall des Flux) |

Die Bibliothek erledigt vor «bereit» nur das Nötigste: Features lesen, Daten
und Control Point abonnieren. Bereiche, Geräteinfo und die Prüfung auf den
Cycling Power Service folgen danach. Beim Reconnect zum selben Gerät werden
sie nicht nochmals gelesen.

Mit «Letzten Trainer verbinden» (`connectKnown`) fällt immerhin der
Geräte-Dialog weg.

## «control: blocked»

Eine andere App hat die Kontrolle (Zwift, TrainerRoad, die Tacx-App …). Die
Daten kommen trotzdem an, nur Befehle werden abgelehnt (`ControlPointError`
mit `result: 'controlNotPermitted'`). Die Bibliothek fragt alle 10 s nach.
Sobald die andere App die Kontrolle freigibt, wird sie übernommen und das
letzte Ziel gesetzt.

## ERG reagiert nicht oder träge

- **Tempo:** Der Flux regelt ERG über einige Sekunden nach, das ist normal. Bei
  sehr tiefer Kadenz erreicht er hohe Ziele nicht.
- **Leistungsbereich:** Der Flux 2 meldet 0–800 W. Höhere Ziele begrenzt
  die Bibliothek (`clampToSupportedRange`).
- **Kontrolle:** In der Demo unter «Befehle» prüfen, ob die Antwort `success`
  ist. Der Paket-Log zeigt `80 05 01` für «Set Target Power: success».

## Werte springen oder sind doppelt

- **Doppelte Pakete:** Windows liefert manchmal dasselbe Indoor-Bike-Data-Paket
  zweimal innerhalb weniger Millisekunden. Das ist harmlos, die Werte werden
  zusammengeführt.
- **Unsinnige Werte nach dem Widerstandsfeld:** Manche Trainer senden das
  Widerstandsfeld als 1 Byte statt 2. Dann
  `new FtmsTrainer({ resistanceLevelEncoding: 'uint8' })` setzen. Den Flux 2
  betrifft das nicht, er sendet das Feld gar nicht.

## Pulsgurt zeigt «contact: notDetected»

Den Gurt anfeuchten und straffer sitzen lassen. Uhren mit «HR Broadcast»
melden den Kontakt teils gar nicht (`notSupported`), das ist in Ordnung.

## Wie melde ich ein Problem?

1. In der Demo verbinden und das Problem nachstellen.
2. **Bericht herunterladen**. Hilft eine echte Datenspur, zusätzlich
   **Aufnahme herunterladen**.
3. Beides weitergeben. Die Aufnahme lässt sich mit **Aufnahme laden…** ohne
   Trainer abspielen.
