# 原生 Office 集成说明

本轮开始日期2026-10-13；最终源码回归、构建、指定可见阅读器/MCP与installed语义完成于2026-10-14。指定三格式流程开发/安装均通过；本文保留全部LibreOffice功能、物理输入/IME/DPI与复杂布局未覆盖边界。

## 1. 原生编辑源与应用边界

Windows 桌面中的 DOCX、XLSX、PPTX 使用内置 LibreOffice 的真实 Writer、Calc、Impress 文档模型和编辑表面。原生引擎承担正文排版、交互和计算；Electron 提供标签、格式工具分类、AI、选区胶囊和保存流程。浏览器开发预览不具备这一原生能力。

默认引擎及 Python/pyuno 来自应用内置目录。运行时创建独立 UNO socket 与短路径私有 profile；文档加载副本和检查点保存在应用管理目录。它不复用用户正在运行的 LibreOffice 会话。旧 DOC/PPT/XLS 仍先转换为现代格式，保留原件。

外观配置只写本运行时的私有 profile：`ApplicationAppearance` 跟随应用浅深主题，`AppBackground` 使用应用画布色，`DocColor` 与 `UseOnlyWhiteDocBackground` 保持文档显示背景为白色。它不修改文档的页面填充、对象颜色、内容或用户已有 LibreOffice profile；文档自身的显式样式仍由引擎呈现。

原生模型打开后成为该文档的唯一写入源。OOXML 适配器负责稳定快照的读取、检索、预览和兼容目标映射，不能把旧镜像写回活跃的原生模型。

## 2. Windows 编辑表面的集成

直接将外部 LibreOffice HWND 用 `SetParent` 挂入 Electron，受跨进程 DPI 和 Chromium DirectComposition 叠放影响；前期实验中的子窗口对象存在不等于用户能看到完整编辑表面。产品采用去标题栏、去任务栏的 **owned native dock**：把受控 Office frame 的 owner 设为阅读器，窗口矩形限制在正文区域，随主窗口移动、缩放、最小化、恢复和标签切换更新。

默认隐藏原生菜单、工具栏、状态栏、标尺和原生幻灯片分页区，由应用左侧工具区提供入口。样式、母版、动画和切换等明确命令需要原生属性 deck 时，保留该次请求的 deck，不能立即被常规隐藏逻辑关闭。原生对话框仍由 LibreOffice 绘制。

导航、Agent 和选区等可信浮层使用独立透明 owned 窗口叠放在 Office 上方。正文截图使用自有 Office HWND 的 `PrintWindow`，不依赖 Chromium `capturePage`，也不截取其他应用；后者不包含外部 HWND 像素。原生对话框属于另一窗口，当前正文截图不包含其完整像素。

布局由可信主进程传入 `ownerViewport` 与正文矩形。worker 根据实际 Win32 client 像素计算 `coordinateScale`，布局、输入、截图和 a11y 统一使用该比例。实际窗口位置及窗口/client 大小与目标误差在 2px 内，才报告 `nativeGeometry:true`；非零但被裁切的窗口不算就绪。公开 MCP 不接受 HWND 或 owner 布局权限。

## 3. 模块职责与多视图

| 模块 | 职责 |
| --- | --- |
| `packages/office-runtime` | 专用 Python/UNO 桥、文档模型、受控 HWND、原生命令、输入、截图及稳定导出 |
| `apps/desktop/src/main/native-office.ts` | 绑定阅读器与 view，可信布局、owner 跟随、浮层 ownership、低频状态同步 |
| `packages/contracts/src/native-office.ts` | 公共 driver、版本、查询与编辑契约；HWND 布置及 ownership 输入仅由可信主进程提供 |
| `packages/document-core/src/index.ts` | 唯一编辑源、文档队列、稳定镜像、保存、恢复、撤销、幂等与 Agent 校验 |
| `packages/sdk/src/office-session.ts`、`apps/local-service/src/mcp.ts` | UI、HTTP、CLI、MCP 共用的原生功能分发 |
| `NativeOfficeDocument`、`NativeOfficeTools`、`NativeOfficeStyleInspector`、`NativeOfficeFormulaBar` | 正文 host、格式分类、应用自己的选区样式控件及 Calc 公式输入 |

一个 `documentId` 对应一个原生 `sessionId` 和一个可写模型。多个 `viewId` 为同一模型建立独立 controller/frame，各自具有选区、布局和 HWND；不重新加载第二个独立 writer。写入和快照按文档串行处理。快照检查所有 live controller 的待提交输入，隐藏视图的 Calc 输入同样阻止不完整快照。

可信桌面 `stateForDisplay()` 在复制前把已绑定原生 Office 的镜像 model 投影为 `{format}`，保留文档、视图、版本及脏状态等元数据；它不改变 Core 数据，也不接入公开 SDK/MCP/HTTP。公开 `state()`、`document_read` 与快照仍含完整镜像，非原生格式不裁切。

