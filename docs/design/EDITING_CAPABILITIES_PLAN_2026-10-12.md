# AgentViewer 全面编辑能力规划

日期：2026-10-12。状态：完整编辑规划保留；本轮已实现的局部 Office 增量见 2.1，完整引擎与 B0–B2 仍按各自门槛验收。

本文基于当前仓库源码审计，补充[功能需求基线](../AgentViewer-功能需求与项目结构设计.md)。重点为 Markdown 对标 Typora、DOCX/XLSX/PPTX 对标 LibreOffice Writer/Calc/Impress，以及完整 PDF 编辑。原有“全部必要引擎与工具随应用内置”“多标签”“实时阅读位置与选区”“所有编辑能力开放给 harness”的要求继续有效。

范围是 Windows 横版桌面。引擎安装、字体、语言数据、转换器和必要运行时由发行包提供；正常本地编辑不要求用户安装 Office、Docker、WSL、Java 或 Python。模型服务配置与本地编辑引擎分别管理。

## 1. 目标、完整性与实施级别

目标是形成可读、可选、可编辑、可撤销、可保存、可重新打开的完整文档会话。工具只有在引擎和当前文件确实支持时才开放。

| 级别 | 含义 | 交付规则 |
| --- | --- | --- |
| B0：基础完整编辑 | 日常写作、表格、演示及 PDF 编辑的必要能力 | 必须全部形成 UI → 引擎 → 保存 → 重开及 harness 闭环；不能用外部手工编辑充当完成 |
| B1：对标主要工作流 | 样式、审阅、复杂对象、数据分析、全文对象编辑等 | 达到 Typora 与 LibreOffice 对应主要工作流；复杂格式分别报告兼容范围 |
| B2：专业完整工具 | 邮件合并、求解、复杂动画、证书签名、结构标签和印前等 | 纳入完整路线；逐项发布明确能力，不用一个“高级编辑”开关笼统宣称支持 |
| D0：引擎验证 | 内嵌、未保存状态、定位、字体与对象写回的技术验证 | 未通过的路线不得作为已可交付能力；失败时按预定备选切换，不删除格式需求 |

“功能对标”采用三种证据分别验收：功能可执行、文件往返结果、显示与定位结果。支持读取某种格式、能够生成文件、已经安装某个引擎，均不单独证明完整编辑已接入。

## 2. 当前实现的实际缺口

以下保留规划初始的源码审计基线；本轮新增能力和证据见 2.1。

| 模块 | 当前可用能力 | 阻碍完整编辑的缺口 | 现有入口 |
| --- | --- | --- | --- |
| Markdown | CodeMirror 源码、GFM 阅读/分栏、范围替换、基础选区格式 | 阅读预览不可编辑；无稳定源码映射、结构表格/媒体、数学/图表及统一历史 | `TextEditor.tsx`、`DocumentPane.tsx`、`TextAdapter` |
| Word | 段落文字、少量标题/对齐、插入段落、简单 run 格式 | 缺真实分页和富文本模型；表格、图像、页眉页脚、修订、批注等未接入 | `OfficeTools.tsx`、`OfficeXmlAdapter` |
| PPT | 文字对象和近似坐标、文字/尺寸调整 | 无完整形状、图片、母版、主题、备注、页序、动画和演示编辑 | `DocumentPane.tsx`、`OfficeXmlAdapter` |
| Excel | 单格值/公式字符串、少量格式、工作表新增/改名 | 无计算引擎和范围模型；最多 1000 行/50 列投影；复杂扩展保存存在风险 | `SheetAdapter`、`OfficeTools.tsx` |
| LibreOffice | 已随应用提供；旧格式转换、独立完整编辑窗口 | 只是启动外部窗口，保存后手工重新载入；没有实时共享模型、UNO 会话或工作台内嵌 | `main/index.ts` 的 `office-open-full-editor`、`office-gateway/conversion.ts` |
| PDF | PDF.js 画布/文字层、文字增补、覆盖标记、旋转/增页 | 标记是页面图形，不是原生批注；没有表单、原文/图片编辑、页面组织、脱敏或签名 | `PdfReader.tsx`、`PdfAdapter` |
| 全格式编辑 | prepare/commit、版本检查、幂等回执、磁盘冲突检查 | 当前单操作；撤销恢复整份最后版本，无 redo、目标条件逆操作和完整引擎共同历史 | `document-core`、`contracts`、`selection-tools` |
| HTML/网页副本 | 源码、净化预览、保存副本 | 无完整结构编辑、资源归档及离线资产包 | `HtmlPreview.tsx`、`TextAdapter` |

需要先整改的具体问题：

1. `App.tsx` 的 `editText()` 当前每次输入提交整篇 `text.replace`；`TextEditor.tsx` 外部更新也替换整篇。改为增量变更，防止扩大冲突、重置选区或污染历史。
2. Markdown 大纲用行正则，可能识别代码围栏里的伪标题、漏 Setext 标题；渲染定位仅查询 H1–H4，和 H1–H6 抽取不一致。改为同一 AST 与稳定块定位。
3. Word/PPT 在 `blur` 时提交整块文字，Excel 在 `blur` 时提交单格。保存、发问快照、导出、翻译开始前必须处理尚未失焦的输入与 IME 状态，不能丢失正在输入的内容。
4. `undo()` 目前拒绝存在后续编辑的整份恢复；这是保守保护，不能标为已经支持目标级撤销。
5. PDF 逐页串行全渲染，应改为可见页优先和分页虚拟化；原生批注、表单、对象交互层必须显式接入。
6. PDF 原有高亮与下划线已写成页面内容，不能自动可靠识别成可编辑批注。旧文件保留其外观，新标记使用原生批注对象；不猜测删除历史图形。

主要代码证据：

- [源码编辑器](../../apps/desktop/src/renderer/components/TextEditor.tsx)、[格式视图](../../apps/desktop/src/renderer/components/DocumentPane.tsx)、[编辑提交与大纲](../../apps/desktop/src/renderer/App.tsx)。
- [当前编辑 schema](../../packages/contracts/src/index.ts)、[预留 Office 会话/ViewBridge](../../packages/contracts/src/extensions.ts)、[格式适配器](../../packages/format-adapters/src/index.ts)。
- [核心事务与保存](../../packages/document-core/src/index.ts)、[选区工具](../../packages/selection-tools/src/index.ts)、[统一 dispatch](../../packages/sdk/src/dispatch.ts)、[MCP 工具](../../apps/local-service/src/mcp.ts)。

### 2.1 2026-10-12 已实现的 Office 增量

现有 `FormatAdapter → prepare/commit → save` 路径已扩展为下列真实文件操作；完整 Writer/Calc/Impress 会话、原生分页与共同历史继续保留在 S2–S4。

| 格式 | 本轮功能与 operation |
| --- | --- |
| Word | `office.setTextStyle`：选区字体、字号、颜色、粗斜体、下划线、删除线、背景色；`word.setParagraphFormat`：间距、行距、缩进；`word.deleteParagraph`、`word.insertTable`、`word.setPageLayout`：段落删除、真实表格、分节方向与边距 |
| PPT | `slides.addSlide/deleteSlide/duplicateSlide/moveSlide`；`slides.addTextShape/deleteShape/setShapeBounds/setShapeStyle`：文字对象、字体、填充、边框、旋转与对齐；`slides.setBackground/setNotes`：背景与独立备注 |
| Excel | `sheets.setCellFormat/setRangeFormat`：字体、颜色、边框、换行与数字格式；`sheets.setRangeValues`：单事务 TSV 粘贴；`mergeCells/unmergeCells`、`insertRows/deleteRows/insertColumns/deleteColumns`、`setColumnWidth/setRowHeight`、`deleteWorksheet/setFreeze/setAutoFilter/sortRange` |

原有命令继续兼容。精确字段、范围与单位以 [editOperationSchema](../../packages/contracts/src/index.ts) 为准：Office 字体/段落/边距使用 pt，PPT bounds 使用幻灯片归一化坐标，sheet 行列从 1 开始，slide 移动下标从 0 开始。`document_capabilities` 返回实际命令；MCP `document_plan_patch → document_apply_patch` 共用该 schema，保存与条件撤销沿用 `document_save/document_undo`。Word/PPT 选区加入删除线，Excel 选区加入下划线与删除线。

实现位于 [OOXML 适配器](../../packages/format-adapters/src/ooxml-editing.ts)、[Excel 适配器](../../packages/format-adapters/src/sheet-editing.ts)；读取模型新增 rich runs、表格单元格归属、页面设置、对象样式/备注，以及 merges、freeze、filter、行高/列宽，供对应格式 UI 使用。

验证：`tsc --noEmit` 通过；[Office 专项测试](../../tests/office-editing.test.ts)与既有 core 测试联合 23 项通过。专项逐项检查提交、条件撤销的源字节、再次提交、保存及新 Core 从文件重开，并验证未涉及的 ZIP 部件、非法目标和危险结构拒绝。内置 LibreOffice 使用独立临时 profile 成功将最终 DOCX/PPTX/XLSX 解析并导出 PDF；Word 横向页为 841.89×595.30 pt，PPT/Excel 均生成两页。此证据覆盖后端往返与外部解析；本轮新 UI 的完整验收另记。

