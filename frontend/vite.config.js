import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// HTTPS is required for getUserMedia on phones. The browser talks to this origin only:
// /live (WebSocket) and /api (HTTP) are proxied to the backend, so the page uses relative URLs
// and works the same on the laptop, on a phone on the LAN, and through a tunnel.
// BACKEND_URL points the proxy at another backend (e.g. the mock on another port).
const BACKEND = process.env.BACKEND_URL || 'http://localhost:3001';

export default defineConfig({
  plugins: [react(), ...(process.env.NO_SSL ? [] : [basicSsl()])],
  server: {
    host: true,
    port: 5173,
    // Cloudflare quick tunnels (*.trycloudflare.com) may reach the dev server; other hosts stay blocked.
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      '/live': { target: BACKEND.replace(/^http/, 'ws'), ws: true },
      '/api': { target: BACKEND, changeOrigin: true },
    },
  },
});
