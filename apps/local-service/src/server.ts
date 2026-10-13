import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import { ViewerCore } from '../../../packages/document-core/src/index';
import { PROTOCOL_VERSION, ViewerError } from '../../../packages/contracts/src/index';
import { dispatch } from '../../../packages/sdk/src/dispatch';
import { ensureSamples } from '../../../packages/document-core/src/fixtures';
import { libreOfficePath } from '../../office-gateway/src/conversion';
import { ZodError } from 'zod';

export function dataDir() { return process.env.AGENTVIEWER_DATA_DIR ?? join(process.env.APPDATA ?? process.env.HOME ?? '.', 'AgentViewer'); }
export async function startServer(core: ViewerCore, root: string, directory: string, port = 3210) {
  const token = randomBytes(32).toString('hex'), app = express();
  const validOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://127.0.0.1:5173', 'http://localhost:5173']);
  const sampleFiles = await ensureSamples(join(directory, 'samples'));
  app.use(express.json({ limit: '20mb' }));
  app.use((req, res, next) => { const origin = req.headers.origin; if (origin && !validOrigins.has(origin)) { res.status(403).json({ error: { code: 'ORIGIN_DENIED', message: '此网页不能访问本地接口。' } }); return; } if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Access-Control-Allow-Credentials', 'true'); res.setHeader('Vary', 'Origin'); } if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); res.sendStatus(204); return; } next(); });
  app.get('/api/bootstrap', (req, res) => { if (req.headers['sec-fetch-site'] === 'cross-site') return res.sendStatus(403); res.cookie('av_session', token, { httpOnly: true, sameSite: 'strict', path: '/' }); res.json({ protocolVersion: PROTOCOL_VERSION }); });
  app.use(['/api', '/v1'], (req, res, next) => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, ''); const cookie = req.headers.cookie?.match(/(?:^|;\s*)av_session=([^;]+)/)?.[1];
    const supplied = bearer ?? cookie; const valid = typeof supplied === 'string' && supplied.length === token.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
    if (!valid) { res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: '需要 AgentViewer 本地连接凭据。' } }); return; }
    res.locals.actor = bearer ? 'agent' : 'human'; next();
  });
  app.get('/v1/info', (_req, res) => res.json({ application: 'AgentViewer', version: '0.1.0', protocolVersion: PROTOCOL_VERSION, browser: !!core.browser, libreOffice: !!libreOfficePath(), persistenceError: core.lastPersistenceError, formats: core.registry.describe() }));
  app.get('/api/samples', (_req, res) => res.json(sampleFiles));
  app.get('/api/state', (_req, res) => res.json(core.state()));
  app.get('/api/documents/:id/bytes', (req, res, next) => { try { res.type('application/octet-stream').send(Buffer.from(core.getDocument(req.params.id).bytes)); } catch (e) { next(e); } });
  app.get('/api/events', (req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders(); const after = Number(req.query.after ?? 0); if (after && after < (core.eventLog[0]?.seq ?? 0)) res.write('event: resync_required\ndata: {}\n\n'); else for (const event of core.eventLog.filter(e => e.seq > after)) res.write('data: ' + JSON.stringify(event) + '\n\n'); const listener = (event: unknown) => res.write('data: ' + JSON.stringify(event) + '\n\n'); core.on('change', listener); req.on('close', () => core.off('change', listener)); });
  app.post('/api/command', async (req, res, next) => { try { const { method, args = {} } = req.body; if (typeof method !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) throw new ViewerError('INVALID_ARGUMENT', '需要 method 和对象类型 args。'); res.json(await dispatch(core, method, args, res.locals.actor)); } catch (e) { next(e); } });
  app.post('/v1/commands/prepare', async (req, res, next) => { try { res.json(await dispatch(core, 'prepare', req.body, 'agent')); } catch (e) { next(e); } });
  app.post('/v1/commands/commit', async (req, res, next) => { try { res.json(await dispatch(core, 'commit', req.body, 'agent')); } catch (e) { next(e); } });
  app.post('/v1/browser/input', async (req, res, next) => { try { res.json(await core.browserInput(req.body)); } catch (e) { next(e); } });
  app.get('/v1/views/:viewId/context', async (req, res, next) => { try { res.json(await core.context(req.params.viewId)); } catch (e) { next(e); } });
  app.post('/v1/snapshots', async (req, res, next) => { try { res.json(await core.snapshot(req.body.viewId)); } catch (e) { next(e); } });
  app.get('/v1/snapshots/:id', (req, res, next) => { try { res.json(core.readSnapshot(req.params.id)); } catch (e) { next(e); } });
  app.use('/fixtures', express.static(join(root, 'tests/fixtures')));
  app.use(express.static(join(root, 'dist/renderer')));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { const code = error instanceof ViewerError ? error.code : error instanceof ZodError ? 'INVALID_ARGUMENT' : 'INTERNAL_ERROR'; const message = error instanceof Error ? error.message : String(error); res.status(code === 'INTERNAL_ERROR' ? 500 : 400).json({ error: { code, message } }); });
  const server = await new Promise<Server>((resolveServer, reject) => { const s = app.listen(port, '127.0.0.1', () => resolveServer(s)); s.on('error', reject); });
  await mkdir(join(directory, 'runtime'), { recursive: true });
  await writeFile(join(directory, 'runtime/connection.json'), JSON.stringify({ application: 'AgentViewer', instanceId: randomBytes(8).toString('hex'), protocolVersion: PROTOCOL_VERSION, endpoint: `http://127.0.0.1:${port}`, token, pid: process.pid, mcpPath: join(root, 'dist/mcp/index.mjs') }), { mode: 0o600 });
  return { server, token, endpoint: `http://127.0.0.1:${port}`, sampleFiles };
}
