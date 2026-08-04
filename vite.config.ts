import { defineConfig } from 'vite';

// WebContainer requires cross-origin isolation (COOP/COEP) + SharedArrayBuffer.
export default defineConfig({
  server: {
    port: 7892,
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
  preview: {
    headers: {
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Embedder-Policy': 'credentialless',
    },
  },
});