主进程以约450ms共享流读取实际状态，供正文/左栏/公式栏复用，约900ms发无正文heartbeat；状态读取不snapshot，公开读取仍fresh。仅焦点/选区/视口使用最长2.5s持久化预算，内容/dirty/保存/关闭仍及时。最终源码已修完整语义payload去重：相同fresh state保留context对象/时间/版本，实际selection/actor/layout/source/quality变化仍传播；appearance desired/applied串行，成功确认applied、同配置失败retry、连续更新应用最后desired且不重复调用。四项纯回归通过，不等于GUI/安装版性能全验收。

## 4. 左侧工具分类

| 格式 | 分类 | 主要内容 |
| --- | --- | --- |
| Word（7） | 开始、插入、表格、布局、引用、审阅、视图 | 字体与段落、样式、图文与字段、表格结构、页面与分栏、脚注目录、批注修订、阅读布局 |
| Excel（7） | 开始、插入、公式、数据、工作表、视图、打印 | 单元格格式、行列与图表、函数和名称、排序筛选及透视表、工作表管理、冻结、打印区域 |
| PPT（9） | 幻灯片、开始、插入、设计、排列、切换、动画、放映、备注 | 实际页序与缩略图、文字、对象、母版背景、位置层级、效果、放映设置和备注 |

这些分组是界面组织方式，不是能力声明。常用入口先对少量候选查询当前文档/选区的真实 `available/enabled/state`，不在初次阅读时加载完整菜单。展开“全部引擎命令”才按需取得目录并按引擎身份缓存，搜索仅刷新可见项状态；不把目录存在当作当前可执行。复杂命令仍可打开原生对话框或属性 deck，显式类型参数不能由界面猜测。

命令发现来自原生 `XDispatchInformationProvider` 与模块菜单配置。Writer 实测发现 1036 项，**不等于覆盖所有 UNO 命令，也不等于这些命令在所有选区都可用**。文件、窗口和应用 chrome 操作由 AgentViewer 管理；宏和原始脚本执行保持关闭。对这些受管理命令查询状态会返回禁用原因，不执行也不抛修改授权错误。

## 5. 阅读上下文、选区与版本

`engineEpoch` 标识当前引擎实例；`engineRevision` 标识原生修改事件；Core 的文档 revision 只在接受稳定快照后更新。`selectionEpoch` 跟踪文字范围、单元格范围或对象身份；滚动导致的选区矩形移动不单独生成新语义选区。`layoutRevision` 跟踪实际矩形、缩放和可见区域变化。坐标操作必须提供当前布局版本，截图位图像素不能直接作为 CSS 输入坐标。

Windows 可见正文通过自有 HWND 的 MSAA document 子树及 IA2 `IAccessibleText` 提取，字符屏幕矩形被裁切并归一到正文 CSS 坐标。Calc 使用实际表格命中测试处理可见单元格及冻结窗格；PPT读取当前页实际文本。它不把整份 UNO 文档文字或界面菜单混入 `visibleText`。

提取有时间、节点及文字预算，超出时报告 `visibleTextTruncated`。失败明确 `visibleTextReady:false`、`visibleTextSource:'unavailable'`，不能用空字符串冒充完整读取。Writer、Calc、PPT 的独立实际 a11y 专项已经取得可见正文证据；Writer 选区真实矩形及滚动后离屏清除、Calc A1 与冻结窗格也有专项证据。

选区替换须绑定当前版本和 `selectionEpoch`，并匹配完整实际 XTextRange；对象选择或截断文字不冒充可编辑文字范围。旧 OOXML 段落目标与原生段落按数量和文字严格对齐；复杂文本框导致映射不一致时明确拒绝。Impress 私有文字事务校验真实页、唯一对象、UTF-16 选区及 expectedText 后固定构造 SelectText/InsertText，保留范围及全对象双回读；公共 TransformDocumentStructure 禁止调用者 raw DataJson/嵌套 UnoCommand 绕过类型化目标，不全局禁止普通命令的 DataJson。PyUNO 的 End 结构体须整体赋值，逐字段修改其 by-value getter 不能确认新范围。

## 6. 首批应用内样式控件

`office_query` 使用 `{kind:'style',target:'text'|'paragraph'|'cells'|'shape'}`，返回真实目标的 `targetKind` 与 `fields[name]={value,state,available,reason?}`。`state` 区分 direct/default/mixed/unsupported，混合值保持 null；不支持或没有真实目标时提供原因，不猜整份文档或第一个形状。

