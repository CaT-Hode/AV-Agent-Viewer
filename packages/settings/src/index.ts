import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DEFAULT_DOCUMENT_PAPER_COLOR, normalizeDocumentPaperColor } from './document-paper';
import { DEFAULT_SELECTION_SHORTCUT, normalizeSelectionShortcut } from '../../contracts/src/selection-shortcut';

export type SettingValue = string | number | boolean;
export type SettingDefinition = { id: string; group: string; section: string; label: string; description?: string; type: 'boolean' | 'number' | 'select' | 'text'; defaultValue: SettingValue; options?: string[]; min?: number; max?: number; effect?: 'immediate' | 'next-task' | 'reopen' | 'restart'; available?: boolean; unavailableReason?: string };
const b = (id: string, group: string, section: string, label: string, value: boolean, description?: string): SettingDefinition => ({ id, group, section, label, type: 'boolean', defaultValue: value, description });
const n = (id: string, group: string, section: string, label: string, value: number, min: number, max: number): SettingDefinition => ({ id, group, section, label, type: 'number', defaultValue: value, min, max });
const s = (id: string, group: string, section: string, label: string, value: string, options: string[]): SettingDefinition => ({ id, group, section, label, type: 'select', defaultValue: value, options });

export const settingsRegistry: SettingDefinition[] = [
  { ...s('general.startPage','工作方式','通用与多开','启动界面','restore',['restore','home']), effect: 'reopen' },
  b('general.restoreTabs','工作方式','通用与多开','恢复标签和阅读位置',true),
  s('general.duplicateFile','工作方式','通用与多开','重复打开文件','focus',['focus','new-view']),
  b('general.previewTabs','工作方式','通用与多开','启用预览标签',false),
  n('general.recentClosed','工作方式','通用与多开','最近关闭记录数',50,0,200),
  b('general.completionSound','工作方式','通用与多开','任务完成声音',false),
  s('appearance.theme','工作方式','外观与布局','主题','system',['system','light','dark']),
  s('appearance.density','工作方式','外观与布局','界面密度','standard',['compact','standard','comfortable']),
  s('appearance.glass','工作方式','外观与布局','玻璃效果','standard',['standard','enhanced','off']),
  { ...s('appearance.documentBackground','工作方式','外观与布局','文档阅读背景','paper',['paper','mist','aurora','dusk','spectrum','lagoon','iris','champagne','opal','solid']), description: '只影响阅读画布与页面周围，不修改文档或导出内容。' },
  { id: 'appearance.documentPaperColor', group: '工作方式', section: '外观与布局', label: '正文纸面颜色', type: 'text', defaultValue: DEFAULT_DOCUMENT_PAPER_COLOR, description: '独立于外围背景与深浅主题；只改变默认纸面，不覆盖文件中明确设置的填色或图片。' },
  { ...s('appearance.backgroundMotion','工作方式','外观与布局','炫彩背景动态','slow',['slow','still']), description: '缓慢漂移只作用于外围彩色画布；关闭或减少动效时保持静止。' },
  s('appearance.motion','工作方式','外观与布局','动效','standard',['standard','elegant','reduced','off']),
  b('appearance.reduceTransparency','工作方式','外观与布局','减少透明度',false),
  b('appearance.highContrast','工作方式','外观与布局','增强对比度',false),
  b('appearance.autoHideToolbar','工作方式','外观与布局','导航栏自动隐藏',false,'默认保持显示；开启后根据滚动方向与距离收起。'),
  n('appearance.toolbarDelayMs','工作方式','外观与布局','胶囊隐藏等待时间（毫秒）',2500,500,10000),
  b('reading.restorePosition','工作方式','阅读与导航','恢复阅读位置',true),
  b('reading.followOutline','工作方式','阅读与导航','目录跟随当前位置',true),
  b('reading.linkTranslations','工作方式','阅读与导航','原译文并排时联动导航',true),
  b('reading.selectionToolbar','工作方式','阅读与导航','选择后显示快捷工具',true),
  s('reading.copyFormat','工作方式','阅读与导航','默认复制格式','plain',['plain','markdown','rich','citation']),
  b('reading.pdfCleanCopy','工作方式','阅读与导航','PDF 复制时修复断行',false),
  b('editing.recovery','工作方式','编辑与保存','草稿恢复',true),
  b('editing.autoSave','工作方式','编辑与保存','自动写回原文件',false),
  n('editing.autoSaveDelayMs','工作方式','编辑与保存','自动保存等待时间（毫秒）',1500,500,30000),
  b('editing.externalChanges','工作方式','编辑与保存','检测外部修改',true),
  s('editing.aiApply','工作方式','编辑与保存','AI 编辑的应用方式','direct',['direct','preview']),
  b('editing.spellcheck','工作方式','编辑与保存','拼写检查',true),
  s('editing.exportConflict','工作方式','编辑与保存','导出文件同名时','increment',['increment','ask']),
  b('annotations.includeSource','工作方式','批注与引用','摘录包含来源位置',true),
  s('annotations.defaultColor','工作方式','批注与引用','高亮颜色','yellow',['yellow','green','blue','pink']),
  s('annotations.quoteFormat','工作方式','批注与引用','引用格式','markdown',['plain','markdown','rich']),
  b('annotations.includeTranslation','工作方式','批注与引用','引用包含译文',false),
  b('translation.selectionAuto','AI','翻译','文档选区自动翻译',true,'连接可用后生效；不会修改原文。'),
  b('translation.selectionShortcutEnabled','AI','翻译','快捷键翻译选区',true,'选中文字后使用快捷键主动翻译；正文底部显示提示。'),
  { id: 'translation.selectionShortcut', group: 'AI', section: '翻译', label: '选区翻译快捷键', type: 'text', defaultValue: DEFAULT_SELECTION_SHORTCUT, description: '点击后按下组合键；支持 Ctrl、Alt、Shift、Meta 与字母、数字或 F1–F12，避开已有编辑快捷键。' },
  n('translation.selectionDelayMs','AI','翻译','选区翻译等待时间（毫秒）',500,200,3000),
  s('translation.selectionPresentation','AI','翻译','选区译文呈现','popover',['popover','drawer']),
  { ...n('translation.capsuleGrowthRatio','AI','翻译','译文胶囊宽高增长比例',1,.15,1), description: '默认1.0：增高100像素时约增宽100像素；达到宽高边界后内部滚动。' },
  b('translation.autoFullDocument','AI','翻译','打开外语文档时自动生成译文',false),
  { ...s('translation.targetLanguage','AI','翻译','目标语言','zh-CN',['zh-CN','en','ja','fr','de','es']), effect: 'next-task' },
  { ...s('translation.outputDirectory','AI','翻译','译文保存位置','managed',['managed','beside-source']), effect: 'next-task' },
  b('translation.openArtifact','AI','翻译','生成后自动打开译文',false),
  b('translation.bilingualCopy','AI','翻译','额外生成双语副本',false),
  b('translation.webAuto','AI','翻译','自动翻译网页',false),
  b('translation.webDynamic','AI','翻译','翻译网页新增内容',true),
  b('translation.webVisibleFirst','AI','翻译','优先翻译可见正文',true),
  b('translation.explainOmissions','AI','翻译','显示未覆盖内容报告',true),
  s('ai.defaultDriver','AI','模型与连接','默认 Harness','none',['codex','none']),
  b('ai.fallbackModel','AI','模型与连接','启用备用模型',false),
  n('ai.requestTimeoutSec','AI','模型与连接','请求超时（秒）',120,10,600),
  n('ai.maxConcurrent','AI','模型与连接','并行请求数',2,1,8),
  b('ai.showCitations','AI','AI 工具与协作','显示来源引用',true),
  s('ai.defaultScope','AI','AI 工具与协作','默认作用范围','selection',['selection','page','document']),
  b('agent.pointer','AI','AI 工具与协作','显示 Agent 指针和点击反馈',true),
  b('agent.followPage','AI','AI 工具与协作','自动跟随 Agent 页面',false),
  s('agent.concurrent','AI','AI 工具与协作','同时操作策略','allow',['allow','pause-on-human-input']),
  s('agent.capsuleDetail','AI','AI 工具与协作','操作胶囊内容','minimal',['minimal','target']),
  n('tasks.concurrent','AI','后台任务','后台任务并发',2,1,8),
  b('tasks.continueOnClose','AI','后台任务','关闭原文标签后继续',true),
  { ...b('tasks.resumeOnStart','AI','后台任务','启动时自动恢复任务',false), effect: 'reopen' },
  b('tasks.lowBatteryPause','AI','后台任务','低电量时暂停重任务',true),
  s('library.importMode','系统','文档库与搜索','导入模式','reference',['reference','copy']),
  b('library.groupTranslations','系统','文档库与搜索','原文与译文分组',true),
  b('search.includeTranslations','系统','文档库与搜索','搜索译文',true),
  b('search.includeAnnotations','系统','文档库与搜索','搜索批注',true),
  { ...s('web.backgroundLoading','系统','网页与下载','后台网页加载','lazy',['lazy','eager']), description: '仅影响之后新登记或恢复的后台网页。按需模式在激活或明确读取正文时加载；不会卸载或重新加载已有页面。' },
  b('web.allowPopups','系统','网页与下载','允许弹出窗口',false),
  s('downloads.conflict','系统','网页与下载','下载同名处理','rename',['rename','ask']),
  b('storage.keepArtifacts','系统','存储与恢复','清理缓存时保留正式译文',true),
  n('storage.recoveryVersions','系统','存储与恢复','恢复版本数量',20,1,100),
  b('accessibility.focusRing','系统','快捷键与无障碍','显示键盘焦点',true),
  b('accessibility.iconLabels','系统','快捷键与无障碍','显示图标文字标签',false),
  s('performance.backgroundTabs','系统','引擎与高级','非活动标签','keep',['keep','sleep']),
  b('advanced.redactLogs','系统','引擎与高级','日志脱敏',true),
  b('advanced.experimental','系统','引擎与高级','实验功能',false),
];
const activeSettings = new Set([
  'general.startPage',
  'appearance.theme','appearance.density','appearance.glass','appearance.documentBackground','appearance.documentPaperColor','appearance.backgroundMotion','appearance.motion','appearance.reduceTransparency','appearance.highContrast','appearance.autoHideToolbar','appearance.toolbarDelayMs',
  'translation.selectionAuto','translation.selectionShortcutEnabled','translation.selectionShortcut','translation.selectionDelayMs','translation.selectionPresentation','translation.targetLanguage','translation.outputDirectory','translation.openArtifact','translation.webAuto','translation.webDynamic',
  'translation.capsuleGrowthRatio','ai.defaultDriver','agent.pointer','agent.capsuleDetail','tasks.resumeOnStart','web.backgroundLoading',
]);
export function settingsAvailability(id: string) { return activeSettings.has(id) ? { available: true } : { available: false, unavailableReason: '当前引擎尚未接入此能力，暂不能修改。' }; }

