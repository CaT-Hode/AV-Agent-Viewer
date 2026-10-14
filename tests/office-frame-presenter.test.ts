import assert from 'node:assert/strict';
import {test} from 'node:test';
import {OfficeFramePresenter,officeFrameTransform,drawOfficeFrameTile,type OfficeFrameScope} from '../apps/desktop/src/renderer/lib/office-frame-presenter';
import {officeDocumentPoint,type OfficeSurfaceGeometry} from '../apps/desktop/src/renderer/lib/office-surface-geometry';
const scope:OfficeFrameScope={documentId:'doc',viewId:'view',sessionId:'session',engineEpoch:'epoch',partIndex:0,engineRevision:3};
const geometry:OfficeSurfaceGeometry={zoom:1,offsetX:260,offsetY:40,scrollX:130,scrollY:80,viewport:{x:73,y:84,width:1024,height:768}};
test('frame reprojection keeps the same document point across zoom, centering and real padded scrolling',()=>{
  const next={...geometry,zoom:1.75,offsetX:300,offsetY:0,scrollX:550,scrollY:220},transform=officeFrameTransform(geometry,next),oldPoint={x:170,y:200};
  const document=officeDocumentPoint(oldPoint.x+geometry.viewport.x,oldPoint.y+geometry.viewport.y,geometry);
  const projected={x:transform.x+oldPoint.x*next.zoom/geometry.zoom,y:transform.y+oldPoint.y*next.zoom/geometry.zoom},restored=officeDocumentPoint(projected.x+next.viewport.x,projected.y+next.viewport.y,next);
  assert.ok(Math.abs(document.x-restored.x)<1e-8&&Math.abs(document.y-restored.y)<1e-8);
});
const fakeCanvas=()=>{
  const draws:unknown[][]=[],clears:unknown[][]=[],resizes:string[]=[];
  const context={setTransform(){},save(){},restore(){},beginPath(){},rect(){},clip(){},clearRect(...args:unknown[]){clears.push(args);},drawImage(...args:unknown[]){draws.push(args);},globalCompositeOperation:'source-over'};
  let width=1,height=1;const canvas={get width(){return width;},set width(value:number){width=value;resizes.push('width');},get height(){return height;},set height(value:number){height=value;resizes.push('height');},getContext(){return context;}};
  return {canvas:canvas as unknown as OffscreenCanvas,draws,clears,resizes};
};
test('unchanged pixels do not reset the visible canvas, and a same-content zoom presents its old frame before new tiles',()=>{
  const allocated:ReturnType<typeof fakeCanvas>[]=[],target=fakeCanvas(),presenter=new OfficeFramePresenter(()=>{const next=fakeCanvas();allocated.push(next);return next.canvas;});
  const paint={scope,geometry,dpr:1,rects:[{x:0,y:0,width:24000,height:16000}],pixelRevision:1,complete:true,draw(){}};
  assert.equal(presenter.present(target.canvas as unknown as HTMLCanvasElement,paint).resized,true);const resizes=target.resizes.length;
  assert.equal(presenter.present(target.canvas as unknown as HTMLCanvasElement,paint).changed,false);assert.equal(target.resizes.length,resizes);assert.equal(target.clears.length,0,'the visible frame is never cleared before asynchronous rendering');
  const result=presenter.present(target.canvas as unknown as HTMLCanvasElement,{...paint,geometry:{...geometry,zoom:1.2},pixelRevision:2,complete:false});
  assert.equal(result.reused,true);assert.equal(result.resized,false);assert.equal(target.resizes.length,resizes);assert.equal(allocated.at(-1)!.draws[0][0],allocated[0].canvas,'real prior pixels are projected, not replaced by an empty staging buffer');
});
test('a prior frame never crosses a document, view, epoch, part or content revision even with identical viewport dimensions',()=>{
  for(const change of [{documentId:'other'},{viewId:'other'},{sessionId:'other'},{engineEpoch:'other'},{partIndex:1},{engineRevision:4}]){
    const target=fakeCanvas(),presenter=new OfficeFramePresenter(()=>fakeCanvas().canvas),paint={scope,geometry,dpr:1,rects:[],pixelRevision:1,complete:true,draw(){}};
    presenter.present(target.canvas as unknown as HTMLCanvasElement,paint);assert.equal(presenter.present(target.canvas as unknown as HTMLCanvasElement,{...paint,scope:{...scope,...change},complete:false}).reused,false);
  }
});
test('actual page clip changes and progressive completion cannot be hidden behind an unchanged pixel-cache revision',()=>{
  const target=fakeCanvas(),presenter=new OfficeFramePresenter(()=>fakeCanvas().canvas),paint={scope,geometry,dpr:1,rects:[{x:0,y:0,width:12000,height:20000}],pixelRevision:1,complete:false,draw(){}};
  presenter.present(target.canvas as unknown as HTMLCanvasElement,paint);
  assert.equal(presenter.present(target.canvas as unknown as HTMLCanvasElement,{...paint,rects:[{x:284,y:284,width:12000,height:20000}]}).changed,true,'real engine page boundaries must be reclipped');
  assert.equal(presenter.present(target.canvas as unknown as HTMLCanvasElement,{...paint,complete:true}).changed,true,'a fully fresh frame must become the next completed anchor');
});
test('a fresh transparent tile replaces its whole destination instead of leaving old glyph pixels underneath',()=>{
  const order:{kind:string;args:unknown[]}[]=[],context={clearRect(...args:unknown[]){order.push({kind:'clear',args});},drawImage(...args:unknown[]){order.push({kind:'draw',args});}} as unknown as OffscreenCanvasRenderingContext2D,image={} as CanvasImageSource,rect={x:42,y:71,width:256,height:240};
  drawOfficeFrameTile(context,image,rect,true);assert.deepEqual(order[0],{kind:'clear',args:[42,71,256,240]});assert.equal(order[1].kind,'draw');
  order.length=0;drawOfficeFrameTile(context,image,rect,false);assert.equal(order.length,1,'a fresh empty staging frame needs only the native draw');assert.equal(order[0].kind,'draw');
});
