import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  base: '/hermes/',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // App base is /hermes/ → API calls go to /hermes/api (must reach Express /api on :3000)
      '/hermes/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/hermes\/api/, '/api'),
      },
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3000', ws: true },
    },
  },
});
