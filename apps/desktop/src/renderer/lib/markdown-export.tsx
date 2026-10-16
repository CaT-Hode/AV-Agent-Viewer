import { renderToStaticMarkup } from 'react-dom/server';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeRaw from 'rehype-raw';
import DOMPurify from 'dompurify';
import { renderMarkdownDiagram, renderMarkdownFormula } from './markdown-renderers';
import { loadMarkdownEmoji, markdownEmoji } from './markdown-emoji';
import { typoraInlineSyntax } from './markdown-export-syntax';

type Render = { kind: 'math' | 'diagram'; source: string; block: boolean; language?: 'mermaid' | 'sequence' | 'flow' };
type MarkdownNode = { type: string; value?: string; children?: MarkdownNode[]; data?: Record<string, unknown> };
/** Optional Typora text extensions are added as AST elements. Their payloads
 * remain text nodes, so source markup never becomes trusted HTML. */
function typoraExtensions() {
  return (tree: unknown) => {
    const transform = (node: MarkdownNode) => {
      if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'math' || node.type === 'inlineMath' || !node.children) return;
      if (node.type === 'paragraph' && node.children.length === 1 && node.children[0].type === 'text' && /^\[toc\]\s*$/i.test(node.children[0].value ?? '')) { node.type = 'avToc'; node.data = { hName: 'nav', hProperties: { className: ['av-toc'], 'data-av-toc': 'true' } }; node.children = []; return; }
      node.children = node.children.flatMap(child => {
        if (child.type !== 'text' || !child.value) { transform(child); return [child]; }
        const result: MarkdownNode[] = []; let cursor = 0;
        for (const match of child.value.matchAll(/:([a-z0-9_+\-]+):/g)) { if (match.index! > cursor) result.push({ type: 'text', value: child.value.slice(cursor, match.index) }); result.push({ type: 'text', value: markdownEmoji(match[1]) ?? match[0] }); cursor = match.index! + match[0].length; }
        if (!cursor) return [child]; if (cursor < child.value.length) result.push({ type: 'text', value: child.value.slice(cursor) }); return result;
      });
    };
    transform(tree as MarkdownNode);
  };
}
const printStyle = `:root{color-scheme:light}*{box-sizing:border-box}body{margin:0;background:#fff;color:#202124;font:15px/1.75 "Segoe UI","Microsoft YaHei",sans-serif}article{max-width:980px;margin:0 auto;padding:40px}h1,h2,h3,h4,h5,h6{line-height:1.35;break-after:avoid}h1,h2{border-bottom:1px solid #ddd;padding-bottom:.35em}a{color:#24658d;text-decoration:underline}pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f4f5f6;padding:16px;border-radius:6px}code{font-family:Consolas,monospace;font-size:.9em}p code,li code{background:#f4f5f6;padding:.1em .25em}blockquote{margin-left:0;padding-left:20px;border-left:3px solid #ccc;color:#555}table{border-collapse:collapse;width:100%;margin:16px 0}th,td{border:1px solid #ccc;padding:8px;overflow-wrap:anywhere}th{background:#f4f5f6}thead{display:table-header-group}tr,img,svg{break-inside:avoid}img,svg{max-width:100%;height:auto}img{object-fit:contain}hr{border:0;border-top:1px solid #ccc}.av-math-block,.av-diagram{text-align:center;margin:18px 0}.av-toc{border-left:2px solid #ddd;padding:12px 20px}.av-toc a{display:block}.av-render-error{border:1px dashed #aaa;padding:12px;white-space:pre-wrap}mark{background:#ffe681}sup,sub{line-height:0}.task-list-item{list-style:none}input[type=checkbox]{margin-right:.5em}@page{size:A4;margin:18mm 16mm}@media print{article{max-width:none;padding:0}body{font-size:11pt}pre{overflow:visible}a{color:inherit}}`;

/** Export from a frozen source string, never from CodeMirror's virtual DOM.
 * Rendering is intentionally exhaustive here. The result is self-contained for
 * local images, formulas and diagrams and has no executable document scripts. */
