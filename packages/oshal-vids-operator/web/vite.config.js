import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Built assets are served by the Node backend (src/server.js) from web/dist, so
// use relative base. In dev, proxy the API + WebSocket to the running backend.
const BACKEND = process.env.VIDS_BACKEND || 'http://localhost:8074';

export default defineConfig({
  base: './',
  plugins: [react()],
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: BACKEND, changeOrigin: true },
      '/ws': { target: BACKEND, ws: true },
    },
  },
});
