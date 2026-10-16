# 编辑重构与Typora对标

基线为[Windows通用功能](https://support.typora.io/Quick-Start/)、[Markdown语法](https://support.typora.io/Markdown-Reference/)和[导出](https://support.typora.io/Export/)。能力存在、代表性流程通过和任意复杂文件完全兼容分开表述。

| 能力组 | 实现与验收 |
| --- | --- |
| 实时、源码、分栏、选区、撤销 | 单源CM；分栏防写与真实范围；浮栏格式的键盘/侧栏/顶部历史；快速Undo立即重选连续验证 |
| GFM、任务、脚注、TOC、YAML、上下标、高亮 | 增量语法；YAML、含冒号脚注、表格范围与全文导出；未知语法保留源码 |
| 可视表格 | 单元格、行列、对齐、Tab、TSV粘贴；转义竖线和插行通过，超24000字符表格使用源码 |
| 代码、公式、图表 | 语言包按需加载；Worker公式；Mermaid、legacy flow/sequence实际SVG与整文导出 |
| HTML、媒体、提示块、Emoji | 净化脚本；本地audio/video解码、播放、Range及目录限制；HTML导出携带媒体 |
| 图片与资源 | 未保存粘贴、拖入、50%→75%缩放、live/split、保存相对资源和fresh重开；显式上传恰一次 |
| 文件树、快速打开、全文搜索 | 新建、dirty拒绝、保存后改名/移动/回收/撤销、搜索源行通过；Windows最近文档入口已接 |
| 大纲、字数、查找替换、专注/打字机 | 增量统计及大纲；实际入口通过；统计与PlainTextRun有固定种子对照 |
| 拼写、配对、主题、快捷键 | 真实配对和历史；侧栏重挂保留状态；CSS computedStyle、改键及禁用继承键通过 |
| 导入导出 | 完整HTML、逐页PDF和无滚动条连续PNG；Pandoc五格式图片往返，LaTeX相对资产 |

## 实施责任

1. 输入与投影分离。普通巨行insertText沿公开inputHandler及范围事务，IME保留原生组合路径；特殊字符与装饰按可视区处理，GFM先筛无竖线段落。
2. Office内部绘制状态与公开可见状态分离。原子inspect、lease和presented输入门槛保留；分段trace定位排队、导入、初始化、瓦片、解码、呈现及输入回执，空闲预热在阶段边界让路。
3. CPU与存储分离。有界Worker处理正文编码/摘要、较大Office辅助模型和恢复导出；历史、快照及回执分别准入，保留版本、幂等与严格保存屏障。
4. 导出与编辑窗口分离。隔离session拒绝服务API，仅提供文档资源桥；导出先暂存，冲突时保护原文件。导入不接受越界或链接资源。

真实Windows系统IME需交互桌面；锁屏记录不算通过。复杂主题CSS、嵌套语法与Office复杂排版不以少量样本承诺全部保真。最新实绩见[测试](../../tests/README.md)，指标见[性能](../performance/README.md)。
