import type { NativeOfficeCommand, NativeOfficeFormat, NativeOfficeNavigateTarget, NativeOfficeState, NativeOfficeStylePatch, NativeOfficeStyleTarget, NativeOfficeStyleValues, UNOProperty } from '../../../../../packages/contracts/src/native-office';
import { nativeOfficeStylePatchSchema } from '../../../../../packages/contracts/src/native-office';
import { nativeOfficeCommandPolicy } from '../../../../../packages/contracts/src/native-office-policy';
import type { OfficeToolboxCategory } from '../components/office/toolbox-contributions';

export type NativeOfficeRequest = <T = unknown>(method: string, args?: Record<string, unknown>) => Promise<T>;
export type NativeOfficeCommandGroup = { title: string; commands: readonly { command: string; label: string; icon?: string }[] };
const group = (title: string, commands: readonly (readonly [string, string, string?])[]): NativeOfficeCommandGroup => ({ title, commands: commands.map(([name, label, icon]) => ({ command: '.uno:' + name, label, icon })) });
const font = group('字体', [['Bold', '粗体', 'bold'], ['Italic', '斜体', 'italic'], ['Underline', '下划线', 'underline'], ['Strikeout', '删除线', 'strike'], ['SuperScript', '上标'], ['SubScript', '下标'], ['FontDialog', '字体设置'], ['ResetAttributes', '清除直接格式']]);
const paragraph = group('段落', [['LeftPara', '左对齐', 'left'], ['CenterPara', '居中', 'center'], ['RightPara', '右对齐', 'right'], ['JustifyPara', '两端对齐', 'justify'], ['DefaultBullet', '项目符号'], ['DefaultNumbering', '编号'], ['ParagraphDialog', '段落设置']]);

