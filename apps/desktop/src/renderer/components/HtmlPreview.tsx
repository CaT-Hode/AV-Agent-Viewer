import { useEffect, useMemo, useRef } from 'react';
import DOMPurify from 'dompurify';
import { readContextScript } from '../../../../../packages/browser-runtime/src/context-script';
import { htmlNavigationScript } from '../lib/html-navigation';
import { createHtmlReadingChannel, htmlReadingChannelScript } from '../lib/html-reading-channel';
import type { SharedOutlineItem } from '../lib/document-outline';
import type { OfficeNavigationRequest, OfficeNavigationResult } from '../lib/office-navigation';
type HtmlReadingLocation = { actor: 'human' | 'agent'; blockId?: string; requestId?: string; quote?: string; unavailable?: boolean };
export function HtmlPreview({ html, documentId, viewId, revision, outline = [], navigationRequest, onNavigationResult, onError, onContext, highlights=[] }: { html: string; documentId: string; viewId: string; revision: number; outline?: readonly SharedOutlineItem[]; navigationRequest?: OfficeNavigationRequest; onNavigationResult?(result: OfficeNavigationResult): void; onError?(error: unknown): void; highlights?: string[]; onContext(text: string, selected: string, scrollTop: number, rect?: {x:number;y:number;width:number;height:number}, location?: HtmlReadingLocation): void }) {
  const frame = useRef<HTMLIFrameElement>(null), callback = useRef({ onContext, onError, onNavigationResult, documentId, viewId, revision }); callback.current = { onContext, onError, onNavigationResult, documentId, viewId, revision };
  const currentNavigation = useRef<{ requestId?: string; blockId?: string; documentId: string; revision: number } | undefined>(undefined);
  const queuedNavigation = useRef<Record<string, unknown> | undefined>(undefined);
  const loadedPreview = useRef<string | undefined>(undefined), loadHandler = useRef<((token: string) => void) | undefined>(undefined);
  const highlightJson=JSON.stringify(highlights).replace(/</g,'\\u003c');
  const preview = useMemo(() => {
    const clean = DOMPurify.sanitize(html, { WHOLE_DOCUMENT: true });
    const token = crypto.randomUUID();
    const script = `<script>(()=>{let readingActor='human',readingBlockId,readingQuote;const human=()=>{readingActor='human';readingBlockId=undefined;readingQuote=undefined;};addEventListener('pointerdown',human,true);addEventListener('wheel',human,{passive:true,capture:true});addEventListener('keydown',human,true);const surfaceBackground=()=>{for(const element of [document.body,document.documentElement]){const color=getComputedStyle(element).backgroundColor;const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const ctx=canvas.getContext('2d');ctx.fillStyle=color;ctx.fillRect(0,0,1,1);if(ctx.getImageData(0,0,1,1).data[3]>204)return color}return 'white'};const send=(navigation)=>{const data=${readContextScript};postReadingMessage({type:'agentviewer-html-context',actor:readingActor,blockId:readingBlockId,headingTitle:readingQuote,requestId:navigation?.type==='agentviewer-html-navigate'?navigation.requestId:undefined,text:data.visibleText,selected:data.selection,scrollTop:data.scrollY,rect:data.selectionRect,surfaceBackground:surfaceBackground()})};${htmlNavigationScript()}${htmlReadingChannelScript(token)}addEventListener('scroll',send,{passive:true,capture:true});addEventListener('resize',send);addEventListener('selectionchange',send);addEventListener('mouseup',send);addEventListener('keyup',send);addEventListener('load',send);setTimeout(send,150);setTimeout(()=>{const quotes=${highlightJson},ranges=[];const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT),nodes=[];let node,text='';while(node=walker.nextNode()){if(['SCRIPT','STYLE'].includes(node.parentElement?.tagName))continue;nodes.push(node);text+=node.textContent}for(const quote of quotes){const from=text.indexOf(quote);if(!quote||from<0||text.indexOf(quote,from+1)>=0)continue;const r=document.createRange();let offset=0,started=false;for(const n of nodes){const end=offset+n.length;if(!started&&from<end){r.setStart(n,from-offset);started=true}if(started&&from+quote.length<=end){r.setEnd(n,from+quote.length-offset);ranges.push(r);break}offset=end}}CSS.highlights.set('reader-notes',new Highlight(...ranges));const style=document.createElement('style');style.textContent='::highlight(reader-notes){background:#ffd95488;color:inherit}';document.head.append(style)},100)})();<\/script>`;
    return { token, source: clean + script };
  }, [html,highlightJson]);
  useEffect(() => {
    currentNavigation.current = undefined;
    queuedNavigation.current = undefined;
    const disconnected = () => {
      const pending = currentNavigation.current, owner = callback.current;
      currentNavigation.current = undefined; queuedNavigation.current = undefined;
      owner.onContext('', '', 0, undefined, { actor: 'human', unavailable: true });
      window.dispatchEvent(new Event('agentviewer:selection-clear'));
      if (pending?.requestId) owner.onNavigationResult?.({ requestId: pending.requestId, status: 'failed', error: 'HTML 阅读预览已离开原文档，Agent 未跳转。' });
    };
    const channel = createHtmlReadingChannel({ token: preview.token,
      source: () => loadedPreview.current === preview.token ? frame.current?.contentWindow : null,
      onDisconnect: disconnected,
      onReady: () => { if (queuedNavigation.current && channel.post(queuedNavigation.current)) queuedNavigation.current = undefined; },
      onMessage: data => {
      const owner = callback.current, pending = currentNavigation.current;
      if (data.type === 'agentviewer-html-navigation-error') { const matches = !!pending && data.requestId === pending.requestId; if (matches) { currentNavigation.current = undefined; if (queuedNavigation.current?.requestId === data.requestId) queuedNavigation.current = undefined; } if (pending?.requestId && matches) owner.onNavigationResult?.({ requestId: pending.requestId, status: 'failed', error: typeof data.message === 'string' ? data.message : 'HTML 标题跳转失败。' }); else owner.onError?.(data.message); return; }
      if (data.type !== 'agentviewer-html-context') return;
      const background = String(data.surfaceBackground ?? ''); if (background.length <= 160 && CSS.supports('color', background)) { frame.current!.dataset.surfaceBackground = background; window.dispatchEvent(new Event('agentviewer:html-surface')); }
      const location: HtmlReadingLocation = { actor: data.actor === 'agent' && pending?.documentId === owner.documentId && pending.revision === owner.revision && pending.blockId === data.blockId ? 'agent' : 'human', blockId: data.blockId === pending?.blockId ? pending?.blockId : undefined, requestId: data.requestId === pending?.requestId ? pending?.requestId : undefined, quote: typeof data.headingTitle === 'string' ? data.headingTitle.slice(0, 120) : undefined };
      const sourceRect = data.rect && typeof data.rect === 'object' ? data.rect as Record<string, unknown> : undefined;
      const frameRect = frame.current!.getBoundingClientRect();
      const rect = sourceRect ? { x: Number(sourceRect.x) + frameRect.x, y: Number(sourceRect.y) + frameRect.y, width: Number(sourceRect.width), height: Number(sourceRect.height) } : undefined;
      owner.onContext(String(data.text ?? ''), String(data.selected ?? ''), Number(data.scrollTop ?? 0), rect && Object.values(rect).every(Number.isFinite) ? rect : undefined, location);
      if (location.actor === 'agent' && location.requestId) owner.onNavigationResult?.({ requestId: location.requestId, status: 'rendered' });
      },
    });
    const receive = (event: MessageEvent) => { channel.receiveHandshake(event); };
    const navigate = (event: Event) => { const data = (event as CustomEvent).detail, owner = callback.current; if (data?.viewId !== owner.viewId || data.documentId !== owner.documentId || data.revision !== owner.revision) return; currentNavigation.current = { requestId: data.requestId, blockId: data.blockId, documentId: owner.documentId, revision: owner.revision }; window.dispatchEvent(new Event('agentviewer:selection-clear')); const message = { ...data, type: 'agentviewer-html-navigate' }; if (!channel.post(message)) queuedNavigation.current = message; };
    const loaded = (token: string) => {
      if (token !== preview.token) return;
      const replaced = loadedPreview.current === preview.token;
      loadedPreview.current = preview.token; channel.reset();
      if (replaced) disconnected();
      // Contains neither nonce nor navigation metadata. Only the original srcDoc
      // can respond with the nonce-authenticated transferred port.
      frame.current?.contentWindow?.postMessage({ type: 'agentviewer-html-channel-request' }, '*');
    };
    loadHandler.current = loaded;
    window.addEventListener('message', receive); window.addEventListener('agentviewer:html-navigate', navigate);
    return () => { channel.close(); if (loadHandler.current === loaded) loadHandler.current = undefined; window.removeEventListener('message', receive); window.removeEventListener('agentviewer:html-navigate', navigate); };
  }, [preview.token]);
  useEffect(() => {
    if (!navigationRequest) {
      if (queuedNavigation.current?.requestId && queuedNavigation.current.requestId === currentNavigation.current?.requestId) { queuedNavigation.current = undefined; currentNavigation.current = undefined; }
      return;
    }
    if (navigationRequest.target.kind !== 'html-heading') return;
    const request = navigationRequest, owner = callback.current;
    if (request.viewId !== owner.viewId || request.documentId !== owner.documentId || request.expectedRevision !== owner.revision) { owner.onNavigationResult?.({ requestId: request.requestId, status: 'failed', error: 'HTML 文档版本已变化，Agent 未跳转。' }); return; }
    const blockId = navigationRequest.target.blockId, index = outline.findIndex(item => item.id === blockId), target = outline[index];
    if (!target) return;
    window.dispatchEvent(new CustomEvent('agentviewer:html-navigate', { detail: { viewId, documentId, revision, index, title: target.title, blockId: target.id, actor: 'agent', requestId: request.requestId } }));
  }, [navigationRequest?.requestId, outline, preview.token]);
  return <iframe ref={frame} title="HTML 阅读预览" sandbox="allow-scripts" className="html-preview" srcDoc={preview.source} onLoad={() => {
    if (loadHandler.current) loadHandler.current(preview.token);
    else { loadedPreview.current = preview.token; frame.current?.contentWindow?.postMessage({ type: 'agentviewer-html-channel-request' }, '*'); }
  }} />;
}
