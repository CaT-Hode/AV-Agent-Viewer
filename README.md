# AgentViewer

<img src="apps/desktop/src/renderer/assets/agentviewer-logo.svg" alt="AgentViewer 标志" width="170" />

面向人类与 agent 共同使用的桌面文档工作台。文件和网页使用统一标签；阅读位置、选中片段、未保存内容、修改版本和保存回执通过同一套接口向 harness 提供。

当前为 **0.1.0 持续实现版本**：包含 Electron 桌面应用、格式编辑器、原生网页输入、HTTP/CLI/MCP 与 Codex 插件开发目录。2026-10-10 又加入独立设置窗口、文档独立译文和网页原地翻译。完整交付仍按[功能需求基线](docs/AgentViewer-功能需求与项目结构设计.md)验收；[实施状态与升级路线](docs/实施状态与升级路线.md)区分已验证能力与尚需引擎的项目。

![AgentViewer 工作台](docs/design/workbench-implemented.png)

## 启动

需要 Node.js 24 及 npm：

```powershell
npm.cmd install
npm.cmd run dev
```

使用构建产物：

```powershell
npm.cmd run build
npm.cmd start
```

`dev` 同时启动 Vite 和 Electron；`start` 使用构建后的桌面应用。`dev:web` 是界面开发预览，原生网页输入和多窗口需要桌面模式。首次启动会生成五种格式的示例文件和一个本地交互测试网页。Windows x64 可执行 `npm.cmd run package:portable` 得到包含离线引擎的 `release/win-unpacked` 目录包；随后运行 `npm.cmd run install:local`，复制到 `%LOCALAPPDATA%\Programs\AgentViewer` 并建立开始菜单的 **AgentViewer** 快捷方式。更新已安装版本前需关闭应用；用户数据保存在独立目录。

数据默认位于 `%APPDATA%\AgentViewer`，HTTP 仅监听 `127.0.0.1:3210`。新文件须选定保存位置；源文件被其他程序修改时会拒绝覆盖。复杂 Office 文件建议另存副本。

## 阅读界面、设置与翻译

左上角只保留静态标识；加号打开主页样式的新标签页，打开文件时直接使用该标签。最近文档、示例和生成的译文集中在主页文档库。阅读页两侧是悬浮圆角工具面板：左侧根据格式显示大纲、查找及可用工具，重复点击当前图标可收起面板；网页不显示左侧工具。右侧 AI 工具栏按需展开。文档顶部只有不占整行的玻璃胶囊，向下滚动自动收起；本地文档仅显示文件名，网页显示地址。各格式提供单行图标选区胶囊，PDF 高亮、下划线和批注可直接从选区操作；旋转、增页和 OCR 留在左侧格式工具。设置中的“文档阅读背景”提供暖纸、晨雾、极光、暮光和纯色，不写入文档。`Ctrl+,` 打开独立、非模态的设置窗口；尚未接入的偏好会显示依赖原因并禁用控件。

