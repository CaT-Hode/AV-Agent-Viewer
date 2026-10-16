# 架构与数据边界

桌面 renderer → preload IPC → main → `ViewerCore`；HTTP、CLI、MCP 经 SDK 分发进入同一 Core。界面负责输入与呈现，文件修改以核心及引擎回执为准。

| 层 | 当前责任 |
| --- | --- |
| desktop / local-service | 窗口、原生宿主、本地鉴权与工具入口 |
| document-core | 文档/视图身份、版本、事务、保存屏障、任务 |
| DocumentSessions / DocumentHistory | 按文档有序执行、历史字节预算 |
| format-adapters | 非原生编辑与格式投影 |
| office-runtime | Kit 进程、原生模型、输入、图块与检查点 |
| markdown | 源范围命令、资源、工作区文件及偏好 |
| persistence | 内容 blob、恢复清单、迁移与有界写队列 |

## 内容与视图

一份内容对应 `documentId`，各 `viewId` 保留选区、位置、缩放和输入上下文。文本使用 UTF-16 范围及内容 revision；Office 另外核对 session、engineEpoch、engineRevision、selectionEpoch 和布局版本。

Markdown 源文本是唯一可写正文；表格、公式等控件产生范围事务，分栏右侧共享只读虚拟预览；预览选区须精确映射回源码。活跃 Office 由原生模型唯一写入，OOXML 镜像供读取与恢复，不能反向覆盖活跃编辑源。

完整 `ReadingSnapshot` 冻结正文和来源。界面可用 `SelectionContext` 传递已确认选区、身份和文档元数据，避免整文件跨 IPC；Office 核对原生 lease，Markdown/HTML 核对 revision 与源范围，失效写入拒绝执行。需要全文时再冻结内容，SDK 默认快照语义保留。Office 原子 `inspect` 在同一操作中取得状态、属性及能力。

## 完成与恢复

命令“已派发”“已应用”“可恢复”和源文件“已保存”分别表达。人工格式操作可先返回 applied，后台检查点完成后才可称 recoverable；SDK 默认保留持久化屏障。

恢复 v2 使用 SHA-256 blob；纯文本模型从正文重建，小改用最多32层的delta及完整检查点。加载校验长度与哈希；原子替换清单前保留 `.v2.bak`，v1迁移保留 `.v1.bak`。GC保留当前、备份及待写依赖，只删自有目录的托管blob。checkpoint可合并，barrier保序，超预算背压。

`exportRecovery(path)` 排空文档队列、严格同步原生及落盘后导出旧格式恢复包；repository维护屏障保护读取的blob，目标必须新建，不切换当前存储。

文本撤销保留逆操作，Office保留原生token；历史、prepared patches分别限制每文档64 MiB、合计256 MiB。提交释放patch正文，回执以指纹保留幂等语义。回执键数量和元数据序列化仍会增长，细粒度授权与统一预算待完善。

桌面按窗口失效通知刷新，已知正文 revision 可省略重复模型；低频轮询用于补偿。外部文档内容不授予工具权限，运行凭据和密钥不得进入仓库。

[编辑责任与对标](editing/refactor.md) · [审查](review.md) · [恢复与性能](performance/README.md)
