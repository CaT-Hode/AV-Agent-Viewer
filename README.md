# AgentViewer

面向 Windows 横版桌面的文档工作台。用户与 Agent 共用真实文档，分别保留视图、位置与选区；编辑核对来源版本，保存明确确认磁盘结果。

## 能力

| 内容 | 工作台能力 |
| --- | --- |
| Markdown | 实时/源码/分栏、表格、公式图表、媒体、文件树、资源与转换 |
| Word / Excel / PPT | 内嵌 Writer / Calc / Impress，文字、单元格、对象、样式、撤销与导出 |
| HTML | 源码编辑、净化预览与源范围定位 |
| PDF | 页面阅读、文字层、OCR、页面处理与标记；覆盖标记不是安全涂黑 |
| 网页 | Chromium 浏览、正文提取、阅读副本与翻译 |
| AI | 冻结来源、阅读分析、译文、任务与独立批注 |

格式兼容以实际文件的读取、保存重开和导出为准。Markdown 按 [Typora 能力矩阵](docs/editing/refactor.md)对标；功能入口存在不代表任意复杂文件完全保真。

## 运行

需要 Node.js 24、npm。Windows Office 适配器构建需要 MSVC x64 工具链。

```powershell
npm.cmd ci
npm.cmd run dev
npm.cmd run build
npm.cmd start
```

`dev:web` 仅预览网页界面。外部引擎与本机替换见[开发与发行](docs/development/README.md)。数据默认位于 `%APPDATA%\AgentViewer`，与安装目录分离；本地服务默认 `127.0.0.1:3210`。

## Agent 接入

应用运行后执行 `npm.cmd run mcp`，打包后也可启动 `node dist/mcp/index.mjs`。插件位于 [plugins/agent-viewer](plugins/agent-viewer)。

初始工具只有 `av_workspace`、`av_tools`。先取得文档 ref，再按 Markdown、HTML、Word、Excel、PPT、PDF 或网页披露工具；高级包按需加载。工具使用扁平参数，ref 封装内部身份，req 标识同一次逻辑修改。默认修改后读回，保存单独调用。

每格式基础与所有高级说明累计按参考 tokenizer 限制在 4500 tokens 内，为宿主预留 500；共享工具另计。`npm.cmd run mcp:budget` 是默认构建门禁。该参考测量尚未认证 Codex 实际工具包装与当前模型 tokenizer，详见 [MCP 协议](docs/automation/mcp.md)。旧公开工具、HTTP 方法和 SDK 别名不保留兼容入口。

## 文档

- [架构](docs/architecture.md) · [代码审查](docs/review.md) · [编辑](docs/editing/README.md)
- [Office](docs/office/README.md) · [阅读界面](docs/reader/README.md) · [AI 与连接](docs/automation/README.md)
- [性能](docs/performance/README.md) · [开发](docs/development/README.md) · [许可](docs/development/dependencies.md) · [验收](docs/verification.md)

每篇完整 Unicode 字符≤2000，每功能模块最多两篇；`npm.cmd run docs:check` 校验清单、长度与本地链接。历史由 Git 保存。
