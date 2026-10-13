# REA 分析与 Office 工具内化

本轮开始日期2026-10-13；最终源码回归、构建、指定可见阅读器/MCP与安装版语义完成于2026-10-14。本文区分二进制观察、源码交叉检查、真实运行与未覆盖范围。

## 目标与实现边界

将高频编辑操作、目标选择、属性检查和事务管理放入 AgentViewer 自己的工具与 MCP 契约。Writer 排版、Calc 计算、Impress 渲染以及格式导入导出仍由内置 LibreOffice 承担。本轮没有将 LibreOffice 整个二进制重写成 JavaScript，也没有移除共享原生引擎。

## 已安装的开发工具

| 工具 | 版本 | 使用范围 |
| --- | --- | --- |
| REA CLI / rea-agents | 6.4.0 | 原生二进制概览、搜索、函数证据、资源清单 |
| Eclipse Temurin 完整 JDK | 21.0.12.1+1 | Ghidra 所需 Java 与 javac |
| NSA Ghidra | 12.1.4 PUBLIC | Windows PE x64 分析后端 |

这些是本机开发工具，不加入 AgentViewer 安装包，也不增加阅读器启动时的依赖。REA 仓库快照为 `fb28ec1537e2d02aaca96325483c849c5c8ade6f`。Ghidra 官方压缩包 SHA-256 为 `ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db`。

REA 的 Windows Ghidra 支持目前为实验性 P0，只使用其实际可用的只读操作。工具的其他提供商未配置，不把它们算作已启用。

## 实际取得的二进制证据

目标来自本项目内置 LibreOffice 26.8.1.1，而不是另一个机器的替代样本。

| 证据 | 观察 | 证据 ID |
| --- | --- | --- |
| cppu3.dll 概览 | PE x64；识别 2249 个过程和 588 个字符串 | `ev_55ae9025a3b951bb8e3a14a76aad535b63fb558cdfe6a1f9b2be7f26bed1dcb5` |
| UNO 导出定位 | `uno_any_assign` 位于 `0x180022c00` | `ev_afc172188fb9c4d2b79ebb60812f92b4b03fc56e400a5984d0ca5ee3dedb4794` |
| 函数证据 | 汇编、反编译伪代码及调用关系；可见 typed Any 的类型描述与值复制路径 | `ev_8b05ac7028d4e10f37f7ae5a4869f39db383bcb53fe4e4bcc24f14bd59d5b290` |
| swlo.dll 资源清单 | 实际 Writer PE 资源，不等于完整 Writer 反编译 | `ev_f0b8c77e9cde497078db546e688b7a30014e6d8a7ba389bfe3c7c9a840ad83d8` |

cppu3.dll SHA-256 为 `c3cb0f14e9875eb445378eda73b0949f8b71f5cb24c6d53680f7445fa0ecaa12`；swlo.dll 为 `aae17de180cff3fc0d99f11e668f823fe9a8a5659a788142ab3200b67be8cc08`。原始报告保留在本机临时证据目录 `agentviewer-rea-office-evidence`。

Writer 全模块自动分析分别在 300 秒和 600 秒达到超时；后一次还报告临时目录清理未确认，目录保留。没有据此报告 Writer 字体或排版函数已经完整逆向。未继续重复大模块分析。

`mergedlo.dll` 是约 151.8 MB 的共享依赖，不能只拿出 Writer/Calc/Impress 小模块就声称已经消除完整引擎。上述二进制结果用于核对桥接路径；实际编辑语义还通过公开 UNO 属性定义、命令定义和运行回读验证。

公开源码交叉检查使用 LibreOffice `libreoffice-26.8.1.1` 标签。它对应发布版本；本机二进制报告的构建哈希另行记录，不宣称二者构建提交完全一致。Calc 列宽和行高使用 `.uno:ColumnWidth`、`.uno:RowHeight`，不使用 Writer 表格命令的同名近似项。

Impress 的实际安装配置 `main.xcd` 进一步确认 F2 对应 `.uno:Text`，并按二进制自己的构建提交 `bf6ef2662401c7d6dce671ab4deb26ee0af3a7c1` 核对快捷键与 `FuText::DoExecute` 实现：恰好选中一个文字对象时进入该对象的文字编辑。`.uno:ToolEdit` 则依赖鼠标命中，不能替代已绑定对象的语义入口。

## 首批应用内工具

| 目标 | 应用自己的编辑控件 | 引擎接口 |
| --- | --- | --- |
| 文字 | 字体、字号、粗斜体、下划线、删除线、字色、底色 | 实际选区 XPropertySet，核对 Latin/Asian/Complex 属性 |
| 段落 | 对齐、左右和首行缩进、段前后间距、比例行距 | Writer/Impress 实际文本范围与段落属性 |
| Calc 单元格 | 字体、水平和垂直对齐、换行、填充、数字格式代码 | 实际单元格/范围属性与 NumberFormats |
| Impress 对象 | 位置、尺寸、旋转、填充、线色、线宽 | 实际已选择的绘图对象，位置尺寸与原生属性 |