| 目标 | 首批 primitive 字段 | 目标与单位 |
| --- | --- | --- |
| text | 字体、字号、粗斜体、下划线、删除线、文字色、高亮色 | 真正非空 XTextRange；字号 pt，按支持情况处理西文、亚洲及复杂文字属性 |
| paragraph | 对齐、左/右/首行缩进、段前后距离、百分比行距 | 当前实际段落或所选段落；长度 mm、行距百分比，Writer 允许 twip 量化 |
| cells | 文字样式、水平/垂直对齐、换行、填充、数字格式代码 | Calc 实际单元格范围；数值、公式、类型和计算不随格式修改改变 |
| shape | x/y/width/height、旋转、填充、线色、线宽 | Impress 实际所选对象；长度 mm、旋转度、线宽 pt，不猜首个对象 |

`office_execute` 一次指定 command/cell/replacement/style 之一，样式形如 `style:{target:'paragraph',values:{left:12.5,lineSpacingPercent:150}}`。样式必须携最新 `expectedEngineEpoch`、`expectedEngineRevision`、`expectedSelectionEpoch` 和幂等键；所有字段严格有界，拒空 patch、未知键、原始 UNO 属性路径或脚本。可信 worker 才创建 UNO enum/struct，执行前完整预检并保留草稿、输入、控制 lease 与原生撤销保护。

形状先以 `office_query {kind:'shapes',slideIndex}` 取得实际对象名，再 `office_navigate {kind:'shape',slideIndex,name}` 选择该页唯一同名对象；不存在或重名拒绝。列表最多 500 项并报告 `total/truncated`；其 `bounds` 与既有单对象查询保持原生 **1/100mm**，列表带 `unit:'1/100mm'`，与样式接口 **mm** 必须区分。文本截断另有 `textTruncated`。

这是首批字体、段落、单元格和对象属性的内化，不是整套 LibreOffice UI 的移植；未内化功能仍通过真实引擎目录及对话框使用。

## 7. Excel 公式与查询

三条路径——`office_cell_set`、兼容 `sheets.setCell` 的 formula、矩阵粘贴中的公式——共用原生 `FormulaParser.parseFormula → XFormulaTokens.setTokens`，配置英文函数、Excel A1 地址及完整 `XL_ENGLISH` OpCodeMap。公式读取使用同一 parser 打印 token 并保证 `=` 前缀，支持逗号参数及带空格/中文的 `sheet!A1` 引用，不做逗号/分号字符替换。

内置实现未暴露文档中列出的 `ParameterSeparator` 属性。代码先检查真实属性，存在时设置逗号；不存在时使用原生 Excel map 的分隔符语义。实际无界面 UNO 专项已验证 `SUM(20,22)=42`、中文带空格跨表引用、带逗号/分号的字符串和 IFERROR。单元格范围查询同时返回 `values`、Excel 语法 `formulas` 及原始 `errors:number[][]`；除零产生结果 null 时明确配对错误码 532。

非公式输入保留原生数值/文本解释。结构化适配器的读取裁切范围不代表原生 Calc 网格、计算引擎或工作表总容量的上限。

## 8. 保存、恢复、撤销与 Agent

快照在管理目录使用 `storeToURL`，不更改原生 model URL。检查导出前后 engine revision、撤销状态和脏状态；不稳定时有限重试并返回 `SNAPSHOT_BUSY`。同版本已经验证的字节复用缓存，避免仅 ZIP 元数据变化产生反复镜像更新。

PPTX exporter临时改live布局污染撤销，故先稳定ODP，再私有隐藏只读clone导出PPTX并验live revision/undo/dirty。clone继承accent1/null/FillTheme=-1失败后，按actual页/count/name/type/text对齐，仅clone复制RGB/完整ComplexColor/InteropGrabBag，不动source版本/Undo、不拼OOXML。production/开发523LT6/安装VRVNwR指定fill重开通过，不宣全部theme-line XML往返；getter局部线色apply/redo不代表完整线条XML矩阵，这不是已确认新lineXML bug。

`unsavedContentChanges` 从真实 `doc.isModified()` 初始化；Modify 通知及状态读取看到真实脏状态后保持 true。阅读元数据变化不凭 revision/ZIP 猜测内容修改，原生临时保存也不清除该标记。只有应用把对应稳定字节保存到目标文件、核对 hash，并严格完成 `ackSaved`，才清除。确认自身的 `setModified(False)` 通知只在版本和撤销状态均未变时窄范围抑制；并发修改使确认失败且保留脏状态。

原生 Ctrl+S 等受管理快捷键通过 frame interceptor 交还应用保存/关闭流程，不能只保存临时加载文件。导出副本通过版本检查后写新路径；不覆盖原文。撤销使用实际 UndoManager 顶部 token，不能向活跃原生引擎回灌旧 OOXML 文件。正常关闭先取得稳定检查点；worker 退出则保留最后确认恢复内容，不把旧镜像当作最新修改。

