/** Public actions route file/window lifecycles through the application owner. */
const managed = new Set(['.uno:Open', '.uno:OpenUrl', '.uno:NewDoc', '.uno:NewWindow', '.uno:CloseDoc', '.uno:Quit', '.uno:Save', '.uno:SaveAs', '.uno:SaveACopy', '.uno:SaveAll', '.uno:Reload', '.uno:ExportTo', '.uno:ExportToPDF', '.uno:ExportDirectToPDF']);
const chrome = new Set(['.uno:Sidebar', '.uno:LeftPaneImpress', '.uno:LeftPaneDraw', '.uno:StatusBarVisible', '.uno:MenuBar', '.uno:ToolbarMode']);
const scripts = new Set(['.uno:Macro', '.uno:RunMacro', '.uno:MacroDialog', '.uno:ScriptOrganizer', '.uno:Execute', '.uno:ExecuteScript']);
export function nativeOfficeCommandPolicy(command: string): { blocked: boolean; reason?: string } {
  if (!/^\.uno:[A-Za-z0-9_]+$/.test(command)) return { blocked: true, reason: '仅支持引擎目录中的原生Office命令。' };
  if (command === '.uno:TransformDocumentStructure') return { blocked: true, reason: '结构化编辑仅通过绑定真实目标的类型化事务提供' };
  if (managed.has(command)) return { blocked: true, reason: command.includes('Export') ? '请使用应用的导出副本功能。' : '此文件或窗口操作由AgentViewer管理，请使用应用对应入口。' };
  if (chrome.has(command) || command.startsWith('.uno:AvailableToolbars') || command.startsWith('.uno:ToolbarVisible')) return { blocked: true, reason: '原生界面布局由AgentViewer工具区管理。' };
  if (scripts.has(command)) return { blocked: true, reason: '原始脚本与宏执行未向文档控制接口开放。' };
  return { blocked: false };
}
