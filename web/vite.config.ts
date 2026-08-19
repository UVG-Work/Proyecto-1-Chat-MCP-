import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The UI talks to the Express bridge (src/api/server.ts). Proxying /api in dev
// keeps the browser on a single origin, so no CORS handling is needed here.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: true,
      },
    },
  },
});
