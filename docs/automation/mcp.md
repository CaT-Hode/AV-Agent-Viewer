# MCP、SDK 与上下文预算

公开入口共用类型化 registry，不保留旧工具、HTTP method 或 SDK 别名。标准 MCP 仍用 JSON 传输；Agent 只填写少量扁平字段，不重复内部身份结构，也不引入命令字符串 DSL。

## 渐进披露

初始仅 `av_workspace`、`av_tools`。先列元数据取得 ref，再执行：

```text
av_tools(type="markdown")
av_md_blocks(ref="r1")
av_md_edit(ref="r17", text="新内容", req="edit1")
av_save(ref="r18", req="save1")
```

ref 绑定目标、授权与版本，不跟随人工焦点。req 标识一次逻辑修改；同键不同载荷冲突。cursor 绑定查询/来源版本，job 表示任务生命周期。默认执行并局部读回，保存独立。

`av_tools` 可指定 ref 或 type；base 加载常用读写，高级 pack 按需加载，all 用于完整发现与预算检查。目录状态属于 MCP 连接，不由人工活动标签决定，不自动合并所有已打开格式。

| type | 专属能力与高级包 |
| --- | --- |
| markdown | 块/范围/格式，table、structure、resources、convert |
| html | 源节点/编辑，structure |
| docx | 原生段落/范围/格式，table、layout、review |
| xlsx | 原生范围/公式/格式，grid、data、chart |
| pptx | 幻灯片/递归对象/文字，slides、layout |
| pdf | 页面/来源，ocr、annotations、pages |
| web | frame/语义元素/操作，frames、capture、copy |

共享读取、查找、保存、任务和显式视图操作另计；files、analysis 按需披露。工具存在不代表当前会话支持全部动作，执行器必须报告实际能力和 unsupported 原因。

## 5k门禁

`npm.cmd run mcp:budget` 启动独立 catalog-only stdio，读取真实目录；不连接桌面或加载文档引擎。

计数含工具名/描述、input/output schema、annotations、格式说明及Office原生能力。能力每类型披露一次，按真实驱动形态计最大值。每格式基础+全部高级累计≤4500参考tokens，预留500宿主开销，硬上限5000；禁止分包计算或把schema搬进结果逃避。共享入口目标1200、全部共享2500，单独统计。

固定 `js-tiktoken 1.0.21` 与两套内置词表/实现SHA，离线使用 `max(o200k_base,cl100k_base)`，不以字节或字符估算tokens。缺数据、哈希变化、跨格式泄露、超限或快照漂移均阻断构建。

运行报告位于 `artifacts/mcp-budget.json`；审查变化后用 `npm.cmd run mcp:budget -- --update` 更新受版本控制的快照。

发布前 mcp:host-check 核对目录摘要、桌面版本、实际加载/调用证据与精确注入计数。缺工件或未知tokenizer均阻止打包和本机替换；普通build可用。CLI夹具不能生成桌面认证。

## Codex 状态

参考计数不代表当前 Codex 模型 tokenizer、工具包装与旧schema淘汰已获认证。MCP 通知不保证宿主刷新；500仅为预留。宿主需使用固定客户端版本与实际注入记录验收。

本机 CLI 0.163.0-alpha.10.2 的本地 Responses 协议夹具确认：两工具起步，av_tools 真实完成并发送9次目录通知，后续未重新列目录，av_md_blocks 未进入执行器。开启 code_mode、incremental_tools 及实际 tool_search 对照仍未闭环。当前模型走 Responses Lite，未提供 request.tools，注入计数仍未认证。夹具不请求外部模型、不改用户配置，也不等同桌面或模型语义验收。可运行 mcp:host-probe 重现该门禁。

[阅读技能](../../plugins/agent-viewer/skills/reading/SKILL.md) · [编辑技能](../../plugins/agent-viewer/skills/editing/SKILL.md)