/** Candidates are a presentation preference, never evidence that the engine supports them. */
const groups: Record<NativeOfficeFormat, Partial<Record<OfficeToolboxCategory, readonly NativeOfficeCommandGroup[]>>> = {
  docx: {
    home: [font, paragraph, group('样式', [['DesignerDialog', '管理样式'], ['EditStyle', '编辑当前样式'], ['StyleNewByExample', '从选区创建样式'], ['StyleUpdateByExample', '更新当前样式']])],
    insert: [group('内容', [['InsertGraphic', '图片'], ['InsertSymbol', '特殊字符'], ['InsertObject', '嵌入对象'], ['InsertTextBox', '文本框'], ['HyperlinkDialog', '超链接']]), group('字段', [['InsertPageNumberField', '页码'], ['InsertPageCountField', '总页数'], ['InsertField', '字段'], ['FieldDialog', '字段设置']])],
    table: [group('表格', [['InsertTable', '插入表格'], ['TableDialog', '表格属性'], ['TableNumberFormatDialog', '单元格数字格式'], ['TableCellBackgroundColor', '单元格底色']]), group('行与列', [['InsertRowsBefore', '向上插入行'], ['InsertRowsAfter', '向下插入行'], ['InsertColumnsBefore', '向左插入列'], ['InsertColumnsAfter', '向右插入列'], ['DeleteRows', '删除行'], ['DeleteColumns', '删除列'], ['DeleteTable', '删除表格']]), group('结构与尺寸', [['MergeCells', '合并单元格'], ['SplitCell', '拆分单元格'], ['SplitTable', '拆分表格'], ['MergeTable', '合并表格'], ['DistributeRows', '均分行高'], ['DistributeColumns', '均分列宽'], ['OptimizeTable', '自动调整']]), group('数据与转换', [['TableSort', '排序'], ['ConvertTableToText', '表格转文字'], ['ConvertTextToTable', '文字转表格']])],
    layout: [group('页面', [['PageDialog', '页面设置'], ['PageColumnDialog', '分栏'], ['InsertPageHeader', '页眉'], ['InsertPageFooter', '页脚'], ['TitlePageDialog', '标题页']]), group('段落与分页', [['ParagraphDialog', '缩进与间距'], ['InsertPagebreak', '分页符'], ['InsertBreak', '手动分隔符'], ['InsertLandscapePage', '横向页面']])],
    references: [group('引用', [['InsertFootnote', '脚注'], ['InsertEndnote', '尾注'], ['InsertFootnoteDialog', '脚注或尾注设置'], ['InsertReferenceField', '交叉引用'], ['InsertBookmark', '书签'], ['InsertCaptionDialog', '题注']]), group('目录与索引', [['InsertMultiIndex', '目录与索引'], ['InsertIndexesEntry', '索引条目'], ['UpdateAllIndexes', '更新全部索引'], ['EditCurIndex', '编辑当前目录']]), group('参考文献', [['InsertAuthoritiesEntry', '参考文献条目'], ['AuthoritiesEntryDialog', '编辑参考文献']])],
    review: [group('校对', [['SpellingAndGrammarDialog', '拼写与语法'], ['ThesaurusDialog', '同义词'], ['WordCountDialog', '字数统计']]), group('批注', [['InsertAnnotation', '添加批注'], ['ReplyComment', '回复批注'], ['ResolveComment', '解决批注']]), group('修订', [['TrackChanges', '记录修订'], ['ShowTrackedChanges', '显示修订'], ['AcceptTrackedChanges', '管理修订'], ['NextTrackedChange', '下一处修订'], ['PreviousTrackedChange', '上一处修订'], ['CompareDocuments', '比较文档']])],
    view: [group('阅读布局', [['PrintLayout', '打印布局'], ['BrowseView', '网页布局'], ['DraftView', '草稿布局'], ['ShowSinglePage', '单页'], ['ShowTwoPages', '双页'], ['ShowMultiplePages', '多页']]), group('显示', [['ControlCodes', '格式标记'], ['Fieldnames', '字段名称'], ['ViewBounds', '文字边界'], ['TableBoundaries', '表格边界']]), group('预览', [['PrintPagePreview', '打印预览']])],
  },
  xlsx: {
    home: [font, group('单元格', [['AlignLeft', '左对齐', 'left'], ['AlignHorizontalCenter', '居中', 'center'], ['AlignRight', '右对齐', 'right'], ['WrapText', '自动换行'], ['ToggleMergeCells', '合并单元格'], ['FormatCellDialog', '单元格格式'], ['NumberFormatCurrency', '货币格式'], ['NumberFormatPercent', '百分比格式']])],
    insert: [group('内容', [['InsertGraphic', '图片'], ['InsertObjectChart', '图表'], ['InsertObject', '嵌入对象'], ['InsertSymbol', '特殊字符']]), group('行列', [['InsertRows', '插入行'], ['InsertColumns', '插入列']])],
    formulas: [group('函数与计算', [['FunctionDialog', '函数向导'], ['AutoSum', '自动求和'], ['Calculate', '重新计算'], ['CalculateHard', '全部重新计算']]), group('命名范围', [['DefineName', '名称管理'], ['AddName', '定义名称'], ['InsertName', '插入名称'], ['CreateNames', '根据标签创建名称']]), group('公式审核', [['ShowPrecedents', '追踪引用'], ['ShowDependents', '追踪从属'], ['ClearArrowPrecedents', '清除引用箭头'], ['ClearArrowDependents', '清除从属箭头']])],
    data: [group('排序与筛选', [['DataSort', '排序'], ['DataFilterAutoFilter', '自动筛选'], ['DataFilterStandardFilter', '标准筛选'], ['DataFilterSpecialFilter', '高级筛选'], ['DataFilterRemoveFilter', '清除筛选']]), group('清理与校验', [['Validation', '数据有效性'], ['TextToColumns', '分列'], ['DataSubTotals', '分类汇总'], ['DataConsolidate', '合并计算']]), group('透视表', [['DataDataPilotRun', '创建数据透视表'], ['RecalcPivotTable', '刷新数据透视表']])],
    worksheet: [group('工作表', [['Insert', '插入工作表'], ['RenameTable', '重命名工作表'], ['Move', '移动或复制工作表'], ['Remove', '删除工作表'], ['Show', '显示工作表'], ['Hide', '隐藏工作表'], ['Protect', '保护工作表'], ['ToolProtectionDocument', '保护工作簿']]), group('行与列', [['ColumnWidth', '列宽'], ['RowHeight', '行高'], ['SetOptimalColumnWidth', '最佳列宽'], ['SetOptimalRowHeight', '最佳行高'], ['DeleteRows', '删除行'], ['DeleteColumns', '删除列']])],
    view: [group('显示', [['NormalViewMode', '普通视图'], ['PagebreakMode', '分页预览'], ['ViewValueHighlighting', '值突出显示'], ['ShowFormula', '显示公式']]), group('冻结', [['FreezePanes', '冻结或取消冻结'], ['FreezePanesRow', '冻结首行'], ['FreezePanesColumn', '冻结首列']])],
    print: [group('打印区域', [['DefinePrintArea', '定义打印区域'], ['AddPrintArea', '添加打印区域'], ['EditPrintArea', '编辑打印区域'], ['DeletePrintArea', '清除打印区域']]), group('页面与输出', [['PageFormatDialog', '页面样式'], ['PrintPreview', '打印预览'], ['PrinterSetup', '打印机设置'], ['Print', '打印…']])],
  },
  pptx: {
    home: [font, paragraph],
    insert: [group('对象', [['Text', '文本框'], ['Rect', '矩形'], ['Ellipse', '椭圆'], ['Line', '直线'], ['InsertGraphic', '图片'], ['InsertTable', '表格'], ['InsertObjectChart', '图表'], ['InsertObject', '嵌入对象']])],
    design: [group('页面与外观', [['PageDialog', '幻灯片设置'], ['Area', '填充与背景'], ['FormatLine', '线条设置'], ['MasterSlidesPanel', '选择母版'], ['EditStyle', '编辑样式']]), group('母版编辑', [['MasterPage', '编辑母版'], ['SlideMasterPage', '幻灯片母版'], ['CloseMasterView', '关闭母版视图'], ['MasterLayouts', '母版元素']])],
    arrange: [group('位置与组合', [['TransformDialog', '位置与尺寸'], ['FormatGroup', '组合'], ['FormatUngroup', '取消组合'], ['ObjectAlignLeft', '对象左对齐'], ['AlignCenter', '对象居中'], ['ObjectAlignRight', '对象右对齐']]), group('层级', [['BringToFront', '置于顶层'], ['SendToBack', '置于底层'], ['Forward', '上移一层'], ['Backward', '下移一层'], ['MirrorHorz', '水平翻转'], ['MirrorVert', '垂直翻转']])],
    slides: [group('幻灯片', [['InsertPage', '新建幻灯片', 'plus'], ['DuplicatePage', '复制幻灯片', 'copy'], ['DeletePage', '删除幻灯片', 'delete'], ['MovePageUp', '前移幻灯片', 'up'], ['MovePageDown', '后移幻灯片', 'down']])],
    transitions: [group('幻灯片切换', [['SlideChangeWindow', '切换效果与时间设置']])],
    animation: [group('对象动画', [['CustomAnimation', '动画效果与顺序'], ['AnimationObjects', '动画对象']])],
    presentation: [group('开始放映', [['Presentation', '从头放映'], ['PresentationCurrentSlide', '从当前页放映']]), group('放映设置', [['PresentationDialog', '放映设置'], ['CustomShow', '自定义放映']])],
    notes: [group('备注编辑', [['NotesMode', '备注页'], ['NotesPage', '备注页模式'], ['PageMode', '返回幻灯片']]), group('备注版式', [['NotesMasterPage', '备注母版'], ['MasterLayoutsNotes', '备注母版元素']])],
  },
};
/** Cheap candidates for live status queries; no full menu catalogue or assumed enablement. */
export function nativeOfficeToolCandidates(format: NativeOfficeFormat, category: OfficeToolboxCategory): readonly NativeOfficeCommandGroup[] {
  return groups[format][category] ?? [];
}
export function nativeOfficeToolGroups(format: NativeOfficeFormat, category: OfficeToolboxCategory, catalog: readonly NativeOfficeCommand[]) {
  const available = new Map(catalog.map(command => [command.command, command]));
  // Older versions can expose a NotesPage alias; display one entry when both exist.
  const discovered = (command: string) => available.has(command) && !(command === '.uno:NotesPage' && available.has('.uno:NotesMode'));
  return (groups[format][category] ?? []).map(item => ({ title: item.title, commands: item.commands.filter(command => discovered(command.command)).map(command => ({ ...available.get(command.command)!, ...command })) })).filter(item => item.commands.length);
}
export function nativeOfficeStatusKey(state: NativeOfficeState) { return JSON.stringify([state.documentId, state.viewId, state.sessionId, state.engineEpoch, state.engineRevision, state.selectionEpoch ?? null, state.pendingInput ?? false]); }
export function nativeOfficeOwnedState(state: NativeOfficeState | undefined, identity: { documentId: string; viewId: string; format?: NativeOfficeFormat }): state is NativeOfficeState {
  return !!state && state.documentId === identity.documentId && state.viewId === identity.viewId && (!identity.format || state.format === identity.format);
}
/** Revision numbers are comparable only within the same document/view native session. */
export function nativeOfficeStateVersionOrder(candidate: NativeOfficeState | undefined, reference: NativeOfficeState | undefined): -1 | 0 | 1 | undefined {
  if (!candidate || !reference || candidate.documentId !== reference.documentId || candidate.viewId !== reference.viewId || candidate.sessionId !== reference.sessionId || candidate.engineEpoch !== reference.engineEpoch) return undefined;
  const difference = candidate.engineRevision - reference.engineRevision || (candidate.selectionEpoch ?? 0) - (reference.selectionEpoch ?? 0);
  return difference < 0 ? -1 : difference > 0 ? 1 : 0;
}
export function nativeOfficeCommandAvailability(command: NativeOfficeCommand, state?: NativeOfficeState): { enabled: boolean; reason?: string } {
  const policy = nativeOfficeCommandPolicy(command.command);
  if (policy.blocked) return { enabled: false, reason: policy.reason };
  if (state?.status === 'failed') return { enabled: false, reason: '文档引擎未就绪。' };
  if (!state || state.status !== 'ready') return { enabled: false, reason: '文档引擎正在准备。' };
  if (state.pendingInput) return { enabled: false, reason: '请先完成正文中的输入。' };
  if (command.available === false) return { enabled: false, reason: command.reason ?? '当前引擎不支持此命令。' };
  if (command.enabled === false) return { enabled: false, reason: command.reason ?? '当前选区或文档状态不可用。' };
  if (command.enabled !== true) return { enabled: false, reason: '尚未取得此命令的实际可用状态。' };
  if (command.requiresSelection && (!state.selection || state.selection.kind === 'none')) return { enabled: false, reason: '请先在正文中选择内容或对象。' };
  return { enabled: true };
}

