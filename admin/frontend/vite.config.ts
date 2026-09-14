import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';

/**
 * admin/frontend Vite config (P28 Unit U6, step 9) - mirrors
 * app/frontend/vite.config.ts. The staff panel and the admin API MUST be
 * same-origin in dev because the `wp_admin_rt` refresh cookie is
 * `SameSite=Strict` + `Secure` (see lib/api-client.ts) - the dev server
 * proxies `/admin/v1` to admin-backend so the browser only ever talks to
 * `http://localhost:5174`.
 */
export default defineConfig({
  plugins: [
    tanstackRouter({
      target: 'react',
      autoCodeSplitting: true,
      routeFileIgnorePattern: '\\.test\\.tsx?$',
    }),
    react(),
    tailwindcss(),
  ],
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      '/admin/v1': {
        target: 'http://127.0.0.1:3001',
        changeOrigin: false,
      },
    },
  },
});
