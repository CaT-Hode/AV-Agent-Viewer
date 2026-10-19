# 测试与证据

[suite.json](suite.json)是唯一清单，总预算50：常规41、Electron流程6、真实Kit流程3。内部断言不额外计项；scripts/test.mjs拒绝未登记、嵌套、动态、禁用和超额测试。不得删除失败断言或缩小范围满足预算。

```powershell
npm.cmd test
npm.cmd run build
npm.cmd run test:desktop
npm.cmd run test:office
node scripts/test.mjs list
npm.cmd run docs:check
```

## 常驻责任

| 入口 | 覆盖范围 |
| --- | --- |
| core.test.ts | 版本、幂等、草稿、选区、逆操作、保存冲突、迁移、blob/GC、队列、准入及文件资源 |
| office-editing.test.ts | 格式能力、公式、未修改内容和保存重开 |
| native-office-mapped-shape-style.test.ts | 样式预检、失败回滚、目标和撤销；Python模拟 |
| translation-selection.test.ts | 冻结来源、任务隔离、取消和超时 |
| home-search.e2e.ts | 新标签搜索、异步导航和设置 |
| reader-interaction.e2e.ts | Markdown三模式、Range、Undo、资源、导出、PDF/native缩放和设置 |
| embedded-office.e2e.ts | Word/Excel/PPT原生输入、属性、遮挡拒绝、保存重开；独立弹窗流程 |
| office-export.integration.ts | 真实Kit三格式导出、撤销重做及源文件保护 |

桌面流程使用当前dist、独立端口、TEMP profile和样本副本，检查真实保存及fresh bytes重开。test:office同时执行已登记的Office常规子集，不重复计项。进程须正常退出，renderer errors与console errors分别检查。

## 已验证的范围

10月16日基线常规41/41、Electron6/6、Kit3/3通过；Reader OtgLce、Office K7UW15、弹窗wKbl6j、Home pLriDI、Kit YJIZCY为对应TEMP证据。fragment oracle覆盖60,167例，另有16例内联边界对照；这些临时探针未加入常驻清单。

10月19日原版Reader P5Gltp完整通过，errors与consoleErrors均为空，正常退出；三轮快速Undo后立即重选均保留Core选区和原生Range。先前一次失败保留MYLvwv，后续三次完整复核未重现，未添加猜测性补丁或修改原测试。

ccDhk0：正文三模式×四档缩放×空/短/长/清空，共48状态；左栏11状态验证测高、连续动画和目录/查询保留。oyD3Wk：22个跨格式导航状态，含网址20ch、窄lane、更多菜单、Excel长公式与草稿取消。最后1px标题取整修正由sk7Yl2复核短标题完整显示和长标题220px上限。上述QA正常退出，应用异常为0；开发Electron CSP警告单独记录。

ZD9zWZ：最终安装版深浅色12张截图，8个材质表面及8组焦点检查通过；深色内白圈消失，模糊、底色、外投影和浅色高光保留。正常退出，errors、consoleErrors和warnings均为空。

package与安装版各384个编译文件逐一SHA256一致，默认profile的243个文件未变。系统输入验证按用户要求停止；WeType仅有部分事件、中文输入及保存记录，三格式系统输入/历史闭环和新前台P95未完成，不记为通过。取消与失败证据保留TEMP。

Python模拟不证明实际UNO；Kit样本不代表任意复杂文件保真。自动composition不替代系统输入法；rAF不等于物理呈现。性能按[方案](../docs/performance/README.md)单独采集。

截图、轨迹和失败日志留TEMP。docs:check约束完整Unicode字符≤2000、每模块≤2篇并检查本地链接。
