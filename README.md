# open-ftms

Zero-dependency TypeScript library for Web Bluetooth fitness devices — FTMS trainers
(primary target: Tacx Flux 2) and BLE heart-rate monitors — plus a demo/test harness.

| Path | Content |
|---|---|
| `packages/open-ftms-ble` | the library (`transport/` → `protocol/` → `devices/`) |
| `apps/demo` | Vite test harness: telemetry (left) and control (right) |

## Development

```bash
npm install
npm run dev        # demo on http://localhost:5173 (Chrome/Edge)
npm test           # library unit tests
npm run typecheck
npm run build
```

Web Bluetooth works in Chromium browsers only (Chrome, Edge) and needs a secure
context (`https://` or `localhost`). On Windows, do not pair the trainer in the
OS Bluetooth settings.
