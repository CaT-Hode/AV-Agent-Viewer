# 原生 Office 本轮验收记录

本轮开始日期：2026-10-13；最终源码回归、构建、指定可见阅读器/MCP及安装版语义流程完成于2026-10-14。本记录区分实际日志、MCP回执、独立UNO专项与未验证范围。三格式本轮指定语义流程在开发与安装产物均通过；这不等于所有LibreOffice功能或物理输入全部验收。

## 1. 批次与构建

最终源码已冻结。`build-final.log` 记录主线 `npm run build` 成功；`final-build-record.json` 记录构建时间为 2026-10-14 00:21:10 +08:00，renderer 为 `index-DXEFkOLV.js`、CSS 为 `index-BKUkaMOr.css`，main SHA-256 为 `991824E0CFCF6BA188E6507D5662DFEB8FC9B53186125724733B69C491447303`。本次包含生产颜色、actor、context 去重和 appearance 修复；日志有产物分块大小提示，没有构建失败。构建记录收集器对 ℹ 日志格式和 PowerShell stderr notice 的处理修正不属于产品失败，也未重复运行已通过的单元批次。本文只读核对记录，没有另行构建。

`unit-final-regression.log` 的 ℹ tests/pass/fail/skipped 结尾实际为 **432 tests / 432 pass / 0 fail / 0 skipped**，约 20.30s。它包括 Core、版本与 Agent lease、worker/schema/错误边界、UI 纯逻辑等回归；部分测试使用受控 driver 或 Python 协议桩。这个计数不能作为 432 个真实 GUI 功能已验收的证据。下文较早 Electron 批次保留各自结果，不能据最终构建成功推断它们已在新产物或安装版全部重跑；sealed manifest、安装文件哈希与安装版语义结果另行记录。

本轮源码提交为 `d4711fb32ec63888de1cee1df26fb416fccb0aec`，提交时间2026-10-14 00:33:29 +08:00；本机 git 实读标题为 Integrate native Office editing with typed MCP tools。正式文档已通过阅读器的 document_create/open、plan/apply、save 和 read 回执发布，原始发布涉及9个文件并逐项核对磁盘文本。远端状态以交付时 main 与本地 HEAD 一致的核验回执为准。

## 2. 已通过的实际 Electron 批次

| 批次 | 实际证据 | 已验证的范围 | 未因此验证的范围 |
| --- | --- | --- | --- |
| UI `qC26Eh` | `ui-smoke-diagnostics.json` 有 scenario-complete、normal-close，rendererErrors/errorDetails 均为空 | 主页、独立设置、选区译文、网页翻译恢复；三格式真正空白创建与原生表面；各左栏分类；默认不急载完整 catalog；自有 Calc 字号控件改实际字号为 16 且数据/公式不变 | 没有遍历或执行所有 UNO 命令、所有对话框、三格式全部格式往返 |
| Startup `wFfJR9` | `startup-report.json passed:true`，primary/recovery exit0，rendererErrors 空 | 真正二次进程唤回隐藏/最小化主窗；设置存活时重建阅读器；四个并发 secondary 只创建一个 reader；正常退出保留未保存 Word 字节，新引擎恢复原文档/视图/dirty | 不能据此推断崩溃时尚未确认的活动编辑缓冲区也完整保存 |
| Reader `Rm4shL` | `evidence/results.json`、errors 空 | Markdown 150% 字形与高度增大但 shellZoom1；PDF viewport 正确增大；网页独立 zoom 与 layoutRevision；真实文件 drop 消费 Home 并保留原标签；设置 click/drag/key 一次 revision、全局 undo，无原生 select | 这是阅读/布局/设置回归，不是 LibreOffice 物理键盘或打印完整验收 |
| 最终 Native semantic `523LT6` | `evidence/results.json passed:true`，errors 空；主线运行 exit0，正常关闭自有 app | 可见 Writer/Calc/Impress controller、正式 stdio MCP、指定样式/替换/Undo/保存/新 session 重开；437 条实际工具回执，28 条 office_execute 均 state.actor=agent、无错误，三格式保存均 saved；原 examples 字节一致 | 本次实际 EXE 为仓库 Electron，不是 installed；physicalKeyboardVerified/physicalMouseVerified 均 false，也未遍历所有 Office 功能 |
| 最终 installed semantic `VRVNwR` | `evidence/results.json passed:true`、errors 空；主线运行exit0、正常关闭自有app | 实际安装EXE/私有TEMP profile；相同三格式全套语义、Undo、磁盘保存与新session重开；445条工具回执、28office_execute全部actoragent/无错误、三save均saved、原examples字节一致；实际mainSHA与最终构建匹配 | physicalKeyboard/Mouse均false；没有遍历全部命令、主题/布局/打印或IME/DPI矩阵；portable文件相同不等于其EXE另跑过 |

