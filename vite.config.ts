import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

export default defineConfig({
  root: 'web',
  plugins: [react(), tailwind()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
  },
  server: {
    port: 4478,
    // `npm run dev:web` serves the UI with hot reload and forwards API calls to
    // the real server started by `orch ui --no-open`.
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4477',
        changeOrigin: true,
      },
    },
  },
});
