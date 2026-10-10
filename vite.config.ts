import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  root: 'apps/desktop/src/renderer',
  plugins: [react()],
  server: { host: '127.0.0.1', port: 5173, strictPort: true, proxy: { '/api': 'http://127.0.0.1:3210', '/v1': 'http://127.0.0.1:3210', '/fixtures': 'http://127.0.0.1:3210' } },
  build: { outDir: '../../../../dist/renderer', emptyOutDir: true },
});
