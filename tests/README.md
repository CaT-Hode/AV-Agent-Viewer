# 测试与证据

[suite.json](suite.json)是唯一清单，总预算 50：常规 41、Electron 用户流程 6、真实 Kit 独立流程 3。内部断言不额外计项；scripts/test.mjs 拒绝未登记、嵌套、动态、禁用和超额测试。不得删除失败断言或弱化范围满足预算。

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run test:desktop
npm.cmd run test:office
node scripts/test.mjs list
npm.cmd run docs:check
```

## 常驻责任

| 入口 | 覆盖范围 |
| --- | --- |
| core.test.ts | 版本、幂等、草稿、轻量选区、逆操作、保存冲突、迁移、blob/GC、队列、容量准入及文件资源流程 |
| office-editing.test.ts | 格式能力、公式、未修改内容和保存重开 |
| native-office-mapped-shape-style.test.ts | 样式预检、失败回滚、目标和撤销；Python 模拟 |
| translation-selection.test.ts | 冻结来源、任务隔离、取消和超时 |
| home-search.e2e.ts | 新标签搜索、异步导航和设置 |
| reader-interaction.e2e.ts | Markdown 三模式、真实选区、快速 Undo、偏好、图片/媒体、公式图表、导出及设置 |
| embedded-office.e2e.ts | Word/Excel/PPT 原生输入、属性、遮挡拒绝、保存重开；独立弹窗流程 |
| office-export.integration.ts | 真实 Kit 三格式导出、撤销重做及源文件保护 |

桌面流程使用本轮 dist、独立端口、TEMP profile 和样本副本，检查真实保存及 fresh bytes 重开。test:office 同时执行已登记的 Office 常规子集，不重复增加清单项。进程须正常退出，renderer errors 必须为空。

## 本轮补强

Core 扩展大正文编码/保存/撤销、回执配额执行前拒绝、旧超额恢复、固定快照和严格持久化断言；已有 Markdown 选区用例增加表格 separator 与代码缩进回归。临时 fragment oracle 60,167 例发现的 14 处上游增量差异全部修复，未引入非 fresh 差异；内联边界 16 例核对同段转义/实体、标点、嵌套强调、上下标和代码。

本轮常规41/41、Electron6/6、真实Kit3/3通过。Reader覆盖嵌套任务、内联语法、音视频播放/Range、三种图表SVG、HTML/PDF/连续PNG及Pandoc五格式图片往返；最终errors与consoleErrors均为空。TEMP证据Reader OtgLce、Office K7UW15、弹窗wKbl6j、Home pLriDI、Kit YJIZCY。独立探针6j3T0w验证文件树dirty拒绝、改名/移动/回收/撤销、搜索、图片粘贴/拖入及显式上传恰一次。

安装版0.2.0探针518dnv通过实际启动、编辑保存、Pandoc转换及触发后台Worker后的Office画布，正常退出且errors为空。383个编译产物哈希、33742个引擎文件清单及8个安装关键文件已核对；原profile的243个文件哈希全部不变。

自动 composition 不证明 Windows 系统拼音输入法；本轮锁屏停止的真实 IME 探针未通过验收。Python 模拟不证明实际 UNO 行为；Kit 流程只证明其样本和操作，不能代表完全等同 Typora、复杂文件保真或 P95 达标。

性能按[方案](../docs/performance/README.md)单独采集。截图、轨迹和失败日志留 TEMP；文档由 docs:check 约束完整 Unicode 字符≤2000、每模块≤2篇并检查链接。
