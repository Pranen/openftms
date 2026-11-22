# Deployment: Ride und Test-Harness

Beide Apps sind statische Vite-Builds und laufen wie die übrigen pranen.li-Apps über den zentralen Caddy aus [`Pranen/pwa-infrastructure`](https://github.com/Pranen/pwa-infrastructure):

```
push auf main ──▶ GitHub Actions (test, build) ──rsync/SSH──▶ /var/www/pwa/<ordner> ◀── Caddy ◀── Coolify-Proxy (HTTPS) ◀── Cloudflare
```

| | Ride | Test-Harness |
|---|---|---|
| Domain | ride.pranen.li | openftms.pranen.li |
| Quelle | `apps/ride` | `apps/demo` |
| Ordner auf dem Server | `ride` | `openftms` |
| Build | `npm run build -w ride` | `npm run build -w demo` |
| Ausgabe | `apps/ride/dist` (~140 MB, davon ~137 MB Weltdaten) | `apps/demo/dist` (~0.1 MB) |
| Secret im Repo | `DEPLOY_SSH_KEY_RIDE` | `DEPLOY_SSH_KEY_OPENFTMS` |
| Workflow | `.github/workflows/deploy-ride.yml` | `.github/workflows/deploy-openftms.yml` |
| Service Worker | ja (`sw.js`, `registerSW.js`, `workbox-*.js`) | nein |
| Client-Routing | nein (kein `spa`) | nein (kein `spa`) |

Zwei Apps aus einem Repo funktionieren wie bei Clickwork (Akte B, Zwölf Uhr nachts): je ein Workflow und je ein eigenes Secret, weil der SSH-Schlüssel bestimmt, in welchen Server-Ordner geschrieben wird.

Web Bluetooth braucht HTTPS. Das liefern Cloudflare und der Coolify-Proxy, Caddy selbst spricht nur HTTP.

## 0. Voraussetzung: Tests grün

Der Workflow führt `npm test` aus, und ein roter Test verhindert das Deployment. Vor dem ersten Deployment lokal prüfen:

```powershell
npm test
```

## 1. Workflows im App-Repo (`Pranen/openftms`)

Beide Dateien zuerst nur mit `workflow_dispatch`. Die `push`-Zeilen aktivierst du nach dem ersten erfolgreichen Deployment (Schritt 6).

`.github/workflows/deploy-ride.yml`:

```yaml
name: Deploy Ride

# Gemeinsamer Workflow aus Pranen/pwa-infrastructure: testen, bauen, per rsync nach
# /var/www/pwa/ride, ausgeliefert vom zentralen Caddy unter ride.pranen.li.
# Deployt wird, wenn sich Ride, die Pakete oder die Abhängigkeiten ändern (oder von Hand).
on:
  # push:
  #   branches: [main]
  #   paths:
  #     - 'apps/ride/**'
  #     - '!apps/ride/**/*.md'
  #     - 'apps/ride/public/world/*.md'
  #     - 'packages/**'
  #     - '!packages/**/*.md'
  #     - 'package-lock.json'
  workflow_dispatch:

jobs:
  deploy:
    uses: Pranen/pwa-infrastructure/.github/workflows/deploy-static.yml@main
    with:
      app: ride
      # Bibliothek, Pakete und Ride: ein roter Test verhindert das Deployment
      test: npm test
      build: npm run build -w ride
      output: apps/ride/dist
    secrets:
      # Eigener Schlüssel, der nur nach /var/www/pwa/ride schreiben darf
      DEPLOY_SSH_KEY: ${{ secrets.DEPLOY_SSH_KEY_RIDE }}
```

`.github/workflows/deploy-openftms.yml`:

```yaml
name: Deploy Test-Harness

# Gemeinsamer Workflow aus Pranen/pwa-infrastructure: testen, bauen, per rsync nach
# /var/www/pwa/openftms, ausgeliefert vom zentralen Caddy unter openftms.pranen.li.
on:
  # push:
  #   branches: [main]
  #   paths:
  #     - 'apps/demo/**'
  #     - 'packages/open-ftms-ble/**'
  #     - '!**/*.md'
  #     - 'package-lock.json'
  workflow_dispatch:

jobs:
  deploy:
    uses: Pranen/pwa-infrastructure/.github/workflows/deploy-static.yml@main
    with:
      app: openftms
      test: npm test -w open-ftms-ble
      build: npm run build -w demo
      output: apps/demo/dist
    secrets:
      # Eigener Schlüssel, der nur nach /var/www/pwa/openftms schreiben darf
      DEPLOY_SSH_KEY: ${{ secrets.DEPLOY_SSH_KEY_OPENFTMS }}
```

`npm ci` und Node 24 setzt der gemeinsame Workflow selbst. Build-Variablen braucht keine der beiden Apps.

## 2. Site-Blöcke im Caddyfile (`Pranen/pwa-infrastructure`)

Unten in `caddy/Caddyfile` vor der Homepage einfügen:

```caddyfile
# Ride – Indoor-Cycling im Rheintal (Pranen/openftms, apps/ride)
# Kein spa: kein Client-Routing. Die Weltdaten unter /world tragen einen Hash im Namen
# (ausser manifest.json, die beim Standard no-cache bleibt) und ändern sich deshalb nie.
http://ride.pranen.li {
	import site ride
	import cache-vite
	import noindex
	@world path_regexp ^/world/.+\.[0-9a-f]{8}\.(bin|json)$
	header @world Cache-Control "public, max-age=31536000, immutable"
	# Weltdaten sind application/octet-stream, das Standard-encode lässt sie aus; gzip spart rund 60 %
	@worldbin path_regexp ^/world/.+\.bin$
	encode @worldbin zstd gzip {
		match {
			header Content-Type application/octet-stream*
		}
	}
	# PWA: Service Worker gar nicht speichern, sonst hält Cloudflare ihn bis zu 4 h (wie bei ski)
	@sw path /sw.js /registerSW.js
	header @sw Cache-Control "no-cache, no-store, must-revalidate"
}

# open-ftms Test-Harness (Pranen/openftms, apps/demo)
# Kein spa, kein Service Worker
http://openftms.pranen.li {
	import site openftms
	import cache-vite
	import noindex
}
```

`noindex` ist wie bei ski, ralli und zug gesetzt. Soll Ride in Suchmaschinen erscheinen, lass die Zeile dort weg.

`csp-strict` ist bewusst nicht gesetzt. Ride nutzt Web Worker und WebGL (three.js), deshalb zuerst ohne CSP live gehen und eine strenge Policy später separat testen.

Das eigene `encode` für `/world/*.bin` ist nötig, weil Caddy `application/octet-stream` sonst unkomprimiert ausliefert. Mit gzip schrumpft eine Kachel von 215 auf 88 KB und der Strassengraph von 8.3 auf etwa 5 MB. Der Browser entpackt die Daten bei `fetch` selbst.

In `apps.md` je eine Zeile ergänzen:

```markdown
| Ride | Pranen/openftms (Monorepo, apps/ride) | Vite (PWA) | ride | ride.pranen.li | cache-vite, noindex, kein spa, sw.js no-store, /world immutable, gzip für /world/*.bin | neu <Datum> (Secret DEPLOY_SSH_KEY_RIDE) |
| open-ftms Test-Harness | Pranen/openftms (Monorepo, apps/demo) | Vite | openftms | openftms.pranen.li | cache-vite, noindex, kein spa | neu <Datum> (Secret DEPLOY_SSH_KEY_OPENFTMS) |
```

Formatieren und prüfen (Docker Desktop muss laufen):

```powershell
docker run --rm -v "C:/data/pwa-infrastructure/caddy:/etc/caddy" caddy:2.10-alpine caddy fmt --overwrite /etc/caddy/Caddyfile
```

```powershell
docker run --rm -v "C:/data/pwa-infrastructure/caddy:/etc/caddy:ro" caddy:2.10-alpine caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
```

Lokal mit dem Ride-Build testen (vorher `npm run build -w ride`):

```powershell
docker run --rm -d --name ride-test -p 8099:80 -v "C:/data/pwa-infrastructure/caddy:/etc/caddy:ro" -v "C:/data/open-ftms/apps/ride/dist:/srv/pwa/ride:ro" caddy:2.10-alpine
```

```powershell
curl.exe -sI -H "Host: ride.pranen.li" http://localhost:8099/sw.js
```

```powershell
curl.exe -sI -H "Host: ride.pranen.li" http://localhost:8099/world/manifest.json
```

```powershell
curl.exe -s -o NUL -D - -H "Host: ride.pranen.li" -H "Accept-Encoding: gzip" http://localhost:8099/world/L0/1370_601.94278f28.bin
```

```powershell
docker rm -f ride-test
```

Erwartet (so am 22.11.2026 lokal geprüft):

| Pfad | Cache-Control | Weiteres |
|---|---|---|
| `/`, `/manifest.webmanifest`, `/world/manifest.json` | `no-cache` | |
| `/assets/*.js` | `public, max-age=31536000, immutable` | |
| `/world/L0/….bin`, `/world/graph.….json` | `public, max-age=31536000, immutable` | `.bin` mit `Content-Encoding: gzip`, wenn der Client es anbietet |
| `/sw.js`, `/registerSW.js` | `no-cache, no-store, must-revalidate` | |
| fehlende Datei | `no-store` | `404` |

Alle Antworten tragen `X-Robots-Tag: noindex, nofollow`.

Caddyfile und apps.md committen und pushen. Das geht sofort live, schadet aber nicht, solange noch keine Domain auf die Sites zeigt.

## 3. Schlüssel und Secrets

Auf dem Server als root, je App einmal:

```bash
bash /root/add-deploy-key.sh ride
```

```bash
bash /root/add-deploy-key.sh openftms
```

Den jeweils ausgegebenen privaten Schlüssel (mit BEGIN- und END-Zeile) in `Pranen/openftms` unter Settings → Secrets and variables → Actions → **Secrets** → New repository secret anlegen: `DEPLOY_SSH_KEY_RIDE` und `DEPLOY_SSH_KEY_OPENFTMS`. Nicht unter «Variables» und nicht als Environment-Secret ablegen. Den Schlüssel nirgends sonst speichern, auch nicht im Repo.

## 4. Erstes Deployment

`Pranen/openftms` → Actions → **Deploy Ride** → **Run workflow** (Branch `main`), danach dasselbe mit **Deploy Test-Harness**. Das erste Ride-Deployment lädt die ganzen Weltdaten hoch (~140 MB), spätere nur geänderte Dateien.

Prüfen auf dem Server:

```bash
docker exec $(docker ps -qf name=caddy) wget -qSO /dev/null --header "Host: ride.pranen.li" http://localhost/
```

```bash
docker exec $(docker ps -qf name=caddy) wget -qSO /dev/null --header "Host: openftms.pranen.li" http://localhost/
```

Erwartet: `HTTP/1.1 200 OK`.

## 5. Domains aufschalten

1. Coolify → `pwa-caddy` → Dienst **caddy** → Domains: `https://ride.pranen.li,https://openftms.pranen.li` an die bestehende Liste anhängen → **Save** → oben **Restart**. Alle statischen Apps sind dabei ein paar Sekunden weg. Die Warnung «Some services do not support multiple domains» ist erwartet.
2. Falls `*.pranen.li` in Cloudflare nicht schon per Wildcard auf den Server zeigt: je einen DNS-Eintrag `ride` und `openftms` wie bei den anderen Apps anlegen.
3. Prüfen vom Windows-Rechner:

```powershell
curl.exe -I https://ride.pranen.li
```

```powershell
curl.exe -I https://openftms.pranen.li
```

Erwartet: `200`. Danach Ride im Chrome öffnen, Trainer verbinden und einmal fahren. Die App lässt sich anschliessend als PWA installieren.

## 6. Automatisch deployen

In beiden Workflows die `push`-Zeilen aktivieren, committen und pushen. Ab dann deployt jeder Push auf `main`, der die jeweilige App betrifft. In `apps.md` den Status nachführen.

## Öffentliches Repo

- Deployt wird nur bei `push` auf `main` oder von Hand, nie bei Pull Requests. Workflows aus Forks bekommen keine Secrets. `pull_request_target` und Self-hosted Runner nicht verwenden.
- Ein Deploy-Schlüssel kann nur seinen eigenen Ordner beschreiben (rrsync). Ein gestohlener Schlüssel könnte also höchstens diese eine Site überschreiben.
- Optional unter Settings → Actions → General: «Require approval for all outside collaborators» für Workflows aus Fork-PRs.

## Betrieb

Rollback, Logs, Schlüsselwechsel und Fehlersuche: [`docs/betrieb.md`](https://github.com/Pranen/pwa-infrastructure/blob/main/docs/betrieb.md) in `pwa-infrastructure`. Kurzfassung für einen Rollback: Actions → letzten guten «Deploy Ride»-Lauf öffnen → **Re-run all jobs**.

Ein neuer Ride-Build entfernt alte Weltkacheln vom Server (`--delete-delay`). Das ist unproblematisch: Ride lädt `world/manifest.json` immer zuerst vom Netz (NetworkFirst) und fragt dann nur die Kacheln der aktuellen Fassung an.
