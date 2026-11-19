import { registerFind, findPattern, snippet, findChanged, type FindHit } from '../lib/reader-find';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import { bytes } from '../lib/transport';
import { useDocumentPaperColor } from '../lib/document-paper';
import { observeNavigationLane } from '../lib/navigation-lane';
import '../pdf-viewport.css';
import type { DocumentInfo, EditOperation } from '../../../../../packages/contracts/src/index';
pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

type Page = { index: number; wrap: HTMLDivElement; canvas: HTMLCanvasElement; layer: HTMLDivElement; controls: HTMLDivElement; page: pdfjs.PDFPageProxy; ready: boolean; base: pdfjs.PageViewport; viewport: pdfjs.PageViewport; text?: ReturnType<pdfjs.PDFPageProxy['getTextContent']>; annotations?: ReturnType<pdfjs.PDFPageProxy['getAnnotations']>; textLayer?: pdfjs.TextLayer; key?: string; task?: pdfjs.RenderTask; visible: boolean };
type Anchor = { index: number; fraction: number; screenY: number; scrollLeft: number };
const editableAnnotationTypes = new Set([pdfjs.AnnotationType.TEXT,pdfjs.AnnotationType.FREETEXT,pdfjs.AnnotationType.LINE,pdfjs.AnnotationType.SQUARE,pdfjs.AnnotationType.CIRCLE,pdfjs.AnnotationType.HIGHLIGHT,pdfjs.AnnotationType.UNDERLINE,pdfjs.AnnotationType.SQUIGGLY,pdfjs.AnnotationType.STRIKEOUT,pdfjs.AnnotationType.STAMP,pdfjs.AnnotationType.INK]);
const annotationNames: Record<number,string> = { [pdfjs.AnnotationType.HIGHLIGHT]:'高亮',[pdfjs.AnnotationType.UNDERLINE]:'下划线',[pdfjs.AnnotationType.STRIKEOUT]:'删除线' };

