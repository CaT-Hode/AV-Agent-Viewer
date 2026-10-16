import { actionsFor, selectionAction } from '../../selection-tools/src/index';
import type { Actor, EditOperation, ReadingContext, Rect, ViewInfo } from '../../contracts/src/index';
import { browserRequestSchema, normalizeWebAddress, ViewerError } from '../../contracts/src/index';
import type { ViewerCore } from '../../document-core/src/index';
import { aiReadingResult, aiReadingTools, retryAIReading, runAIReading } from './ai-reading';
import { createDocument } from './document-create';
import { outlineDocument, searchDocument } from './document-content';
import { navigateReader } from './reader-navigation';
import { agentAcquireSchema, agentReleaseSchema, agentStatusSchema } from './authoring-schemas';
import { officeSession } from './office-session';
import { markdownResource, importMarkdownImage, resolveMarkdownLink } from '../../markdown/src/resources';
import { readMarkdownPreferences, saveMarkdownPreferences } from '../../markdown/src/preferences';
import { listMarkdownResources, applyMarkdownResources } from '../../markdown/src/resource-actions';

export async function dispatch(core: ViewerCore, method: string, args: Record<string, unknown>, actor: Actor = 'agent'): Promise<unknown> {
  const str = (key: string) => { const value = args[key]; if (typeof value !== 'string') throw new ViewerError('INVALID_ARGUMENT', `${key} 必须是字符串。`); return value; };
  const viewId = typeof args.viewId === 'string' ? args.viewId : undefined;
  if (method.startsWith('office-')) return officeSession(core, method, args, actor);
  if (method.startsWith('markdown-workspace-')) { const extension = core.extensions.get(method); if (!extension) throw new ViewerError('CAPABILITY_UNSUPPORTED', '文件管理服务尚未连接。'); return extension(args, actor); }
  switch (method) {
    case 'markdown-preferences-read': return readMarkdownPreferences(core, str('documentId'));
    case 'markdown-preferences-save': { if (actor !== 'human') throw new ViewerError('AUTH_SCOPE_DENIED', '偏好设置由阅读窗口管理。'); return saveMarkdownPreferences(core, str('documentId'), args.preferences); }
    case 'markdown-resources-list': return listMarkdownResources(core, str('documentId'));
    case 'markdown-resources-apply': { if (actor !== 'human') throw new ViewerError('AUTH_SCOPE_DENIED', '资源批处理由阅读窗口发起。'); return applyMarkdownResources(core, { documentId: str('documentId'), expectedRevision: Number(args.expectedRevision), action: str('action'), sources: args.sources as string[] }); }
    case 'markdown-resource': return markdownResource(core, str('documentId'), str('path'));
    case 'markdown-import-image': return importMarkdownImage(core, { documentId: str('documentId'), name: String(args.name ?? 'image'), mimeType: String(args.mimeType ?? ''), bytes: args.bytes as number[] | undefined, dataUrl: args.dataUrl as string | undefined });
    case 'markdown-resolve-link': return resolveMarkdownLink(core, str('documentId'), str('href'));
    case 'new-document': return createDocument(core, args, actor);
    case 'reader-navigate': return navigateReader(core, args, actor);
    case 'agent-acquire': return core.acquireAgentView(agentAcquireSchema.parse(args));
    case 'agent-release': return core.releaseAgentView(agentReleaseSchema.parse(args));
    case 'agent-status': return core.agentViewStatus(agentStatusSchema.parse(args));
    case 'ai-reading-tools': return aiReadingTools(core, args);
    case 'ai-reading-run': return runAIReading(core, args, actor);
    case 'ai-reading-retry': return retryAIReading(core, args, actor);
    case 'ai-reading-result': return aiReadingResult(core, args);
    case 'selection-tools': { const textSelection=args.lightweight===true&&!args.snapshotId&&['markdown','html'].includes(core.getDocument(core.getView(viewId).documentId).info.format);const snapshot = args.snapshotId ? core.readSnapshot(str('snapshotId')) : textSelection ? await core.selectionContext(str('viewId'),args.expected as import('../../contracts/src/index').SelectionContextLease|undefined) : await core.snapshot(viewId); return { snapshot, actions: actionsFor(snapshot, !!core.extensions.get('selection-ai')) }; }
    case 'selection-context': { const selectionContext = await core.selectionContext(str('viewId'), args.expected as import('../../contracts/src/index').SelectionContextLease | undefined); return { selectionContext, actions: actionsFor(selectionContext, !!core.extensions.get('selection-ai')) }; }
    case 'selection-action': return selectionAction(core, args, actor);
    case 'annotations-list': return [...core.annotations.values()].filter(note => note.documentId === str('documentId'));
    case 'annotation-remove': { const id = str('id'), note = core.annotations.get(id); if (!note) throw new ViewerError('TARGET_NOT_FOUND', '批注不存在。'); if (actor === 'agent' && ['paused','stopped'].includes(core.agentControl.get(note.documentId) ?? '')) throw new ViewerError('AGENT_PAUSED', 'Agent 已暂停。'); core.annotations.delete(id); core.event('annotation.removed', { id, actor }); await core.persist(); return {}; }
    case 'document-open-view': { const id=str('documentId'), activate=args.activate!==false; const existing=[...core.views.values()].find(v=>v.documentId===id&&v.windowId===String(args.windowId??'main')); const next=existing??core.addView(id,String(args.windowId??'main'),activate), document=core.getDocument(id).info; if(actor==='human'&&activate)core.activate(next.id,actor); if(document.format==='web'&&document.model.url)await core.browser?.open(next.id,document.model.url,{background:!activate&&args.preload!==true}); return next; }
    case 'state': return core.state();
    case 'events': return core.eventLog.filter(event => event.seq > Number(args.after ?? 0)).slice(-100);
    case 'agent-control': if (actor !== 'human') throw new ViewerError('AUTH_SCOPE_DENIED', '仅用户可暂停或停止 Agent。'); if (!['running','paused','stopped'].includes(String(args.status))) throw new ViewerError('INVALID_ARGUMENT', '未知 Agent 状态。'); core.setAgentControl(str('viewId'), args.status as 'running' | 'paused' | 'stopped'); return {};
    case 'capabilities': return args.documentId ? core.getDocument(str('documentId')).info.capabilities : core.registry.describe();
    case 'open': {
      const activate = args.activate !== false, uri = str('uri'), url = normalizeWebAddress(uri, 'omnibox');
      const humanIntent = core.humanActivationVersion;
      // Windows also supports drive-relative paths such as D:notes.md. Keep
      // x:// as an unknown URL scheme, rather than interpreting it as a drive.
      const localDrivePath = /^[a-z]:(?!\/\/)/i.test(uri.trim()) && (process.platform === 'win32' || /^[a-z]:[\\/]/i.test(uri.trim()));
      if (!url && /^[a-z][\w+.-]*:/i.test(uri.trim()) && !localDrivePath) throw new ViewerError('INVALID_URL', '请输入有效的 HTTP(S) 网址或本地文件路径。');
      const view = url ? await core.openWeb(url, args.windowId as string | undefined, activate, { preload: args.preload === true }) : await core.openFile(uri, args.windowId as string | undefined, activate);
      // A new page is allocated before its network load finishes. A later
      // genuine human tab choice must survive this older open's completion.
      if (actor === 'human' && activate && (!url || core.humanActivationVersion === humanIntent && core.activeViewId === view.id)) core.activate(view.id, actor); return view;
    }
    case 'create-text': { const format = args.format === 'html' ? 'html' : 'markdown'; const view = await core.openBytes(String(args.title ?? (format === 'html' ? '未命名.html' : '未命名.md')), new TextEncoder().encode(String(args.text ?? '')), format, undefined, args.windowId as string | undefined); if (actor === 'human') core.activate(view.id, actor); return view; }
    case 'activate': { const view = core.getView(str('viewId')), document = core.getDocument(view.documentId).info; core.activate(view.id, actor); if (document.format === 'web' && document.model.url) await core.browser?.open(view.id, document.model.url); return {}; }
    case 'mode': { const mode = str('mode'); if (!['read', 'source', 'split'].includes(mode)) throw new ViewerError('INVALID_ARGUMENT', '未知视图模式。'); core.setMode(str('viewId'), mode as ViewInfo['mode']); return {}; }
    case 'zoom': return core.setNativeViewZoom(str('viewId'), Number(args.factor), actor);
    case 'duplicate-view': { const view = core.getView(str('viewId')), activate=args.activate!==false, next = core.addView(view.documentId, args.windowId as string | undefined ?? view.windowId, activate), document = core.getDocument(view.documentId).info; if (document.format === 'web' && document.model.url) await core.browser?.open(next.id, document.model.url, {background:!activate}); return next; }
    case 'close': await core.requestCloseView(str('viewId'), !!args.retainRecovery); return {};
    case 'context': return args.snapshotId ? core.readSnapshot(str('snapshotId')).context : core.context(viewId);
    case 'selection': return (args.snapshotId ? core.readSnapshot(str('snapshotId')).context : await core.context(viewId)).selection;
    case 'report-context': if (actor !== 'human') throw new ViewerError('AUTH_SCOPE_DENIED', '外部 harness 不能伪造界面上下文。'); core.updateContext(str('viewId'), args.context as Partial<ReadingContext>, (args.context as Partial<ReadingContext>)?.actor === 'agent' ? 'agent' : actor); return {};
    case 'snapshot': return core.snapshot(viewId);
    case 'snapshot-read': return core.readSnapshot(str('snapshotId'));
    case 'read': { if(!args.snapshotId)await core.synchronizeNativeDocument(str('documentId'));const document = args.snapshotId ? core.readSnapshot(str('snapshotId')).document : core.getDocument(str('documentId')).info; return { ...document.model, revision: document.revision, warnings: document.warnings }; }
    case 'outline': await core.synchronizeNativeDocument(str('documentId'));return outlineDocument(core.getDocument(str('documentId')).info);
    case 'search': { const query = str('query'); if (!query || query.length > 10000) throw new ViewerError('INVALID_ARGUMENT', '搜索词需为 1–10000 字符。'); await core.synchronizeNativeDocument(str('documentId'));return searchDocument(core.getDocument(str('documentId')).info, query); }
    case 'prepare': await core.synchronizeNativeDocument(str('documentId'));return core.prepare(str('documentId'), Number(args.expectedRevision), args.operation as EditOperation, { viewId: args.viewId === undefined ? undefined : str('viewId'), controlId: args.controlId === undefined ? undefined : str('controlId') });
    case 'commit': return core.commit(str('patchId'), str('idempotencyKey'), actor);
    case 'undo': return core.undo(str('transactionId'), actor);
    case 'save': return core.save(str('documentId'), args.path as string | undefined, actor === 'human' && !!args.allowOverwrite);
    case 'workspace-export-recovery': return core.exportRecovery(str('path'));
    case 'browser-input': return core.browserInput(browserRequestSchema.parse(args));
    case 'browser-capture': if (!core.browser) throw new ViewerError('CAPABILITY_UNSUPPORTED', '请使用桌面浏览器。'); return core.browser.capture(str('viewId'));
    case 'browser-navigate': {
      if (!core.browser) throw new ViewerError('CAPABILITY_UNSUPPORTED', '请使用桌面浏览器。');
      const action = str('action');
      if (!['back', 'forward', 'reload', 'url'].includes(action)) throw new ViewerError('INVALID_ARGUMENT', '未知网页导航操作。');
      const url = action === 'url' ? normalizeWebAddress(str('url')) : undefined;
      if (action === 'url' && !url) throw new ViewerError('INVALID_URL', '请输入有效的网址，例如 example.com 或 https://example.com。');
      await core.browser.navigate(str('viewId'), action as 'back' | 'forward' | 'reload' | 'url', url); return {};
    }
    case 'browser-html': { if (!core.browser) throw new ViewerError('CAPABILITY_UNSUPPORTED', '请在桌面应用读取真实网页。'); return core.browser.html(str('viewId')); }
    case 'browser-copy': return core.browserCopy(str('viewId'));
    case 'browser-layout': if (actor !== 'human') throw new ViewerError('AUTH_SCOPE_DENIED', '布局由桌面工作台管理。'); core.browser?.layout(String(args.windowId ?? 'main'), args.views as { viewId: string; bounds: Rect }[]); return {};
    case 'harness-submit': {
      if (args.sourceScope !== undefined && args.sourceScope !== 'selection' && args.sourceScope !== 'visible') throw new ViewerError('INVALID_ARGUMENT', '未知阅读范围。');
      return core.submitTask(str('driverId'), str('prompt'), viewId, typeof args.snapshotId === 'string' ? args.snapshotId : undefined, args.sourceScope as 'selection' | 'visible' | undefined);
    }
    case 'harness-cancel': core.cancelTask(str('taskId')); return {};
    case 'harness-list': return [...core.drivers.values()].map(d => ({ id: d.id, capabilities: d.capabilities }));
    default: throw new ViewerError('METHOD_UNSUPPORTED', `未知方法：${method}`);
  }
}
