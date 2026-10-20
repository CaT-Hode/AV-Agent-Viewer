# 测试与证据

[suite.json](suite.json)是唯一清单，总预算50：常规41、Electron流程6、真实Kit流程3。扩展现有职责，不增加重复用例；scripts/test.mjs拒绝未登记、嵌套、动态、禁用和超额测试。不得删除失败断言或缩小范围满足预算。

```powershell
npm.cmd test
npm.cmd run build
node scripts/test.mjs list
npm.cmd run docs:check
npm.cmd run mcp:budget
```

## 常驻责任

| 入口 | 覆盖范围 |
| --- | --- |
| core.test.ts | 版本、幂等、草稿、选区、保存、持久化、资源、HTTP/MCP目录、连接隔离和内存释放 |
| office-editing.test.ts | 格式能力、公式、未修改内容和保存重开 |
| native-office-mapped-shape-style.test.ts | 样式预检、失败回滚和撤销；Python模拟 |
| translation-selection.test.ts | 来源冻结、普通翻译协议、分段、隔离及取消 |
| home-search.e2e.ts | 搜索、导航和设置 |
| reader-interaction.e2e.ts | Markdown三模式、Range、Undo、资源、导出及缩放 |
| embedded-office.e2e.ts | 原生输入、属性、遮挡拒绝、保存重开及弹窗 |
| office-export.integration.ts | 真实Kit导出、结构化编辑、撤销及独立重开 |

桌面流程使用当前dist、独立端口、TEMP profile和样本副本，检查真实保存、fresh bytes重开、错误日志与正常退出。`test:desktop`、`test:office`包含输入流程；按用户要求，本轮不运行输入验收。

## 当前验证范围

10月20日独立TEMP/Electron复核覆盖滚动、选中对比度、单层浮栏、输入框、翻译快捷键、底部浮窗、拖动收起及网页原文保留。长文检查18px、默认1.0、圆角/1px模糊、边界滚动；全局避让检查真实hitbox、移动及收起。翻译使用确定性夹具，DOM事件与API不代表真实输入或模型质量。

10月19日结构化Kit验收使用既有office-export流程的`AGENTVIEWER_AUTHORING_ONLY=1`分支，经过真实原生引擎、读回、幂等、可用的Undo/Redo、保存及独立重新导入，源文件不变。Word覆盖文字/段落/页面、批注、表格和修订；Excel覆盖工作表、数值/公式、网格/格式、验证、排序/筛选、图表和透视；PPT覆盖文字/对象、幻灯片、组合、母版、备注、背景及原生动画属性。页面布局、修订开关等无原生撤销的动作显式报告限制。

`artifacts/agent-v2-validation/native-authoring-final.json`记录该链。public-office记录三格式公开SDK读写、重试和保存；public-content-refs记录Word长表格续读/写入、PDF精确范围和文件分页；web-ref-isolation记录跨域frame、元素续读和连接隔离。这些检查保持隐藏窗口与人工活动状态，无输入动作。

HTTP回归另覆盖同内容跨文档/集合/导航游标隔离、失效连接恢复、数值矩阵、聚合内存释放，以及持久化期间取消不产生文档修改。MCP预算检查真实stdio目录及服务一致性，仍不代表宿主已刷新目录。

当前Codex协议夹具实际完成av_tools、发送9次目录通知，后续工具仍不可调用；宿主精确token计数和桌面认证未通过，发布与本机替换受[门禁](../docs/automation/mcp.md)阻止。

## 证据边界

历史10月16日基线为常规41/41、Electron6/6、Kit3/3；10月19日Reader、导航缩放及深浅色材质视觉复核通过。这些历史结果不覆盖之后新增的MCP接口。

Python模拟不证明实际UNO；Kit样本不代表任意复杂文件保真。系统输入验收已停止，三格式系统输入闭环和新前台P95未完成；隐藏结构化调用耗时不等于输入延迟或物理呈现。性能按[方案](../docs/performance/README.md)单独采集。

日志、截图保留TEMP或artifacts，不提交用户内容。docs:check约束完整Unicode字符≤2000、每模块≤2篇并检查本地链接。