export function PdfReader({ document, viewId, initial, zoom = 1, note, highlight, edit, pageRef, onReady }: { document: DocumentInfo; viewId:string; initial?:import('../../../../../packages/contracts/src/index').Locator; zoom?: number; note: string; highlight: boolean; edit(operation: EditOperation): Promise<void>; pageRef: React.RefObject<number>; onReady(): void }) {
  const host = useRef<HTMLDivElement>(null), [error,setError] = useState(''), [readingWidth,setReadingWidth] = useState(0);
  const paperColor = useDocumentPaperColor();
  const current = useRef({note,highlight,edit,pageRef,onReady,zoom,readingWidth,paperColor}); current.current = {note,highlight,edit,pageRef,onReady,zoom,readingWidth,paperColor};
  const pages = useRef<Page[]>([]), generation = useRef(0), revision = useRef(document.revision), loading = useRef(true), running = useRef(false), requestFrame = useRef(0), viewUpdate = useRef<() => void>(()=>{}), queuePaint = useRef<() => void>(()=>{});
  const loadedPdf=useRef<pdfjs.PDFDocumentProxy | undefined>(undefined);
  const scrollport = () => host.current?.closest<HTMLElement>('.document-content');
  useEffect(()=>registerFind(viewId,async(options,signal)=>{
    const pdf=loadedPdf.current;if(!pdf)throw new Error('PDF 正在加载。');
    const hits:FindHit[]=[],targets:{page:number;start:number;startOffset:number;end:number;endOffset:number}[]=[];
    let hasText=false,limited=false;
    for(let page=0;page<pdf.numPages&&!limited;page++){
      signal.throwIfAborted();
      const rendered=pages.current[page];
      const content=await (rendered?.text??(await pdf.getPage(page+1)).getTextContent());
      signal.throwIfAborted();
      const items=content.items.filter(i=>'str' in i);let text='';const starts=items.map(item=>{const at=text.length;text+=item.str+(item.hasEOL?' ':'');return at;});
      hasText ||= !!text.trim();let j=0;
      for(const match of text.matchAll(findPattern(options))){if(hits.length===500){limited=true;break;}
        while(j+1<items.length&&starts[j+1]<=match.index)j++;let end=j;
        const to=match.index+match[0].length;while(end+1<items.length&&starts[end+1]<to)end++;
        hits.push(snippet(text,match.index,to,'第 '+(page+1)+' 页'));
        targets.push({page,start:j,startOffset:Math.min(items[j].str.length,match.index-starts[j]),end,endOffset:Math.min(items[end].str.length,to-starts[end])});
      }
    }
    let navigation=0;const name='av-pdf-find';
    return {hits,limited,note:hasText?undefined:'此 PDF 没有可搜索的文字层。',clear(){navigation++;CSS.highlights.delete(name);},async reveal(i){
      const n=++navigation,t=targets[i],item=pages.current[t.page];item.wrap.scrollIntoView({block:'start'});item.visible=true;queuePaint.current();
      for(let tries=0;tries<160;tries++){if(signal.aborted||n!==navigation||loadedPdf.current!==pdf)return;
        const divs=item.textLayer?.textDivs,start=divs?.[t.start]?.firstChild,end=divs?.[t.end]?.firstChild;
        if(start?.isConnected&&end?.isConnected){const r=window.document.createRange();r.setStart(start,t.startOffset);r.setEnd(end,t.endOffset);
          divs![t.start].scrollIntoView({block:'center'});CSS.highlights.set(name,new Highlight(r));current.current.pageRef.current=t.page;return;}
        await new Promise(done=>setTimeout(done,25));
      }throw new Error('此页文字层未能呈现。');
    }};
  }),[viewId,document.revision]);
  const anchor = (): Anchor | undefined => {
    const root=scrollport(); if(!root||!pages.current.length)return;
    const box=root.getBoundingClientRect(), screenY=Math.min(box.height*.35,260), at=box.top+screenY;
    const page=pages.current.find(item=>{const rect=item.wrap.getBoundingClientRect();return rect.bottom>at;})??pages.current.at(-1)!;
    const rect=page.wrap.getBoundingClientRect(); return {index:page.index,fraction:(at-rect.top)/Math.max(1,rect.height),screenY,scrollLeft:root.scrollLeft};
  };
  const restore = (value: Anchor | undefined) => {
    const root=scrollport(), page=value&&pages.current[Math.min(value.index,pages.current.length-1)]; if(!root||!page||!value)return;
    const rect=page.wrap.getBoundingClientRect(), box=root.getBoundingClientRect();
    root.scrollTop+=rect.top-box.top+value.fraction*rect.height-value.screenY; root.scrollLeft=value.scrollLeft;
  };
  const visible = (page:Page,margin=700) => { const root=scrollport();if(!root)return false;const box=root.getBoundingClientRect(),rect=page.wrap.getBoundingClientRect();return rect.bottom>=box.top-margin&&rect.top<=box.bottom+margin; };
  const paintKey = (page:Page) => `${revision.current}:${page.viewport.scale}:${Math.min(2,window.devicePixelRatio||1)}:${current.current.paperColor}`;
  queuePaint.current=()=>{
    if(running.current||requestFrame.current)return;
    requestFrame.current=requestAnimationFrame(()=>{
      requestFrame.current=0;if(running.current)return;running.current=true;
      const run=async()=>{
        for(;;){
          if(loading.current)break;
          const candidates=pages.current.filter(item=>item.visible&&item.key!==paintKey(item));
          candidates.sort((a,b)=>Math.abs(a.index-current.current.pageRef.current)-Math.abs(b.index-current.current.pageRef.current));
          const item=candidates[0];if(!item)break;
          const owned=generation.current;let key=paintKey(item);
          try{
          if(!item.ready){
            const source=loadedPdf.current;if(!source)break;
            const page=await source.getPage(item.index+1);if(generation.current!==owned)continue;
            const saved=anchor();item.page=page;item.ready=true;item.base=page.getViewport({scale:1});
            const scale=Math.min(1.1,current.current.readingWidth/item.base.width)*current.current.zoom;item.viewport=page.getViewport({scale});item.wrap.style.width=item.viewport.width+'px';item.wrap.style.height=item.viewport.height+'px';item.wrap.style.setProperty('--scale-factor',String(scale));item.wrap.style.setProperty('--total-scale-factor',String(scale));restore(saved);
          }
          key=paintKey(item);const viewport=item.viewport,ratio=Math.min(2,window.devicePixelRatio||1,Math.sqrt(8_000_000/(viewport.width*viewport.height))),color=current.current.paperColor;
          const canvas=window.document.createElement('canvas');canvas.width=Math.ceil(viewport.width*ratio);canvas.height=Math.ceil(viewport.height*ratio);canvas.style.width='100%';canvas.style.height='100%';
            item.task=item.page.render({canvas,canvasContext:canvas.getContext('2d')!,viewport,background:color,transform:ratio===1?undefined:[ratio,0,0,ratio,0,0]});
            await item.task.promise;
            if(generation.current!==owned||key!==paintKey(item)||!item.wrap.isConnected)continue;
            item.canvas.replaceWith(canvas);item.canvas=canvas;canvas.dataset.documentPaper=color;
            const text=await (item.text??=item.page.getTextContent());
            if(generation.current!==owned||key!==paintKey(item))continue;
            item.textLayer?.cancel();
            if(item.layer.dataset.scale!==String(viewport.scale)||item.layer.dataset.revision!==String(revision.current)){
              const layer=window.document.createElement('div');layer.className='textLayer';layer.style.setProperty('--total-scale-factor',String(viewport.scale));
              const textLayer=new pdfjs.TextLayer({textContentSource:text,container:layer,viewport});item.textLayer=textLayer;await textLayer.render();
              if(generation.current!==owned||key!==paintKey(item))continue;
              layer.dataset.scale=String(viewport.scale);layer.dataset.revision=String(revision.current);item.layer.replaceWith(layer);item.layer=layer;
            }
            const annotations=await (item.annotations??=item.page.getAnnotations({intent:'display'}));
            if(generation.current!==owned||key!==paintKey(item))continue;
            item.controls.replaceChildren();
            for(const annotation of annotations){
              if(!editableAnnotationTypes.has(annotation.annotationType)||!/^\d+R\d*$/.test(annotation.id))continue;
              const [x1,y1]=viewport.convertToViewportPoint(annotation.rect[0],annotation.rect[1]),[x2,y2]=viewport.convertToViewportPoint(annotation.rect[2],annotation.rect[3]), control=window.document.createElement('button');
              control.className='pdf-annotation-delete';control.type='button';control.textContent='×';control.title=control.ariaLabel='删除'+(annotationNames[annotation.annotationType]??'批注');control.dataset.sourceKind='pdf-native-annotation';control.dataset.annotationId=annotation.id;
              control.style.left=Math.min(viewport.width-20,Math.max(0,Math.max(x1,x2)-6))+'px';control.style.top=Math.max(0,Math.min(y1,y2)-12)+'px';
              control.addEventListener('pointerdown',event=>{event.stopPropagation();event.preventDefault();});
              control.addEventListener('click',event=>{event.stopPropagation();control.disabled=true;void current.current.edit({kind:'pdf.removeAnnotation',pageIndex:item.index,annotationId:annotation.id}).catch(error=>{setError(String(error));control.disabled=false;});});item.controls.append(control);
            }
            item.controls.style.visibility='';item.key=key;current.current.onReady();
            // Keep nearby pages warm, release large rasters after leaving them.
            const cached=pages.current.filter(page=>!page.visible&&page.canvas.width>0).sort((a,b)=>Math.abs(b.index-item.index)-Math.abs(a.index-item.index));
            let pixels=pages.current.reduce((sum,page)=>sum+page.canvas.width*page.canvas.height,0);
            for(const page of cached){if(pixels<=24_000_000)break;pixels-=page.canvas.width*page.canvas.height;page.canvas.width=page.canvas.height=0;page.key=undefined;}
          }catch(error){if((error as Error).name!=='RenderingCancelledException'&&generation.current===owned){setError(String(error));item.key=key;}}
          finally{item.task=undefined;}
        }
      };
      void run().finally(()=>{running.current=false;});
    });
  };
  viewUpdate.current=()=>{
    const saved=anchor();generation.current++;
    for(const item of pages.current){
      item.task?.cancel();const scale=Math.min(1.1,current.current.readingWidth/item.base.width)*current.current.zoom,viewport=item.base.clone({scale});item.viewport=viewport;
      item.wrap.style.width=viewport.width+'px';item.wrap.style.height=viewport.height+'px';item.wrap.style.setProperty('--scale-factor',String(scale));item.wrap.style.setProperty('--total-scale-factor',String(scale));
      const textScale=Number(item.layer.dataset.scale);if(textScale){item.layer.style.setProperty('--total-scale-factor',String(textScale));item.layer.style.transform=`scale(${scale/textScale})`;item.layer.style.transformOrigin='0 0';item.layer.style.width=viewport.width/(scale/textScale)+'px';item.layer.style.height=viewport.height/(scale/textScale)+'px';}
      if(item.key!==paintKey(item))item.controls.style.visibility='hidden';
    }
    restore(saved);for(const item of pages.current)item.visible=visible(item);queuePaint.current();
  };
  useLayoutEffect(()=>{
    const reader=host.current?.closest<HTMLElement>('.reader-panel');if(!reader)return;
    const update=()=>{
      const box=reader.getBoundingClientRect(),workbench=reader.closest('.workbench'),leftRail=workbench?.querySelector('.activity-rail')?.getBoundingClientRect(),rightRail=workbench?.querySelector('.ai-rail')?.getBoundingClientRect();
      const railLeft=Math.max(12,leftRail?leftRail.right-box.left+12:12),railRight=Math.max(12,rightRail?box.right-rightRail.left+12:12);
      for(const [name,value]of[['--pdf-safe-left',railLeft],['--pdf-safe-right',railRight]]as const){const text=value.toFixed(3)+'px';if(reader.style.getPropertyValue(name)!==text)reader.style.setProperty(name,text);}
      const width=Math.max(1,Math.round(box.width-railLeft-railRight));setReadingWidth(old=>old===width?old:width);
    };
    const stop=observeNavigationLane(reader,update,false);return()=>{stop();reader.style.removeProperty('--pdf-safe-left');reader.style.removeProperty('--pdf-safe-right');};
  },[document.id]);
  useLayoutEffect(()=>{if(readingWidth)viewUpdate.current();},[zoom,readingWidth,paperColor]);
  useEffect(()=>{
    let disposed=false;const root=scrollport();if(!root)return;
    const saved=anchor();let initialAllowed=!saved;
    const cancelInitial=()=>{initialAllowed=false;};for(const type of ['wheel','pointerdown','keydown'])root?.addEventListener(type,cancelInitial,true);
    let task:ReturnType<typeof pdfjs.getDocument>|undefined;loading.current=true;setError('');
    const visibility=new IntersectionObserver(entries=>{for(const entry of entries){const item=pages.current[Number((entry.target as HTMLElement).dataset.pageIndex)];if(item?.wrap===entry.target)item.visible=entry.isIntersecting;}queuePaint.current();},{root,rootMargin:'700px 0px'});
    const load=async()=>{
      const input=await bytes(document.id);if(disposed)return;task=pdfjs.getDocument({data:input});const pdf=await task.promise;if(disposed)return;
      const first=await pdf.getPage(1);if(disposed)return;
      generation.current++;revision.current=document.revision;loadedPdf.current=pdf;findChanged(viewId);
      const old=pages.current;for(const item of old){item.task?.cancel();item.textLayer?.cancel();}
      pages.current=Array.from({length:pdf.numPages},(_,index)=>{
        const page=first;
        const reused=old[index],wrap=reused?.wrap??window.document.createElement('div'),canvas=reused?.canvas??window.document.createElement('canvas'),layer=reused?.layer??window.document.createElement('div'),controls=reused?.controls??window.document.createElement('div');
        wrap.className='pdf-page';wrap.dataset.pageIndex=String(index);layer.className='textLayer';controls.className='pdf-annotation-controls';controls.replaceChildren();
        if(!reused){canvas.style.width=canvas.style.height='100%';wrap.append(canvas,layer,controls);host.current!.append(wrap);
          wrap.addEventListener('pointerdown',()=>{current.current.pageRef.current=index;});
          wrap.addEventListener('click',event=>{const callback=current.current;if(!callback.note&&!callback.highlight)return;const rect=wrap.getBoundingClientRect(),x=(event.clientX-rect.left)/rect.width,y=(event.clientY-rect.top)/rect.height;void callback.edit(callback.highlight?{kind:'pdf.highlight',pageIndex:index,x,y,width:Math.min(.25,1-x),height:Math.min(.03,1-y)}:{kind:'pdf.addText',pageIndex:index,x,y,text:callback.note,size:16}).catch(error=>setError(String(error)));});
        }
        return {index,wrap,canvas,layer,controls,page,ready:index===0,base:index===0?page.getViewport({scale:1}):old[index]?.base??page.getViewport({scale:1}),viewport:page.getViewport({scale:1}),visible:false};
      });
      for(const item of old.slice(pdf.numPages))item.wrap.remove();
      for(const item of pages.current)visibility.observe(item.wrap);
      loading.current=false;viewUpdate.current();restore(saved);if(initialAllowed&&initial?.pageIndex!==undefined&&pages.current[initial.pageIndex])restore({index:initial.pageIndex,fraction:initial.pageFraction??0,screenY:0,scrollLeft:0});initialAllowed=false;for(const item of pages.current)item.visible=visible(item);queuePaint.current();
    };
    void load().catch(error=>{if(!disposed)setError(String(error));});
    return()=>{for(const type of ['wheel','pointerdown','keydown'])root?.removeEventListener(type,cancelInitial,true);disposed=true;visibility.disconnect();generation.current++;for(const item of pages.current){item.task?.cancel();item.textLayer?.cancel();}void task?.destroy();};
  },[document.id,document.revision]);
  useEffect(()=>()=>{cancelAnimationFrame(requestFrame.current);for(const item of pages.current)item.wrap.remove();pages.current=[];},[document.id]);
  return <div className="pdf-content" ref={host}>{error&&<p className="error-text" role="alert">{error}</p>}</div>;
}
