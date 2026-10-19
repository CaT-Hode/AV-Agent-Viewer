import express from 'express';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Server } from 'node:http';
import { ViewerCore } from '../../../packages/document-core/src/index';
import { PROTOCOL_VERSION, ViewerError } from '../../../packages/contracts/src/index';
import { dispatch } from '../../../packages/sdk/src/dispatch';
import { ensureSamples } from '../../../packages/document-core/src/fixtures';
import { ZodError } from 'zod';
import { MarkdownWorkspace } from '../../../packages/markdown/src/workspace';
import { AgentSession } from '../../../packages/sdk/src/agent-session';
import { toolByName, type AgentToolName } from '../../../packages/sdk/src/agent-tools';
import { version } from '../../../package.json';

export function dataDir() { return process.env.AGENTVIEWER_DATA_DIR ?? join(process.env.APPDATA ?? process.env.HOME ?? '.', 'AgentViewer'); }
export async function startServer(core: ViewerCore, root: string, directory: string, port = 3210) {
  const markdownWorkspace = new MarkdownWorkspace(core, directory);
  core.extensions.set('markdown-workspace-root', async args => markdownWorkspace.resourceRoot(String(args.documentId)));
  core.extensions.set('markdown-workspace-list', async args => markdownWorkspace.list(String(args.documentId), String(args.path ?? '')));
  core.extensions.set('markdown-workspace-search', async args => markdownWorkspace.search(String(args.documentId), String(args.query ?? ''), args.caseSensitive === true, String(args.mode ?? 'content')));
  core.extensions.set('markdown-workspace-set-root', async (args, actor) => { if (actor !== 'human') throw new ViewerError('AUTH_SCOPE_DENIED', '请选择工作文件夹。'); return markdownWorkspace.setRoot(String(args.documentId), String(args.path)); });
  core.extensions.set('markdown-workspace-change', async (args, actor) => { if (actor !== 'human') throw new ViewerError('AUTH_SCOPE_DENIED', '文件管理由阅读窗口发起。'); return markdownWorkspace.change(args as any); });
  core.extensions.set('agent-files-change',async(args,actor)=>markdownWorkspace.changeAuthorized(String(args.root),{action:String(args.action),path:args.path as string|undefined,destination:args.destination as string|undefined,transactionId:args.transactionId as string|undefined},actor));
  const token = randomBytes(32).toString('hex'), app = express();
  const sessions=new Map<string,AgentSession>(),clients=new Map<string,string>();
  const retire=(id:string)=>{const session=sessions.get(id);if(!session)return;for(const [identity,value] of clients)if(value===id)clients.delete(identity);void session.dispose().then(()=>sessions.delete(id));};
  const validOrigins = new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`, 'http://127.0.0.1:5173', 'http://localhost:5173']);
  const sampleFiles = await ensureSamples(join(directory, 'samples'));
  app.use(express.json({ limit: '48mb' }));
  app.use((req, res, next) => { const origin = req.headers.origin; if (origin && !validOrigins.has(origin)) { res.status(403).json({ error: { code: 'ORIGIN_DENIED', message: '此网页不能访问本地接口。' } }); return; } if (origin) { res.setHeader('Access-Control-Allow-Origin', origin); res.setHeader('Access-Control-Allow-Credentials', 'true'); res.setHeader('Vary', 'Origin'); } if (req.method === 'OPTIONS') { res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); res.sendStatus(204); return; } next(); });
  app.get('/internal/bootstrap', (req, res) => { if (req.headers['sec-fetch-site'] === 'cross-site'||req.headers.authorization) return res.sendStatus(403); res.cookie('av_session', token, { httpOnly: true, sameSite: 'strict', path: '/' }); res.json({ protocolVersion: PROTOCOL_VERSION }); });
  app.use(['/internal', '/v2'], (req, res, next) => {
    const bearer = req.headers.authorization?.replace(/^Bearer /, ''); const cookie = req.headers.cookie?.match(/(?:^|;\s*)av_session=([^;]+)/)?.[1];
    const supplied = bearer ?? cookie; const valid = typeof supplied === 'string' && supplied.length === token.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
    if (!valid) { res.status(401).json({ error: { code: 'AUTH_REQUIRED', message: '需要 AgentViewer 本地连接凭据。' } }); return; }
    res.locals.actor = bearer ? 'agent' : 'human';
    if(req.originalUrl.startsWith('/internal')&&bearer||req.originalUrl.startsWith('/v2')&&!bearer){res.status(403).json({error:{code:'AUTH_SCOPE_DENIED',message:'内部阅读界面与Agent领域接口使用独立入口。'}});return;}
    next();
  });
  app.get('/v2/info', (_req, res) => res.json({ application:'AgentViewer',version,agentProtocolVersion:'2.0' }));
  app.post('/v2/sessions',(req,res,next)=>{try{
    const client=req.body?.client;if(typeof client!=='string'||!client.trim()||client.length>160)throw new ViewerError('INVALID_ARGUMENT','需要稳定client身份。');
    const connection=req.body?.connection;if(typeof connection!=='string'||!connection||connection.length>160)throw new ViewerError('INVALID_ARGUMENT','需要独立connection身份。');
    const identity=client+'\0'+connection;let id=clients.get(identity),session=id?sessions.get(id):undefined;
    if(!session){if(sessions.size>=64)throw new ViewerError('SESSION_QUOTA_EXCEEDED','Agent连接数已满。');session=new AgentSession(core,client,directory);id=session.id;sessions.set(id,session);clients.set(identity,id);}
    session.lastUsed=Date.now();res.json({session:id,version:'2.0'});
  }catch(error){next(error);}});
  app.post('/v2/sessions/close',(req,res,next)=>{try{
    const id=String(req.body?.session),session=sessions.get(id);if(!session){res.json({status:'closed'});return;}
    const draining=session.active;retire(id);res.json({status:draining?'draining':'closed',effectsCancelled:false});
  }catch(error){next(error);}});
  app.post('/v2/tools/:name',async(req,res,next)=>{try{
    if(!toolByName.has(req.params.name))throw new ViewerError('UNKNOWN_TOOL','未知领域工具。');
    const session=sessions.get(String(req.body?.session));if(!session)throw new ViewerError('SESSION_EXPIRED','请重新建立Agent连接。');
    res.json(await session.invoke(req.params.name as AgentToolName,req.body.input));
  }catch(error){next(error);}});
  app.get('/internal/samples', (_req, res) => res.json(sampleFiles));
  app.get('/internal/state', (_req, res) => res.json(core.stateForDisplay()));
  app.get('/internal/documents/:id/bytes', (req, res, next) => { try { res.type('application/octet-stream').send(Buffer.from(core.getDocument(req.params.id).bytes)); } catch (e) { next(e); } });
  app.get('/internal/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive'); res.flushHeaders();
    const cursor = Math.max(Number(req.query.after ?? 0), Number(req.headers['last-event-id'] ?? 0));
    const after = Number.isSafeInteger(cursor) && cursor >= 0 ? cursor : 0;
    const write = (event: {seq:number}) => res.write('id: ' + event.seq + '\ndata: ' + JSON.stringify(event) + '\n\n');
    if (after && after < (core.eventLog[0]?.seq ?? 0)) res.write('id: ' + (core.eventLog.at(-1)?.seq ?? 0) + '\nevent: resync_required\ndata: {}\n\n');
    else for (const event of core.eventLog) if (event.seq > after) write(event);
    core.on('change', write); req.on('close', () => core.off('change', write));
  });
  app.post('/internal/command', async (req, res, next) => { try { const { method, args = {} } = req.body; if (typeof method !== 'string' || !args || typeof args !== 'object' || Array.isArray(args)) throw new ViewerError('INVALID_ARGUMENT', '需要 method 和对象类型 args。'); res.json(await dispatch(core, method, args, 'human')); } catch (e) { next(e); } });
  app.use(['/api','/v1'],(_req,res)=>res.status(404).json({error:{code:'NOT_FOUND',message:'公共接口已重建，请使用 /v2 领域工具。'}}));
  app.use('/fixtures', express.static(join(root, 'tests/fixtures')));
  app.use(express.static(join(root, 'dist/renderer')));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => { const code = error instanceof ViewerError ? error.code : error instanceof ZodError ? 'INVALID_ARGUMENT' : 'INTERNAL_ERROR'; const message = error instanceof Error ? error.message : String(error); res.status(code === 'INTERNAL_ERROR' ? 500 : 400).json({ error: { code, message } }); });
  const server = await new Promise<Server>((resolveServer, reject) => { const s = app.listen(port, '127.0.0.1', () => resolveServer(s)); s.on('error', reject); });
  const expiry=setInterval(()=>{for(const [id,session] of sessions)if(!session.active&&Date.now()-session.lastUsed>30*60*1000)retire(id);},60_000);expiry.unref();
  server.once('close',()=>{clearInterval(expiry);for(const id of sessions.keys())retire(id);});
  await mkdir(join(directory, 'runtime'), { recursive: true });
  await writeFile(join(directory, 'runtime/connection.json'), JSON.stringify({ application: 'AgentViewer', instanceId: randomBytes(8).toString('hex'), protocolVersion: PROTOCOL_VERSION, agentProtocolVersion:'2.0', endpoint: `http://127.0.0.1:${port}`, token, pid: process.pid, mcpPath: join(root, 'dist/mcp/index.mjs') }), { mode: 0o600 });
  return { server, token, endpoint: `http://127.0.0.1:${port}`, sampleFiles };
}
