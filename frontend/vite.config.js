import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS is required for getUserMedia on iPhone. The browser talks to this origin only;
// /live is proxied to the backend so the page can use wss:// on the same host.
export default defineConfig({
  plugins: [react(), ...(process.env.NO_SSL ? [] : [basicSsl()])],
  server: {
    host: true,
    port: 5173,
    proxy: { '/live': { target: 'ws://localhost:3001', ws: true } },
  },
});