export type SettingsSnapshot = { schemaVersion: 1; values: Record<string, SettingValue>; revision: number; canUndo?: boolean };
export class SettingsService {
  private values: Record<string, SettingValue> = {};
  private revision = 0;
  private history: { id: string; value: SettingValue }[] = [];
  private writing: Promise<void> = Promise.resolve();
  constructor(readonly path: string) {}
  async load() {
    try {
      const parsed = JSON.parse(await readFile(this.path, 'utf8')) as Partial<SettingsSnapshot>;
      for (const definition of settingsRegistry) if (parsed.values && definition.id in parsed.values) {
        try { this.validate(definition.id, parsed.values[definition.id]); this.values[definition.id] = definition.id === 'appearance.documentPaperColor' ? normalizeDocumentPaperColor(parsed.values[definition.id])! : parsed.values[definition.id]; } catch { /* stale setting falls back to its default */ }
      }
      this.revision = Number.isSafeInteger(parsed.revision) ? Number(parsed.revision) : 0;
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  snapshot(): SettingsSnapshot { return { schemaVersion: 1, values: Object.fromEntries(settingsRegistry.map(d => [d.id, this.get(d.id)])), revision: this.revision, canUndo: this.history.length > 0 }; }
  get(id: string): SettingValue { const definition = settingsRegistry.find(d => d.id === id); if (!definition) throw new Error(`未知设置：${id}`); return this.values[id] ?? definition.defaultValue; }
  private validate(id: string, value: unknown) {
    const definition = settingsRegistry.find(d => d.id === id); if (!definition) throw new Error(`未知设置：${id}`);
    if (definition.type === 'boolean' && typeof value !== 'boolean') throw new Error('设置值需要布尔值');
    if (definition.type === 'number' && (typeof value !== 'number' || !Number.isFinite(value) || value < (definition.min ?? -Infinity) || value > (definition.max ?? Infinity))) throw new Error('设置值超出范围');
    if (definition.type === 'select' && (typeof value !== 'string' || !definition.options?.includes(value))) throw new Error('设置选项无效');
    if (definition.type === 'text' && typeof value !== 'string') throw new Error('设置值需要文本');
    if (id === 'appearance.documentPaperColor' && !normalizeDocumentPaperColor(value)) throw new Error('纸面颜色需要 #RGB 或 #RRGGBB 格式');
    if (id === 'translation.selectionShortcut' && !normalizeSelectionShortcut(value)) throw new Error('快捷键无效或与现有操作冲突，请使用其他组合键。');
  }
  async undo() { const last = this.history.pop(); if (!last) return this.snapshot(); return this.set(last.id, last.value, false); }
  async set(id: string, value: SettingValue, record = true) {
    if (id === 'appearance.documentPaperColor') value = normalizeDocumentPaperColor(value) ?? value;
    if (id === 'translation.selectionShortcut') value = normalizeSelectionShortcut(value) ?? value;
    this.validate(id, value); if (record && this.get(id) !== value) { this.history.push({ id, value: this.get(id) }); if (this.history.length > 100) this.history.shift(); } this.values[id] = value; this.revision++;
    const snapshot = this.snapshot();
    this.writing = this.writing.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temporary = this.path + '.' + randomUUID() + '.tmp';
      await writeFile(temporary, JSON.stringify(snapshot, null, 2)); await rename(temporary, this.path);
    });
    await this.writing; return snapshot;
  }
}