文档选中文字后，可在右侧浮窗或抽屉查看译文、复制和固定卡片；这一过程不修改原文文件或撤销栈。全文翻译会冻结发起时的字节并在后台生成新的同格式文件，支持取消后从已完成片段继续。Markdown、HTML、DOCX、PPTX、XLSX 的基础结构译文已接入；Office 复杂样式、PPT 溢出及 Excel 扩展需要人工验收。PDF 全文翻译使用内置 [BabelDOC](https://github.com/funstory-ai/BabelDOC) 0.6.4 适配器与离线版面资源，已通过一页 PDF 的模型桥往返；复杂样本尚未验收。BabelDOC 采用 AGPL-3.0 许可证。

网页翻译只替换当前页面的文字节点，不提交或保存到站点。可显示原文，页面自身改动过的节点不会被旧恢复操作覆盖；动态新增文字可按设置继续翻译。翻译改变布局后，MCP 坐标输入必须携带新的 `layoutRevision`。

设置中的模型连接支持 OpenAI Responses、Chat Completions 兼容服务和 Anthropic Messages；可以给选区、全文、网页和问答分别指定连接，也可以选择本机 Codex Harness。密钥由 Electron `safeStorage` 加密写入本地配置，设置导出和读取接口不返回密钥。PDF 适配器通过短时本地桥接令牌调用模型，避免把实际服务密钥放入 BabelDOC 进程参数。

## 当前编辑范围

| 格式 | 已实现 | 限制 |
| --- | --- | --- |
| Markdown | CodeMirror 源码、GFM 预览、源码/预览分栏、范围修改与保存 | 数学/图示插件和稳定的源码/渲染映射待补 |
| DOCX | 段落阅读、文字编辑、标题样式、段落对齐、插入段落、保存 DOCX；可转入内置 LibreOffice 完整编辑 | 工作台内的 OOXML 编辑只覆盖常用段落工具；修改文字块可能合并混合字体样式 |
| PPTX | 按实际页序读取、文字对象编辑、位置与尺寸调整、保存 PPTX；可转入内置 LibreOffice 完整编辑 | 工作台预览为文字与近似位置；母版、图片、动画等对象在 LibreOffice 中处理 |
| XLSX | 单元格与公式、显式数字/布尔类型、字体/对齐/数字格式/填充、工作表增改名、保存 XLSX；可转入内置 LibreOffice 完整编辑 | 当前模型最多 1000 行/50 列；无公式计算引擎，复杂内容往返受 ExcelJS 限制 |
| PDF | 真实画布与文字层、中文文字增补、覆盖式高亮、页面旋转/新增、保存 | 高亮是写入页面的矩形；原生批注、表单、删除/重排未实现。增补坐标限未旋转、CropBox 原点为零的页面 |
| 网页 | Chromium 浏览、导航、多视图、截图、鼠标/键盘、顶层可见文字与选区 | DOM 元素引用、跨 frame 语义读取、下载管理和多 profile 设置待补 |
| HTML/网页副本 | 源码、净化预览、位置/选择、保存 HTML；可从真实网页建立副本 | 资源仍使用原链接；无完整离线资产包和结构富文本编辑器 |

`.doc/.ppt/.xls` 使用随应用提供的 LibreOffice 26.8.1 转换器：保留原件，转换后编辑并另存现代格式。三类旧格式的真实文件转换往返已通过。现代 Office 文件保存后可从左侧工具栏打开随应用内置的 LibreOffice 完整编辑窗口；在该窗口保存后，返回工作台使用“从磁盘重新载入”，有未保存修改时会拒绝重新载入。PDF 页面 OCR 使用内置 Tesseract.js 7.0.0 和中英文字库，结果单独显示。LibreOffice 尚未嵌入阅读视图，工作台内编辑范围以上表为准；EPUB 为后续适配器。

## 原生网页输入

网页由独立 `WebContentsView` 承载；`click/move/drag/scroll/press/type` 发送给实际 Chromium 页面，中文输入使用原生文本插入。

MCP 顺序：`workspace_list` 确认目标 → `reader_get_context` / `browser_capture` 读取视口 → `browser_input` → 核对回执。坐标为网页视口内的 **CSS 像素**；截图另有位图尺寸和 CSS 视口，不能直接使用位图像素作为输入坐标。

```json
{
  "viewId": "从 workspace_list 取得",
  "expectedNavigationId": "从 context.viewport.navigationId 取得",
  "expectedLayoutRevision": 0,
  "expectedViewport": { "width": 900, "height": 700, "scrollX": 0, "scrollY": 0 },
  "action": { "kind": "click", "x": 120, "y": 160, "button": "left" },
  "idempotencyKey": "每个新操作使用独立的唯一键"
}
```

`expectedViewport` 可选，基于截图操作时应提供。网页翻译后 `expectedLayoutRevision` 必填且应取最新值。导航、布局、尺寸或滚动变化会拒绝旧请求；同键同请求返回原回执。实时网页提交影响该站点；持久文档编辑使用“编辑副本”。Agent 鼠标会通过穿透输入的独立透明窗口显示轨迹与点击反馈。

## Harness、MCP 与插件

应用运行后，执行 `npm.cmd run mcp` 启动 stdio MCP，或让 MCP 客户端连接构建产物：

```json
{
  "mcpServers": {
    "agent_viewer": {
      "command": "node",
      "args": ["D:/CodexProj/AgentViewer/dist/mcp/index.mjs"]
    }
  }
}
```

插件开发包位于 [`plugins/agent-viewer`](plugins/agent-viewer)，包含 manifest、MCP 发现启动器及 reading/editing 两个 Skill。启动器根据本地运行发现信息查找产物；本轮未修改用户 Codex 插件配置，也未发布到插件市场。

MCP 支持枚举、打开、位置/选择、快照、正文/大纲/搜索、能力、准备/应用修改、保存/撤销、视图和网页操作。`reader_selection_tools` 与 `reader_selection_action` 开放与选区胶囊相同的工具；`document_annotations` 与 `document_remove_annotation` 管理独立批注。HTTP、MCP、CLI 共用 `dispatch` 与 `ViewerCore`，访问同一份打开的内容。

```powershell
npm.cmd run cli -- state
npm.cmd run cli -- context
```

右侧还有 Codex CLI 驱动入口：在连接设置启用后发送问题，使用 `codex app-server`、固定快照、流式结果和取消，复用已有登录配置。驱动创建独立线程，当前不能附着本条 Codex 桌面会话。实际模型回合和交互授权尚未验收；独立 MCP 连接不依赖此驱动。

## 配置与验证

| 环境变量 | 用途 |
| --- | --- |
| `AGENTVIEWER_DATA_DIR` | 数据目录，测试使用独立临时目录 |
| `AGENTVIEWER_PORT` | HTTP 端口，默认 3210 |
| `AGENTVIEWER_CONNECTION_FILE` | SDK/MCP 指定运行发现文件 |
| `AGENTVIEWER_CODEX` | Codex 原生可执行文件 |
| `AGENTVIEWER_LIBREOFFICE` | 可选：覆盖内置 LibreOffice `soffice` 路径 |
| `AGENTVIEWER_PDF_FONT` | 可嵌入字体；Windows 默认尝试黑体 |
| `AGENTVIEWER_BABELDOC` | 可选：覆盖内置 BabelDOC CLI 路径 |

运行发现文件包含本地凭据，不应复制到报告或提交仓库。外部网页禁止访问工作台 API；bearer 接口不能伪造人类上下文或窗口布局。细分文档授权和凭据撤销仍需后续实现。

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run test:desktop
npm.cmd run test:ui
npm.cmd run engines:verify
npm.cmd run test:engines
```

桌面测试启动独立 Electron 实例，在临时样本上操作并生成截图，结果目录由测试输出提供。运行前关闭占用 3210 的 AgentViewer。依赖版本由 `package-lock.json` 固定。

- [接口与扩展](docs/接口与扩展.md)：格式、浏览器、存储和 harness 升级接口。
- [扩展架构 ADR](docs/adr/0001-扩展架构与首轮引擎.md)：首轮引擎与持久化决策。
- [实施状态与升级路线](docs/实施状态与升级路线.md)：功能范围、验收证据和下一轮计划。
- [架构调研与 MCP 设计](docs/AgentViewer-架构调研与MCP设计.md)：选型依据。
