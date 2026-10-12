# PDF 左侧工具箱与原生编辑需求附件

日期：2026-10-12。范围：Windows 横版桌面、本机内置引擎、多视图、用户与 harness 共用命令。本文细化[左侧工具箱主需求](LEFT_TOOLBOX_REQUIREMENTS_2026-10-12.md)与[完整编辑能力规划](EDITING_CAPABILITIES_PLAN_2026-10-12.md)第 7 节，区分当前代码、待开发能力与引擎验证项，不把下面的命令名当作现有 API。

## 1. 当前基线与必须纠正的能力名称

当前 `PdfAdapter` 仅登记 `pdf.addText`、`pdf.highlight`、`pdf.markup`、`pdf.rotate`、`pdf.addPage`。`open()` 的模型仅含页数，尚无原生对象、字体、字段、批注或结构模型。高亮/下划线/删除线通过 `drawRectangle/drawLine` 加入页面内容流；`pdf.addText` 新增文字，并没有替换原有文字。增补文字和旧式点击高亮还拒绝旋转页、非零 CropBox 原点。选区 note 保存在应用侧，与写进 PDF 的原生评论不同。

`PdfReader` 用 PDF.js 逐页串行创建 canvas 和 text layer，编辑/缩放后重建全部页面；没有页面缩略图虚拟化、annotation/widget 交互层或原始对象选择。源码证据：

- [PdfAdapter](../../packages/format-adapters/src/index.ts)、[编辑合同](../../packages/contracts/src/index.ts)。
- [PdfReader](../../apps/desktop/src/renderer/components/PdfReader.tsx)、[DocumentPane](../../apps/desktop/src/renderer/components/DocumentPane.tsx)。
- [选区工具服务](../../packages/selection-tools/src/index.ts)、[现有 MCP 工具](../../apps/local-service/src/mcp.ts)。