类型化样式组成一组真实原生撤销；Impress 直接 XShape setter 不产生原生历史时，注册持有精确前后属性/PropertyState/几何的 `XUndoAction`，撤销和重做均验回读。setter 失败只撤回自己的新组或恢复捕获值，不清空旧历史。属性/输入恢复失败明确报错；属性虽恢复但原有 redo 已被新编辑丢弃时返回 `NATIVE_STYLE_ROLLBACK_UNVERIFIED`，不声称完整原子回滚。Core 在 style 或 replacement 失败后刷新实际状态/稳定快照并持久化检查点，再抛原始错误；不回灌旧字节、不写源文件、不造 applied/lastEdit 或自动重试。iCrUe6 的真实检查点改字但范围校验失败，说明错误不能等同于没有修改。

Agent acquire/status/release固定view/controlId，与人类暂停/停止分开，prepare绑定doc/view/control epoch不漂移；旧control不释放新会话。执行校验版本/选区/暂停/lease；已发生不因release伪报未执行或重建Agent状态。幂等键绑定内容，未知超时不重发。actor保留到state采样，开发523LT6与installed VRVNwR各28command/style/replacement office_execute均actoragent实测通过。

通用命令异步 dispatch 返回 `dispatched`；打开对话框或发送按键本身不证明文档修改已经应用或保存。之后须回读状态、查询目标、同步稳定快照并取得应用保存回执。

## 9. 验收状态与剩余边界

最终432/432单元、0fail/skip，build成功；2026-10-14 00:21:10+08 rendererDXEFkOLV/BKUkaMOr，mainSHA991824E0CFCF6BA188E6507D5662DFEB8FC9B53186125724733B69C491447303。UI qC26Eh/startup wFfJR9/reader Rm4shL及独立4目标/快照/生产色通过。开发523LT6与安装VRVNwR可见reader/stdioMCP均passedtrue/errors[]/exit0：W/C全文段序/公式42/样式/Undo/save新session重开，PPTtrueText/替换/reentry/text/shape Undo/XMLexact/色字号重开；各28execute actoragent、原examples不变。installed真实EXE为C:/Users/cth/AppData/Local/Programs/AgentViewer/AgentViewer.exe，resources/app身份/mainSHA匹配/privateTEMP，445MCP回执；physicalKeyboard/Mouse=false。仅reopen w/h1单位量化；80×30mm autoGrowoff与0.99mm窄autoGrow限制、Undo几何真变setter/PointSize先enum保留，不宣全主题/线XML/布局。早期LockApp guard记录不绕过，也不猜当前前台。

尚未完成的验收包括：真实原生 IME 组合输入、OLE 文件拖入新标签闭环、Windows 100%/150%/200% 全矩阵，以及复杂 Word 域/文本框/修订、PPT 母版/动画/嵌入对象、复杂表格/图表/打印的完整往返样本。原生对话框与应用浅深主题的一致性、单独 modal capture/坐标控制也需后续验证。

滚动由共享流/MCP viewport更新，不承诺逐帧/全文伪可见。本轮432单元/build/production/context-appearance/523LT6/installed VRVNwR已有实证，源码d4711fb32ec63888de1cee1df26fb416fccb0aec。installation-sync-20261014-003121.json apply/verify/portable PASS：19候选/8变更/19逐SHA、mainSHA匹配；plan-02bca3136388430c953846a2b9cbe199.json build摘要CC9E89933B154DFF1D968B99960E6CECD3F11317FC321BF6ECFE8A99775AF385，EXE/engines/deps/package/profile未改。installed实测另PASS，portable仅同runtime文件验证；正式文档/远程发布主线收尾，物理/IME/DPI/全部命令与特性、GUI idle性能不据此全验收。

## 10. 官方接口参考

- [XModel2 多 controller](https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1frame_1_1XModel2.html)
- [XDispatch](https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1frame_1_1XDispatch.html) 与 [XDispatchInformationProvider](https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1frame_1_1XDispatchInformationProvider.html)
- [FormulaParser](https://api.libreoffice.org/docs/idl/ref/servicecom_1_1sun_1_1star_1_1sheet_1_1FormulaParser.html)、[XFormulaTokens](https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1sheet_1_1XFormulaTokens.html)、[XFormulaOpCodeMapper](https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1sheet_1_1XFormulaOpCodeMapper.html)
- [实际 FormulaParser 实现](https://github.com/LibreOffice/core/blob/master/sc/source/ui/unoobj/tokenuno.cxx)，用于核对 API 文档与实际属性差异。
- [XPropertyState](https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1beans_1_1XPropertyState.html) 与 [XUndoAction](https://api.libreoffice.org/docs/idl/ref/interfacecom_1_1sun_1_1star_1_1document_1_1XUndoAction.html)，用于混合/默认样式及对象真实撤销。
