import type {Rect} from '../../../../../packages/contracts/src/index';
import type {OfficeSurfaceIdentity, OfficeSurfaceTile} from '../../../../../packages/contracts/src/office-surface';
import { officeTileRgba } from './office-surface-pixels';
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
export type OfficeFrameIdleScheduler={setTimer(callback:()=>void,milliseconds:number):unknown;clearTimer(timer:unknown):void};
const idleScheduler:OfficeFrameIdleScheduler={setTimer(callback,milliseconds){const timer=globalThis.setTimeout(callback,milliseconds);(timer as unknown as {unref?():void}).unref?.();return timer;},clearTimer:timer=>globalThis.clearTimeout(timer as ReturnType<typeof setTimeout>)};
export type OfficeFramePaint={scope:OfficeFrameScope;geometry:OfficeSurfaceGeometry;dpr:number;rects:readonly Rect[];pixelRevision:number|readonly number[];complete:boolean;draw(context:RasterContext,replacing:boolean):void};
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
  private idleRelease?:unknown;
  constructor(private create:()=>RasterCanvas=()=>new OffscreenCanvas(1,1),private idle:OfficeFrameIdleScheduler=idleScheduler){}
  private cancelIdleRelease(){if(this.idleRelease!==undefined)this.idle.clearTimer(this.idleRelease);this.idleRelease=undefined;}
  private releaseScratch(){const canvas=this.scratch;this.scratch=undefined;if(canvas){canvas.width=1;canvas.height=1;}}
  private releaseWhenIdle(){this.cancelIdleRelease();if(!this.scratch)return;this.idleRelease=this.idle.setTimer(()=>{this.idleRelease=undefined;this.releaseScratch();},750);}
  clear(){this.cancelIdleRelease();for(const canvas of [this.scratch,this.completed?.canvas])if(canvas){canvas.width=1;canvas.height=1;}this.scratch=undefined;this.completed=undefined;this.signature='';}
  present(target:HTMLCanvasElement,paint:OfficeFramePaint){
    const {geometry,dpr,scope}=paint,width=Math.max(1,Math.ceil(geometry.viewport.width*dpr)),height=Math.max(1,Math.ceil(geometry.viewport.height*dpr));
    if(!Number.isSafeInteger(width*height*4)||width*height*4>128*1024*1024)throw new Error('Office viewport exceeds the bounded frame memory budget.');
    const identity:OfficeFrameScope={documentId:scope.documentId,viewId:scope.viewId,sessionId:scope.sessionId,engineEpoch:scope.engineEpoch,partIndex:scope.partIndex,engineRevision:scope.engineRevision};
    const signature=JSON.stringify([identity,geometry.zoom,geometry.offsetX,geometry.offsetY,geometry.scrollX,geometry.scrollY,width,height,dpr,paint.pixelRevision,paint.complete,paint.rects]);
    if(signature===this.signature&&target.width===width&&target.height===height)return {changed:false,reused:false,resized:false};
    const scratch=this.scratch??=this.create();if(scratch.width!==width)scratch.width=width;if(scratch.height!==height)scratch.height=height;
    const previous=this.completed;let reused=false;
    try{
      const context=scratch.getContext('2d');if(!context)throw new Error('Office frame compositor is unavailable.');
      context.setTransform(dpr,0,0,dpr,0,0);context.clearRect(0,0,width/dpr,height/dpr);context.save();
      try{
        context.beginPath();const scale=geometry.zoom/15;
        for(const rect of paint.rects)context.rect(geometry.offsetX+rect.x*scale-geometry.scrollX,geometry.offsetY+rect.y*scale-geometry.scrollY,rect.width*scale,rect.height*scale);
        context.clip();if(!paint.complete&&previous&&sameOfficeFrame(previous.scope,scope)){
          const transformed=officeFrameTransform(previous.geometry,geometry);context.drawImage(previous.canvas,transformed.x,transformed.y,transformed.width,transformed.height);reused=true;
        }
        paint.draw(context,reused);
      }finally{context.restore();}
    }catch(error){
      // A failed staging transaction must not retain a large raster indefinitely
      // or carry its clipping state into a later attempt.
      this.cancelIdleRelease();this.releaseScratch();throw error;
    }
    let resized=false;if(target.width!==width){target.width=width;resized=true;}if(target.height!==height){target.height=height;resized=true;}
    const visible=target.getContext('2d');if(!visible)throw new Error('Office Canvas is unavailable.');
    visible.setTransform(1,0,0,1,0,0);visible.globalCompositeOperation='copy';visible.drawImage(scratch,0,0);visible.globalCompositeOperation='source-over';
    this.signature=signature;
    if(paint.complete){this.scratch=previous?.canvas;this.completed={canvas:scratch,scope:identity,geometry:{...geometry,viewport:{...geometry.viewport}}};}
    // Keep the staging raster during active zoom/input bursts. After a quiet
    // interval its pixels are redundant: visible and completed already own
    // the stable frame. Release storage explicitly without repainting either.
    this.releaseWhenIdle();
    return {changed:true,reused,resized};
  }
}

