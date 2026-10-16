# 测试与证据

[suite.json](suite.json)是唯一清单，总预算50：常规41、Electron用户流程6、真实Kit独立流程3。内部断言不额外计项；scripts/test.mjs拒绝未登记、嵌套、动态和超额测试。

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run test:desktop
npm.cmd run test:office
node scripts/test.mjs list
npm.cmd run docs:check
```

## 保留范围

| 入口 | 责任 |
| --- | --- |
| core.test.ts | 版本/幂等/草稿、轻量选区、逆操作、保存冲突、恢复迁移、blob/GC/背压、文档队列、HTTP及资源/文件流程 |
| office-editing.test.ts | 格式能力、公式、未修改内容及保存重开 |
| native-office-mapped-shape-style.test.ts | 样式预检、失败回滚、目标和撤销；Python模拟 |
| translation-selection.test.ts | 冻结来源、任务隔离、取消与超时 |

边界用例覆盖10 MiB正文的小选区不携模型、冻结复制/AI和过期写拒绝、重启回执回放；恢复覆盖v1/v2备份、二进制损坏拒绝、delta/checkpoint、metadata复用、GC并发及exclusive旧格式导出。文件流程覆盖资源根、链接、移动/回收与撤销、外部变化保护。

## 本轮实绩

2026-10-16：常规41/41、Electron6/6、真实Kit3/3；完整build与类型检查通过。6条Electron均renderer errors=[]。证据TEMP：Reader h7J73W、Home n1WkbB、Office hPle9b/Dialog UkU5Xp、Kit Kg8h0P（passed/workerExited/sourcesStable=true）。Reader验证浮栏格式及Undo/Redo、临时图片50→75%连续缩放、live/split解码、HTML导出及保存后fresh bytes读回；PDF 2页，PNG 1100×1200和1100×283。Pandoc未安装。

桌面流程使用本轮dist、独立端口、TEMP配置和样本副本，检查真实保存/重开。不得删除失败断言或弱化范围来满足数量预算。test:office还会运行已登记的Office常规子集，不重复增加清单项。

自动化composition不证明Windows系统拼音输入法；Python模拟不证明实际UNO行为。真实Kit流程只证明其实际覆盖的格式、操作和样本；不等于全部Typora能力、复杂文件保真或P95达标。

性能实验按[方案](../docs/performance/README.md)单独采集；截图、轨迹和日志留TEMP，不增加过程报告。文档由docs:check约束每篇完整Unicode字符≤2000、每模块≤2并检查链接。
