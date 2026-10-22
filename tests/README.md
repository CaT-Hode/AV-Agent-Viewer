# 测试与版本依据

[suite.json](suite.json)登记36项单元测试、6项生产Electron流程和3项真实Kit流程，合计45项，上限50。删除重复的Python样式模拟，保留真实引擎与文件往返检查。单元通过不表示完整应用验收通过。

```powershell
npm.cmd test
npm.cmd run test:desktop
npm.cmd run test:office
npm.cmd run test:full
```

后三个入口先从当前源码完整构建。build在`dist/test-build.json`记录源码、测试、配置和生产输出的SHA-256。直接运行桌面或引擎测试也会核对该清单；源码或dist变化后拒绝使用旧构建。每份桌面证据附带相同的版本、commit、源码摘要和输出摘要。

## 保留的测试职责

| 入口 | 验证范围 |
| --- | --- |
| core.test.ts | 当前核心、持久化、冲突、HTTP/MCP、隔离与资源释放；含替身 |
| office-model.test.ts | OOXML模型、解析、公式与文件往返；不加载原生Office |
| translation-selection.test.ts | 翻译协议、冻结来源、取消及隔离；使用确定性响应 |
| home-search.e2e.ts | 完整生产桌面的搜索、导航、设置；译文搜索通过本地HTTP协议夹具验证，不评价模型质量 |
| reader-interaction.e2e.ts | 完整生产桌面的Markdown编辑、资源、导出、PDF和设置 |
| embedded-office.e2e.ts | 当前原生DLL、Writer/Calc/Impress输入、样式、保存重开和弹窗 |
| office-export.integration.ts | 三格式真实Kit领域编辑、回执重放、撤销、导出及独立重开；不是桌面呈现验收 |

首页和阅读器使用生产入口与本地协议夹具。Office流程使用当前构建和适配器，不保留独立的PPT选择或authoring诊断模式。领域断言并入三个正式格式流程，证据统一由runner收集。`test:office`只运行原生流程；`npm test`运行单元测试。

## 产物与临时文件

每轮仅使用自己创建的TEMP根目录和样本副本，不接管用户进程或用户数据。通过后把截图、结果及构建身份汇总到`artifacts/verification/<unit|desktop|office|full>/`，删除该轮浏览器profile和临时样本。失败时保留工作目录并在report.json记录位置；每种入口仅保留最新报告，不引用旧日期或已删除的历史工件作为当前依据。

`test:full`执行当前清单全部职责，成功报告才代表该源码与构建的完整本地回归。真实远端AI质量、系统拼音输入法、大文件性能和Codex桌面MCP认证仍需各自证据，不能由模拟、Chromium组合输入或固定样本推断。