属性是类型化白名单；不支持的字段显示原因，混合值保持混合状态。控件仅提交用户改过的字段，不能将整个检查器初始值覆盖回文档。颜色以六位十六进制表示；文字单位 pt、段落和形状长度 mm、形状查询的原生边界为 1/100mm。Writer 长度会按内部 twip 量化，回读值可能与输入相差 0.01mm，保留真实值。

真实保存重开检查还发现 LibreOffice 26.2 新增的 `ParagraphAdjust.START/END`。保存的 DOCX 正确保留逻辑对齐，但旧解码器不认识它。现按实际 `WritingMode` 映射物理左右，LTR 与 RTL 的四种保存重开均已验证；方向混合、竖排或未知时不猜测。这个问题说明仅验证原生 setter 的即时回读不足，文件重新导入后的类型值也必须验收。

文本、段落、单元格和对象共享 `office_query` 的 style 检查，以及 `office_execute` 的 style 事务。harness 可以先 `office_query {kind:'shapes',slideIndex}` 取得真实名字，再用 `office_navigate {kind:'shape',slideIndex,name}` 选择唯一对象。重复或不存在的对象名拒绝定位，不根据 OOXML id 猜测原生对象。

当前构建的 `TransformDocumentStructure` 接受结构化 DataJson，源码还能分派嵌套 UnoCommand，因此公共调用不能直接接受任意 JSON 越过类型化目标、保存和宏命令约束。共享 policy 仅阻断公开 `.uno:TransformDocumentStructure`，提示“结构化编辑仅通过绑定真实目标的类型化事务提供”，不全局禁止其他命令的 DataJson。Impress 私有替换事务先核对真实当前页、唯一对象、UTF-16 范围和 expectedText，只在内部固定构造 JumpToSlide/SelectText/InsertText，再直接调用原生 dispatcher；不接受调用者 JSON、任意对象索引或嵌套 UnoCommand。本轮没有据该接口推断存在任意 shell 执行漏洞。

真实阅读器 `iCrUe6` 证明固定文字事务已经改变模型：恢复检查点含新 marker、revision2、dirty:true；随后范围校验仍报错。具体问题是 PyUNO 的嵌套 End getter 返回结构体副本。完整 TextPosition 赋给 native.End 后保留插入范围和对象完整 prefix/新文字/suffix 双校验；32 项 helper 及后续 UQLdFQ/u6hGbx 的实际替换、重新进入文字编辑、文字样式 Undo、形状样式 Undo 与保存步骤已通过。仍不能把这些即时成功步骤当作文件重开后所有属性都正确。

保存与重新导入继续暴露了两类不同问题。u6hGbx 的 PPTX x/y/cx/cy 全部等于保存前原生值×360 EMU；重开 x/y 不变，只有 width/height 各少 1 个 1/100mm 单位，未改原输入也有该导入量化。测试仍要求 XML 与 Undo 精确一致，只对重开 w/h 接受这个实测 1 单位边界。填充色 b6d8cc 导出受旧 accent1 影响、重开变4472c4 是另一项真实失败，不能作为几何容差放过。`av-color-proof-132c0a7e/report.json` 早期仅 live-only，而最新更新已是实际生产 ODP→只读 clone→PPTX：不同 RGB b6d8cc 导出 srgbClr、Undo 主题 XML 精确、Redo RGB XML 精确；同 RGB20d604 的 explicitRGBXML/UndoThemeExact/RedoRGBExact/bagRestored 也通过。Writer middle 局部改色/真实 Undo/Redo 保留前缀色和全文，原件不变并正常退出。报告仍是 headlessOnly，不代表最终可见阅读器和 installed 全套通过。

production曾见clone继承accent1、null/FillTheme=-1无效；现helper对actual页/count/name/type/text严格对齐，仅clone复制RGB/完整ComplexColor/InteropGrabBag，不动source/版本/Undo，不拼OOXML。production专项、开发523LT6和installed VRVNwR均通过指定fill往返；80×30mm/autoGrowoff fixture与0.99mm窄autoGrow高度重排的未全面恢复边界保留。Undo仅几何真变setter，Point/Size先enum；不扩展为全主题/渐变/布局。lineColor getter局部apply/redo有证据，但独立theme-line XML往返矩阵未覆盖，这是未验证范围而非已确认lineXML新bug。

事务固定 document/view/session、引擎与选区版本；目标变化时草稿保留但禁止直接应用。成功动作必须有真实回读。Writer/Calc 使用原生撤销；Impress 直接 setter 没有自动记录时，注册实际属性与几何前后值的 XUndoAction。失败不清除用户旧撤销栈；无法证明完整恢复时返回明确错误和恢复检查点。原生写入可能清除既有重做历史，失败后不能保证保留时用 `NATIVE_STYLE_ROLLBACK_UNVERIFIED` 报告，不能冒充完全原子成功。

