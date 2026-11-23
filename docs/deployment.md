# Deployment: Test-Harness auf openftms.pranen.li

Die Test-Harness (`apps/demo`) ist ein statischer Vite-Build ohne Service Worker. Sie läuft auf GitHub Pages:

```
push auf main ──▶ GitHub Actions (test, build) ──▶ GitHub Pages ──▶ openftms.pranen.li (HTTPS)
```

| | |
|---|---|
| Domain | openftms.pranen.li |
| Workflow | `.github/workflows/pages.yml` («Deploy Test-Harness») |
| Auslöser | Push auf `main`, der `apps/demo`, `packages/open-ftms-ble`, `package-lock.json` oder den Workflow ändert; oder von Hand |
| Test | `npm test -w open-ftms-ble` (ein roter Test verhindert das Deployment) |
| Build | `npm run build -w demo` → `apps/demo/dist` |
| Secrets | keine |

Web Bluetooth braucht HTTPS. Das liefert GitHub Pages, auch für die eigene Domain.

## Einrichtung (einmalig)

1. Repo → Settings → Pages → Build and deployment → Source: **GitHub Actions**.
2. Unter Custom domain `openftms.pranen.li` eintragen → Save. Nach der DNS-Prüfung **Enforce HTTPS** einschalten.
3. Cloudflare → DNS für pranen.li: `CNAME openftms → pranen.github.io`, Proxy-Status **DNS only** (graue Wolke). Mit Proxy kann GitHub das Zertifikat für die eigene Domain nicht ausstellen.
4. Actions → **Deploy Test-Harness** → **Run workflow**.
5. Prüfen:

   ```powershell
   curl.exe -I https://openftms.pranen.li
   ```

   Erwartet: `200`.

## Hinweise

- Pages setzt die Cache-Header selbst (`max-age=600`). Für die Test-Harness ohne Service Worker reicht das.
- Suchmaschinen: Pages kann keinen `X-Robots-Tag` senden. Deshalb steht `<meta name="robots" content="noindex, nofollow">` in `apps/demo/index.html`.
- Das Repo ist öffentlich. Der Workflow läuft nur bei `push` auf `main` und von Hand, nie bei Pull Requests aus Forks, und er braucht keine Secrets.
- Rollback: Actions → letzten guten Lauf öffnen → **Re-run all jobs**, oder den Commit mit `git revert` zurücknehmen.
