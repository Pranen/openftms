import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

const pkg = (p: string) => fileURLToPath(new URL(`../../packages/${p}/src/index.ts`, import.meta.url));

export default defineConfig({
  // packages are consumed from their TypeScript sources (no separate build step)
  resolve: {
    alias: {
      'open-ftms-ble': pkg('open-ftms-ble'),
      'route-graph': pkg('route-graph'),
      'sim-core': pkg('sim-core'),
    },
  },
  server: {
    // No automatic reloads: a reload drops the Bluetooth connection mid-ride. RIDE_HMR=1 re-enables them.
    hmr: process.env['RIDE_HMR'] === '1',
    host: 'localhost', // Web Bluetooth needs a secure context; http://localhost qualifies
    port: 5174,
    strictPort: true,
  },
  worker: { format: 'es' },
  plugins: [
    VitePWA({
      // never update in the middle of a ride: the app asks (later), loads on demand
      registerType: 'prompt',
      injectRegister: 'auto',
      includeAssets: ['icons/*.png'],
      workbox: {
        globPatterns: ['**/*.{js,css,html,png,woff2}'],
        // world data (tiles, graph) is immutable (hash in the name): cache on first use
        runtimeCaching: [
          {
            urlPattern: ({ url }) => url.pathname.includes('/world/') && !url.pathname.endsWith('manifest.json'),
            handler: 'CacheFirst',
            options: { cacheName: 'ride-world', expiration: { maxEntries: 2000 } },
          },
          {
            urlPattern: ({ url }) => url.pathname.endsWith('/world/manifest.json'),
            handler: 'NetworkFirst',
            options: { cacheName: 'ride-manifest' },
          },
        ],
      },
      manifest: {
        id: '/',
        name: 'Ride – Rheintal',
        short_name: 'Ride',
        description: 'Indoor-Cycling im Rheintal, im Retro-Look, direkt im Browser.',
        lang: 'de',
        start_url: '/',
        scope: '/',
        display: 'fullscreen',
        display_override: ['fullscreen', 'standalone'],
        orientation: 'landscape',
        background_color: '#000000',
        theme_color: '#2b4a7a',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
});
