# Markdown 与本地 HTML 左侧工具箱：详细需求

日期：2026-10-12。状态：规划，以下新增命令尚未全部实现。总体布局、事务与 MCP 基线见[主需求文档](LEFT_TOOLBOX_REQUIREMENTS_2026-10-12.md)。

## 1. 编辑目标与信息组织

Markdown 需要同时满足语法熟练者的源码控制和普通写作者的实时编辑。左栏应按“结构、写作、插入、块属性、资源引用、查找审阅、输出”组织，不按源码／预览技术实现组织。显示模式在统一导航切换，各模式共用原文、稳定选择和历史。

默认阅读展示标题树；默认编辑展示写作工具。结构树提供标题、列表、表格、代码、公式、图示和图片的类型筛选，选择项显示实际来源和渲染预览。标题树不必把所有普通段落挤入同一列表；完整块列表按需启用。

参考 [Typora Markdown Reference](https://support.typora.io/Markdown-Reference/) 的结构语法与表格编辑、[图片处理流程](https://support.typora.io/Images/) 的资源方式；本项目规划自己的编辑器与命令，不依赖调用或内置 Typora。Typora 对 GFM 的支持也不等于所有 Markdown 方言一致，文档须保存方言与扩展能力。

## 2. 工具级需求矩阵

级别：P0 为可编辑工作台基础闭环，P1 为完整写作能力，P2 为扩展工作流。等级是实施顺序，不代表可以用按钮占位交付。

| ID／级别 | 组和具体工具 | 参数与目标 | 结果／验收要点 | MCP 命令 ID（规划） |
| --- | --- | --- | --- | --- |
| MD-01／P0 | 标题树与跳转 | headingId，reveal，是否加入导航历史 | 同名标题可区分，切模式仍回到正确段 | `reader.revealTarget` |
| MD-02／P0 | 标题级别／章节升降级 | headingId 或 sectionId，level 1–6，是否连带后代 | 内容保留；超出层级拒绝；锚链接变化有映射 | `markdown.section.setLevel` |
| MD-03／P0 | 章节移动／复制／删除 | sectionId，before／afterSectionId，包含后代 | 默认携带至下个同级标题前的完整内容；不删邻节 | `markdown.section.move/duplicate/remove` |
| MD-04／P0 | 块类型转换 | blockRefs，paragraph／heading／quote／code／list | 能转换与损失情况预览；不把表格改成普通字符串 | `markdown.block.transform` |
| MD-05／P0 | 粗斜体／删除线／行内代码 | textRanges，mark，enable／disable | 解析现有语法、转义和嵌套；不重复包裹 | `markdown.mark.set` |
| MD-06／P0 | 清除格式 | ranges，内联／块／全部 | 保留原文字与链接目标，范围外源码不改变 | `markdown.mark.clear` |
| MD-07／P0 | 有序／无序／任务列表 | blockRefs，类型，起始编号，marker | 保留子列表、代码和段落；不以每行加字符代替解析 | `markdown.list.setType` |
| MD-08／P0 | 列表缩进／提升／任务完成 | itemIds，delta／checked | 维护树关系；任务状态也成为可撤销事务 | `markdown.list.indent/setChecked` |
| MD-09／P0 | 插入文字块／分隔线／引用 | insertionAnchor，kind，content | 插入返回 blockId 与新光标，空段处理一致 | `markdown.block.insert` |
| MD-10／P0 | 插入与编辑表格 | insertionAnchor／tableId，rows／columns，cells | 合法 GFM 表格；处理管道转义和内联语法 | `markdown.table.insert/setCells` |
| MD-11／P0 | 表格行列增删／移动／对齐 | tableId，indices，position，alignment | 列数和 header 保持有效；空表和最后一行规则明确 | `markdown.table.rows/columns/setAlignment` |
| MD-12／P1 | 表格转置／TSV 粘贴／排序 | tableId，range，typedOptions | 纯 Markdown 不提供 Excel 类型或公式重算承诺；排序范围明确 | `markdown.table.transpose/paste/sort` |
| MD-13／P0 | 图片插入／替换／说明 | anchor／imageId，assetId／path，alt，title | 资源与源码路径关联；缺失提示；返回图片和资产身份 | `markdown.asset.insertImage/replace` |
| MD-14／P1 | 图片显示尺寸与裁剪 | imageId，方言允许的 dimensions；crop 为独立资源产物 | CommonMark 本身没有图片尺寸语法；扩展／HTML 写入需明确 | `markdown.asset.setPresentation/createCrop` |
| MD-15／P0 | 链接设置／删除／跳转 | range／linkId，URI，title，inline／reference | 去链接保留文字；空格／括号正确转义；内部引用可解析 | `markdown.link.set/remove/resolve` |
| MD-16／P1 | 引用定义／脚注管理 | definitionId／footnoteId，label，content | 定义重命名同步引用；孤立／重复标识可发现 | `markdown.reference.update/rename` |
| MD-17／P0 | 代码块与语言 | blockId，language，code，fence preference | 内文含围栏时安全选择长度；语言只影响呈现 | `markdown.code.set` |
| MD-18／P1 | 公式块／内联公式 | blockId／range，TeX，displayMode | 错误保留原文并定位；不执行任意命令 | `markdown.math.set` |
| MD-19／P1 | Mermaid／图示 | blockId，language，source | 图示预览、源码和错误定位；导出兼容性报告 | `markdown.diagram.set` |
| MD-20／P1 | 提示块与扩展语法 | blockId，dialect，kind，source | 不支持方言时提供源码编辑岛，不能删除未知节点 | `markdown.extension.set` |
| MD-21／P1 | front matter | metadataNodeId，keyChanges，format | YAML／TOML 方言明确；保留注释和未知键，禁止 eval | `markdown.frontMatter.update` |
| MD-22／P0 | 查找替换 | scope，query，regex／case，replacement | 数量、具体范围和样例 diff；对未知节点是否包括须声明 | `document.search/replace` |
| MD-23／P0 | 应用批注／摘录／引用 | stable anchor，text，tag，template | 独立保存；回跳明确；原文变化标失效 | `annotation.create/update` |
| MD-24／P1 | 排版与校对 | range／block，词典／规则，拟修改列表 | 阅读行距与字体只影响视图；源码校对显式确认应用 | `markdown.proofread.prepare` |
| MD-25／P0 | 源码格式化 | block／document，规则集 | 一条明确命令、完整 diff；不会自动修改无关源码 | `markdown.format` |
| MD-26／P0 | 保存／HTML／PDF 导出 | snapshot revision，format，资源与主题选项 | 可重开；当前未保存内容准确；临时 UI 不进入输出 | `document.save/export` |
| MD-27／P1 | 离线资源打包与重定位 | assetRefs，输出目录，冲突策略 | 输出清单与 rewritten paths；不覆盖外部原资源 | `markdown.asset.package/relink` |

## 3. 属性区和选择语义

文字范围显示内联状态，段落／章节显示块属性，表格显示表格与单元格属性，代码／公式／图示显示源码编辑器和错误摘要。不能把“图片居中”默认实现为给 Markdown 加任意 CSS；若方言不支持，其展示设置只作用于阅读视图，持久修改使用明确 HTML／扩展语法策略。

混合状态示例：跨两个列表选择，其中一个有序一个无序，类型控件显示“混合”；点击“有序”统一修改所选列表。选择图片并不使字符加粗按钮默认作用于图片 alt。表格选区与正文 text range 分别表示，保留精确目标快照。

源码位置是 UTF-16 offset；字节写回、AST 位置、渲染 DOM、可视编辑器 position 分别映射。组合字符／emoji 边界在 UI 命令中按用户感知字符处理。映射失效要拒绝并重新取得目标，不用首个同文段落兜底。

## 4. 原文模型与编辑实现

`MarkdownDocument` 保存原字节、编码／BOM、换行、rawText、语法树、source range、方言、block ID 和资源关系。稳定 block ID 由事务映射保持，不能按行号重新生成。遵照 [CommonMark 0.31.2](https://spec.commonmark.org/0.31.2/) 的语法上下文，围栏、引用定义和嵌套块变化可能扩大重解析范围，但只写回实际修改的源码片段。

推荐以 CodeMirror 6 为可靠源码与历史基座；实时可视编辑候选 Milkdown／ProseMirror 仅在源码局部写回和映射验收通过后成为默认。ProseMirror 文档转换到 Markdown 的全文 serializer 不自动保证原字节保真。不能为了实现可视表格操作而每次重写全部文档。

数据路径：

```text
UI / MCP command
    → 固定稳定目标及源 revision
    → 语义操作计划 / 最小安全源码范围
    → 局部 ChangeSet 和选择/引用映射
    → 一个共同历史事务
    → AST / 渲染增量更新与读回
    → 同编码保留未改 bytes / 保存回执
```

未知扩展、HTML 注释、标签、自定义属性保留原始片段；结构编辑不能使未知语法消失。无法可靠修改的节点进入源码编辑岛；能力查询说明限制。字体／背景／行距等视图偏好不改变原文 dirty。无内容变化打开并保存，文件字节相同。

## 5. 本地 HTML 独立工具箱

本地 HTML 和网页阅读副本是可持久编辑文档；远程网页仍按主文档规则采用默认无常驻左栏。两者不能通过共同“网页工具”模糊保存语义。

| 分类 | 功能与参数 | MCP 命令族（规划） |
| --- | --- | --- |
| 结构 | DOM／AST 树、标题／section、节点移动复制删除、属性／文字查找 | `html.node.list/insert/move/remove` |
| 文字 | 内联语义、段落、标题、列表、链接，选择和源码对应 | `html.text.replace/mark`、`html.block.transform` |
| 插入 | 表格、图片、视频／音频引用、语义区块、公式、代码 | `html.object.insert` |
| 对象属性 | 节点属性、表格行列／合并、图片尺寸／alt、CSS 盒模型、display／布局 | `html.node.setAttributes`、`html.style.set`、`html.table.*` |
| 资源 | CSS／图片／字体／脚本清单，缺失、相对路径、替换与打包 | `html.asset.relink/package` |
| 源码与审阅 | HTML／CSS 源码、格式化、差异、批注、规则检查 | `html.source.patch/format`、`annotation.*` |
| 输出 | 保存 HTML、HTML+资源包、PDF、净化阅读副本 | `document.save/export` |

AST 原节点与属性顺序／注释／未知标签尽量保留；结构编辑经局部 patch，使用稳定 nodeRef＋revision＋expected source，而不是全 DOM.innerHTML 回写。CSS 控件声明修改的是内联样式、文档样式表还是仅应用阅读呈现。预览默认净化脚本与事件属性；源码保留是另一个层，不能自动把净化后的内容覆盖原文。

资源插入前记录文档根和目标资产目录；相对链接解析以文档位置为准。另存资源包返回 copied／external／missing 清单与新路径映射。离线模式不能宣称已完整归档所有跨域或认证资源。

## 6. MCP 目标与验收

每个 MD／HTML 命令由同一 CommandRegistry 发布 schema 和真实可用状态。当前实现只有源码范围修改与部分选区工具；上述语义命令是新增规划，禁止把命令 ID 当现有 tool 名。

命令目标示意：`{documentId,viewId,expectedRevision,target:{kind:'textRanges',ranges:[{blockId,from,to,affinity}]},commandId,parameters}`；结构命令用 block／section／table／asset refs。prepare 返回源码 diff、可能变化的引用、生成资源及覆盖限制；commit 返回 affectedTargets／mapping／undoToken。

基础验收样本必须包括：

1. 两段完全相同正文，编辑第二段后第一段 bytes 不变。
2. CRLF、LF、BOM 和中文／emoji／组合字符，多模式选择一致。
3. 嵌套引用／多级列表／列表内代码围栏，移动章节保留结构。
4. 表格内管道、反引号、链接，增删列／转置／TSV 粘贴保存后仍正确解析。
5. front matter 注释、raw HTML、自定义扩展，编辑相邻块不丢内容。
6. 图片相对路径、同名资源、缺失资源、另存打包，关系可重开。
7. 视图主题／缩放／模式切换不 dirty；显式格式化可统一撤销。
8. UI 与 MCP 相同命令产生等价内容；准备后同目标变化拒绝旧 commit。
9. IME／连续输入／切页保存，草稿不丢；关闭失败仍可编辑。
10. 本地 HTML 未知属性／注释保留，净化预览不回写；正文和资源导出可重开。

完整实现阶段按主文档 T0→T2 执行；每个工具通过读取、修改、撤销、保存和新会话重开后，才能进入 verified 状态。
