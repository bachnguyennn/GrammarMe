import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // harper.js resolves its 20 MB WASM via `new URL(..., import.meta.url)`; pre-bundling would break that.
  optimizeDeps: { exclude: ['harper.js'] },
  build: { target: 'es2022', chunkSizeWarningLimit: 2000 },
  worker: { format: 'es' },
});