当前边界：Word 使用连续纸张流，页面参数已持久化，真实分页、页眉页脚和修订仍待完整引擎；Excel 数据变更使公式缓存失效，需要完整引擎重算，结构调整仅处理常规 A1 引用，复杂包/数组/三维/结构化公式、受影响的合并及公式区排序明确拒绝；非主格有内容时合并拒绝，最后幻灯片/工作表及被引用工作表删除拒绝。PPT 删除保留孤立部件，不能用于安全擦除。撤销仍要求该事务后没有其他编辑，目标条件逆操作继续按 3.3 实施。

## 3. 共同编辑底座

### 3.1 一个文档只有一个权威编辑会话

目前 `DocumentModel + bytes` 适合基础补丁，但不能作为完整 Office/PDF 的全部状态。新增通用 `EditorDocumentSession`：

| 模块 | 职责 |
| --- | --- |
| `EditorSessionManager` | 按 documentId 管理唯一权威会话、引擎生命周期、多个 view/controller 和 engineEpoch |
| `CommandRegistry` | 统一命令 ID、schema、状态、能力、效果、实现处理器、菜单/快捷键贡献 |
| `TransactionCoordinator` | 增量/批次提交、版本前置条件、目标校验、幂等、输入同步屏障、回执 |
| `AnchorService` | 源码/结构/页/对象/范围锚点、映射、阅读恢复、引用与选区快照 |
| `HistoryService / UndoProvider` | 原生历史桥、用户 undo/redo、agent 条件逆操作、冲突检查 |
| `AssetService / ArtifactStore` | 图片/附件/字体资源、冻结字节、生成产物、版本及引用计数 |
| `SaveCoordinator` | 引擎导出、源摘要冲突、临时产物检查、原子落盘、另存和恢复点 |
| `FidelityReport` | 字体替换、对象不支持、公式错误、PPT/PDF 溢出、导出损失和未处理范围 |

Markdown 的权威状态是保留原始语法的源码文档；Office 是 LibreOffice 实时模型；PDF 是唯一 `PdfDocumentSession`。`DocumentModel` 改为可分页的读取投影，不再要求每次同步整份模型。

同一 Office/PDF 会话不能同时由 OOXML/ExcelJS/pdf-lib 与完整引擎分别修改。切换后端需先同步输入、冻结版本并重新打开；不得在未完成事务中热切换 writer。

### 3.2 编辑、快照和保存的一致性

```text
用户输入 / harness 命令
        ↓
输入同步屏障 → 目标解析 → 能力与版本检查
        ↓
同一引擎会话执行事务 → 原生编辑事件回传
        ↓
内容修订 + 目标映射 + 历史回执 + 视图失效/更新
        ↓
导出固定版本 → 校验临时文件 → 检查磁盘摘要 → 落盘
```

- 普通用户输入在本地即时显示，连续输入合理合并为历史项；粘贴表格、插图、批量格式和 AI 修改分别形成事务。
- `flushPendingInput()` 先处理已完成的输入。IME 仍在组合输入时等待明确结束；超时返回可解释的待同步状态，不强行中断中文输入。
- `read/snapshot/prepare/save/export/translation-start` 使用引擎已确认修订。状态尚未同步时等待有上限的屏障；未确认不能冒充当前全文。
- 保存版本 R 后发生新编辑 R+1，仍保留 dirty；回执显示实际保存的 R。不能因异步导出完成而把更新后的文档标成已保存。
- 长任务使用固定版本的独立 artifact。一致性屏障覆盖输入确认、版本冻结和必要的引擎导出，不覆盖后续翻译/索引全过程。优先使用可验证的克隆、检查点或 copy-on-write 缩短屏障；必须串行序列化的引擎在实际导出期间排队写入并显示等待/进度。D0 实测阻塞时长，不能为缩短屏障生成混合版本。
- 断线恢复查询事务/任务状态再继续；原生引擎的非持久提交存在崩溃窗口时返回 `unknown/partial`，不宣称跨进程 exactly-once。

### 3.3 撤销与并发

用户 Ctrl+Z/Ctrl+Y 进入当前文档权威引擎的共同历史，覆盖人类和 agent 在该会话的动作。工具栏只保留当前文档会话的一组撤销/重做入口，不实现跨标签撤销。

agent 的“撤销我的修改”采用条件逆操作：保存目标前后值、稳定引用和映射；其他目标的后续修改允许保留；同一目标已变化则拒绝或返回冲突预览。对没有可靠逆操作的复杂命令，只提供仍处于历史顶端的原生撤销，不能伪装任意选择性撤销。逆操作本身成为新事务。

批次命令明确声明 `atomic` 或 `compensable`。引擎原生 undo 分组不是数据库事务锁；失败时验证回滚结果。无法完整回滚必须报告实际已修改目标及恢复入口，不能返回成功或整份覆盖用户后续内容。

## 4. 工具与界面组织

保留现有静态 logo、主页式新标签、连续正文背景、悬浮两侧面板和自动隐藏的玻璃导航胶囊。新增能力不恢复整行遮罩，不在文档导航显示文件路径。

| 入口 | 负责的功能 | 约束 |
| --- | --- | --- |
| 顶部胶囊 | 编辑模式、全局 undo/redo、保存、少量当前格式操作 | 自动隐藏；复杂格式工具不铺满顶栏 |
| 选区胶囊 | 选中文字/单元格/对象的最常用操作 | 单行图标、统一悬停提示；超出收进“更多”；保存选区快照，不因点击工具丢失选择 |
| 对象浮窗 | 图片、表格、图形、PDF 对象的属性与变换 | 按对象类型变化；不把文字格式工具显示给图片 |
| 左侧格式面板 | 大纲/页/工作表/对象导航、样式、页面布局、范围/对象高级属性 | 点击当前图标收起；图标各不相同；网页不加入额外工具栏 |
| 批注与审阅面板 | 原生批注和应用侧摘录、修订列表及过滤 | 同一种列表只有一个可见入口；“添加批注”和“查看列表”是不同动作 |
| 命令面板/更多菜单 | 完整功能目录、键盘操作、低频专业命令 | 与 UI/harness 共用命令状态；不另写业务逻辑 |
| 设置窗口 | 偏好、默认样式、工具显示/顺序、引擎诊断、快捷键 | 不把一次性的编辑操作做成设置开关 |

可见入口收敛规则：常用选区动作以胶囊为主，高级设置通过该动作的更多项进入；左栏不再次列出一排相同高亮/加粗按钮。上下文菜单和快捷键调用同一命令，不建立不同版本的逻辑。

所有命令都有 enabled/disabled 状态和禁用原因；格式切换类命令另外提供 on/off/mixed，插入/导出动作不伪造 toggle 状态。可用性不能仅通过“是否有选中文字”判断；混合字体、跨多个单元格、不可编辑 PDF 字形和受保护区域分别处理。

## 5. Markdown：对标 Typora

