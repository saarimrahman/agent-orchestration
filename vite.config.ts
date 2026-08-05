import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwind from '@tailwindcss/vite';

const host = process.env.ORCH_HOST ?? '127.0.0.1';
const exposed = !['127.0.0.1', 'localhost', '::1'].includes(host);

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
    host,
    // Vite rejects requests whose Host header it does not recognise. On a dev
    // box reached by its own hostname that shows up as "Blocked request", which
    // reads like the app is broken. Only relax it when deliberately exposed.
    allowedHosts: exposed ? true : undefined,
    // `npm run dev` starts this alongside the API server and forwards calls to it.
    proxy: {
      // Keep the trailing slash in the match. A broad `/api` prefix also catches
      // the frontend module `/api.ts` and replaces it with backend HTML, leaving
      // the browser with a titled but completely blank page.
      '^/api/': {
        target: `http://127.0.0.1:${process.env.ORCH_API_PORT ?? 4477}`,
        changeOrigin: true,
      },
    },
  },
});
