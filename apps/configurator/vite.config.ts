import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

/**
 * The page may load only its own files and may not make any network request
 * (`connect-src 'none'`). The dev server needs inline scripts for hot reload, so the
 * policy is added to production builds only. CloudFront should send the same policy
 * as a header, which also allows frame-ancestors.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "font-src 'self'",
  "img-src 'self' data:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
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

// Served from build.kodra.io/agent/ (SPEC section 14, decision 5).
export default defineConfig({
  base: '/agent/',
  plugins: [react(), tailwindcss(), contentSecurityPolicy()],
  server: { port: 5174 },
  preview: { port: 4174, strictPort: true },
});
