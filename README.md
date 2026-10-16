# AgentViewer

面向 Windows 横版桌面的文档工作台。用户与 Agent 共用文档、视图、选区和版本化修改；Electron、HTTP、CLI、MCP 连接同一核心。

## 运行

需要 Node.js 24、npm。构建 Windows Office 适配器还需要 Visual Studio Build Tools 的 MSVC x64 工具链。

```powershell
npm.cmd ci
npm.cmd run dev
# 或构建后运行
npm.cmd run build
npm.cmd start
```

`dev:web` 供浏览器预览；真实 Office、网页输入、多窗口和系统输入法需要 Electron 验收。外部引擎准备见[开发与发布](docs/development/README.md)。

## 当前实现

| 内容 | 能力 |
| --- | --- |
| Markdown | 实时/源码/分栏编辑、可视表格、公式图表、文件工作区、资源批处理、偏好与导入导出 |
| DOCX / XLSX / PPTX | 内嵌 LibreOffice 编辑、选区属性、查询、保存、撤销及独立导出 |
| HTML / 网页 | 本地净化预览、Chromium 浏览、坐标输入、阅读副本与翻译 |
| PDF | 阅读、OCR、增补文字、覆盖式标记、旋转与增页 |
| AI | 按明确来源分析、选区翻译、独立全文译文与任务协作 |

本轮实现与实测范围见[测试记录](tests/README.md)，格式保真以保存重开和导出产物为准。Markdown 按[官方 Windows 功能矩阵](docs/editing/refactor.md)逐项对标 Typora；复杂语法、主题兼容及可选转换仍需补齐验收。PDF 标记不会删除原文。

## 接入与数据

应用运行后执行 `npm.cmd run mcp`；MCP 也可使用 `node dist/mcp/index.mjs`。CLI 示例：`npm.cmd run cli -- context`。插件位于 [plugins/agent-viewer](plugins/agent-viewer)。

数据默认在 `%APPDATA%\AgentViewer`，服务默认监听 `127.0.0.1:3210`；可用 `AGENTVIEWER_DATA_DIR`、`AGENTVIEWER_PORT` 覆盖。恢复采用校验过的内容 blob 与小型清单，旧格式迁移保留备份。源文件冲突拒绝覆盖；新文档须指定保存路径。

## 文档

- [架构](docs/architecture.md) · [审查与风险](docs/review.md)
- [编辑能力](docs/editing/README.md) · [Typora 对标与重构](docs/editing/refactor.md)
- [Office](docs/office/README.md) · [阅读界面](docs/reader/README.md) · [AI](docs/automation/README.md)
- [性能](docs/performance/README.md) · [开发](docs/development/README.md) · [许可](docs/development/dependencies.md) · [测试](tests/README.md)

每篇完整 Unicode 字符不超过 2000，每模块最多两篇；`npm.cmd run docs:check` 校验清单、长度和链接。历史记录由 Git 保留。
