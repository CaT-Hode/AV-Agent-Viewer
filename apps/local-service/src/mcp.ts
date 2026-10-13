import { selectionActionSchema } from '../../../packages/selection-tools/src/index';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { call } from '../../../packages/sdk/src/client';
import { browserRequestSchema, editOperationSchema } from '../../../packages/contracts/src/index';
import { aiReadingRequestSchema, aiReadingResultSchema, aiReadingRetrySchema } from '../../../packages/sdk/src/ai-reading';

const server = new McpServer({ name: 'agent-viewer', version: '0.1.0' });
const text = (data: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }] });
const schemas = {
  reader_ai_tools: { description: '发现与右侧 AI 工具一致的摘要、解释、术语、证据、大纲、公式、表格与学习工具；返回具体视图的来源可用状态。', method: 'ai-reading-tools', schema: z.object({ viewId: z.string(), snapshotId: z.string().optional() }) },
  reader_ai_run: { description: '在明确冻结的选区或当前可见范围运行阅读分析，返回任务ID；不读取其他范围或修改原文。同一进程内幂等记录保留期间不重复发起，最多256项且在途不淘汰；重启或记录淘汰后先查询原任务。用 workspace_list 查询结果。', method: 'ai-reading-run', schema: aiReadingRequestSchema },
  reader_ai_retry: { description: '对已结束的阅读分析或独立草稿重新运行，沿用原冻结来源，返回新任务ID；服务商模型配置由发起时捕获，外部Harness保留原驱动（具体模型取决于Harness）。不读取当前新选区或写回原文。原任务在运行时拒绝。限当前进程保留的256项AI阅读记录，同一幂等键不重复新建。', method: 'ai-reading-retry', schema: aiReadingRetrySchema },
  reader_ai_result: { description: '读取AI阅读任务的当前结果、冻结范围原文、阅读器生成的来源位置/版本/指纹，以及结束后的独立Markdown导出内容。来源最多48000字符；模型生成内容按文本处理，草稿未应用到原文。普通Harness任务或过期记录不冒充可引用阅读结果。', method: 'ai-reading-result', schema: aiReadingResultSchema },
  reader_selection_tools: { description: '冻结当前选区并发现可执行图标工具，返回 snapshot 与 actions。支持所有文档格式；编辑需使用该快照与幂等键。', method: 'selection-tools', schema: z.object({viewId:z.string(),snapshotId:z.string().optional()}) },
  reader_selection_action: { description: '执行与阅读器选区浮窗相同的工具：复制/引用/摘录/批注/格式/替换/PDF 标记/AI。基于固定快照，版本或网页导航变化会拒绝修改。', method: 'selection-action', schema: selectionActionSchema },
  document_annotations: { description:'列出独立保存的批注及其来源选区和版本。',method:'annotations-list',schema:z.object({documentId:z.string()}) },
  document_remove_annotation: { description:'删除指定应用侧批注。',method:'annotation-remove',schema:z.object({id:z.string()}) },
  workspace_list: { description: '枚举文档、视图和任务，取得明确目标身份。', method: 'state', schema: z.object({}) },
  reader_open: { description: '打开本地文件或 HTTP(S) 网页。', method: 'open', schema: z.object({ uri: z.string() }) },
  reader_get_context: { description: '读取真实视口、位置、选择及版本。先确认目标，再操作。', method: 'context', schema: z.object({ viewId: z.string().optional(), snapshotId: z.string().optional() }) },
  reader_get_selection: { description: '读取选中文字及所属位置。', method: 'selection', schema: z.object({ viewId: z.string().optional(), snapshotId: z.string().optional() }) },
  reader_create_snapshot: { description: '固定发问时的阅读上下文与未保存内容。', method: 'snapshot', schema: z.object({ viewId: z.string().optional() }) },
  document_read: { description: '读取当前内容模型或固定快照的内容模型。', method: 'read', schema: z.object({ documentId: z.string().optional(), snapshotId: z.string().optional() }) },
  document_capabilities: { description: '查询可用编辑操作和真实引擎限制。', method: 'capabilities', schema: z.object({ documentId: z.string().optional() }) },
  document_outline: { description: '查询标题、工作表或幻灯片结构。', method: 'outline', schema: z.object({ documentId: z.string() }) },
  document_search: { description: '在适配器可提供的文字范围内搜索。', method: 'search', schema: z.object({ documentId: z.string(), query: z.string().min(1) }) },
  document_plan_patch: { description: '校验目标版本并准备修改预览，不改变内容。', method: 'prepare', schema: z.object({ documentId: z.string(), expectedRevision: z.number().int(), operation: editOperationSchema }) },
  document_apply_patch: { description: '提交准备好的修改；幂等键防止重复插入。', method: 'commit', schema: z.object({ patchId: z.string(), idempotencyKey: z.string().min(1) }) },
  document_undo: { description: '仅在不存在后续编辑时撤销事务。', method: 'undo', schema: z.object({ transactionId: z.string() }) },
  document_save: { description: '保存并校验磁盘文件；冲突时拒绝覆盖。', method: 'save', schema: z.object({ documentId: z.string(), path: z.string().optional() }) },
  browser_input: { description: '原生鼠标/键盘输入：click/move/drag/scroll/press/type。坐标为网页视口 CSS 像素，正 deltaY 向下滚。必须携带 context 的 navigationId 和独立幂等键；网页翻译后还须携带最新 layoutRevision，否则旧坐标会被拒绝。', method: 'browser-input', schema: browserRequestSchema },
  browser_navigate: { description: '指定网页导航、刷新、前进后退。', method: 'browser-navigate', schema: z.object({ viewId: z.string(), action: z.enum(['url', 'back', 'forward', 'reload']), url: z.string().optional() }) },
  browser_reading_copy: { description: '建立可持久编辑的 HTML 副本，不修改远程站点。', method: 'browser-copy', schema: z.object({ viewId: z.string() }) },
} as const;
for (const [name, tool] of Object.entries(schemas)) server.registerTool(name, { description: tool.description, inputSchema: tool.schema.shape }, async (args: Record<string, unknown>) => { try { return text(await call(tool.method, args)); } catch (e) { return { ...text({ error: String(e) }), isError: true }; } });
server.registerTool('browser_capture', { description: '截图包含当前导航身份、位图尺寸和 CSS 视口。输入坐标使用 CSS 像素，可用 expectedViewport 防止旧截图误操作。', inputSchema: { viewId: z.string() } }, async args => { try { const data = await call('browser-capture', args) as unknown as { mimeType: string; data: string; width: number; height: number; navigationId: string; viewport?: unknown }; return { content: [{ type: 'image' as const, mimeType: data.mimeType, data: data.data }, { type: 'text' as const, text: JSON.stringify({ width: data.width, height: data.height, navigationId: data.navigationId, viewport: data.viewport }) }] }; } catch (e) { return { ...text({ error: String(e) }), isError: true }; } });
server.registerTool('reader_manage_views', { description: '显式激活、复制或关闭视图。', inputSchema: { action: z.enum(['activate', 'duplicate-view', 'close']), viewId: z.string() } }, async args => { try { return text(await call(args.action, { viewId: args.viewId })); } catch (e) { return { ...text({ error: String(e) }), isError: true }; } });
server.registerTool('reader_set_zoom', { description: '按视图设置正文缩放比例。导航及工具栏保持原尺寸；缩放改变网页布局版本，旧坐标需要重新定位。', inputSchema: { viewId: z.string(), factor: z.number().min(.25).max(4) } }, async args => { try { return text(await call('zoom', args)); } catch (error) { return { ...text({ error: String(error) }), isError: true }; } });
await server.connect(new StdioServerTransport());
