import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const lines = [
  '# 首轮直接依赖记录', '',
  '2026-10-10。版本与许可证字段读取本机已安装包的 package.json；完整依赖树由 package-lock.json 固定。此表不是完整发行 NOTICE，Electron/Chromium、PDF.js 等的内嵌第三方组件仍需在打包时整理。BabelDOC 通过可选外部 CLI 适配，许可证 AGPL-3.0；本机未安装或验收。ONLYOFFICE、LibreOffice、Tiptap、SQLite 和 OCR 尚未作为内置引擎集成。', '',
  '| 依赖 | 实际版本 | 包声明许可证 | 范围 |',
  '| --- | --- | --- | --- |',
];
for (const [scope, dependencies] of [['运行', pkg.dependencies], ['开发/构建/测试', pkg.devDependencies]]) {
  for (const name of Object.keys(dependencies)) {
    const metadata = JSON.parse(await readFile(join('node_modules', name, 'package.json'), 'utf8'));
    const license = typeof metadata.license === 'string' ? metadata.license : JSON.stringify(metadata.license ?? '未声明');
    lines.push(`| ${name} | ${metadata.version} | ${license} | ${scope} |`);
  }
}
lines.push('', '重新生成：node scripts/dependency-report.mjs', '');
await writeFile('docs/直接依赖版本与许可证.md', lines.join('\n'));
