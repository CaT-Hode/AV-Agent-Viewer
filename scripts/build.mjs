import { build } from 'esbuild';
import { buildOfficeKitAdapter } from './build-office-kit-adapter.mjs';
await buildOfficeKitAdapter();
await build({ entryPoints: ['apps/desktop/src/main/index.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: 'dist/main/index.cjs', external: ['electron', 'tesseract.js'], sourcemap: true });
await build({ entryPoints: ['apps/desktop/src/preload/index.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/main/preload.cjs', external: ['electron'] });
await build({ entryPoints: ['apps/desktop/src/preload/browser.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/main/browser-preload.cjs', external: ['electron'] });
await build({ entryPoints: ['apps/local-service/src/mcp.ts'], bundle: true, platform: 'node', format: 'esm', outfile: 'dist/mcp/index.mjs', packages: 'external' });