const types = new Set(['string', 'boolean', 'short', 'long', 'hyper', 'double']);
/** Explicit typed primitives only; no inferred UNO property names or executable content. */
export function parseNativeOfficeArguments(source: string): UNOProperty[] {
  if (!source.trim()) return [];
  let value: unknown;
  try { value = JSON.parse(source); } catch { throw new Error('参数必须为 JSON 数组。'); }
  if (!Array.isArray(value) || value.length > 64) throw new Error('一次最多提供 64 个参数。');
  const names = new Set<string>();
  return value.map(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('每项参数需要 name、type 和 value。');
    const property = item as Record<string, unknown>;
    if (Object.keys(property).some(key => !['name', 'type', 'value'].includes(key)) || typeof property.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(property.name) || names.has(property.name)) throw new Error('参数名称无效或重复。');
    if (typeof property.type !== 'string' || !types.has(property.type)) throw new Error('请明确指定 string、boolean、short、long、hyper 或 double 类型。');
    const type = property.type as NonNullable<UNOProperty['type']>, data = property.value;
    if (type === 'string' ? typeof data !== 'string' || data.length > 100000 : type === 'boolean' ? typeof data !== 'boolean' : typeof data !== 'number' || !Number.isFinite(data)) throw new Error('参数值与类型不匹配。');
    if (typeof data === 'number' && type !== 'double' && (!Number.isSafeInteger(data) || (type === 'short' && (data < -32768 || data > 32767)) || (type === 'long' && (data < -2147483648 || data > 2147483647)))) throw new Error('整数参数超出类型范围。');
    names.add(property.name); return { name: property.name, type, value: data as UNOProperty['value'] };
  });
}

