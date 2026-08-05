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
    // Bind IPv4 explicitly. Vite's default of `localhost` can resolve to ::1
    // only, which leaves http://127.0.0.1:4478 refusing connections and looking
    // for all the world like a blank page.
    host: '127.0.0.1',
    // `npm run dev` starts this alongside the API server and forwards calls to it.
    proxy: {
      '/api': {
        target: `http://127.0.0.1:${process.env.ORCH_API_PORT ?? 4477}`,
        changeOrigin: true,
      },
    },
  },
});