export type OfficeDecodedTile = Pick<OfficeSurfaceTile, 'key' | 'width' | 'height'>;
type BitmapResource = { close(): void };
type TileDecodeOptions<T extends BitmapResource> = {
  current(): boolean;
  validate(tile: OfficeSurfaceTile): void;
  decode(image: ImageData): Promise<T>;
  /** Ownership transfers to the cache, including its rejected-admission disposal. */
  admit(tile: OfficeDecodedTile, bitmap: T): void;
  imageData?(pixels: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): ImageData;
};

/** Keep raw tiles out of the suspended async frame. Only the ImageData needed
 * by the browser decoder and small identity/size metadata survive this call.
 * Straight RGBA may share its buffer with ImageData: never detach or edit it. */
function beginTileDecode<T extends BitmapResource>(tiles: OfficeSurfaceTile[], index: number, options: TileDecodeOptions<T>) {
  const tile = tiles[index];
  delete tiles[index];
  if (!tile) throw new Error('Office tile 回执缺少像素。');
  options.validate(tile);
  const metadata: OfficeDecodedTile = { key: tile.key, width: tile.width, height: tile.height };
  const pixels = officeTileRgba(tile);
  const image = options.imageData ? options.imageData(pixels, tile.width, tile.height) : new ImageData(pixels, tile.width, tile.height);
  return { metadata, bitmap: options.decode(image) };
}

/** Consumes an exclusively owned renderer RPC batch. The original reply loses
 * each raw tile before decoding waits; failure/cancellation drops every unused
 * tile as well. Cache tickets and their final cancellation remain with caller. */
export async function consumeOfficeTileBatch<T extends BitmapResource>(tiles: OfficeSurfaceTile[], options: TileDecodeOptions<T>): Promise<void> {
  try {
    for (let index = 0; index < tiles.length; index++) {
      if (!options.current()) break;
      const pending = beginTileDecode(tiles, index, options);
      const bitmap = await pending.bitmap;
      if (!options.current()) { bitmap.close(); break; }
      options.admit(pending.metadata, bitmap);
    }
  } finally { tiles.length = 0; }
}

/** One fetch flight may mix its last visible pixels with offscreen prefetch.
 * Track only initially missing visible keys; the final live check prevents an
 * intervening eviction/invalidation from announcing an incomplete viewport.
 * If that check fails, normal batch-end painting/retry remains authoritative. */
export function createOfficeVisibleTileCompletion(keys: readonly string[], has: (key: string) => boolean, current: () => boolean) {
  const required = [...new Set(keys)], missing = new Set(required.filter(key => !has(key)));
  let checked = missing.size === 0;
  return {
    /** Call only after successful cache admission. At most one completion edge
     * is checked per flight; halo and duplicate admissions are constant-time. */
    admitted(key: string): boolean {
      if (checked || !missing.delete(key) || missing.size > 0) return false;
      checked = true;
      return current() && required.every(has);
    },
  };
}

type CanvasBacking = { width:number; height:number; readonly isConnected:boolean };

/** Release the backing only after React has really detached the old DOM node.
 * A hidden/minimized/obscured view keeps its pixels. The microtask also allows
 * StrictMode or a ref handoff to reattach the same node without clearing it. */
export function createOfficeCanvasBinding<T extends CanvasBacking>(reference:{current:T|null}) {
  return (node:T|null)=>{
    const previous=reference.current;reference.current=node;
    if(!previous||previous===node)return;
    queueMicrotask(()=>{
      if(reference.current===previous||previous.isConnected)return;
      previous.width=1;previous.height=1;
    });
  };
}
