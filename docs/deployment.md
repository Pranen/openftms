# Deployment: Test-Harness auf GitHub Pages

Die Test-Harness (`apps/demo`) ist ein statischer Vite-Build ohne Service Worker. Sie läuft auf GitHub Pages unter **https://pranen.github.io/openftms/**:

```
push auf main ──▶ GitHub Actions (test, build) ──▶ GitHub Pages ──▶ pranen.github.io/openftms/
```

| | |
|---|---|
| Adresse | https://pranen.github.io/openftms/ |
| Workflow | `.github/workflows/pages.yml` («Deploy Test-Harness») |
| Auslöser | Push auf `main`, der `apps/demo`, `packages/open-ftms-ble`, `package-lock.json` oder den Workflow ändert; oder von Hand |
| Test | `npm test -w open-ftms-ble` (ein roter Test verhindert das Deployment) |
| Build | `npm run build -w demo -- --base=/openftms/` → `apps/demo/dist` |
| Secrets | keine |

Web Bluetooth braucht HTTPS, das liefert GitHub Pages.

Der Build bekommt den Basispfad `/openftms/`, weil Pages das Projekt in diesem Unterordner ausliefert. Lokal (`npm run dev`, `npm run build -w demo`) bleibt die Basis `/`. Feste Pfade wie `/irgendwas` in der Test-Harness würden auf Pages ins Leere zeigen. Für eigene Dateien deshalb relative Pfade oder `import.meta.env.BASE_URL` verwenden.

## Einrichtung (erledigt am 23.11.2026)

Repo → Settings → Pages → Build and deployment → Source: **GitHub Actions**, keine eigene Domain.

## Hinweise

- Pages setzt die Cache-Header selbst (`max-age=600`). Für die Test-Harness ohne Service Worker reicht das.
- Suchmaschinen: Pages kann keinen `X-Robots-Tag` senden. Deshalb steht `<meta name="robots" content="noindex, nofollow">` in `apps/demo/index.html`.
- Alle Pages-Projekte unter `pranen.github.io` teilen sich eine Origin und damit den Browser-Speicher (localStorage, IndexedDB). Für die Test-Harness ist das unkritisch.
- Das Repo ist öffentlich. Der Workflow läuft nur bei `push` auf `main` und von Hand, nie bei Pull Requests aus Forks, und er braucht keine Secrets.
- Rollback: Actions → letzten guten Lauf öffnen → **Re-run all jobs**, oder den Commit mit `git revert` zurücknehmen.