style 或 replacement 出错后，Core 从实际引擎同步状态、稳定快照和恢复检查点，再抛出原始错误；已经修改的内容不被旧 OOXML 镜像覆盖，错误也不被转为 applied/lastEdit 或自动重试。受控 driver 回归与 `iCrUe6` 实际检查点分别覆盖这条边界的逻辑路径和真实阅读器结果。

## 性能与外观

完整命令目录改为按需加载；默认工具只检查对应命令状态。主进程状态流被多个控件复用，Office 正文镜像不反复进入私有界面状态。完整文档仍可由公共 read/snapshot/MCP 获取。临时选择、滚动和焦点持久化与真实修改的保存节奏分开。

主线确认 native context 曾在语义相同时仍更新 capturedAt/viewRevision 并带动整 App 刷新；最终源码已改为完整语义 payload 去重，相同 fresh state 保留 context 对象/版本/时间，真实语义变化照常传播。appearance desired/applied 已串行，RPC 成功才确认 applied，同配置失败可重试，连续更新应用最后 desired 且不重复调用。432 项回归中的相同 native reads/真实变化 dedup 与 appearance retry/concurrent display 均通过；这是纯逻辑与受控引擎调用证据，不替代实际 GUI/安装版性能测量。

背景在独立 LibreOffice profile 中按应用主题设置，文档白纸与页面自身样式分开。不会通过改文件的 PageStyle 或幻灯片背景来修复黑色画布。

专项无界面真实 UNO 验证已取得四类属性修改、回读、撤销和重做证据；完整 Electron、真实 MCP、可见 HWND、保存重开及安装同步由本轮验收记录单独报告。二进制分析成功不等于这些桌面流程已通过。

最终432/432、0fail/skip、build成功；2026-10-14 00:21:10+08 renderer DXEFkOLV/BKUkaMOr，mainSHA991824E0CFCF6BA188E6507D5662DFEB8FC9B53186125724733B69C491447303。开发523LT6与安装VRVNwR均passedtrue/errors[]/exit0/正常退出：W/C全文段序/公式42/样式/Undo/save新session重开，PPTtrueText/替换/reentry/text/shape Undo/XMLexact/色字号重开通过；各28office_execute actoragent、原examples不变。VRVNwR实际EXE为C:/Users/cth/AppData/Local/Programs/AgentViewer/AgentViewer.exe，appPath/resources身份与mainSHA匹配，profile为私有TEMP，445MCP回执。两者physicalKeyboard/Mouse均false，早期LockApp/前台命中guard失败边界保留，不猜当前前台，不宣全Office特性通过。

源码提交d4711fb32ec63888de1cee1df26fb416fccb0aec。2026-10-14 00:31:21 installation-sync-20261014-003121.json apply/verify/portable PASS，19候选/8变更/19逐SHA，installed/portable mainSHA一致，EXE/engines/deps/package/profile未改；plan-02bca3136388430c953846a2b9cbe199.json build摘要CC9E89933B154DFF1D968B99960E6CECD3F11317FC321BF6ECFE8A99775AF385，manifest文件SHA4C06B75B811C7E0F44027C6D7749F1D6B1492E0CD0ACC44B452891F02849AE74。installed VRVNwR运行实测另行PASS，不以文件同步推断；portable只验证相同runtime文件，未另启动其EXE全套。正式文档/远程发布由主线完成，432单元与指定语义通过不代表物理/IME/DPI/全部命令特性均验收。

## 参考来源

- [REA 官方仓库](https://github.com/morluto/rea)
- [REA 的逆向工作流](https://github.com/morluto/rea/blob/main/.agents/skills/reverse-engineer-anything/SKILL.md)
- [Ghidra 官方项目与发行](https://github.com/NationalSecurityAgency/ghidra)
- [LibreOffice 26.8.1.1 Calc 命令定义](https://github.com/LibreOffice/core/blob/libreoffice-26.8.1.1/sc/sdi/scalc.sdi)
- [LibreOffice UNO API](https://api.libreoffice.org/docs/idl/ref/)
- [当前构建的 Impress F2 配置](https://github.com/LibreOffice/core/blob/bf6ef2662401c7d6dce671ab4deb26ee0af3a7c1/officecfg/registry/data/org/openoffice/Office/Accelerators.xcu#L3182)
- [当前构建的文字编辑实现](https://github.com/LibreOffice/core/blob/bf6ef2662401c7d6dce671ab4deb26ee0af3a7c1/sd/source/ui/func/futext.cxx#L180)
- [当前构建的结构化文字事务及嵌套命令分派](https://github.com/LibreOffice/core/blob/bf6ef2662401c7d6dce671ab4deb26ee0af3a7c1/sd/source/ui/view/drviews2.cxx#L1031)
- [START/END 的方向语义](https://api.libreoffice.org/docs/idl/ref/namespacecom_1_1sun_1_1star_1_1style.html)

REA 为 MIT、Ghidra 为 Apache-2.0，Temurin JDK 为 GPLv2 with Classpath Exception；这些开发工具不随应用分发。内置 LibreOffice 继续保留 MPL-2.0 / LGPL-3.0+ 及其第三方许可文件。
