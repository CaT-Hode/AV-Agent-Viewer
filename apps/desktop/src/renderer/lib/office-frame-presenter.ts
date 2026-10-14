import type {Rect} from '../../../../../packages/contracts/src/index';
import type {OfficeSurfaceIdentity} from '../../../../../packages/contracts/src/office-surface';
import type {OfficeSurfaceGeometry} from './office-surface-geometry';

export type OfficeFrameScope=OfficeSurfaceIdentity&{partIndex:number;engineRevision:number};
export function sameOfficeFrame(left:OfficeFrameScope,right:OfficeFrameScope){return left.documentId===right.documentId&&left.viewId===right.viewId&&left.sessionId===right.sessionId&&left.engineEpoch===right.engineEpoch&&left.partIndex===right.partIndex&&left.engineRevision===right.engineRevision;}
/** Affine reprojection preserves document coordinates, not old screen coordinates. */
export function officeFrameTransform(previous:OfficeSurfaceGeometry,current:OfficeSurfaceGeometry){
  const ratio=current.zoom/previous.zoom;
  return {x:current.offsetX-current.scrollX-(previous.offsetX-previous.scrollX)*ratio,y:current.offsetY-current.scrollY-(previous.offsetY-previous.scrollY)*ratio,width:previous.viewport.width*ratio,height:previous.viewport.height*ratio};
}
type RasterCanvas=OffscreenCanvas;
type RasterContext=OffscreenCanvasRenderingContext2D;
type Frame={canvas:RasterCanvas;scope:OfficeFrameScope;geometry:OfficeSurfaceGeometry};
export type OfficeFramePaint={scope:OfficeFrameScope;geometry:OfficeSurfaceGeometry;dpr:number;rects:readonly Rect[];pixelRevision:number;complete:boolean;draw(context:RasterContext,replacing:boolean):void};
/** Fresh alpha is authoritative: a transparent native tile must erase old glyphs too. */
export function drawOfficeFrameTile(context:RasterContext,image:CanvasImageSource,rect:Rect,replacing:boolean){
  if(replacing)context.clearRect(rect.x,rect.y,rect.width,rect.height);
  context.drawImage(image,rect.x,rect.y,rect.width,rect.height);
}
/** Synchronous presentation and asynchronous tile acquisition have separate lifetimes.
 * A completed same-content frame survives zoom while new-resolution tiles arrive.
 * The visible canvas is replaced in one copy operation, never cleared before an await. */
export class OfficeFramePresenter{
  private completed?:Frame;
  private scratch?:RasterCanvas;
  private signature='';
  constructor(private create:()=>RasterCanvas=()=>new OffscreenCanvas(1,1)){}
  clear(){for(const canvas of [this.scratch,this.completed?.canvas])if(canvas){canvas.width=1;canvas.height=1;}this.scratch=undefined;this.completed=undefined;this.signature='';}
  present(target:HTMLCanvasElement,paint:OfficeFramePaint){
    const {geometry,dpr,scope}=paint,width=Math.max(1,Math.ceil(geometry.viewport.width*dpr)),height=Math.max(1,Math.ceil(geometry.viewport.height*dpr));
    if(!Number.isSafeInteger(width*height*4)||width*height*4>128*1024*1024)throw new Error('Office viewport exceeds the bounded frame memory budget.');
    const identity:OfficeFrameScope={documentId:scope.documentId,viewId:scope.viewId,sessionId:scope.sessionId,engineEpoch:scope.engineEpoch,partIndex:scope.partIndex,engineRevision:scope.engineRevision};
    const signature=JSON.stringify([identity,geometry.zoom,geometry.offsetX,geometry.offsetY,geometry.scrollX,geometry.scrollY,width,height,dpr,paint.pixelRevision,paint.complete,paint.rects]);
    if(signature===this.signature&&target.width===width&&target.height===height)return {changed:false,reused:false,resized:false};
    const scratch=this.scratch??=this.create();if(scratch.width!==width)scratch.width=width;if(scratch.height!==height)scratch.height=height;
    const context=scratch.getContext('2d');if(!context)throw new Error('Office frame compositor is unavailable.');
    context.setTransform(dpr,0,0,dpr,0,0);context.clearRect(0,0,width/dpr,height/dpr);context.save();context.beginPath();
    const scale=geometry.zoom/15;
    for(const rect of paint.rects)context.rect(geometry.offsetX+rect.x*scale-geometry.scrollX,geometry.offsetY+rect.y*scale-geometry.scrollY,rect.width*scale,rect.height*scale);
    context.clip();let reused=false;
    const previous=this.completed;if(!paint.complete&&previous&&sameOfficeFrame(previous.scope,scope)){
      const transformed=officeFrameTransform(previous.geometry,geometry);context.drawImage(previous.canvas,transformed.x,transformed.y,transformed.width,transformed.height);reused=true;
    }
    paint.draw(context,reused);context.restore();
    let resized=false;if(target.width!==width){target.width=width;resized=true;}if(target.height!==height){target.height=height;resized=true;}
    const visible=target.getContext('2d');if(!visible)throw new Error('Office Canvas is unavailable.');
    visible.setTransform(1,0,0,1,0,0);visible.globalCompositeOperation='copy';visible.drawImage(scratch,0,0);visible.globalCompositeOperation='source-over';
    this.signature=signature;
    if(paint.complete){this.scratch=previous?.canvas;this.completed={canvas:scratch,scope:identity,geometry:{...geometry,viewport:{...geometry.viewport}}};}
    return {changed:true,reused,resized};
  }
}
