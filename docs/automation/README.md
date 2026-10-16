# AI、翻译与连接

AI 操作绑定文档、视图、内容版本和来源范围。空选区不自动扩大为全文，可见范围不等于整篇内容。分析文本与原文修改采用不同操作。

## 来源与任务

reader_ai_tools/run/result/retry 提供发现、执行和结果。重试沿用原冻结来源，晚到结果不得覆盖新选择；模型输出不是源文档事实。

Office、Markdown、HTML 的界面选区工具可返回轻量 SelectionContext。复制、引用与选区 AI 使用冻结文本；批注及正文修改复核当前范围和版本。需要全文分析或导出时固定 ReadingSnapshot，SDK 默认完整快照语义保留，轻量元数据不表示读取过全文。

选区翻译可取消或固定，不进入文档撤销历史。全文翻译冻结发起时字节，生成独立同格式文件并支持片段恢复；后续原文变化不混入译文。PDF 全文翻译依赖 BabelDOC，复杂 Office 排版须检查产物。

网页翻译替换页面文字，可恢复未被站点自身改动的节点；不提交站点。布局改变后原坐标请求必须刷新身份。

## 模型连接

支持 OpenAI Responses、Chat Completions 兼容服务和 Anthropic Messages；选区、全文、网页、问答可选择不同连接。在途任务捕获发起时配置，不随设置改动换模型。

密钥通过 Electron safeStorage 本地保存，读取/导出设置不返回明文；PDF 翻译使用短时本地模型桥。Codex 驱动通过独立 app-server 会话使用已有登录，不能附着当前桌面聊天。

## 外部工具

HTTP、CLI、MCP 共用[SDK工具定义](../../apps/local-service/src/mcp.ts)与 Core。[阅读](../../plugins/agent-viewer/skills/reading/SKILL.md)和[编辑](../../plugins/agent-viewer/skills/editing/SKILL.md)插件说明版本、来源与回执。

进程内 AI 去重记录有上限；重启或淘汰后先查询原任务。原生修改区分 dispatched、applied、recoverable 与 saved，不确定结果先核对，不自动重发。

Markdown 图片上传是独立、显式的资源操作，只在用户点击时执行配置命令，不因读取或保存偏好自动上传。运行发现文件含本地凭据，仅供受信任客户端使用。

本轮来源冻结、轻量选区、幂等重试和恢复边界见[测试记录](../../tests/README.md)。自动化通过不表示全部模型连接与外部副作用均已实测。[架构](../architecture.md)
