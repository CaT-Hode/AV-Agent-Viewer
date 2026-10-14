export type OfficeFitSize = { width: number; height: number };
/** Manual zoom uses a full viewport, with real scrollable space to uncover both pane-covered edges. */
export function officePresentationManualLayout(pageCss:OfficeFitSize,viewport:OfficeFitSize,gaps:{left:number;right:number}){
  const left=Math.max(0,gaps.left),right=Math.max(0,gaps.right),safeWidth=Math.max(1,viewport.width-left-right);
  const offsetX=left+Math.max(0,(safeWidth-pageCss.width)/2),offsetY=Math.max(0,(viewport.height-pageCss.height)/2);
  return {offsetX,offsetY,stageSize:{width:Math.max(viewport.width,offsetX+pageCss.width+right),height:Math.max(viewport.height,offsetY+pageCss.height)},safeViewport:{x:left,y:0,width:safeWidth,height:viewport.height}};
}
export function officePresentationFit(pageTwips: OfficeFitSize, viewportCss: OfficeFitSize): number | undefined {
  if (![pageTwips.width,pageTwips.height,viewportCss.width,viewportCss.height].every(value=>Number.isFinite(value)&&value>0)) return;
  const width=Math.max(1,viewportCss.width-16),height=Math.max(1,viewportCss.height-16);
  // Fit the real engine document at its natural aspect, with an eight-pixel
  // inner breathing space. Core acknowledges whole percentage points: floor
  // to that canonical precision so its ACK cannot round past the safe viewport.
  return Math.max(.25,Math.min(4,Math.floor(Math.min(width*15/pageTwips.width,height*15/pageTwips.height)*100+1e-9)/100));
}
const close=(a:number,b:number)=>Math.abs(a-b)<.00001;
export class OfficePresentationFitController {
  private automatic=true;
  private observed?:number;
  private requested?:number;
  get enabled(){return this.automatic;}
  get pending(){return this.requested!==undefined;}
  observeZoom(actual:number){
    if(this.observed===undefined){this.observed=actual;if(!close(actual,1))this.automatic=false;return;}
    if(close(actual,this.observed))return;
    if(this.requested!==undefined&&close(actual,this.requested))this.requested=undefined;
    else {this.automatic=false;this.requested=undefined;}
    this.observed=actual;
  }
  manual(){this.automatic=false;this.requested=undefined;}
  request(page:OfficeFitSize,viewport:OfficeFitSize,actual:number){
    this.observeZoom(actual);if(!this.automatic||this.requested!==undefined)return;
    const fitted=officePresentationFit(page,viewport);if(fitted===undefined||close(fitted,actual))return;
    this.requested=fitted;return fitted;
  }
}
// Keep each view's explicit manual/fit choice across ordinary tab switches.
// It is renderer-local state, bounded independently of the document cache.
const views=new Map<string,OfficePresentationFitController>();
export function officePresentationFitForView(identity:string){
  const existing=views.get(identity);if(existing){views.delete(identity);views.set(identity,existing);return existing;}
  const controller=new OfficePresentationFitController();views.set(identity,controller);while(views.size>64)views.delete(views.keys().next().value!);return controller;
}