Typora 的官方参考覆盖实时 Markdown 呈现、结构内容、图形表格操作与多种扩展；图片与导出也各有专门工作流。以下矩阵是 AgentViewer 的产品需求，不以调用 Typora 为实现方式。[Typora Markdown Reference](https://support.typora.io/Markdown-Reference/)、[Images](https://support.typora.io/Images/)、[Export](https://support.typora.io/Export/)

### 5.1 功能矩阵

| ID | 级别 | 需要实现的具体工具 | 实现方法与持久化 |
| --- | --- | --- | --- |
| MD-01 | B0 | 阅读、实时可视编辑、源码、分栏；切换保留光标/选区/位置 | CodeMirror 源码 + Milkdown/ProseMirror 编辑投影；共用同一源码会话 |
| MD-02 | B0 | 粗体、斜体、删除线、行内代码、链接、移除格式 | 语义 toggleMark；识别混合状态、嵌套定界符和反引号长度，避免重复包裹 |
| MD-03 | B0 | H1–H6、正文、引用、分隔线、软/硬换行 | AST 块命令；支持 ATX/Setext，未修改语法风格保留 |
| MD-04 | B0 | 有序/无序/任务列表、缩进/反缩进、续写、任务勾选 | 维护父子列表结构；勾选写回 `[x]`；粘贴和 Enter/Tab 行为一致 |
| MD-05 | B0 | 表格网格插入、行列增删/移动、对齐、Tab 导航、TSV 粘贴 | GFM 表格结构命令；转义竖线与单元格内容；不假造 GFM 合并单元格能力 |
| MD-06 | B0 | 代码块语言、缩进、复制、折叠、独立代码编辑 | 代码块编辑岛；内容按原始文本处理，不执行其中脚本 |
| MD-07 | B0 | 链接插入/编辑、内联/引用式、文内锚点、定义回跳 | 独立保存 label/destination/title/refId；不擅自改变链接写法 |
| MD-08 | B0 | 本地插图、粘贴/拖入图片、alt/title、相对路径 | AssetService 复制资源 + 插入引用为一个可恢复事务 |
| MD-09 | B0 | 查找替换、全词/大小写/正则、选区范围、命中跳转 | 源码和可视视图共用搜索 ID；全部替换为批次事务 |
| MD-10 | B0 | 精确大纲、当前位置、源码↔预览定位、联动滚动 | AST/sourceRange/blockId 统一；重复文字不再靠 indexOf 猜位置 |
| MD-11 | B0 | undo/redo、块删除/复制/移动、章节提升/降低 | 移动标题章节包含其子内容；增量操作进入共同历史 |
| MD-12 | B1 | LaTeX 行内/块公式、源码编辑、错误定位 | 内置 KaTeX 主选，复杂兼容需求由 MathJax 适配；原公式源码保留 |
| MD-13 | B1 | Mermaid 编辑、预览、错误定位、SVG/图片导出 | 本地依赖/字体；受控渲染；导出覆盖情况随 artifact 报告 |
| MD-14 | B1 | 脚注/YAML/[toc]/callout、高亮/上下标/emoji 方言 | 分方言启用；未知扩展以原始节点保留和源码编辑 |
| MD-15 | B1 | 表格转置、CSV/Markdown 复制、列宽视图；资源修复 | 转置/排序显式操作；不把视图列宽保存成标准 GFM 语法 |
| MD-16 | B1 | 拼写/个人词典、字数、专注/打字机模式、章节折叠 | 拼写数据内置；视图设置不改变文档内容 |
| MD-17 | B1 | Markdown 保真保存、独立 HTML/PDF、打印主题/页码/目录 | 本地渲染产物 + Electron 打印；临时浮层不进入输出 |
| MD-18 | B2 | DOCX/EPUB 等导入导出、模板、文献引用和批量转换 | Pandoc 作为后期独立转换器；产物独立身份，声明语法/样式差异 |
| MD-19 | B1 | 图片重命名/移动、断链检测、附件管理、资源去重 | 维护引用图；删除引用不自动删除其他文档共享资源 |
| MD-20 | B1 | 选择摘录、稳定引用、文档比较、AI 局部改写 | 和 AnchorService/HistoryService 共用来源版本；翻译仍生成独立结果 |

### 5.2 引擎选择与保真方案

保留 CodeMirror 6；可视编辑主候选为 Milkdown/Crepe，底层 ProseMirror。Milkdown 官方以 Markdown 编辑为目标，提供 ProseMirror/remark 扩展；但任何全文 Markdown serializer 都不能自然保证原始源码字节保持。Tiptap 的 Markdown 扩展官方目前标为 beta，可作底层替换候选；Vditor 可作模式交互原型，所有 CDN 资源需本地化。[Milkdown](https://github.com/Milkdown/milkdown)、[Transformer](https://milkdown.dev/docs/api/transformer)、[Tiptap Markdown](https://tiptap.dev/docs/editor/markdown)、[Vditor](https://github.com/Vanessa219/vditor)

`MarkdownDocument` 保留原始 bytes、rawText、编码/BOM、换行、方言、语法树、sourceRange 与稳定 blockId。可支持编码建立 byte↔UTF-16 映射；解码失败不能静默用替代字符覆盖原字节。编辑投影向它产生局部补丁：

1. 解析原始源码，保存原始片段与语法形式；显示模型不替代原始内容。
2. 将可视事务映射到源码，找出受影响的最小安全祖先块；只重新生成该块。
3. 列表/表格等结构变化必要时扩大至整个结构；同编码保存时复制未修改的原始字节片段，无内容修改直接沿用原始 bytes。编码转换作为显式操作，转换后不承诺原字节保持。
4. raw HTML、注释、未知语法和特殊扩展使用原始节点/源码编辑岛，不默默删除。
5. 解析范围扩展到语法上下文稳定边界，围栏/引用定义变更必要时重新解析全文；持久化仍只写回实际变更片段。重解析不触发未改源码重新序列化，并映射所有 view 的 caret/selection、批注与搜索锚点。
6. 模式切换、打开后立即保存或只修改视图样式不应造成 dirty。

源码偏移继续明确使用 UTF-16；用户感知字符边界需处理组合字形和 emoji。AST 位置、ProseMirror 位置和源码位置各有映射，不混用。统一锚点采用 `blockId + inlineOffset + sourceRange + revision + affinity`；节点 ID 通过事务映射维持，不能每次解析按行号重建。CommonMark 的语法规则包含代码围栏、引用定义、Setext 与复杂嵌套，不能用简单标题/链接正则承担结构编辑。[CommonMark 规范](https://spec.commonmark.org/0.31.2/)

若 D0 不能证明 Milkdown 局部写回与稳定映射，默认实时编辑改为 CodeMirror Decoration/Widget 的源码保真实时呈现；表格/公式使用编辑岛。Milkdown 保留受控模式，直到满足相同验收。该备选仍提供完整结构工具，不退回只有源码输入。

### 5.3 最小命令集合

```text
markdown.mark.toggle / clear
markdown.block.insert / transform / move / remove / duplicate
markdown.heading.setLevel / moveSection
markdown.list.setType / indent / toggleTask
markdown.table.insert / setCell / rows / columns / align / transpose
markdown.link.set / remove / resolve
markdown.asset.insert / relink / rename
markdown.code.setLanguage / replace
markdown.math.set / markdown.diagram.set
markdown.frontMatter.update / markdown.footnote.update
document.search / replace / compare / export
```

每个命令的输入是明确块/范围/资源身份；预览包含源码 diff 和渲染差异提示。UI 与 harness 不分别拼接字符串。

## 6. Office：完整引擎而非继续扩展简化 OOXML 页面

### 6.1 部署与集成主线

**主线：现有内置 LibreOffice + 新建 Windows 原生 Office Host + UNO 会话桥。** 对标 Writer/Calc/Impress 的主要能力直接进入完整引擎，工作台负责统一工具、标签、定位、事务、AI 和保存，不自建另一套分页/公式/母版内核。

1. 新建 C++ `office-host`，随应用提供 UNO SDK 构建产物、所需运行库；启动独立应用 profile 和本机受控进程。
2. Electron 为文档客户区提供 native host surface；通过 UNO Toolkit 的 system child window 与 XFrame 初始化创建文档 frame/controller，挂载完整模型。
3. 接入同一文档的多个 controller；host 完成 model/controller/frame 的 attach/connect/setComponent 接线。agent 使用保存的目标 view/controller 引用，不用 currentController 路由或 setCurrentController 切换全局焦点。
4. 主进程与 host 使用受控命名管道/本地 IPC；以 session token、实例身份和白名单命令校验。不对外暴露任意 UNO、宏、脚本或远程监听服务。
5. Office 原生编辑事件更新应用修订；读取、编辑、快照、撤销及导出进入同一会话。放弃“外部窗口保存后手工 reload”作为完整模式。
6. 简化 OOXML/ExcelJS 后端保留导入检测、测试和受限恢复用途；不和实时 Office 引擎并行写入。

这是一条**需要 D0 实证的工程主线**。官方 UNO 提供 system child factory 和 frame/model/controller 接口；这些接口不等于已有可直接装进 Electron 的 Windows SDK，也不能证明跨进程父窗口、DPI、输入法和浮层已经可用。禁止把 `SetParent` 现有 soffice 主窗口作为成功内嵌的证据。[XSystemChildFactory](https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1awt_1_1XSystemChildFactory.html)、[XFrame](https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1frame_1_1XFrame.html)、[XModel2](https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1frame_1_1XModel2.html)

| 路线 | 在本项目的角色 | 约束与选择 |
| --- | --- | --- |
| LibreOffice UNO 原生子视图 | 本机完整编辑主线 | D0 验证内嵌、多个 controller、真实视口/选择、共同历史和未保存导出；官方接口可行性不代替实测 |
| 内置 LibreOffice 受管独立窗口 + 同一 UNO bridge | 原生子视图验证期间的过渡 | 能补全引擎和 harness，但尚不满足工作台内多标签；不得作为最终内嵌验收 |
| ONLYOFFICE DesktopEditors 自建 host/插件桥 | Windows 完整离线引擎备用 | 有本机编辑及插件能力；没有直接可承诺的 Electron 嵌入接口，需单独 D0/自定义构建 |
| ONLYOFFICE Docs / Collabora Online | 后续可选服务型适配器 | 不作为本机默认依赖；服务器、平台与 API/许可证/配额分别处理 |

此前需求将 ONLYOFFICE Docs 服务列为 Office 主选；本补充按照“全部内置、本机运行”的约束，将当前实施优先级改为 LibreOffice UNO。服务适配器仍保留，不擅自删掉替换能力。若 UNO 内嵌 D0 失败，先交付受管实时窗口作为过渡，立即启动 DesktopEditors host 验证；最终默认内嵌必须有一条通过相同门槛的路线。

ONLYOFFICE Docs 的插件和 Office API 不等于任意外部自动化权限；其 Automation API 官方另有版本条件，不能把付费能力列为免费基线。[DesktopEditors](https://github.com/ONLYOFFICE/DesktopEditors)、[Automation API](https://api.onlyoffice.com/docs/docs-api/usage-api/automation-api/)、[Collabora SDK](https://sdk.collaboraonline.com/docs/intro.html)

### 6.2 Word / Writer 功能矩阵

| ID | 级别 | 功能组与具体工具 | UNO/引擎实现方向 |
| --- | --- | --- | --- |
| WR-01 | B0 | 真实分页、页码、连续/单页/双页、缩放、打印布局 | Writer controller/layout；实际页结构与视口采集 |
| WR-02 | B0 | 字体/字号、粗斜体、下划线/删除线、字色/高亮、上下标、清除格式 | TextRange/CharacterProperties；混合状态和局部 run 保持 |
| WR-03 | B0 | 对齐、行距/段距、首行/悬挂缩进、制表位、边框/底色 | ParagraphProperties；样式与直接格式分别显示 |
| WR-04 | B0 | 标题/正文样式、样式选择与修改、格式刷 | StyleFamilies/段落与字符样式；保留继承关系 |
| WR-05 | B0 | 有序/无序/多级列表、编号续接/重启、嵌套缩进 | NumberingRules；不把编号当普通文本 |
| WR-06 | B0 | 表格插入、行列增删、合并/拆分、宽高、边框、对齐 | TextTable/表格 cursor；结构目标及批次事务 |
| WR-07 | B0 | 图片插入/替换、裁剪、缩放、旋转、环绕/锚定、alt | GraphicObject/DrawPage；嵌入资源及对象变换 |
| WR-08 | B0 | 页尺寸/方向/边距、分页符、分节、分栏 | PageStyle/Break/Section；真实排版即时更新 |
| WR-09 | B0 | 页眉页脚、页码、日期/作者/文档属性字段 | TextFields/PageStyle；动态字段与纯文字区分 |
| WR-10 | B0 | 查找替换、选区与全文、跳转、批注增删/回复 | TextSearch/文本范围；批注写入原生文档 |
| WR-11 | B0 | DOCX 保存、PDF 导出、打印、当前未保存版本读取 | XStorable + 固定版本导出；导出前同步所有输入 |
| WR-12 | B1 | 目录/图表目录、书签、交叉引用、脚注/尾注、超链接 | TextIndexes/Bookmarks/ReferenceMarks/Footnotes |
| WR-13 | B1 | 修订开关、修改作者、接受/拒绝单项/选区/全部、比较 | Redlines/审阅命令；harness 可用真实修订输出 |
| WR-14 | B1 | 浮动形状、文本框、连接线、图表、公式、对象层级 | DrawPage/Shapes/Chart/嵌入对象；属性与源数据可读 |
| WR-15 | B1 | 表格排序、重复标题、跨页规则、单元格公式、题注 | 引擎表格/字段能力；溢出与分页样本验收 |
| WR-16 | B1 | 拼写/词典、字数、语言、自动更正、不换行与孤行控制 | 本机语言组件；自动更正规则可关闭，不覆盖代码 |
| WR-17 | B1 | 文档导航树、对象选择、节/页/引用回跳、样式检查 | 统一稳定锚点；可见区域与 caret 分离 |
| WR-18 | B2 | 模板、封面、邮件合并、标签/信封、索引与文献 | 复用引擎向导/数据绑定，产物独立；发送类副作用另授权 |
| WR-19 | B2 | 表单控件、保护节/字段、密码、签名、无障碍检查 | 明确导入/编辑/保存覆盖和外部格式差异 |

Writer 的引擎选取以对应官方工作流为参照，兼容验收仍以真实 DOCX 文件为准。[LibreOffice Writer Help](https://help.libreoffice.org/latest/en-US/text/swriter/main0000.html)

### 6.3 Excel / Calc 功能矩阵

| ID | 级别 | 功能组与具体工具 | UNO/引擎实现方向 |
| --- | --- | --- | --- |
| XL-01 | B0 | 大网格、范围/多范围选择、名称框、公式栏、编辑单元格 | 引擎 controller；分页读取可见范围，移除 1000×50 的功能限制 |
| XL-02 | B0 | 文字/数字/布尔/日期/错误类型、清除内容/格式、特殊粘贴 | 应用 typed cell 映射原生数值/文本/公式/格式，保留日期系统与布尔/错误语义；公式、显示值与原始值分开 |
| XL-03 | B0 | 真实公式计算、依赖更新、错误提示、自动/手动重算 | XCalculatable；报告 calculating/stale/complete 和公式兼容性 |
| XL-04 | B0 | 范围复制/移动、填充柄、序列填充、相对/绝对引用 | 原生范围操作；不通过逐格字符串替换实现引用调整 |
| XL-05 | B0 | 字体、对齐/换行、数字/日期/百分比/货币格式、边框/填充 | RangeProperties；格式代码和区域设置明确 |
| XL-06 | B0 | 行列插入/删除/移动、宽高、隐藏/取消隐藏、合并/拆分 | Sheet/Rows/Columns；相依公式和名称同步更新 |
| XL-07 | B0 | 工作表增删/复制/改名/重排、颜色、隐藏、跨表引用 | Worksheets；删除影响引用的预览报告 |
| XL-08 | B0 | 冻结/拆分窗格、筛选/排序、查找替换、范围跳转 | SheetView/XViewPane；多个 pane 的可见范围分别报告 |
| XL-09 | B0 | CSV/TSV 导入导出、分隔符/编码、打印区域、分页/PDF | 类型推断可预览；禁止把 CSV 输出说成保留多表/公式 |
| XL-10 | B0 | XLSX 保存/重开、重算后缓存值、未保存内容和选区读取 | 完整引擎导出；不用 ExcelJS 做完整会话保存 |
| XL-11 | B1 | 条件格式、数据验证、下拉列表、去重、分列 | 引擎对应模型；规则对象可列出、修改、移除 |
| XL-12 | B1 | 命名范围/表达式、结构表、数组公式、跨表函数 | 引擎能力逐项检测；Excel 专有函数明确 unsupported |
| XL-13 | B1 | 图表插入、类型/数据范围/轴/图例/主题、图像/形状 | Chart 与源数据绑定；不把图表变成截图 |
| XL-14 | B1 | 数据透视表、分组/汇总、聚合、刷新 | DataPilotTables；导入/导出兼容性单独测试 |
| XL-15 | B1 | 公式向导、前驱/后继、显示公式、循环引用定位 | 引擎计算与审计；错误不以空字符串掩盖 |
| XL-16 | B1 | 批注/回复、保护表/单元格、锁定区域、审阅 | 控件按当前文件权限开放；批注与摘录分离 |
| XL-17 | B1 | 数值格式区域设置、日期系统、精度规则、外部链接管理 | 1900/1904 日期、引用刷新与缺失链接有验收样本 |
| XL-18 | B2 | 目标求解、求解器、场景/假设分析、数据源连接 | 内置对应引擎模块；自动外部刷新单独配置 |
| XL-19 | B2 | 宏/扩展函数保留、兼容检查、版本比较、专业数据导入 | 不承诺 VBA/Power Query/Power Pivot 等同；不静默丢失不支持部件 |
| XL-20 | B1 | 仅选区导出、带公式/值/格式的引用、图表摘录 | UI/harness 同一范围与 artifact 服务 |

Calc 的公式、分析和布局由完整引擎承担；ExcelJS 可生成基础测试文件，但不承担对标完整计算引擎。[LibreOffice Calc Help](https://help.libreoffice.org/latest/en-US/text/scalc/main0000.html)

### 6.4 PPT / Impress 功能矩阵

| ID | 级别 | 功能组与具体工具 | UNO/引擎实现方向 |
| --- | --- | --- | --- |
| PT-01 | B0 | 幻灯片缩略图/页序、新增/删除/复制/重排/隐藏 | DrawPages/Presentation；稳定 slideId 与实际页序 |
| PT-02 | B0 | 文本框、字体/段落/列表、项目缩进、字符样式 | Shape 的 Text/TextRange；保留多 run 与占位符 |
| PT-03 | B0 | 基础形状/连接线、填充/线条/透明度/边框 | Shapes/Connectors；对象类型与属性语义 |
| PT-04 | B0 | 图片插入/替换、裁剪/翻转/旋转、尺寸和压缩 | GraphicObject；原图资源与显示裁剪分开 |
| PT-05 | B0 | 对象多选/编组/解组、对齐/分布、置顶/底、锁定 | DrawPage/GroupShape；一次变换形成一事务 |
| PT-06 | B0 | 拖动/缩放/旋转、对齐参考线、精确坐标、纵横比 | 引擎交互 + 对象属性浮窗；坐标/单位显式转换 |
| PT-07 | B0 | 幻灯片尺寸/方向、版式、背景、基础主题 | PageProperties/MasterPages；不复制背景当母版 |
| PT-08 | B0 | 表格插入与编辑、行列/合并/边框、图表与数据 | TableShape/Chart；保持可编辑结构 |
| PT-09 | B0 | 演讲备注、正文/备注独立定位、演示播放 | NotesPage/Presentation；演示模式与编辑 view 分开 |
| PT-10 | B0 | PPTX 保存、PDF/图片导出、讲义/备注打印 | 固定版本导出；页面/媒体/备注覆盖报告 |
| PT-11 | B1 | 母版、占位符、配色/字体主题、页码/日期/页脚 | MasterPages/占位符关系；布局继承可读 |
| PT-12 | B1 | 过渡、对象动画、顺序/触发器/时长、预览 | 动画树/引擎命令；导入/播放/PPTX 往返分别验收 |
| PT-13 | B1 | 视频/音频、链接/动作、嵌入媒体与资源归档 | 媒体支持与编解码资产检测；缺失资源报告 |
| PT-14 | B1 | SVG/公式/嵌入对象、自由曲线、图形组合/路径 | 引擎对象能力；SmartArt 不能默认按完全可编辑宣布 |
| PT-15 | B1 | 批注/回复、对象查找、审阅列表、版本比较 | 同一对象身份与审阅桥，非 textContent 近似模型 |
| PT-16 | B1 | 演示者模式、计时、字幕/导览、节与导航 | 展示窗口纳入目标管理；字幕/导览需应用补充能力，PPT 节按导入/编辑/保存单独验收 |
| PT-17 | B1 | 字体/行距/文本适配、溢出检查、主题资源失效检查 | 检测实际布局；不无限缩小字体隐藏溢出 |
| PT-18 | B2 | 模板、批量版式、专业图示、复杂动画与格式兼容报告 | 按实际引擎覆盖开放；不支持对象保留/转换策略明确 |

Impress 的编辑对象、母版、动画和演示作为功能参照；与 Microsoft PowerPoint 的复杂对象兼容需单独报告。[LibreOffice Impress Help](https://help.libreoffice.org/latest/en-US/text/simpress/main0000.html)

### 6.5 原生状态桥、撤销与保存

| 内容 | 技术方案 | 必须避免的问题 |
| --- | --- | --- |
| 人类选择 | view/controller 的 XSelectionSupplier；Writer TextRange、Calc ranges、Impress shapes 分别解析 | agent 不能用 currentController 抢人类焦点；多范围不能降成单格 |
| Calc 视口 | 每个 pane 的 first row/column 与 XViewPane.getVisibleRange | 冻结窗格和滚动 pane 不合并成错误连续范围 |
| Impress 视口 | XDrawView 当前页 + 文档客户区/对象可见 bounds | 当前页身份不能替代对象实际可见性 |
| Writer 视口 | UNO accessibility 的文本/组件 bounds 与客户区相交，必要时 UIA 补漏 | TextViewCursor 是 caret，不是滚动后的实际阅读区域 |
| 多视图 | XModel2/controller + 应用 viewId 映射；每 view 独立上下文 | 同一路径多个互不共享模型的 engine 实例不能伪装共同编辑 |
| 修改事件 | Modify/Selection/Property/Accessibility 事件汇入修订账本 | 自身命令回调去重；部分 native 命令异步完成前不能返回 applied |
| undo/redo | XUndoManager 文档历史；批次 enter/leaveUndoContext | lock() 不是事务锁；每种 setter/dispatch 验证原生 undo action，缺失时实现受控 XUndoAction/条件逆操作，否则声明不可撤销 |
| 导出/保存 | XStorable 导出到临时 URL → 校验 → 应用 SaveCoordinator | storeToURL 与 storeAsURL 身份语义不同；D0 验证 URL/dirty/diskRevision/undo 栈及字段/重算副作用，导出前后核验固定修订 |

官方接口：[XSelectionSupplier](https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1view_1_1XSelectionSupplier.html)、[XViewPane](https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1sheet_1_1XViewPane.html)、[XDrawView](https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1drawing_1_1XDrawView.html)、[XAccessibleComponent](https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1accessibility_1_1XAccessibleComponent.html)、[XAccessibleText](https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1accessibility_1_1XAccessibleText.html)、[XUndoManager](https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1document_1_1XUndoManager.html)、[XStorable](https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1frame_1_1XStorable.html)。

harness 主要命令命名空间：`writer.text/styles/paragraphs/tables/images/pages/fields/references/comments/revisions`、`calc.cells/ranges/formulas/sheets/styles/charts/validation/conditionalFormats/pivots/print`、`impress.slides/shapes/text/images/tables/charts/masters/notes/animations/presentation`。每组同时具备读取、检查及实际可用的修改命令，不仅暴露插入能力。

## 7. PDF：原生编辑、页面、表单、脱敏与专业工具

### 7.1 引擎组合

**主选：PDF.js 阅读/交互 + 本机 MuPDF worker 唯一编辑内核。** qpdf 负责结构检查/优化/密码；Tesseract 负责 OCR；后期 pyHanko 负责证书签名/验证，veraPDF 负责 PDF/A 与 PDF/UA 机器验证。pdf-lib 为迁移期基础命令后端，复杂编辑逐步转到同一 PDF 会话。

PDF.js 的表单/批注交互只派发权威命令，不独立保存。qpdf、pyHanko 等处理器接收固定修订的临时产物，完成后由 SaveCoordinator 校验和发布；若将结果载入活动编辑会话，递增 engineEpoch 并失效旧对象句柄/坐标映射。它们不得绕过会话直接改活动源文件。

pdf-lib 官方明确不提供普通页面原有正文编辑/删除 API，不能承担任意 PDF 文本改写。MuPDF 提供原生注释、页面与脱敏能力，但仍需本项目开发对象定位、字形映射和文本重排。其 JavaScript 文档中标为 `only mutool run` 的能力不能直接当作 npm/WASM 接口；主线路径为固定版本 Windows 原生 worker + C API。[pdf-lib 限制](https://github.com/Hopding/pdf-lib#limitations)、[MuPDF PDFDocument](https://mupdf.readthedocs.io/en/latest/reference/javascript/types/PDFDocument.html)、[PDFPage](https://mupdf.readthedocs.io/en/latest/reference/javascript/types/PDFPage.html)、[PDFAnnotation](https://mupdf.readthedocs.io/en/latest/reference/javascript/types/PDFAnnotation.html)

MuPDF 为 AGPLv3/商业双路线。当前项目已有 BabelDOC AGPL 依赖，不等于项目主体已经自动选择同样许可证；正式发行需明确主体与集成/源码提供策略。PDFium 是保留的 BSD 风格许可备选，提供真实对象编辑 API，但段落排版、原生批注和完整脱敏仍需更多自建工作。规划采用 MuPDF 主线，不同时建设两套主 writer。[MuPDF 许可](https://mupdf.readthedocs.io/en/latest/license.html)、[PDFium 编辑 API](https://pdfium.googlesource.com/pdfium/+/refs/heads/main/public/fpdf_edit.h)

### 7.2 完整功能矩阵

| ID | 级别 | 功能组与具体工具 | 实现与保存要求 |
| --- | --- | --- | --- |
| PF-01 | B0 | 连续/单页/双页、缩放/适应、页码/页标签、书签、搜索、链接 | PDF.js + 应用稳定 pageId；页标签仅展示，不作身份；可见页优先 |
| PF-02 | B0 | 多页选择、插入空白/图片/PDF、删除/复制/重排、旋转 | page tree 事务；注释、书签、链接、表单关系同步处理 |
| PF-03 | B0 | 抽页、合并、拆分、替换页、裁剪、页面尺寸 | 产物独立身份；影响范围/链接策略预览；普通 CropBox 裁剪仅隐藏区域，实际移除内容使用明确的破坏性裁切/脱敏流程 |
| PF-04 | B0 | 原生高亮/下划线/删除线/波浪线、便签、评论/回复 | PDF annotation 对象与 quad、作者/颜色/时间/appearance；外部阅读器可继续编辑 |
| PF-05 | B0 | 文本框、手绘、箭头/线/矩形/椭圆/多边形、图章 | 创建/更新/移动/缩放/删除原生批注；批注列表/导出 |
| PF-06 | B0 | 文字增补、字体/颜色/字号/对齐/行距、移动/旋转/缩放 | 保留可再次编辑的对象身份；内置可嵌入字体、字符检测和溢出提示 |
| PF-07 | B0 | 图片增补、移动/缩放/旋转/替换/删除 | 资源与对象实例映射；保存后再次打开仍可识别和操作 |
| PF-08 | B0 | AcroForm 填写、复选/单选/下拉、Tab、保存填写值 | widget/field 与 appearance 更新；区分 readonly/required/XFA |
| PF-09 | B0 | PDF 保存/另存/打印，页面/批注/区域导出 | 同一 PDF 会话；临时文件验证；保持页关系和版本说明 |
| PF-10 | B1 | 原文单 run/单行替换/删除/格式、受限段落重排、逐项替换 | 修改真实内容对象；字体/字形/内容流重建，不采用白色覆盖 |
| PF-11 | B1 | 原图提取/替换/裁剪、路径与矢量对象编辑、层级/透明度 | XObject/inline image/Form/clip/transform 图；共享资源 clone-on-write |
| PF-12 | B1 | 页眉页脚、页码/Bates、背景、水印、更新/移除 | 自有标识与页范围；不猜测删除来源不明的页面内容 |
| PF-13 | B1 | 表单字段创建/属性/位置/类型/验证/Tab 顺序、数据导入导出/扁平化 | 先填写闭环，再表单设计；XFA 覆盖单独声明 |
| PF-14 | B1 | 页面/区域 OCR、语言/方向/去倾斜、字词框/置信度/校对、可搜索层 | Tesseract 布局输出 + PDF 隐藏文本层；避免重复文字层 |
| PF-15 | B1 | 扫描文字区域编辑、图像清理、区域重建 | 原像素真实移除/替换 + 新文字；OCR 文本层不等于扫描原文已编辑 |
| PF-16 | B1 | 文字/区域脱敏标记、规则搜索、预览、应用、隐藏信息清理与检查 | native redaction + 完整重写/垃圾收集；实际删除文字/图像/隐藏对象 |
| PF-17 | B1 | 书签/链接/附件/元数据/语言增改删、可选图层 | 修改真实目录/资源结构，关联锚点同步 |
| PF-18 | B1 | 视觉手写/图片签名、密码/权限、既有签名状态检查 | 视觉签名和证书签名分开；修改后重新报告签名有效性 |
| PF-19 | B2 | 证书签名/验证、时间戳/信任链/撤销状态、允许修改范围 | pyHanko；保存策略与签名覆盖范围检查；离线验证报告实际覆盖 |
| PF-20 | B2 | 结构标签/阅读顺序/alt 修复、PDF/A/PDF/UA、印前、优化/压缩 | 编辑和验证是不同命令；veraPDF 机器结果 + 人工阅读顺序验收 |
| PF-21 | B2 | 文档比较、测量/比例尺/单位、专业绘图与图层锁定 | 专业工具贡献，不阻塞 B0；明确测量精度与坐标模型 |

完整 PDF 工具目录以常见编辑工作流校验，包括原文/图像、页面组织、批注、表单、脱敏和签名；这些是分开的引擎能力。[Acrobat 编辑 PDF](https://helpx.adobe.com/acrobat/using/edit-pdf.html)、[页面管理](https://experienceleague.adobe.com/en/docs/document-cloud-learn/acrobat-learning/get-started/create/organize)、[表单设计](https://www.adobe.com/learn/acrobat/web/create-digital-form-from-pdf-file)、[脱敏与清理](https://experienceleague.adobe.com/en/docs/document-cloud-learn/acrobat-learning/advanced-tasks/protect/redact)、[数字签名](https://helpx.adobe.com/acrobat/desktop/e-sign-documents/learn-about-signatures/digital-sign-overview.html)

### 7.3 原文编辑的实现边界

PDF 通常没有可直接操作的“段落文档模型”。新增 `PdfObjectGraph` 保存页、内容流指令、文字 run/字形/字体、图像实例、Form XObject、剪裁/变换、批注与 widget；段落是应用分析得到的投影。

PdfObjectGraph、内容流精确改写、字体编码/CID 映射、字形定位和必要的 shaping 是本项目自建层，MuPDF C API 不等于已有可修改的 run 树。普通文字编辑不能普遍用矩形 redaction 代替，否则会误删同区域其他文字/线条/图片。字体覆盖检测同时验证编码、字形与度量。

pageId 由应用管理：重排保持身份，复制/跨文档合并建立新 pageId 与来源关系；完整重写后重新绑定引擎页对象，不依赖页码、页标签或 PDF 间接对象号永久稳定。

- 首批原文编辑支持单 run/单行、字体可编码的新字形。真实移除被修改目标的旧文字操作并写入新 run，另一提取器在该位置读到新内容；其他位置的合法重复文字保留。
- 段落重排限制在明确选定区域内；根据字体度量计算新排版。换字体、行数变化、边界溢出必须写入预览与 FidelityReport。
- 字体子集不能编码新字符时使用内置可分发替代字体，并标明视觉变化；不能默默换字体或极端缩小字号。
- 连字、RTL、竖排、Type3、文字路径、共享 Form、复杂 clip/透明度逐对象检测可编辑性。不能可靠保持时提供明确的区域重建/重建副本方案，原对象保留至应用事务完成。
- 整页光栅化仅是明确选择的重建方式，标记文字/矢量/无障碍结构变化，不作为默认保存。

坐标采用 PDF user space、完整变换矩阵和 QuadPoints；处理 MediaBox/CropBox/Rotate/UserUnit。截图/鼠标仍用当前视口 CSS 像素并携带 layoutRevision；不能继续仅用比例矩形承担所有位置。

### 7.4 脱敏与签名的特殊规则

脱敏采用“标记 → 预览 → 明确应用 → 检查输出”。涂黑、白色覆盖、删除可见文字层不能冒充真正脱敏。应用后完整重写，不使用保留旧内容的增量保存；检查文本、图片像素、共享对象、批注、附件、元数据和隐藏层，并用独立解析器复查。混合扫描页、共享 XObject、旧增量修订、隐藏 OCR 层纳入样本；未覆盖区域或检查失败返回 partial/failed，不能发布“脱敏完成”。正式脱敏产物不能携带应用自己的原文快照，但设备上的原件/旧备份是独立对象，不能声称已经从整台设备擦除。

证书签名使用单独签名服务。已有签名文档打开后先识别覆盖范围与允许变更；通用 qpdf 重写/压缩不能在签署后的文件上自动运行。签名保存需要保留字节范围和允许的增量规则；导出签署副本后重新验证。

### 7.5 Harness 命令

```text
pdf.pages.insert / remove / reorder / copy / extract / merge / split / crop
pdf.objects.list / inspect / transform / remove
pdf.text.insert / replace / format
pdf.images.insert / replace / extract
pdf.annotations.list / create / update / reply / remove / export
pdf.forms.list / setValues / createField / updateField / removeField / flatten
pdf.ocr.start / review / writeTextLayer
pdf.redactions.mark / preview / apply / sanitize / verify
pdf.signatures.inspect / validate / sign
pdf.security.inspect / encrypt / decrypt
pdf.structure.bookmarks / links / attachments / tags / metadata
pdf.export / compare / optimize / validate
```

所有命令返回实际 changedPages/affectedTargets/warnings/undo 能力。页面重排、对象删除、OCR/翻译/布局变化重新映射锚点，旧对象引用与坐标操作失效。

## 8. HTML、网页与其他文档工具的补充

| 范围 | 能力 | 实现 |
| --- | --- | --- |
| 本地 HTML/阅读副本 B0 | 标题/段落/列表/表格/链接/图片结构编辑、源码、查找替换、保存 | Tiptap/ProseMirror 开源核心 + 受支持 schema；未知 HTML 保留原始块 |
| 离线资源 B0/B1 | 图片/CSS/字体归档、相对链接重写、缺失资源清单、单文件/资源目录导出 | AssetService/manifest；只打包明确允许获取的资源 |
| 网页选择 B0 | 复制/引用/摘录、应用侧批注、临时选区译文/替换译文 | 原站操作与副本持久编辑分别命名；不宣称远程站点已保存 |
| 网页控制 B1 | 语义元素引用、表单/可编辑区域、DOM/AX/frame 可见性、下载 | 复用 BrowserRuntime 的导航/布局版本；保留真实鼠标/键盘路径 |
| 后续格式 B2 | ODT/ODS/ODP、CSV、EPUB、带宏 Office | 增加格式能力/定位器，不硬塞进当前 Format union；同一会话协议扩展 |

文档翻译继续独立展示/输出，不写回原文；网页译文仅临时原地替换。AI 改写和翻译是不同命令和历史路径。

## 9. 需要新增的编辑设置

设置仍在独立窗口按需打开，普通偏好即时保存；不接入的引擎参数显示依赖原因。

| 分类 | 新增设置 |
| --- | --- |
| 通用编辑 | 默认阅读/编辑模式、保存前输入同步、自动保存与恢复点分别管理、输入历史合并、外部修改提示、AI 直接应用/预览 |
| Markdown | 默认可视/源码模式、方言、公式/图示/脚注、图片目录/复制策略、粘贴方式、列表/表格偏好、保留语法/显式格式化、专注模式 |
| Word | 默认页面/样式/字号/语言、粘贴格式、修订显示、打印/导出批注、对象锚定/环绕偏好 |
| Excel | 区域/日期/数字格式、自动/手动重算、粘贴类型、公式输入/错误显示、外部链接刷新、打印预设 |
| PPT | 默认尺寸/主题/版式、对齐参考线/吸附、默认字体、文字溢出策略、媒体压缩、演示/备注打印 |
| PDF | 标记作者/颜色/透明度、原生/应用侧批注策略、文本增补字体、OCR 语言/校对、页面布局、表单高亮、签名验证、导出优化 |
| 资源与引擎 | 引擎版本/健康/离线资产、字体替换、可用字典、缓存容量、后台任务并发、迁移/恢复诊断 |
| 工具与无障碍 | 胶囊图标/顺序/固定项、快捷键、图标文字提示、键盘焦点、减少动效、屏幕阅读状态播报 |

不提供“文档翻译自动覆盖原文”选项；不能提供关闭版本/目标校验的偏好。原生批注与应用侧批注的默认选择不改变已有批注的存储位置。

## 10. 共通 Harness / MCP / 插件协议

### 10.1 能力发现优于几百个固定 MCP 工具

当前 `Capabilities.editKinds: string[]` 和固定 `EditOperation` union 不足以容纳完整编辑。保留旧接口并新增版本化 registry：

```text
document_commands_list(documentId, target?, category?, cursor?)
document_command_describe(documentId, commandId)
document_resolve_target(documentId, viewId?, locator, expectedRevision)
document_read_structure(documentId, scope, budget, cursor?)
document_prepare_commands(documentId, commands[], preconditions)
document_commit_transaction(transactionId, idempotencyKey)
document_transaction_status(transactionId | idempotencyKey)
document_undo_transaction(transactionId, mode)
document_export(documentId, format, options, expectedRevision)
reader_reveal(viewId, targetRef, preconditions)
editor_input / editor_capture（按引擎是否支持声明）
document.history.undo / redo / state（会话顺序历史命令）
```

以上为拟新增工具名，不是当前已可调用接口。旧 `document_plan_patch/apply_patch/selection_action` 经适配层映射到 registry；UI、HTTP、CLI 与 MCP 共用 schema/处理器。只读批量列表使用预算/分页并报告 coverage/truncated，不让大模型一次读取完整大表或对象树。能力状态/结构读取响应带 contentRevision 与 engineEpoch；cursor 绑定该版本，变化返回过期，不能拼接跨版本分页。会话 undo/redo 和条件逆操作 `document_undo_transaction` 分开。

每条命令描述包含：输入/结果 JSON schema、目标类型、可用引擎/文件限制、enabled/toggle/mixed 状态、预期效果、所需授权范围、atomic/compensable、undo 支持、是否后台任务、导出格式/保真等级、缺失依赖原因。

### 10.2 请求与回执示例

以下是设计示例，提交方身份由 IPC/认证会话确定，不能在 payload 中伪造 human。

```json
{
  "schemaVersion": "1.1",
  "documentId": "doc-1",
  "viewId": "view-1",
  "sessionId": "session-1",
  "engineEpoch": "epoch-1",
  "expectedContentRevision": 42,
  "commands": [{
    "commandId": "calc.ranges.setValues",
    "target": {"ref": "range-7", "expectedFingerprint": "sha256:..."},
    "args": {"values": [["品名", "数量"], ["示例", 2]]}
  }]
}
```

```json
{
  "transactionId": "tx-1",
  "status": "applied",
  "contentRevision": 43,
  "affectedTargets": ["range-7"],
  "warnings": [],
  "undo": {"mode": "conditionalInverse", "token": "undo-1"},
  "layoutChanged": true,
  "calculation": {"state": "complete"}
}
```

- 内容编辑携带 contentRevision、engineEpoch、目标稳定引用/指纹；允许的重定位/重基必须可核验。
- 坐标输入额外携带 viewId、layoutRevision、viewportRevision、CSS 坐标；原生 Office surface 另带 surfaceId、boundsRevision、DPI/zoom 与变换版本，转换为 native client pixels，对象几何使用引擎文档单位。引擎重启、页面组织或字体加载均可使旧输入失效。
- SelectionSnapshot 包含 selectionId、human/agent 来源、多个范围/对象、源版本、frame/controller、坐标变换与预算覆盖。
- 错误区分 `CAPABILITY_UNSUPPORTED / TARGET_STALE / VERSION_CONFLICT / INPUT_PENDING / ENGINE_RESTARTED / CALCULATION_PENDING / EXPORT_LOSS / PARTIAL_COMMIT / FILE_CONFLICT`。
- 对白名单之外的脚本、宏、外部数据提交不给通用执行入口；复杂工具通过明确能力扩展。

### 10.3 Codex 插件与其他 harness

现有 `plugins/agent-viewer` 继续作为 MCP 发现与工作流指导层，不把文档引擎塞进 Codex 插件。引擎随 AgentViewer 安装，插件连接应用的实际会话。

更新 reading/editing skills 的流程为“发现能力 → 确认视图与来源 → 读取真实目标 → 准备命令 → 提交 → 查看回执/目标 → 按任务保存”。高级命令通过发现机制获取，避免把某一引擎版本的命令硬编码到提示词。

agent 操作事件来自实际命令/输入，附目标身份和当前布局；指针、目标高亮和底部胶囊继续显示真实动作。工具调用不得通过直接修改磁盘文件绕过打开文档的状态。

## 11. 依赖、内置资源与分发

以下是候选主线/补充工具的规划，不代表已安装。新增时固定版本、下载来源、哈希、许可、第三方 NOTICE 和离线资产。

| 组件 | 采用方式 | 许可/内置说明 |
| --- | --- | --- |
| CodeMirror / remark / Milkdown / ProseMirror | MD 源码、语法、编辑投影 | 开源核心；本地 JS/CSS；不嵌入需购买许可的 Typora |
| KaTeX / Mermaid | 公式与图示 | 开源依赖和字体全本地；复杂公式可换 MathJax 适配 |
| LibreOffice + UNO Host | Writer/Calc/Impress 和格式转换 | 现有资源扩展；当前发行以 MPL-2.0 为主，实际版本的其他许可/第三方部件按 LICENSE/NOTICE 记录；bridge/runtime/字体/词典分别记录 |
| PDF.js | PDF 显示与选择/交互 | Apache-2.0；worker/CMap/字体/图像依赖本地 |
| MuPDF native worker | PDF 完整编辑主内核 | AGPLv3 或商业许可；发行策略须明确；保留 PDFium 后端接口 |
| qpdf | PDF 检查/结构优化/密码 | Apache-2.0；不是原文编辑或独立脱敏引擎 |
| Tesseract.js / tessdata | OCR 文字布局/校对 | 现有组件扩展；语言数据/worker/WASM 本地，避免重复 OCR 引擎 |
| pyHanko | 证书签名/验证 | MIT；随专用 Python 环境提供，不破坏现有 BabelDOC 环境 |
| veraPDF | PDF/A/UA 机器验证 | GPLv3+/MPLv2+ 路线；若采用须带受支持 Java runtime |
| Pandoc | 后期 Markdown 专业转换 | GPL-2.0-or-later；独立转换进程/NOTICE；不是默认保存链 |
| Tiptap/ProseMirror 开源核心 | 本地 HTML/阅读副本结构编辑 | 不将商业批注/历史/AI 扩展计入免费基线 |
| SQLite + artifact store | 事务/历史/原生对象映射/恢复/资源索引 | 小型元数据与大二进制分别存储；兼容当前 JSON 检查点 |

官方边界：[LibreOffice Licenses](https://www.libreoffice.org/licenses/)、[qpdf Overview](https://qpdf.readthedocs.io/en/stable/overview.html)、[qpdf License](https://qpdf.readthedocs.io/en/stable/license.html)、[pyHanko License](https://github.com/MatthiasValvekens/pyHanko/blob/master/LICENSE)、[签名验证](https://pyhanko.readthedocs.io/en/latest/cli-guide/validation.html)、[veraPDF](https://verapdf.org/home/)。

发行包允许采用应用管理的组件包来分层更新，但首次完整安装必须带齐 B0 所需引擎/数据，不依赖首次打开时从 CDN 下载。B2 工具只有在实际随包提供或明确安装完成后声明可用。

补充到 `engines.lock.json`：平台/架构、版本/hash、runtime/字体/字典资产、功能清单、协议版本、健康探针、来源、LICENSE/NOTICE/源码提供信息、磁盘/内存预算。低频引擎按需启动；未保存/运行任务的 session 不自动休眠。所有 engines worker 崩溃隔离且保留有效检查点。

## 12. 项目结构与迁移

下面目录是拟新增或拟扩展，并非当前实现状态。

```text
packages/
  contracts/             命令描述、事务、SelectionSnapshot、能力/版本协商
  editor-sessions/       唯一权威 session、view/controller、事件同步
  command-registry/      schema、状态、处理器、工具贡献
  anchors/               源码/结构/页面/对象/范围定位与映射
  edit-history/          原生历史、条件逆操作、事务账本
  markdown-engine/       保真源码、AST、映射、可视/源码增量编辑
  office-bridge/         UNO schema、controller 路由、状态与导出
  pdf-engine/            object graph、批注/表单/页面/脱敏事务
  assets/                图片/附件/字体、资源引用、导出归档
  export-pipeline/       固定版本、格式导出、保真报告、检查
  persistence/           SQLite 元数据与 artifact store、JSON 迁移
apps/
  office-host/           Windows native host / UNO / 受控 IPC
  pdf-worker/            MuPDF native 封装 / 受控 IPC
  desktop/               编辑器视图、contextual capsule、属性面板
  local-service/         旧 MCP 兼容 + 新命令发现/事务工具
tests/
  fixtures/editing/      按功能 ID 编号的真实样本与期望
  editing-contract/      UI 与 harness 相同 schema/状态/回执
  roundtrip/             保存、外部引擎读取/渲染、兼容报告
  native-editor/         焦点/IME/DPI/视口/多窗/崩溃恢复
```

迁移顺序：

1. 扩展 `contracts/extensions.ts` 已预留的 OfficeEngineSession/ViewBridge，而非另建不兼容接口；增加通用 session/registry。
2. 保留当前文档/view 身份与旧命令。新读取投影改为分页；持久快照包含冻结 artifact，旧快照不可用时明确标记。
3. 先把现有 text.replace/selection actions 接入 registry，再逐格式切换 writer；禁止两条链长期分叉。
4. 保存路径/文档身份关系不因加入引擎而改变；旧 Office 转换保留原件与来源映射。
5. JSON → SQLite/artifact 采用版本迁移、完整校验与可恢复旧文件，不覆盖原恢复资料。
6. 全文译文/导出产物与编辑历史、缓存分别存储；清理缓存不删除译文、用户摘录或恢复所需文件。

## 13. 实施包与门槛

实施包按依赖组织；B1/B2 没有被删出需求，但不将“全部高级功能”塞进同一次改动。完成一个包即交付完整闭环及证据。

| 包 | 工作内容 | 通过条件与下一步 |
| --- | --- | --- |
| S0：共同底座 + 三类 D0 | 命令注册、输入屏障、增量事务/历史、锚点；MD 投影、Office native frame、PDF 真修改原型 | 三种引擎都能未保存读取/选择/修改/撤销/保存重开；内嵌风险有实测结果 |
| S1：Markdown B0 | 可视/源码/分栏、格式/结构、表格、链接/图片/代码、查找替换、大纲、harness | MD-01–11 的 UI/MCP 和保真样本通过；IME/重复文字/未知语法不丢失 |
| S2：Writer B0 | 真实布局/文本/样式/列表/表格/图像/页面/字段/批注/导出 | WR-01–11 通过；两个 controller 共享未保存内容，位置不跟焦点漂移 |
| S3：Calc B0 | 范围/类型/计算/粘贴/格式/行列/表/筛选/冻结/导出 | XL-01–10 通过；结果包含真实重算状态；大表按需读取 |
| S4：Impress B0 | 页序/文本/形状/图像/多选/布局/表格图表/备注/播放/导出 | PT-01–10 通过；对象/资源/备注往返完整，文本溢出有报告 |
| S5：PDF B0 | 页组织、原生批注、增补文本/图像、表单、保存/导出 | PF-01–09 通过；外部阅读器可继续编辑批注/表单；统一坐标验证 |
| S6：B1 编辑与审阅 | MD 扩展/导出/资源；Office 引用/审阅/透视/母版动画；PDF 原文/对象/OCR/脱敏 | 每项功能独立样本；特别验证 PDF 原内容删除、Office 未修改对象保留 |
| S7：B2 专业与稳定发行 | 专业转换/数据工具/复杂演示/证书/结构/印前；内置资源、多窗恢复、性能、安装验收 | 离线机器可运行实际声明功能；完整能力报告/许可证与发行资产一致 |

MD、Office、PDF 的 D0 可并行；底座、引擎 writer 切换、保存/历史迁移必须顺序执行。S2–S4 共用 Office Host，不重复造三个引擎。PDF B0 可与 Office UI 工具接入并行。

最先实施的具体任务：移除 Markdown 整篇输入提交；建立增量事务与命令 registry；修正 AST 大纲/稳定锚点；建立 pending-input 屏障；同时完成三个 D0 样本。这样后续每增加一个工具，都有正确的选择、历史、保存和 harness 路径。

## 14. 验收样本与证据

### 14.1 引擎 D0 门槛

| D0 | 最小样本/操作 | 失败后的动作 |
| --- | --- | --- |
| MD 投影 | 重复文本、嵌套列表、引用式链接、raw HTML/注释、BOM/CRLF、中文 IME；切换模式/局部修改/回跳/重开 | 默认改走 CodeMirror 实时呈现；Milkdown 暂不声明保真编辑完成 |
| Office Host | 各一个复杂 DOCX/XLSX/PPTX；同文档两个 view、两个应用窗口；滚动不移动 caret；IME/agent/未保存导出；跨进程子窗、可信浮层叠放/穿透、标签隐藏/恢复、侧栏动画/resize、对话框 ownership、崩溃恢复、100%/150%/200% DPI | 子视图失败记录具体项；受管 UNO 实时窗口作为过渡，启动备用 host 验证 |
| PDF 编辑内核 | 旋转/非零 CropBox/字体子集/共享图像/表单/原生批注/脱敏；外部重开与文字提取 | 按对象实际能力限制，不提供伪编辑；许可路线改变时验证 PDFium 备选 |

### 14.2 必须完成的端到端场景

1. 每个功能 ID 均有 UI 操作和相同 harness 命令测试；同一输入得到相同目标、结果与限制。
2. 正在输入但未 blur 时保存/发问/翻译，固定版本包含完整已确认内容；IME 不被工具点击中断。
3. Markdown 未改块字节保持；打开→切换模式→保存不产生语法正规化；代码内伪标题、Setext/H5/H6、重复片段定位准确。
4. DOCX 表格/图像/混合 run、页眉页脚、脚注/目录、修订与评论；PPTX 母版/图表/备注/媒体；XLSX 公式/名称/验证/条件格式/透视，保存重开逐项核对。
5. Calc 输入真实数值/日期、复制相对公式、跨表变更后重算；错误值、stale/complete 状态真实，不能仅检查公式字符串保存。
6. Office/MD 同一文档两 view 共享未保存内容；滚动与选择独立；后台 agent 不抢用户另一页的焦点。
7. PDF 原生批注和表单在另一阅读器可读取、修改、删除；sidecar 注释的导出与原生注释写回分别验证。
8. PDF 原文替换后，被修改目标的旧内容从内容流移除，另一提取器在该位置读到新内容；其他位置的同文内容保留，未改区域视觉差异受控。复杂字体替换/重建产生可理解报告。
9. PDF 旋转/裁剪/UserUnit/任意方向 quad、页面重排后的书签/链接/表单关系准确；Windows 100%/150%/200% 缩放下点击一致。
10. 脱敏输出完整重写，从文本/对象/图片/附件/元数据/隐藏层检查；保留旧备份的范围说明准确。
11. 用户后续修改另一目标，agent 条件撤销保留它；同目标冲突定位明确；不支持条件逆操作的命令不宣称支持。
12. 引擎重启/崩溃、提交中断、磁盘冲突/锁文件、保存失败，原件/未保存内容/回执状态可解释，重连不重复修改。
13. 离线新机器运行 B0 全部必需格式；没有外部 Office/Docker/运行时或首次 CDN 下载依赖；诊断显示实际引擎来源。
14. 工具状态与当前文件权限/对象限制一致；缺失功能有实际原因；设置开关不能宣称未接入能力。
15. 1280×800、1440×900、1920×1080 及不同缩放下，标签/状态栏固定，侧栏动画不滚动 shell；玻璃工具层只有实际胶囊区域，无遮挡矩形。
16. 打印/普通导出不包含 agent 指针、选区胶囊、临时译文；选择翻译不改变原文、dirty 或编辑历史；全文翻译冻结真实未保存版本并生成独立文件。

### 14.3 性能目标与产物记录

以下是拟定性能目标，需要记录测试机器和样本，不是当前测量结果：普通本地编辑/选区反馈 P95 ≤ 100ms；稳定选择/视口变化后上下文更新 ≤ 200ms；大表/PDF 使用分页/预算读取；单页修改只失效受影响页/对象；长耗时导出、OCR、比较和转换作为可取消后台任务。首次打开/内存/导出耗时按真实大文件基准记录，D0 后再固定具体门槛。

每个测试保存：源文件 SHA-256、引擎与桥版本、命令/目标/回执、固定来源修订、输出摘要、外部重开/解析结果、视觉截图或差异、FidelityReport。截图证明显示与落点；文件重开证明持久化；真实上下文测试证明阅读/选择桥。三者分别记录，不能相互替代。

本规划的完成条件是需求、引擎、工具、harness 和验证路径明确。新增编辑能力的完成状态继续由后续实施证据逐项更新，不能因本文落盘而将当前阅读器标为已具备完整 Typora/LibreOffice/PDF 编辑功能。
