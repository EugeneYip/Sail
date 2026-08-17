import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: {
    port: 5178,
    host: '127.0.0.1',
  },
  build: {
    target: 'esnext',
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
  },
});