必须分别显示“新增文字”“编辑现有文字”“应用侧笔记”“PDF 原生批注”。保留旧文件中的覆盖标记，不能根据颜色或位置猜测并删除已有页面图形。pdf-lib 官方也明确普通页面文本的读取、修改与删除不属于其高级 API 能力；迁移期不能据此宣称任意 PDF 正文编辑。[pdf-lib 官方限制](https://github.com/Hopding/pdf-lib#limitations)

## 2. 布局与入口

左侧采用可展开的工具箱，不重新放回工作区目录。完整分类为“页面”“定位”“编辑对象”“插入”“批注”“表单”“扫描与 OCR”“脱敏与保护”“检查与导出”；任务栏默认显示前七组，后两组归入“更多”并允许自定义固定，以符合主需求的可见分类数量。再次点击当前图标收起面板，切换图标替换当前面板。页面组默认开放；专业组可折叠，检索工具能直接定位到具体命令。

选区浮动胶囊仍负责高亮、下划线、删除线、添加评论、翻译、复制引用；左侧批注面板负责列表、过滤、回复和批量属性，避免把同一套选区快捷按钮再次铺进左栏。原生对象选中后，在原位显示缩放/旋转手柄，左侧编辑面板呈现精确属性。保存、撤销和缩放使用现有全局导航入口，左侧不新增相同按钮。

每个工具有 `enabled / disabled / busy` 与原因；属性另有 `value / mixed`。工具箱能展示“依赖未内置”“此对象字体不可编辑”“文档受保护”“当前文件为 XFA”等具体原因。不能只用 `selection.text` 非空来决定可编辑性。

工具范围参考 Acrobat 的文字/图像、页面组织、扫描、表单、批注与保护工作流；具体工具分组、命令和实现约束是本项目的设计。[Acrobat 编辑工作流](https://helpx.adobe.com/acrobat/using/edit-pdf.html)、[Acrobat 页标签](https://helpx.adobe.com/acrobat/desktop/edit-documents/organize-pages/renumber-pages.html)

## 3. 对象、坐标与版本模型

所有命令指向 `documentId + sessionId + engineEpoch + expectedContentRevision`；视图操作另带 `viewId + layoutRevision`。共享会话允许用户切换标签，agent 的目标始终绑定原 view，不跟随当前激活页漂移。

| 对象 | 必须可读取的字段 | 身份与限制 |
| --- | --- | --- |
| Page | `pageId, index, label, MediaBox, CropBox, TrimBox, rotation, UserUnit, sourceDigest` | 应用 UUID 为身份；页码和展示标签不是身份，复制/导入页生成新 ID |
| ContentObject | `objectId, pageId, kind, bounds, matrix, clipPath, opacity, resourcePath, sharedResource, sourceHash` | 区分 text/image/path/Form XObject；同一资源的每个绘制实例有独立 occurrence ID |
| TextRun | `runId, unicode, glyphCodes, fontRef, fontName, fontSize, writingMode, baseline, quads, encodingQuality, editability` | Unicode 提取成功不代表能反向写入原字体；段落是带置信度的派生结构 |
| Annotation | `annotationId, nativeType, pageId, quads/rect/ink, contents, author, color, opacity, replyTo, status, appearance` | 原生批注与应用摘录分开，禁止两个系统各维护一份可写真值 |
| FormField | `fieldId, fullyQualifiedName, type, widgetIds, flags, value, defaultValue, options, maxLength, tabOrder, appearance` | 同名字段可能有多个 widget；读写 field 值与移动单个 widget 分开 |
| OCRResult | `jobId, sourceRevision, pageId, region, dpi, language, orientation, words, confidence, corrections` | 冻结原页；不能把晚返回的结果插到已变化的页面 |
| Signature | `signatureId, fieldId, coveredRevision, byteRange, digestState, trustState, timestampState, permittedChanges` | 不把视觉签名图片当作证书签名 |

坐标主协议使用页面自身的 PDF user space 点和显式 `coordinateSpace`，保存完整矩阵；阅读选区报告 glyph quad，而非仅矩形。UI 的 CSS/DPR/缩放/页旋转/CropBox/UserUnit 转换在统一 `PdfCoordinateMapper` 内完成。多页选区每段都有自己的 `pageId` 和 quad。旧归一化 `pageIndex + x/y` 接口只作为迁移适配器，准备命令时解析到固定 pageId 与固定页面几何。

MuPDF 文档区分页面坐标与 PDF user space，并提供页面框、批注、widget 和脱敏能力；有些 JavaScript 接口标注 `only mutool run`，不能把它们直接视为 npm/WASM 功能。[MuPDF PDFPage](https://mupdf.readthedocs.io/en/latest/reference/javascript/types/PDFPage.html)

## 4. 页面工具箱

| 具体工具 | 目标与主要参数 | 结果和验收 |
| --- | --- | --- |
| 缩略图/多页选择 | `pageIds`、单选/Shift 范围/Ctrl 多选、拖动前后插入线 | 可见缩略图优先，当前页跟随，跨 1000 页仍可操作 |
| 新增/插入页 | `afterPageId`、空白尺寸/方向、图片或来源 PDF 页、资源引用 | 返回新 pageIds；跨文档对象通过 graft/copy，不共享外来对象句柄 |
| 删除/复制/替换/重排 | `pageIds`、`destinationPageId`、链接与表单迁移策略 | 页树、书签、链接、字段引用同步；最后一页处理规则明确；重复页使用新身份 |
| 旋转/页面尺寸 | `pageIds`、90°倍数、尺寸、锚点处理 | 页级几何和坐标版本递增；不能只转 canvas 的视觉外观 |
| 裁剪 | `pageIds`、框类型、点坐标、预览范围 | 常规 CropBox 裁剪只是隐藏；“永久移除裁剪外内容”使用专门内容删除流程 |
| 抽页/合并/拆分 | 来源 pageIds、分组/页数/书签层级、输出命名 | 生成独立文档身份和真实文件，返回来源映射、被丢弃引用与字段重名策略 |
| 页标签 | 前缀、起始序号、阿拉伯/罗马格式、应用范围 | 标签与文件页面序号分别保存和显示，不把页面原文中的数字改掉 |

删除页面不自动等于安全擦除：MuPDF 官方指出，重排删除后对象可能仍存在，需相应垃圾回收保存策略。普通页面组织与“清除可恢复数据”应分别定义。[MuPDF PDFDocument 页树与保存](https://mupdf.readthedocs.io/en/latest/reference/javascript/types/PDFDocument.html)

## 5. 搜索、定位与编辑现有对象

定位面板包含全文文字、原生批注、书签、表单字段、对象与附件检索；结果标明文本层/OCR/批注来源、页标签和真实页序。搜索建立逐页索引，进度显示已覆盖页数，不把当前 24k 可见文本快照当作全文。

| 工具 | 参数重点 | 实现边界 |
| --- | --- | --- |
| 编辑现有文字 | `runIds`、`expectedText/sourceHash`、替换内容、字体策略、样式、对齐与溢出策略 | 必须删除/重建实际内容流对应字形；不得默认白色覆盖。先支持单 run/单行，再扩展受限段落 |
| 字体与段落属性 | 内置 `fontId`、字号/颜色/字距/行距、书写方向、限定框 | 原字体缺字、无可用嵌入字体或字形逆映射失败时返回具体原因；可显式选择替代字体并预览 |
| 文本重排 | `runIds`、允许的重排框、字体映射、行距、段落识别置信度 | 不承诺任意 PDF 的 Word 式重排；复杂 Type3、RTL、竖排、连字、剪裁、艺术字先返回受限能力 |
| 图像编辑 | occurrence/object ID、替换资源、裁剪框、matrix、尺寸/透明度 | 同图多次引用使用 clone-on-write；只改目标绘制实例，保留原色彩/软遮罩影响报告 |
| 路径/图形/Form 编辑 | 目标 path/实例、填充/笔画/宽度/transform/clip、前后层级 | 嵌套 Form 和共享资源显式标明；不把整个页面渲染截图后冒充对象编辑 |
| 删除对象 | object IDs、预期摘要、结构/引用影响策略 | 删除真实绘制操作；安全擦除另走脱敏与完整重写验收 |

新增文字与编辑现有文字是不同命令；原始文本框不一定存在于 PDF 中，因此 `TextRun` 到内容流/Tj/TJ/glyph 的映射、字体编码以及受限重建由本项目实现。MuPDF 作为处理和写入内核，不能凭接口名称承诺已获得完整段落编辑器。Adobe 的文字编辑、文本框与图像工作流可用于功能验收，而非证明本项目保真。[Acrobat 文字编辑](https://helpx.adobe.com/acrobat/using/edit-text-pdfs1.html)、[MuPDF 原生页面 API](https://github.com/ArtifexSoftware/mupdf/blob/master/include/mupdf/pdf/page.h)

## 6. 插入与批注

插入组包含文字框、图片、矢量形状、页眉/页脚/页码/Bates 编号、水印/背景、链接、附件和书签。指定 pageIds、布局/位置、字体/资源、前景或背景、替换规则。应用生成对象保留 manifest 与对象身份，后续“更新水印”只更新本应用拥有的对象，不根据相似外观删除任意内容。

批注组包含原生评论/回复列表、作者/时间/颜色/状态筛选、批量属性、回跳、批注清单与带批注副本导出；浮动工具负责 text markup、便签、文本框/呼出框、手绘、箭头/线/矩形/椭圆/多边形、图章。手绘的连续笔画提交为合理事务，页面翻转不丢失当前 stroke。

原生 markup 使用准确 QuadPoints；所有批注更新 appearance，使外部阅读器能显示并继续编辑。扁平化是独立导出动作，明确丢失可编辑批注/表单，不与普通保存混用。应用侧摘录保留来源 pageId/quote/quads 和源版本，导出到原生批注通过明确迁移命令完成。[MuPDF PDFAnnotation](https://mupdf.readthedocs.io/en/latest/reference/javascript/types/PDFAnnotation.html)、[Acrobat 批注工作流](https://helpx.adobe.com/acrobat/desktop/share-and-review-documents/review-documents/add-comments.html)

## 7. 表单工具箱

填表与制作表单分开。填表入口列出文本、多行、组合/列表、复选、单选、按钮、签名字段；制作入口提供新增/删除/复制 widget、字段名与 tooltip、尺寸/位置、对齐分布、默认值、必填/只读/maxLength、导出值、tab 顺序、格式/校验/计算与外观字体。字段/选项/值都用类型化数据，不把所有值转换成字符串后写回。

命令分为 `pdf.form.setValue`、`pdf.form.updateField`、`pdf.form.updateWidget`、`pdf.form.create/delete`、`pdf.form.import/exportData`、`pdf.form.flattenCopy`。共同参数包含 fieldId/widgetId、旧值/源摘要、值类型、是否更新 appearance。表单批量写入为单一会话事务，跨多个 widget 的同字段值保持一致。

MuPDF 提供 widget 值读取、文字/choice 设置与开关交互，字段标记和约束仍需统一映射；项目不得直接执行 PDF 中的 JavaScript、自动提交表单或打开远程资源。XFA、脚本计算和特殊条码等逐项报告支持程度，不能用栅格化结果宣称保留表单交互。[MuPDF PDFWidget](https://mupdf.readthedocs.io/en/latest/reference/javascript/types/PDFWidget.html)、[Acrobat 字段属性](https://helpx.adobe.com/acrobat/desktop/work-with-pdf-forms/customize-form-fields/field-properties.html)

## 8. 扫描、OCR 与图像清理

扫描面板提供页面/区域语言、方向、去倾斜、DPI、去噪、二值化、背景清理、对比度，区分预览与实际图像替换。OCR 结果展示字词框、置信度、低置信度校对与文字层覆盖情况；扫描页没有文字层时，选区允许先选区域识别。

`pdf.ocr.start` 冻结 sourceRevision 和 pageIds/regions；参数为语言列表、DPI/方向、预处理、`outputMode=review|searchableLayer|independentCopy`、已有文字层策略。创建可搜索层前检测既有文字，避免双层复制/双重搜索；校对结果再由唯一 PDF 会话写入隐藏文本层。Tesseract 输出的可搜索 PDF 是图像与独立识别文本层，hOCR 提供字词框与置信度；它本身不等于扫描原图已修改。[Tesseract 官方输出说明](https://tesseract-ocr.github.io/tessdoc/Command-Line-Usage.html)

“编辑扫描文字”需明确旧像素移除/修补范围、新文本与字体、背景重建和质量提示；低质量结果可保存独立副本。OCR 任务可取消、恢复检查点；页面被修改后，旧结果不能静默应用到新页。

## 9. 脱敏、保护与签名

### 9.1 真正脱敏

流程为搜索/区域标记 → 检查名单 → 应用到固定版本 → 完整重写/垃圾回收 → 检查产物。红框或黑框只是标记。`pdf.redaction.mark` 接受 pageId+quads/rect、原因码、覆盖外观；`pdf.redaction.apply` 接受 markIds、文字/图片/线条处理策略、隐藏信息清理范围、输出文档与文件策略。

应用后的交付文件必须移除原文、图像对应像素和相关隐藏数据，不能采用增量保存把旧内容留在文件历史中。清理范围包含元数据、附件、批注/表单值、隐藏文字与图层等，逐项报告；共享 XObject、跨层内容、OCR 文本层和裁剪外图像都进入测试。`CropBox` 隐藏或高亮颜色不能作为脱敏成功证据。应用原文件/备份中仍可能保有未脱敏来源，产物报告明确覆盖的文件身份，不自动清除用户其他原件。[Acrobat 删除敏感信息](https://experienceleague.adobe.com/en/docs/document-cloud-learn/acrobat-learning/advanced-tasks/protect/redact)、[MuPDF 应用脱敏](https://mupdf.readthedocs.io/en/latest/reference/javascript/types/PDFPage.html#PDFPage.prototype.applyRedactions)

脱敏提交包含可检查的计划摘要和固定源版本。活动文档内可使用受控恢复点返回未提交编辑状态；安全导出完成后，撤销不能伪称敏感数据仍存在于该已交付文件中。回执区分 `removedInArtifact`、检查项、尚未检查范围与 sourceRetention。

### 9.2 密码与证书签名

保护工具显示打开/编辑/打印/复制/组装权限、加密算法和密码状态；使用主进程凭据引用，不把密码放进日志、普通设置或 harness 上下文。qpdf 用于结构检查、优化与加密等辅助处理，不能承担页面正文排版与编辑。[qpdf 官方命令说明](https://qpdf.readthedocs.io/en/stable/cli.html)

视觉手写/图片签名是普通图形操作。证书签名独立提供证书引用、签名字段、reason/location、时间戳、允许变更、签名外观；签前冻结版本，签后任何修改重新报告完整性、信任链、时间戳和变更是否允许，不能一个绿色“有效”概括全部状态。签名验证使用 pyHanko 等专门组件；既有签名、增量更新与差异分析是独立的验收问题。[pyHanko 签名 API](https://github.com/MatthiasValvekens/pyHanko/blob/master/docs/lib-guide/signing.rst)、[pyHanko 验证模型](https://pyhanko.readthedocs.io/en/latest/cli-guide/validation.html)

## 10. 检查、结构、导出与后台性能

检查组包含文档属性/语言、书签/链接/附件、图层、字体与资源、结构标签/阅读顺序/替代文本、PDF/A/PDF/UA 验证、缺字、表单/签名状态、空间占用与损坏修复报告。标签修复是真实结构修改，验证是独立任务；veraPDF 的 PDF/UA 检查只覆盖机器可验证项，人工阅读顺序和替代文本质量不能据此宣布通过。[veraPDF 验证范围](https://docs.verapdf.org/validation/)

导出包含页/选区/图像、独立合并/拆分文件、批注清单、带批注副本、表单数据、可搜索副本、优化副本、印前/标准转换产物。全局普通保存不扁平化、不默默移除签名、不嵌入 Agent 光标或 UI 浮窗。

PDF.js 负责阅读、可见页优先渲染、文字/批注/widget 交互层；禁止其独立保存分叉。缩略图与全文索引按页生成，渲染队列可取消，canvas/页位图用尺寸预算 LRU，单次对象编辑只使受影响页和映射失效。当前全页串行重绘列为必须改造项，不通过缩小正文像素假装流畅。[PDF.js 官方 API](https://mozilla.github.io/pdf.js/api/)

## 11. 唯一 writer 与发行内置

主路径仍是 PDF.js + Windows 本机 MuPDF worker。MuPDF 会话是活动 PDF 权威 writer；pdf-lib 迁移期只服务旧基础操作，切换时先同步输入、冻结版本、重新打开会话，不并行改同一文件。qpdf/pyHanko/OCR/验证组件处理固定修订的临时产物，由 SaveCoordinator 校验并发布，载回活动会话时递增 engineEpoch 并失效旧句柄。

原生 worker 需要本项目维护的对象/内容流/字体桥，采用固定 ABI 与独立进程，限制输入大小/执行时间并报告崩溃恢复状态。MuPDF JavaScript 文档可以作能力参照，实际实现以固定版本 C 头文件与源码为准；不执行用户 PDF 所附任意脚本。[MuPDF C 文档声明](https://github.com/ArtifexSoftware/mupdf/blob/master/include/mupdf/pdf/document.h)

PDF/OCR 工具、可嵌入字体、语言包和必要运行时随发行包内置；首次使用不能要求用户再安装 Python/Java/Office。清单记录版本、SHA、许可证、可用命令和离线状态。MuPDF 官方提供 AGPL/商业两种路线，主体项目与各组件的发行许可须明确，已有 BabelDOC 不等于自动完成 MuPDF 的集成许可选择；这是发行前核查项，不是当前运行功能开关。[MuPDF 官方许可](https://mupdf.readthedocs.io/en/latest/license.html)

## 12. 工具对象与 harness/MCP

所有左侧命令、选区胶囊、键盘和 agent 调用同一 `PdfCommandRegistry`。它是全应用 `CommandRegistry` 的 PDF contribution／适配器，不建立另一套执行或撤销系统。只读命令提供 `pdf.listPages / readRegion / listObjects / inspectObject / listAnnotations / listFields / inspectSignatures / search`，分页结果绑定 revision 与 engineEpoch，不能通过返回截图替代实际对象与文本。

```ts
type PdfTool = {
  id: string; group: string; label: string; icon: string;
  targetKinds: ('page' | 'text-run' | 'object' | 'annotation' | 'field' | 'region')[];
  mutation: 'none' | 'edit' | 'artifact';
  requiredCapability: string; inputSchema: object;
  state: { enabled: boolean; reason?: string; value?: unknown; mixed?: boolean };
};
type PdfCommandTarget = {
  documentId: string; sessionId: string; engineEpoch: number;
  expectedContentRevision: number; viewId?: string; layoutRevision?: number;
  pageIds?: string[]; objectIds?: string[]; sourceHashes?: string[];
};
```

拟增变更命令族：`pdf.pages.*`、`pdf.content.*`、`pdf.insert.*`、`pdf.annotation.*`、`pdf.form.*`、`pdf.ocr.*`、`pdf.redaction.*`、`pdf.security.*`、`pdf.signature.*`、`pdf.structure.*`、`pdf.export.*`。具体参数如前述各组；UI 不向 renderer 暴露原生对象地址或任意引擎脚本。

| 共同回执 | 规则 |
| --- | --- |
| `transactionId, idempotencyKey, before/afterRevision, engineEpoch` | 同键同载荷只执行一次，不同载荷拒绝；不能因重连重复删除页面/签名 |
| `affectedPageIds, changedObjectIds, anchorRemap, renderInvalidation` | 结构变化返回旧→新锚点；失效锚点显式说明，不把旧坐标继续当成有效 |
| `fidelityReport, unsupportedRegions, fontSubstitutions, overflow` | 未覆盖内容不能报完整成功；字体替代与重建范围可检查 |
| `undoPolicy, inverseTargetGuards, irreversibleArtifact` | 常规编辑可目标级条件撤销；并发用户改同对象拒绝旧 inverse |
| `artifacts, sourceRevision, outputHash, coverage, validation` | 导出身份独立，校验真正写入的文件而非旧缓存预览 |
| `signatureImpact, sourceRetention, redactionVerification` | 签名/敏感产物影响随任务报告，凭据与被脱敏正文不写进普通日志 |

现有 MCP `document_capabilities`、`document_plan_patch`、`document_apply_patch`、`document_undo`、选区工具和 `reader_get_context` 可扩展接入，但当前 schema 未登记这些高级 PDF 操作。发现接口需分别返回“supported”“disabled by permission”“requires engine”“requires object inspection”，不能只公布一张静态菜单。准备/提交校验源版本、字体/对象/权限、输入中的目标摘要和签名影响；任务阶段来自实际 worker，不用假进度。

## 13. 实施与交付门槛

1. **P0**：页面/缩略图、stable pageId、对象/字段读取投影、统一坐标、可见页渲染、原生批注列表与编辑、保存重开与 MCP 闭环。
2. **P1**：页面组织、插入、基础文字/图像/路径编辑、AcroForm 值与制作、OCR 可搜索层、受限文本重排、真实脱敏。先验证 native worker 与字体桥再开放 UI。
3. **P2**：证书签名、结构/无障碍修复、标准/印前验证、复杂扫描重建、专业测量与比较。每项单独记录能力范围，不能用“高级 PDF 已完成”取代验收。

必验样本包括：0/90/180/270°与非零 CropBox/UserUnit、跨页 quad、同图共享引用、嵌套 Form/clip、CJK/RTL/竖排/连字/缺字、1000 页大文件、字段多 widget/同名导入、已有签名、扫描+OCR 重复层、增量历史与裁剪外/隐藏层敏感文字。各操作必须通过 UI → 真实引擎 → 保存 → 外部重开，以及对应 harness 命令；脱敏另做原文提取/解压流/对象/图像覆盖检查，签名另做加密完整性与信任状态检查。

验收也必须证明：agent 目标不随标签切换；用户与 agent 对不同对象可同时操作，对同目标冲突可定位；关闭原文或停止任务不串改别页；撤销不覆盖用户后续对象变更；任务/缓存清理不删正式产物。本文仅完成需求与实现边界，不声明这些工具现已交付。
