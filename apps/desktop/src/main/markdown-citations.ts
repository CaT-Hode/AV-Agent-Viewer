import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseFragment, serializeOuter, type DefaultTreeAdapterTypes } from 'parse5';
import type { ReferenceOccurrence } from '../../../../packages/markdown/src/writing-syntax';
import type { MarkdownPreferences } from '../../../../packages/markdown/src/preferences';
import { ViewerError } from '../../../../packages/contracts/src/index';

const execute = promisify(execFile);
export async function bibliographyArgs(settings: MarkdownPreferences['export'], documentPath?: string) {
  if (!settings.bibliography) return [];
  const args = ['--citeproc'];
  for (const [key, raw] of [
    ['bibliography', settings.bibliography],
    ['csl', settings.csl],
  ]) {
    if (!raw) continue;
    if (!documentPath && !isAbsolute(raw))
      throw new ViewerError('INVALID_ARGUMENT', '请先保存文档，或为参考文献文件填写绝对路径。');
    const path = resolve(documentPath ? dirname(documentPath) : '.', raw);
    if (!(await stat(path).catch(() => null))?.isFile())
      throw new ViewerError('INVALID_ARGUMENT', '找不到本地参考文献文件：' + path);
    args.push('--' + key + '=' + path);
  }
  return args;
}
export function checkCitations(stderr: string) {
  const missing = [...stderr.matchAll(/citation (.+?) not found/gi)].map((match) => match[1]);
  if (missing.length) throw new ViewerError('INVALID_ARGUMENT', '文献库缺少引用键：' + missing.join('、'));
}
/** Format every occurrence in document order in one citeproc run. A numeric
 * or author-date CSL style can depend on earlier occurrences of the same key. */
export async function formattedCitations(pandoc: string, args: string[], occurrences: ReferenceOccurrence[]) {
  const directory = await mkdtemp(join(tmpdir(), 'agentviewer-citations-'));
  try {
    const file = join(directory, 'citations.md');
    await writeFile(file, occurrences.map((c) => c.raw).join('\n\n'), 'utf8');
    const { stdout, stderr } = await execute(
      pandoc,
      [file, '--from=markdown+citations', '--to=html5', '--wrap=none', ...args],
      { cwd: directory, windowsHide: true, timeout: 120000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8' }
    );
    checkCitations(stderr);
    const root = parseFragment(stdout),
      inline: string[] = [];
    let references = '';
    for (const line of root.childNodes) {
      if (!('tagName' in line)) continue;
      if (line.tagName === 'p') {
        const cite = line.childNodes.find(
          (child): child is DefaultTreeAdapterTypes.Element =>
            'tagName' in child && child.attrs.some((attr) => attr.name === 'data-cites')
        );
        if (cite) inline.push(serializeOuter(cite));
      } else if (line.attrs.some((attr) => attr.name === 'id' && attr.value === 'refs'))
        references = serializeOuter(line);
    }
    if (inline.length !== occurrences.length)
      throw new ViewerError('INVALID_ARGUMENT', '所选引文样式无法生成完整引用。');
    return { inline, references };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
