import type { Rect } from '../../../../../packages/contracts/src/index';
export const TRANSLATION_CAPSULE_METRICS = { width:340,height:118,maxWidth:560,maxHeight:420,horizontalInset:112,verticalInset:66,growthRatio:1 } as const;

/** Cache font measurements once per result. Fitting reuses widths and never
 * copies/parses the document or measures the DOM at intermediate spring sizes. */
export function translationTextHeight(text:string,measure:(text:string)=>number,lineHeight:number){
  if(text.length>16000)return()=>Infinity;
  const words=new Intl.Segmenter(undefined,{granularity:'word'}),graphemes=new Intl.Segmenter(undefined,{granularity:'grapheme'});
  const paragraphs=text.split('\n').map(line=>[...words.segment(line)].map(({segment})=>({text:segment,width:measure(segment),parts:undefined as number[]|undefined})));
  return(width:number)=>{
    let lines=0;
    for(const paragraph of paragraphs){let used=0;lines++;
      for(const token of paragraph){
        if(!used&&/^\s+$/.test(token.text))continue;
        if(token.width<=width){if(used+token.width>width){lines++;used=0;}used+=token.width;}
        else{token.parts??=[...graphemes.segment(token.text)].map(({segment})=>measure(segment));for(const part of token.parts){if(used&&used+part>width){lines++;used=0;}used+=part;}}
      }
    }
    return lines*lineHeight;
  };
}
/** Width grows by ratio * height growth. Only after exhausting the vertical
 * budget may width grow independently; overflow starts at the final bounds. */
export function fitTranslationCapsule(viewport:Rect,textHeight:(width:number)=>number,ratio:number=TRANSLATION_CAPSULE_METRICS.growthRatio){
  const m=TRANSLATION_CAPSULE_METRICS,maxWidth=Math.max(1,Math.min(m.maxWidth,viewport.width-24)),maxHeight=Math.max(50,Math.min(m.maxHeight,viewport.height*.52));
  const baseWidth=Math.min(m.width,maxWidth),baseHeight=Math.min(m.height,maxHeight),growth=Math.max(.15,Math.min(1,Number.isFinite(ratio)?ratio:m.growthRatio));
  const required=(width:number)=>Math.max(baseHeight,textHeight(Math.max(1,width-m.horizontalInset))+m.verticalInset);
  if(required(baseWidth)<=baseHeight)return {width:baseWidth,height:baseHeight,maxWidth,maxHeight,growthRatio:growth};
  let low=0,high=maxHeight-baseHeight;
  for(let index=0;index<10;index++){const delta=(low+high)/2,width=Math.min(maxWidth,baseWidth+growth*delta);if(required(width)<=baseHeight+delta)high=delta;else low=delta;}
  let height=Math.min(maxHeight,Math.ceil(baseHeight+high)),width=Math.min(maxWidth,Math.ceil(baseWidth+growth*high));
  if(required(width)>height+1){
    height=maxHeight;low=width;high=maxWidth;
    for(let index=0;index<10;index++){const middle=(low+high)/2;if(required(middle)<=maxHeight)high=middle;else low=middle;}
    width=Math.ceil(high);
  }
  return {width,height,maxWidth,maxHeight,growthRatio:growth};
}

/** The translation owns the bottom-center lane, below the Agent capsule. */
export function placeTranslationPopover(viewport: Rect, size: { width: number; height: number }) {
  if (![viewport.x, viewport.y, viewport.width, viewport.height, size.width, size.height].every(Number.isFinite) || size.width <= 0 || size.height <= 0 || viewport.width < 100 || viewport.height < 100) return;
  const inset = 12, width = Math.min(size.width, viewport.width - inset * 2), maxHeight = Math.min(TRANSLATION_CAPSULE_METRICS.maxHeight,viewport.height * .52), height = Math.min(size.height,maxHeight);
  return { x: viewport.x+(viewport.width-width)/2, y: viewport.y+viewport.height-height-18, width,height,maxHeight,edge:'bottom' as const };
}
export function translationDragShape(x: number, y: number) {
  const pull = Math.min(.075, Math.hypot(x, y) / 1800), vertical = Math.abs(y) >= Math.abs(x);
  return { scaleX: 1 + (vertical ? -pull * .55 : pull), scaleY: 1 + (vertical ? pull : -pull * .55) };
}
export function shouldCollapseTranslation(delta: { x: number; y: number }, velocityY: number) {
  return delta.y > 0 && delta.y > Math.abs(delta.x) * .75 && (delta.y >= 72 || delta.y >= 24 && velocityY >= 650);
}