UI 截图包括 `qC26Eh/office-compact-style-tools.png`、`office-tools.png`；Reader 截图包括 `Rm4shL/evidence/settings-light.png`、`settings-dark.png`。普通 Chromium 截图不能完整捕获外部原生 HWND，因此不能仅靠这些截图证明 Office 正文全部像素或物理焦点正确。

## 3. 独立、实际 headless UNO 专项

这些专项使用真正内置 LibreOffice/pyuno、独立端口与私有 profile，报告正常 UNO 终止及 ownEndpointClosed；它们不是模拟接口测试，也不等同于可见 GUI controller 的文字编辑。

| 专项 | 报告结果 | 具体证明与边界 |
| --- | --- | --- |
| 四类样式 `av-style-proof-4cdd8760f065/report.json` | success:true、headless:true | Writer 文字/段落、Calc cells、Impress shape 全部 actualUndoRestored/actualRedoRestored/oneRealUndoAction/historySuffixPreserved；Writer 12.5mm 回读 12.51mm、-2mm 回读 -1.99mm 是真实量化；不证明 GUI 活动 TextEdit 缓冲区 |
| 目标身份 `av-selection-proof-2f4c193f/report.json` | success:true | Writer 空 caret 的 UTF-16 offset5、漏 listener 时校验、同 range 稳定；不同表格文字容器分离；同名/同文 Impress 对象 lease 分离；报告明确 controllerTextEditNotExercised:true |
| PPTX 快照 `av-pptx-guard-692a3adb0d03/report.json` | success:true，三个样本 stable:true | 空 PPTX、UI 空白样本、正式八页副本；重复强制导出、真实 InsertPage 修改后快照、Undo/Redo 历史与输入恢复通过；同版 bytes 缓存一致。首次导出约 0.81–1.10s、缓存约 2–3ms，仅是这三个专项样本的计时 |
| START/END `av-alignment-proof-bb5a5c2d/report.json` | success:true，四格保存重开通过 | ParaAdjust 原始 short5/6 与 WritingMode0/1 实测；LTR START→left、END→right，RTL 相反；先前失败 DOCX 也实际回读 left。方向未知、混合或竖排不猜物理左右 |
| 颜色依赖 `av-color-proof-132c0a7e/report.json` | **更新后生产快照专项 success:true、headlessOnly:true，正常退出** | 实际 ODP→只读 clone→PPTX 中，b6d8cc 导出 srgbClr，原 accent1+lumMod70000/lumOff20000 的 Undo XML/Redo RGB XML 精确；同 RGB20d604 分支 explicitRGBXML/undoThemeExact/redoRGBExact/bagRestored 均 true。Writer middle 局部改色/真实 Undo/Redo 保留前缀颜色与全文，原件不变。不是最终 GUI 或所有主题/渐变验收 |

PPTX稳定导出采用live model→ODP→私有隐藏只读clone→PPTX，避免live exporter污染撤销。旧av-snapshot-2541de928679是success:false/SNAPSHOT_BUSY，早期颜色proof也只live-only，不冒充新证据。production曾见clone继承accent1、null/FillTheme=-1无效；最终helper对实际页/count/name/type/text严格对齐后，仅clone复制真实RGB/完整ComplexColor/InteropGrabBag，不动源模型/版本/Undo、不拼OOXML。更新的production专项、523LT6及installed VRVNwR指定流程均验证了颜色保存重开。

颜色专项使用正常 80×30mm、关闭 autoGrow 的文本框。原自建 0.99mm 宽自动增高文本框在颜色 setter 后重排高度，目标几何无法精确恢复，这条极窄自动布局边界尚未全面处理，不能声明所有布局恢复通过。Undo 只在几何真正不同才调用 setter；真实 Point/Size struct 的识别先于 enum。报告保留 failedBindings 作为早期 clone 主题传递失败的诊断，不将它删去或当成全部颜色组合已覆盖。

