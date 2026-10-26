import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { CONTENT_SECURITY_POLICY } from './src/csp.ts';

function contentSecurityPolicy(): Plugin {
  return {
    name: 'kodra-content-security-policy',
    apply: 'build',
    transformIndexHtml: () => [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: CONTENT_SECURITY_POLICY },
        injectTo: 'head-prepend',
      },
    ],
  };
}

// Served from build.kodra.io/agent/ (SPEC section 14, decision 5).
export default defineConfig({
  base: '/agent/',
  plugins: [react(), tailwindcss(), contentSecurityPolicy()],
  server: { port: 5174 },
  preview: { port: 4174, strictPort: true },
});
