import { build } from 'esbuild';
import { buildOfficeKitAdapter } from './build-office-kit-adapter.mjs';
await buildOfficeKitAdapter();
await build({ entryPoints: ['apps/desktop/src/main/index.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: 'dist/main/index.cjs', external: ['electron', 'tesseract.js'], sourcemap: true });
await build({ entryPoints: ['packages/format-adapters/src/office-model-worker.ts'], bundle: true, platform: 'node', format: 'cjs', target: 'node22', outfile: 'dist/main/office-model-worker.cjs' });
await build({ entryPoints: ['apps/desktop/src/preload/index.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/main/preload.cjs', external: ['electron'] });
await build({ entryPoints: ['apps/desktop/src/preload/browser.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/main/browser-preload.cjs', external: ['electron'] });
await build({ entryPoints: ['apps/desktop/src/preload/markdown-export.ts'], bundle: true, platform: 'node', format: 'cjs', outfile: 'dist/main/markdown-export-preload.cjs', external: ['electron'] });
// Keep the complete MCP SDK and validators, but let esbuild remove unused
// dependency exports instead of initializing a large external module graph.
// Some bundled CommonJS dependencies still require Node builtins at runtime.
await build({ entryPoints: ['apps/local-service/src/mcp.ts'], bundle: true, platform: 'node', format: 'esm', target: 'node22', outfile: 'dist/mcp/index.mjs', minifySyntax: true, legalComments: 'linked', banner: { js: "import { createRequire as __agentViewerCreateRequire } from 'node:module'; const require = __agentViewerCreateRequire(import.meta.url);" } });
