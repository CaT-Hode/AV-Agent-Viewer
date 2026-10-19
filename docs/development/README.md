# 开发与发行

使用 Node.js 24、npm 和锁文件安装。PowerShell 阻止 ps1 启动器时使用 npm.cmd。

```powershell
npm.cmd ci
npm.cmd run dev
npm.cmd run build
npm.cmd test
npm.cmd run test:desktop
npm.cmd run test:office
```

build 包括文档约束、TypeScript、主进程/preload/MCP 和 Vite 产物。Windows 原生适配器需 MSVC x64；发布包运行不需要编译器。视觉 Worker 由 Vite 单独打包，验证必须使用本轮构建的 dist。

## 引擎与可选转换

```powershell
npm.cmd run engines:prepare
npm.cmd run engines:verify
npm.cmd run package:portable
```

[engines.lock.json](../../engines.lock.json)锁定引擎和校验值。portable 流程准备引擎、bootstrap seed 与发行目录；普通前端构建不自动下载全部外部引擎。

Markdown 的 HTML/PDF/PNG 使用应用导出；DOCX、ODT、RTF、EPUB、LaTeX 等转换使用随包提供、校验锁定的 Pandoc 3.12.1；AGENTVIEWER_PANDOC 可覆盖路径。图片上传执行用户明确配置的可执行文件和参数，保存配置不触发上传。

## 数据与调试

| 环境变量 | 用途 |
| --- | --- |
| AGENTVIEWER_DATA_DIR | 独立数据/测试配置目录 |
| AGENTVIEWER_PORT | 本地服务端口，默认 3210 |
| AGENTVIEWER_CONNECTION_FILE | SDK/MCP 发现文件 |
| AGENTVIEWER_CODEX | Codex 可执行文件 |
| AGENTVIEWER_LIBREOFFICE | 转换引擎路径 |
| AGENTVIEWER_OFFICE_PREWARM=0 | 关闭桌面空闲预热 |
| AGENTVIEWER_BABELDOC | PDF 翻译 CLI |
| AGENTVIEWER_PDF_FONT | PDF 内嵌字体 |

恢复v2在清单旁保存blob；文本delta最多32层，GC保留当前及上代依赖。迁移留 `.v1.bak`，每次v2替换留 `.v2.bak`。SDK的 `exportRecovery(新路径)` 或 `workspace-export-recovery` 导出可供旧版读取的完整恢复包，拒绝覆盖目标且不切换当前存储。迁移、故障和回滚验证使用数据副本，保留用户配置、凭据和活动会话。

每轮相关修改完成后再验证，当前实绩与覆盖边界见[测试记录](../../tests/README.md)。测试总预算 50，以[清单](../../tests/suite.json)统计为准；文档按[manifest](../manifest.json)限制每模块两篇、每篇完整 Unicode 字符≤2000。日志与轨迹留 TEMP，依赖报告放 artifacts。

install:local先复制到同级暂存目录，用.NET流式SHA256校验后切换安装目录，旧版本留作回退，兼容Windows PowerShell 5.1与PowerShell 7。完整暂存可通过-StagingDirectory显式复用；仅接受Programs直系暂存目录，核对完整文件清单、长度和关键哈希，拒绝链接及残缺复制。发现已安装进程运行时拒绝替换；APPDATA用户数据独立保留。安装和远端推送分别验证，不把工作区构建当作已安装。

[测试](../../tests/README.md) · [依赖许可](dependencies.md) · [原生适配](../../packages/office-runtime/native/README.md)
