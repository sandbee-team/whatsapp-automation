import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';

/**
 * app/frontend Vite config (P04b UB2, P05 U5 +Tailwind v4). The SPA and the
 * API MUST be same-origin in dev because the refresh cookie is
 * `SameSite=Strict` + `Secure` (see api-client.ts) - the dev server proxies
 * `/v1` to the backend so the browser only ever talks to
 * `http://localhost:5173`.
 */
export default defineConfig({
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
      // `routes/__tests__/**` holds this app's route-guard test(s), not a
      // route - excluded from route-tree scanning here rather than moving
      // the test out of `routes/` (its canonical location per the phase
      // spec) or renaming it with the framework's `-` ignore prefix.
      routeFileIgnorePattern: '\\.test\\.tsx?$',
    }),
    react(),
    tailwindcss(),
  ],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/v1': {
        target: 'http://127.0.0.1:3000',
        changeOrigin: false,
        // `GET /v1/events` (lib/sse.ts) is a long-lived SSE stream: the
        // backend flushes ITS OWN response headers immediately
        // (`platform/http/sse.ts`'s `openSseStream`) but writes no body
        // bytes until the first real event or heartbeat (up to
        // `SSE_HEARTBEAT_MS`, 15s by default). Vite's dev proxy calls
        // `res.writeHead(...)` on the downstream (browser-facing) response
        // when it receives `proxyRes` but never flushes it - Node buffers
        // that header block until the first `res.write()`, so every SSE
        // connection through this proxy silently stalls for a full
        // heartbeat interval before the browser's `fetch()` even sees a 200
        // status (proven directly: `curl --max-time 20 -w
        // '%{time_starttransfer}'` shows 0.0025s hitting :3000 directly vs
        // ~15s through this proxy; a minimal bare `http.createServer`
        // reverse proxy with no Vite involved reproduces the identical 15s
        // stall, and adding one `res.flushHeaders()` call there fixes it
        // instantly - so this is a proxy-buffering artifact, not anything
        // in `lib/sse.ts`'s connection/reconnect logic). Flushing headers
        // as soon as they arrive from the upstream keeps this dev-only hop
        // from ever hiding a live connection behind a fake "Reconnecting…"
        // window.
        configure: (proxy) => {
          proxy.on('proxyRes', (proxyRes, _req, res) => {
            const contentType = proxyRes.headers['content-type'] ?? '';
            if (!contentType.startsWith('text/event-stream')) return;
            // http-proxy copies the upstream status + headers (set-cookie
            // included) SYNCHRONOUSLY right after emitting 'proxyRes', so a
            // flush in this same tick sends a bare 200 with none of them - it
            // turned every 4xx into a 200 and dropped the refresh cookie once
            // (2026-09-08). Flush on the next macrotask, and only for SSE.
            setImmediate(() => {
              if (!res.headersSent) res.flushHeaders();
            });
          });
        },
      },
    },
  },
});
