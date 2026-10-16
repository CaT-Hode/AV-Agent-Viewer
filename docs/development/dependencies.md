# 依赖与许可

package.json 描述直接依赖，package-lock.json 固定 npm 依赖树，engines.lock.json 固定外部引擎。发行核对实际产物，不能仅依据手写版本表。

## 编辑与图表

CodeMirror/Lezer 提供源码、分栏虚拟预览及增量语法；React Markdown、rehype-raw、remark-math 用于完整文档导出。MathJax/Mermaid 按需加载公式和图表。

本轮新增旧语法兼容组件，已检查安装包的元数据及原始许可：

| 组件 | 实际版本 | 许可 |
| --- | --- | --- |
| @rokt33r/js-sequence-diagrams | 2.0.6-2 | BSD-2-Clause；LICENCE 保留 Andrew Brampton 归属 |
| flowchart.js | 1.18.0 | MIT |
| raphael | 2.3.0 | MIT |
| underscore | 1.13.7 | MIT |
| gemoji | 8.1.0 | MIT |

rehype-raw 7.0.0 与 remark-math 6.0.0 元数据声明 MIT；原始许可是否随发行完整携带仍需发行清单核对。旧图表依赖通过 override 统一 Raphael/Underscore；KaTeX 间接依赖锁定使用修复版本。Pandoc 是可选外部命令，不随 npm 安装。

## 外部运行时

LibreOffice 26.8.1 使用 MPL-2.0/LGPL-3.0+；BabelDOC 0.6.4 声明 AGPL-3.0；Tesseract.js 7.0.0 使用 Apache-2.0。精确引擎内容由锁文件和 engines:verify 核对，Windows ABI另见[适配器](../../packages/office-runtime/native/README.md)。

## 报告与归属

```powershell
npm.cmd run dependencies:report
```

2026-10-16 本轮报告已生成，包含 51 个已安装直接 npm 包及实际版本/许可字段，输出 artifacts/dependencies.json。该报告不覆盖全部传递依赖、Electron/Chromium 内嵌组件或外部引擎，不能视作完整发行 NOTICE。

发行时保留各包原始许可、归属及适用源码提供义务。[Liquid Glass MIT 原文](../licenses/liquid-glass-frontend-MIT.txt)保持不变；法律原文不为项目说明的字符预算删改。

[开发与发行](README.md) · [测试](../../tests/README.md)
