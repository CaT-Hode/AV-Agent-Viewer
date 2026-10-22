# 开发与发行

使用 Node.js 24、npm 与锁文件。PowerShell 阻止 ps1 启动器时使用 npm.cmd。

```powershell
npm.cmd ci
npm.cmd run dev
npm.cmd run build
npm.cmd test
npm.cmd run test:desktop
npm.cmd run test:office
npm.cmd run test:full
```

build 检查文档、MCP预算与TypeScript，再构建全部运行时和Vite。dev复用运行时构建并启动Vite/Electron，代理/internal与/fixtures。TypeScript拒绝未使用的声明和参数。原生适配器需要MSVC x64；预算在独立catalog-only进程测量，不触发编辑或输入。

## 公开接口维护

新功能在公共 registry 定义类型和说明，再实现共享服务与真实读回。旧公开路由/工具/SDK别名直接删除，不增加兼容层。按格式归属schema，不把巨大union塞进共享核心。

```powershell
npm.cmd run docs:check
npm.cmd run mcp:budget
npm.cmd run mcp:budget -- --update
npm.cmd run mcp:host-probe
npm.cmd run mcp:host-check
```

审查目录与token变化后才更新预算快照，不得绕过硬上限。tokenizer、离线词表与实现SHA已锁定；Codex实际包装未认证。

host-probe 使用自有 loopback Responses 服务及独立 MCP 文档，120秒上限，无真实模型请求。它检查 Codex 的目录刷新与实际调用；当前客户端未通过时返回非零，不进入普通构建门禁。日志仅保留工具元数据，不代表桌面验收。

package:portable 与安装脚本均先运行 host-check，直接调用PS也不能跳过。认证绑定目录摘要、桌面版本与实际捕获；安装另核对源包目录清单及代码/技能SHA。未知精确tokenizer或缺证据均不放行，不生成手写通过工件；失败时可继续构建和修复。

## 引擎与打包

```powershell
npm.cmd run engines:prepare
npm.cmd run engines:verify
npm.cmd run package:portable
```

[engines.lock.json](../../engines.lock.json)固定引擎与校验值。portable 准备引擎、seed 与发行目录；普通构建不下载全部运行时。Pandoc 转换输出独立产物，图片上传只执行明确配置的命令。

## 数据与调试

| 环境变量 | 用途 |
| --- | --- |
| AGENTVIEWER_DATA_DIR | 独立用户/测试数据目录 |
| AGENTVIEWER_PORT | 本地端口，默认3210 |
| AGENTVIEWER_CONNECTION_FILE | SDK/MCP发现文件 |
| AGENTVIEWER_CODEX | Codex可执行文件 |
| AGENTVIEWER_LIBREOFFICE | 转换引擎路径 |
| AGENTVIEWER_OFFICE_PREWARM=0 | 关闭空闲预热 |
| AGENTVIEWER_BABELDOC | PDF翻译CLI |
| AGENTVIEWER_PDF_FONT | PDF内嵌字体 |
| AGENTVIEWER_CATALOG_ONLY=1 | 目录测量，禁止连接桌面 |

发现文件含凭据，不提交。验证使用数据副本，保留配置、账户和活动会话。恢复blob/delta及内部备份独立于公开API生命周期。

## 验证与本机替换

测试45项、上限50，单元不作桌面验收。桌面及原生入口重建、核对源码/产物SHA，通过后保留证据、清理临时数据。文档≤2000字符，每模块≤2篇，见[manifest](../manifest.json)。

发行安装先通过认证，再暂存并校验文件、长度与SHA，切换目录并保留回退。本机开发入口使用已验证dist，正常关闭后重建并核对运行身份。保留APPDATA及恢复副本，不强关用户进程。构建、本机更新与push分别验证。

[测试](../../tests/README.md) · [依赖许可](dependencies.md) · [适配器](../../packages/office-runtime/native/README.md)
