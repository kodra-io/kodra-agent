import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Served from build.kodra.io/agent/ (SPEC section 14, decision 5).
export default defineConfig({
  base: '/agent/',
  plugins: [react(), tailwindcss()],
  server: { port: 5174 },
});
