import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// The demo consumes the library straight from its TypeScript sources so that
// changes in packages/open-ftms-ble hot-reload without a separate build step.
const librarySource = fileURLToPath(
  new URL('../../packages/open-ftms-ble/src/index.ts', import.meta.url),
);

export default defineConfig({
  resolve: {
    alias: {
      'open-ftms-ble': librarySource,
    },
  },
  server: {
    // Web Bluetooth requires a secure context; http://localhost qualifies.
    host: 'localhost',
    port: 5173,
    strictPort: true,
  },
});
