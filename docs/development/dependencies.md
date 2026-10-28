# 依赖与许可

package.json 声明直接依赖，package-lock.json 固定 npm 树，engines.lock.json 固定外部引擎。发行必须核对实际产物与原始许可，手写版本表不能代替清单。

## 编辑与转换

CodeMirror/Lezer 负责源码、虚拟预览和增量语法；React Markdown、rehype-raw、remark-math 用于完整导出。MathJax/Mermaid 按需加载数学和图表。

| 组件 | 许可 |
| --- | --- |
| @rokt33r/js-sequence-diagrams | BSD-2-Clause，保留 Andrew Brampton 归属 |
| flowchart.js / raphael / underscore / gemoji | MIT |
| rehype-raw / remark-math | MIT，发行核对原文 |
| Pandoc | GPL-2.0-or-later，保留 COPYING |

旧图表库通过 overrides 统一 Raphael/Underscore；KaTeX 间接依赖使用修复版本。Pandoc 作为独立进程随包提供，版本、下载地址与 SHA 见引擎锁文件。

## 上下文计数

开发依赖 `js-tiktoken 1.0.21` 使用 MIT。包内包含 o200k_base、cl100k_base 离线词表；npm锁文件固定依赖，预算脚本核对版本，不重复计算包文件SHA，不运行时下载，也不以字节/字符估算 tokens。

该 profile 是可复现的参考计数，不表示当前 Codex 模型 tokenizer 与宿主包装已认证。依赖不进入编辑器运行路径。

## 外部运行时

LibreOffice 使用 MPL-2.0/LGPL-3.0+；BabelDOC 声明 AGPL-3.0；Tesseract.js 使用 Apache-2.0。精确版本由引擎锁文件、安装内容与 engines:verify 核对。Electron/Chromium 内嵌组件另需发行许可清单。

## 报告

```powershell
npm.cmd run dependencies:report
```

报告写入 `artifacts/dependencies.json`，列出已安装直接包的版本与许可。它不覆盖全部传递依赖、内嵌组件或外部引擎，不能当作完整发行 NOTICE。

发行保留原始许可、归属与适用源码提供义务。[Liquid Glass许可原文](../licenses/liquid-glass-frontend-MIT.txt)不因说明文档字数限制删改。

[开发](README.md) · [MCP](../automation/mcp.md)
