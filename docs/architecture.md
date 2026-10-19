# 架构与边界

桌面 renderer → preload → main → ViewerCore。MCP、HTTP、CLI 和类型化 SDK 使用同一公开操作 registry；格式服务、事务与文件授权集中处理，入口不各自维护语义。

| 层 | 责任 |
| --- | --- |
| desktop / local-service | 窗口、宿主、本地鉴权、连接级工具目录 |
| sdk / contracts | 扁平工具、运行时校验、类型、refs 与错误 |
| document-core | 文档队列、来源版本、回执、历史、保存与任务 |
| format-adapters / markdown | 文本结构、范围事务、资源与转换 |
| office-runtime | 原生模型、controller、typed UNO 事务与检查点 |
| persistence | 内容 blob、恢复清单、有界编码与写入队列 |

## 来源与控制

同一 document 可有多个 view。Markdown 源文本是唯一可写正文，实时/源码/分栏共享 UTF-16 范围；HTML 的写入针对源码，不假定具备任意 DOM 富文本编辑能力。活跃 Office 由原生模型写入，辅助 OOXML 投影不能覆盖它。

Agent 只持有短 ref。服务端绑定文档、授权、目标与版本：文本范围绑定 revision/指纹；Office 绑定 session/engine 与原生容器；PDF 绑定文件哈希、页和提取来源；网页绑定 frame、导航与 DOM 世代。读取 active/selection 可原子解析，修改必须使用具体 ref。视口移动本身不应使纯模型目标失效。

默认后台执行；激活、跳页、选择与窗口变更通过显式视图操作。不能安全隔离的原生编辑返回能力限制，禁止偷偷借用人工页面或选区。用户草稿、暂停、组合输入和模态状态始终优先。

## 执行与完成

req 是逻辑修改身份，与 ref、内容哈希、JSON-RPC id 分开。相同 req/载荷重试返回原回执，不同载荷冲突；先查已完成回执，再检查旧 ref 是否过期。

修改默认执行并读回目标，源文件保存独立。回执分别表达 effect、verification、durability；job 表示尚未完成的生命周期，不表示成功。取消不撤销已应用的效果。冻结版本落盘后，较新的实时内容仍可能保持 dirty。

事务按文档排队。原生 UndoContext 和互斥不是原子回滚；批量操作必须明确 atomic、ordered-stop-on-error 或 best-effort，不支持的 atomic 在执行前拒绝。

## 存储与上下文

列表只返回元数据；范围、单元格和对象按需读取，游标绑定查询与来源版本。回执只读回受影响内容，不默认传输全文模型、任务正文或重复结果。

恢复保留校验过的 blob、delta 与原子清单；历史、快照、回执有准入配额，保存使用冻结版本和冲突检查。内部恢复格式不构成旧公开 API 兼容层。

[MCP](automation/mcp.md) · [编辑](editing/README.md) · [性能](performance/README.md)
