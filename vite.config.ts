import { defineConfig } from 'vite';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Set by `npm run lan` (scripts/lan.mjs): serve over HTTPS with the locally made certificate, so a
 * phone or tablet on the same Wi-Fi may use its camera. Unset, `npm run dev` stays plain http on
 * localhost, where the camera is allowed anyway.
 */
const lanCert = process.env.SUBWAY_LAN_CERT_DIR;

export default defineConfig({
  // `VITE_BASE=/Subway-IRL/` for GitHub Pages; the game is served from `/` everywhere else.
  base: process.env.VITE_BASE ?? '/',
  server: lanCert
    ? { https: { key: readFileSync(resolve(lanCert, 'lan-key.pem')), cert: readFileSync(resolve(lanCert, 'lan-cert.pem')) } }
    : undefined,
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        debug: resolve(import.meta.dirname, 'debug.html'),
        gallery: resolve(import.meta.dirname, 'gallery.html'),
        monitor: resolve(import.meta.dirname, 'monitor.html'),
        audioLab: resolve(import.meta.dirname, 'audio-lab.html'),
      },
    },
  },
  worker: { format: 'es' },
});