START/END 属于 LibreOffice 26.2 起的逻辑对齐值，实际含义依赖书写方向；本轮修的是回读解码，先前 DOCX 文件本身已经保留 `w:jc=start` 和 LTR 方向。[官方 ParagraphAdjust 说明](https://api.libreoffice.org/docs/idl/ref/namespacecom_1_1sun_1_1star_1_1style.html)

## 4. 真正阅读器与 stdio MCP 的语义验收

`tests/native-office-semantic.e2e.ts` 启动可见但隔离的 Electron，TEMP 复制三份正式示例，通过项目正式 stdio launcher 调用工具；没有 physical office_input、SendInput、假 controller 或跳过必要检查。工具参数和返回均保存在 `evidence/mcp-calls.json`，原始示例不被写入。

开发523LT6完成于2026-10-14 00:29:35 +08:00，实际EXE为仓库electron.exe/appPath为本仓库；安装VRVNwR完成于00:40:47，实际EXE为`C:/Users/cth/AppData/Local/Programs/AgentViewer/AgentViewer.exe`，appPath为该安装目录resources/app、resourcesPath为resources，profile为独立TEMP/agentviewer-native-semantic-VRVNwR。两报告passed:true，main SHA与第1节一致，assets为DXEFkOLV/BKUkaMOr；两次实际进程身份分别记录，不混用。

| 当前场景 | 状态 | 实际回读 |
| --- | --- | --- |
| Writer 文字与段落 | **523LT6与installed VRVNwR通过** | 真 paragraph select:true、精确容器和 UTF-16 范围；文字 18pt/斜体/166a71、段落 left/2.5mm/150%；原生 Undo 恢复值与 PropertyState；保留修改后 document_save，关闭最后 controller、新 native session 磁盘重开回读成功，全文和段序不变 |
| Calc 单元格 | **通过**，同上 | 实际 Z50 `=SUM(20,22)` 返回 42/error0；fill d8e8dd、wrap true、numberFormat0.0000 修改/Undo；实际保存并新 session 重开后公式、数值、样式均正确 |
| Impress 真实文字编辑、替换与文字样式 Undo | **523LT6与installed VRVNwR通过** | 查询唯一`Text 0`→`.uno:Text`/SelectAll→真实完整范围→marker替换→重新进入编辑→19pt/斜体/166a71→原生Undo/字段恢复→保存并新session重开marker/字体/颜色；不是物理F2证据 |
| Impress 形状样式 Undo 与保存 | **523LT6与installed VRVNwR通过** | 实际唯一对象x29.59mm/width287.47mm/fill b6d8cc修改，Undo精确恢复；PPTX保存回执、磁盘模型及新session名称/type/text/样式均实查，fill不再恢复accent1 |
| Impress 几何保存与重新导入 | **开发与installed精确XML/回读通过，保留量化边界** | PPTX x/y/cx/cy均为保存前原生1/100mm值×360EMU；重开x/y相同，width28747→28746、height3809→3808。未改输入亦有0.01mm边界；XML/Undo精确一致，仅reopen w/h允许1单位 |
| Impress 填充色保存重开 | **开发与installed指定GUI流程通过** | 新session保持fill b6d8cc、字色166a71、19pt/斜体/marker；旧u6hGbx失败与production proof保留。其他主题/渐变、线条XML矩阵不据此全覆盖 |

`xqTbNT` 保留修复前 no-change 基线；`iCrUe6` 实际改字但 PyUNO End by-value 回读失败，真实检查点没有丢失；`u6hGbx` 保留填充色重开失败。完整 End 赋值、范围/全对象双校验及 clone 颜色保护修复后，最终 523LT6 已通过上述指定语义流程。失败基线不删，也不再误写成最终状态；GUI 成功仅限实际断言覆盖的范围。

最终产物实际state采样后才清operationActor；523LT6与VRVNwR各28条command/style/replacement office_execute均state.actor=agent，真实来源断言通过。实际EXE/appPath/resourcesPath/mainSHA分别回读，安装与开发产物同源；用户常用profile未被测试使用。

本次通过没有放宽 no-change 为成功，仍要求活动 TextEdit/Outliner、模型、revision/dirty/Undo 和快照形成同一闭环；marker、样式、条件撤销、原件不变及新 session 保存重开断言全部保留。

## 5. 目标级 Undo/Redo 与失败限制

四目标独立原生样式专项验证一组真实Undo/Redo；开发及installed语义完成W/C/PPT各指定目标Undo/字段恢复，不据此宣称完整GUI Redo矩阵。Impress无自动历史的setter用实际属性/PropertyState/几何注册XUndoAction，不回灌镜像。production颜色专项验证主题/lumMod/lumOff XML Undo、RGB Redo及sameRGB bag，指定fill GUI/installed往返也通过；自动布局极窄目标与完整theme-line XML矩阵尚未验证，未据此认定已知新lineXML缺陷。

撤销必须匹配当前 engine epoch/revision 与 Undo 顶部 token；目标、选区或历史变化时拒绝误撤销其他人的工作。setter 失败只能撤回可证明属于自己的新组，或精确恢复捕获的字段并验值，不清空用户旧历史。输入恢复失败、属性恢复失败、原生历史不确定均须报错并保留恢复检查点。

新原生编辑可能消除既有 redo。属性已经恢复但旧 redo 无法完整保留时，返回 `NATIVE_STYLE_ROLLBACK_UNVERIFIED`，不能宣称完整原子回滚；无法恢复字段是 `NATIVE_STYLE_ROLLBACK_FAILED`。partial setter 失败不造 applied/lastEdit，不自动重发未知结果请求、不隐式覆盖原文。

Core 对 style 或 replacement 错误会读取实际引擎状态、同步稳定快照并持久化恢复检查点，再保留并抛出原始错误。受控回归证明 replacement 已改变字节与版本后抛错，实际模型和 dirty 可恢复，原文件保持未写入，没有 applied 回执或伪造 lastEdit；旧版本的显式重试会拒绝。`iCrUe6` 的真实检查点也体现了“错误不等于未修改”的边界。

公共 `.uno:TransformDocumentStructure` 被统一 policy 拒绝，原因是“结构化编辑仅通过绑定真实目标的类型化事务提供”；调用者传入包含 `UnoCommand/.uno:Save/.uno:RunMacro` 的任意 `DataJson` 也不能绕过目标和生命周期保护。worker 私有文字替换在验证真实页面、唯一对象、UTF-16 范围及 expectedText 后自行构造固定 JumpToSlide/SelectText/InsertText，直接交给原生 dispatcher，不接受调用者 JSON 或嵌套命令。没有全局禁止普通命令合法的 DataJson，也没有据此声称已证明 shell 执行漏洞。

## 6. 尚未验收的范围

完整physical `native-office.e2e.ts` 未通过本轮验收。早期记录遇LockApp/前台命中保护，5Yamxv也显示isolated reader logo命中非本应用窗口；最终开发与installed报告明确physicalKeyboard/Mouse=false。本记录不判断当前前台状态，不忽略FocusGuard，也不用语义`.uno:Text`替代真实F2/Ctrl+A/Ctrl+S/Ctrl+wheel。

指定PPT色/样式/actor和installed已通过；后续仍需完整物理输入、IME、Windows DPI全矩阵、复杂Word域/修订/文本框、Calc图表/透视表、PPT母版/动画/OLE、dialogs/打印及独立theme-line XML往返。lineColor getter局部apply/redo通过不代表主题线条XML全覆盖；此处是证据未覆盖，不报告已知新bug。完整catalog存在/状态可查不等于所有命令特性均验收。

两项性能修复已随最终源码冻结，并通过纯回归：相同 fresh native 语义 payload 保留 context 对象、capturedAt 和 viewRevision，真实选区/actor/layout/source/quality 变化仍更新；appearance desired/applied 串行，成功后才确认 applied，同配置失败可重试，连续更新应用最后 desired 且不重复引擎调用。日志中 identical fresh native reads/native context dedup 与 failed appearance/concurrent display 四项明确通过。它们证明逻辑和受控调用边界，不代表实际 GUI 延迟、idle 全 App 渲染或安装版性能已测完。

runtime同步于2026-10-14 00:31:21+08实际完成：installation-sync-20261014-003121.json apply/verify/portable均PASS，19候选/8变更/19逐项验证，installed/portable mainSHA与第1节一致。plan-02bca3136388430c953846a2b9cbe199.json的buildSha256为CC9E89933B154DFF1D968B99960E6CECD3F11317FC321BF6ECFE8A99775AF385；manifest文件SHA为4C06B75B811C7E0F44027C6D7749F1D6B1492E0CD0ACC44B452891F02849AE74，不混用。同步未改EXE/engines/dependencies/package或访问profile，没有启动/关闭app；之后安装版VRVNwR另以私有profile实际全套语义PASS/exit0，运行结果与同步回执分别保留。

## 7. 交付记录与证据边界

| 记录 | 本轮需要补入的实际证据 |
| --- | --- |
| 最终源码与构建 | 432/432/0skip、最终build/main SHA/assets与源码提交d4711fb已核对；正式文档经实际阅读器MCP发布和读回；远端 main/HEAD 校验随交付回执记录 |
| 完整语义流程 | 523LT6 已 passed:true，28实际office_execute actor=agent，三格式保存重开、指定生产色保护、原件字节一致、errors[]、正常退出；main SHA与d4711fb最终产物对应 |
| 性能与 appearance | context 去重与 desired/applied/retry 纯回归已通过；实际 GUI idle 渲染/引擎调用与安装版结果如执行须补真实记录，不能推断 |
| installed 复验 | VRVNwR passedtrue/errors[]/exit0，实际安装EXE/private profile/mainSHA与assets匹配，445MCP回执、28execute均actoragent、三格式save/Undo/reopen通过 |
| local/portable 同步 | installation-sync-20261014-003121.json已PASS：19候选/8变更/19验证，installed/portable mainSHA一致；profile/EXE/engines/deps/package未改，manifest摘要见第6节 |

## 8. 本机证据索引

- `C:/Users/cth/AppData/Local/Temp/agentviewer-rea-office-evidence/unit-final-regression.log`
- `C:/Users/cth/AppData/Local/Temp/agentviewer-rea-office-evidence/build-final.log`
- `C:/Users/cth/AppData/Local/Temp/agentviewer-rea-office-evidence/final-build-record.json`
- `C:/Users/cth/AppData/Local/Temp/agentviewer-rea-office-evidence/native-semantic-final.log`，最终指定完整语义流程 PASS
- `C:/Users/cth/AppData/Local/Temp/agentviewer-native-semantic-523LT6/evidence/results.json` 与 `mcp-calls.json`
- `C:/Users/cth/AppData/Local/Temp/agentviewer-native-semantic-VRVNwR/evidence/results.json` 与 `mcp-calls.json`；主日志 `agentviewer-rea-office-evidence/native-semantic-installed.log`
- `C:/Users/cth/AppData/Local/Temp/agentviewer-rea-office-evidence/installation-sync-20261014-003121.json`
- `C:/Users/cth/AppData/Local/Temp/agentviewer-runtime-sync-6a807bce9b7743bbbbd34a9dce097c4b/plan-02bca3136388430c953846a2b9cbe199.json`
- `C:/Users/cth/AppData/Local/Temp/agentviewer-ui-qC26Eh/ui-smoke-diagnostics.json`
- `C:/Users/cth/AppData/Local/Temp/agentviewer-startup-wFfJR9/evidence/startup-report.json`
- `C:/Users/cth/AppData/Local/Temp/agentviewer-reader-interaction-Rm4shL/evidence/results.json`
- `C:/Users/cth/AppData/Local/Temp/av-style-proof-4cdd8760f065/report.json`
- `C:/Users/cth/AppData/Local/Temp/av-selection-proof-2f4c193f/report.json`
- `C:/Users/cth/AppData/Local/Temp/av-pptx-guard-692a3adb0d03/report.json`
- `C:/Users/cth/AppData/Local/Temp/av-alignment-proof-bb5a5c2d/report.json`
- `C:/Users/cth/AppData/Local/Temp/av-color-proof-132c0a7e/report.json`
- `C:/Users/cth/AppData/Local/Temp/agentviewer-native-semantic-xqTbNT/evidence/failure.json` 与 `mcp-calls.json`
- `C:/Users/cth/AppData/Local/Temp/agentviewer-native-semantic-iCrUe6/evidence/failure.json`、`mcp-calls.json` 与同目录上一级的 `workspace.json`
- `C:/Users/cth/AppData/Local/Temp/agentviewer-native-semantic-UQLdFQ/evidence/failure.json` 与 `mcp-calls.json`，记录已通过步骤及重开 1 单位差异
- `C:/Users/cth/AppData/Local/Temp/agentviewer-native-semantic-u6hGbx/evidence/failure.json` 与 `mcp-calls.json`，含 impressStoredGeometry 与填充色失败
- `C:/Users/cth/AppData/Local/Temp/agentviewer-native-office-5Yamxv/evidence/failure.json`
