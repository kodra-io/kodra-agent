import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * The agent serves the console with this policy as a header (apps/agent/src/console/server.ts).
 * The build adds it as a meta tag too, so the browser tests run with it in force. The page
 * talks only to its own agent: connect-src 'self'.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

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

export default defineConfig({
  base: '/',
  plugins: [react(), tailwindcss(), contentSecurityPolicy()],
  server: { port: 5175 },
  preview: { port: 4175, strictPort: true },
});