export type NativeOfficeActionResult = { state: NativeOfficeState; status: string; warnings?: string[] };
export type NativeOfficeToolController = { viewId: string; documentId: string; execute(command: string, args?: UNOProperty[]): Promise<NativeOfficeActionResult>; navigate(target: NativeOfficeNavigateTarget): Promise<NativeOfficeActionResult>; setStyle(target: NativeOfficeStyleTarget, values: NativeOfficeStyleValues, source: NativeOfficeState): Promise<NativeOfficeActionResult> };
/** Capture a versioned native selection and never retry a dispatched mutation automatically. */
export function createNativeOfficeToolController(identity: { documentId: string; viewId: string }, options: { current(): NativeOfficeState | undefined; request: NativeOfficeRequest; accept(state: NativeOfficeState): void; beforeAction?(): Promise<NativeOfficeState | void>; makeKey?(): string }) {
  let active = true, pending = false;
  const current = () => {
    const state = options.current();
    if (!active || !nativeOfficeOwnedState(state, identity)) throw new Error('当前 Office 视图已变化。');
    if (state.status && state.status !== 'ready') throw new Error('文档引擎未就绪。');
    if (state.pendingInput) throw new Error('请先完成正文中的输入。');
    return state;
  };
  const unchanged = (before: NativeOfficeState) => {
    const state = current();
    if (nativeOfficeStatusKey(state) !== nativeOfficeStatusKey(before)) throw new Error('文档或选区已变化，请重新执行。');
    return state;
  };
  const accept = (before: NativeOfficeState, state: NativeOfficeState) => {
    const latest = current();
    if (!nativeOfficeOwnedState(state, identity) || state.sessionId !== before.sessionId || state.engineEpoch !== before.engineEpoch || latest.sessionId !== before.sessionId || latest.engineEpoch !== before.engineEpoch) throw new Error('原生会话已变化，此结果不属于当前视图。');
    if (state.engineRevision >= latest.engineRevision && (state.engineRevision > latest.engineRevision || (state.selectionEpoch ?? 0) >= (latest.selectionEpoch ?? 0))) options.accept(state);
  };
  const run = async (action: 'execute' | 'navigate' | 'style', target: string | NativeOfficeNavigateTarget | NativeOfficeStylePatch, args?: UNOProperty[], source?: NativeOfficeState) => {
    if (pending) throw new Error('上一条 Office 操作仍在处理中。');
    pending = true;
    try {
      if (source && (!nativeOfficeOwnedState(source, identity) || nativeOfficeStatusKey(source) !== nativeOfficeStatusKey(current()))) throw new Error('属性来源的内容或选区已变化，请重新读取。');
      if (options.beforeAction) {
        const original = current(), prepared = await options.beforeAction();
        if (prepared) {
          if (!nativeOfficeOwnedState(prepared, identity) || prepared.sessionId !== original.sessionId || prepared.engineEpoch !== original.engineEpoch || prepared.engineRevision < original.engineRevision || prepared.selectionEpoch !== original.selectionEpoch) throw new Error('提交草稿时选区或原生会话已变化，请重新执行。');
          const latest = current();
          if (latest.sessionId !== original.sessionId || latest.engineEpoch !== original.engineEpoch || latest.selectionEpoch !== original.selectionEpoch) throw new Error('提交草稿时选区或原生会话已变化，请重新执行。');
          if (prepared.engineRevision >= latest.engineRevision) options.accept(prepared);
        }
        const latest = current();
        if (latest.sessionId !== original.sessionId || latest.engineEpoch !== original.engineEpoch || latest.selectionEpoch !== original.selectionEpoch) throw new Error('提交草稿时选区或原生会话已变化，请重新执行。');
      }
      const before = current();
      if (action === 'style') {
        const fresh = await options.request<NativeOfficeState>('office-status', { viewId: identity.viewId });
        unchanged(before);
        if (!nativeOfficeOwnedState(fresh, identity) || nativeOfficeStatusKey(fresh) !== nativeOfficeStatusKey(before) || !source || nativeOfficeStatusKey(fresh) !== nativeOfficeStatusKey(source)) throw new Error('属性来源的内容或选区已变化，请重新读取。');
        if (fresh.selectionEpoch === undefined) throw new Error('引擎尚未确认属性目标的选区版本。');
        options.accept(fresh);
      }
      if (action === 'execute') {
        const policy = nativeOfficeCommandPolicy(target as string); if (policy.blocked) throw new Error(policy.reason);
        const checked = await options.request<{ state: NativeOfficeState; commands: NativeOfficeCommand[] }>('office-command-status', { viewId: identity.viewId, commands: [target] });
        unchanged(before);
        if (!nativeOfficeOwnedState(checked.state, identity) || nativeOfficeStatusKey(checked.state) !== nativeOfficeStatusKey(before)) throw new Error('文档或选区已变化，请重新执行。');
        const command = checked.commands.find(item => item.command === target);
        const availability = command && nativeOfficeCommandAvailability(command, before);
        if (!availability?.enabled) throw new Error(availability?.reason ?? '引擎未提供此命令的可用状态。');
      }
      unchanged(before);
      const versions = { viewId: identity.viewId, expectedEngineEpoch: before.engineEpoch, expectedEngineRevision: before.engineRevision, expectedSelectionEpoch: before.selectionEpoch, idempotencyKey: options.makeKey?.() ?? crypto.randomUUID() };
      if (action === 'execute' || action === 'style') {
        const result = await options.request<{ receipt: { status: 'dispatched' | 'applied' | 'no-change'; warnings?: string[] }; state: NativeOfficeState }>('office-execute', { ...versions, ...(action === 'style' ? { style: target } : { command: target, args }) });
        if (!result.receipt || !['dispatched', 'applied', 'no-change'].includes(result.receipt.status)) throw new Error('引擎未返回有效的操作回执。');
        accept(before, result.state); return { state: result.state, status: result.receipt.status, warnings: result.receipt.warnings };
      }
      const result = await options.request<{ status: 'requested' | 'rendered'; state: NativeOfficeState }>('office-navigate', { ...versions, target });
      if (!['requested', 'rendered'].includes(result.status)) throw new Error('引擎未确认导航状态。');
      accept(before, result.state); return result;
    } finally { pending = false; }
  };
  const controller: NativeOfficeToolController = { ...identity, execute: (command, args) => run('execute', command, args), navigate: target => run('navigate', target), setStyle: async (target, values, source) => run('style', nativeOfficeStylePatchSchema.parse({ target, values }), undefined, source) };
  return { controller, dispose() { active = false; } };
}
