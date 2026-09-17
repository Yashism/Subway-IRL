import { defineConfig } from 'vite';
import { resolve } from 'node:path';

export default defineConfig({
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, 'index.html'),
        debug: resolve(import.meta.dirname, 'debug.html'),
        gallery: resolve(import.meta.dirname, 'gallery.html'),
      },
    },
  },
  worker: { format: 'es' },
});