export async function renderMarkdownForExport(source: string, documentId: string, resource?: (path: string, kind?: 'image'|'media') => Promise<{ url: string }>): Promise<string> {
  const resolveResource = resource ?? (async (path: string) => (await import('./transport')).call<{url:string}>('markdown-resource', {documentId,path}));
  if (/:[a-z0-9_+\-]+:/.test(source)) await loadMarkdownEmoji();
  const renders: Render[] = [];
  const body = source.replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)(?:\r?\n|$)/, '');
  const html = renderToStaticMarkup(<ReactMarkdown remarkPlugins={[[remarkGfm, { singleTilde: false }], remarkMath, typoraInlineSyntax, typoraExtensions]} rehypePlugins={[rehypeRaw]} urlTransform={(url, key, node) => url.startsWith('agentviewer-asset:') || key === 'src' && node.tagName === 'img' && url.length <= 32 * 1024 * 1024 * 1.4 && /^data:image\/(?:png|jpeg|gif|webp|bmp|avif|svg\+xml);base64,/i.test(url) ? url : defaultUrlTransform(url)} components={{
    code: ({ className, children }) => { const classes = className?.split(/\s+/) ?? [], language = classes.find(name => name.startsWith('language-'))?.slice(9); if (classes.includes('language-math')) { const index = renders.push({ kind: 'math', source: String(children).replace(/\n$/, ''), block: classes.includes('math-display') }) - 1; return <span data-av-render={index} />; } if (language && ['mermaid', 'sequence', 'flow'].includes(language)) { const index = renders.push({ kind: 'diagram', source: String(children).replace(/\n$/, ''), block: true, language: language as 'mermaid' | 'sequence' | 'flow' }) - 1; return <span data-av-render={index} />; } return <code className={className}>{children}</code>; },
  }}>{body}</ReactMarkdown>);
  const parsed = new DOMParser().parseFromString('<article>' + html + '</article>', 'text/html'), article = parsed.querySelector('article')!;
  for (const placeholder of article.querySelectorAll<HTMLElement>('[data-av-render]')) {
    const item = renders[Number(placeholder.dataset.avRender)]; if (!item) continue;
    const replacement = parsed.createElement(item.block ? 'div' : 'span');
    replacement.className = item.kind === 'math' ? item.block ? 'av-math-block' : 'av-math' : 'av-' + item.kind;
    try {
      if (item.kind === 'math') replacement.innerHTML = await renderMarkdownFormula(item.source, item.block);
      else if (item.kind === 'diagram') replacement.innerHTML = await renderMarkdownDiagram(item.source, item.language);
    } catch { replacement.className = 'av-render-error'; replacement.textContent = item.source; }
    // A block extension can be the only child of a Markdown paragraph/pre.
    const container = placeholder.parentElement;
    if (item.block && container && /^(P|PRE)$/.test(container.tagName) && container.textContent === '') container.replaceWith(replacement);
    else placeholder.replaceWith(replacement);
  }
  const slugs = new Map<string, number>();
  for (const heading of article.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')) { const base = (heading.textContent ?? '').toLowerCase().replace(/[^\p{L}\p{N}_\-\s]/gu, '').trim().replace(/\s+/g, '-'); const count = slugs.get(base) ?? 0; slugs.set(base, count + 1); heading.id = base + (count ? '-' + count : ''); }
  for (const toc of article.querySelectorAll<HTMLElement>('[data-av-toc]')) { toc.removeAttribute('data-av-toc'); for (const heading of article.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6')) { const link = parsed.createElement('a'); link.href = '#' + heading.id; link.textContent = heading.textContent; link.style.paddingLeft = (Number(heading.tagName[1]) - 1) * 14 + 'px'; toc.append(link); } }
  for (const image of article.querySelectorAll<HTMLImageElement>('img')) { const path = image.getAttribute('src') ?? ''; if (!path || /^https?:/i.test(path)) continue; try { image.src = (await resolveResource(path)).url; } catch (cause) { if(resource)throw cause; const label = parsed.createElement('span'); label.className = 'av-render-error'; label.textContent = '图片无法加载：' + (image.alt || path.slice(0, 200)); image.replaceWith(label); } }
  for(const media of article.querySelectorAll<HTMLMediaElement|HTMLSourceElement>('audio[src],video[src],source[src]')) {
    const path=media.getAttribute('src')??'';if(!path||/^https?:/i.test(path))continue;
    try{if(!resource)throw new Error('媒体导出需要桌面资源通道。');const result=await resource(path,'media');if(result.url)media.setAttribute('src',result.url);else media.removeAttribute('src');}catch(cause){if(resource)throw cause;media.removeAttribute('src');const label=parsed.createElement('span');label.className='av-render-error';label.textContent='媒体无法导出：'+path.slice(0,200);media.after(label);}
  }
  for (const frame of article.querySelectorAll('iframe')) { if (!/^https?:/i.test(frame.getAttribute('src') ?? '')) frame.remove(); else { frame.setAttribute('sandbox', 'allow-scripts allow-presentation'); frame.setAttribute('referrerpolicy', 'no-referrer'); frame.setAttribute('loading', 'lazy'); } }
  for (const quote of article.querySelectorAll('blockquote')) { const first = quote.querySelector('p'); if (first && /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(first.textContent ?? '')) { quote.classList.add('av-callout'); first.innerHTML = first.innerHTML.replace(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i, '<strong>$1</strong>'); } }
  const safe = DOMPurify.sanitize(article.outerHTML, { USE_PROFILES: { html: true, svg: true, svgFilters: true }, ADD_TAGS: ['mjx-container', 'iframe'], ADD_ATTR: ['style', 'sandbox', 'referrerpolicy', 'allowfullscreen'] });
  const title = parsed.querySelector('h1')?.textContent ?? 'Markdown 文档';
  return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' + title.replace(/[<>&"']/g, char => '&#' + char.charCodeAt(0) + ';') + '</title><style>' + printStyle + '</style></head><body>' + safe + '</body></html>';
}
