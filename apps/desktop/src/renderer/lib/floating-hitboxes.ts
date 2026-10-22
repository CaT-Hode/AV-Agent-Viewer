import type { Rect } from '../../../../../packages/contracts/src/index';

export type FloatingHitbox = { id: string; group: string; bounds: Rect; canMove?: boolean; canCollapse?: boolean; yield?(bounds?: Rect): void };
export const FLOATING_HITBOX_EVENT = 'agentviewer:floating-hitboxes-changed';
const records = new Map<string,FloatingHitbox>();
const nativeSources=new Map<string,Set<string>>();
const valid = (rect: Rect) => !!rect && [rect.x,rect.y,rect.width,rect.height].every(Number.isFinite) && rect.width > 0 && rect.height > 0;
export const floatingOverlap = (a: Rect,b: Rect,gap = 8) => a.x < b.x+b.width+gap && a.x+a.width+gap > b.x && a.y < b.y+b.height+gap && a.y+a.height+gap > b.y;
function floatingCandidates(preferred: Rect,viewport: Rect,obstacles: readonly Rect[],gap = 8):Rect[] {
  if (!valid(preferred)||!valid(viewport)||preferred.width>viewport.width||preferred.height>viewport.height) return [];
  const maxX=viewport.x+viewport.width-preferred.width,maxY=viewport.y+viewport.height-preferred.height;
  const clampX=(x:number)=>Math.max(viewport.x,Math.min(maxX,x)),clampY=(y:number)=>Math.max(viewport.y,Math.min(maxY,y));
  const xs=[clampX(preferred.x),viewport.x,maxX,...obstacles.flatMap(rect=>[clampX(rect.x-preferred.width-gap),clampX(rect.x+rect.width+gap)])];
  const ys=[clampY(preferred.y),viewport.y,maxY,...obstacles.flatMap(rect=>[clampY(rect.y-preferred.height-gap),clampY(rect.y+rect.height+gap)])];
  const candidates=[...new Set(ys)].flatMap(y=>[...new Set(xs)].map(x=>({...preferred,x,y}))).filter(rect=>obstacles.every(obstacle=>!floatingOverlap(rect,obstacle,gap)));
  candidates.sort((a,b)=>Math.hypot(a.x-preferred.x,a.y-preferred.y)-Math.hypot(b.x-preferred.x,b.y-preferred.y));
  return candidates;
}
export function nearestFloatingRect(preferred:Rect,viewport:Rect,obstacles:readonly Rect[],gap=8){return floatingCandidates(preferred,viewport,obstacles,gap)[0];}
/** First move the requester. Only a fully feasible fallback may move/collapse
 * explicitly yieldable surfaces; protected chrome and dialogs never disappear. */
export function planFloatingRoom(preferred: Rect,viewport: Rect,obstacles: readonly FloatingHitbox[]) {
  const direct=nearestFloatingRect(preferred,viewport,obstacles.map(item=>item.bounds));
  if(direct)return {bounds:direct,yields:[] as {id:string;bounds?:Rect}[]};
  const fixed=obstacles.filter(item=>!item.canMove&&!item.canCollapse),movable=obstacles.filter(item=>item.canMove||item.canCollapse);
  for(const target of floatingCandidates(preferred,viewport,fixed.map(item=>item.bounds)).slice(0,96)){
    const positions=new Map(obstacles.map(item=>[item.id,item.bounds])),yields:{id:string;bounds?:Rect}[]=[];let feasible=true;
    for(const item of movable){
      if(!floatingOverlap(target,positions.get(item.id)!))continue;
      const blockers=[target,...[...positions].filter(([id])=>id!==item.id).map(([,rect])=>rect)];
      const position=item.canMove?nearestFloatingRect(item.bounds,viewport,blockers):undefined;
      if(position){positions.set(item.id,position);yields.push({id:item.id,bounds:position});}
      else if(item.canCollapse){positions.delete(item.id);yields.push({id:item.id});}
      else{feasible=false;break;}
    }
    if(feasible)return {bounds:target,yields};
  }
}
function ownerWindow(): Window { let target=window;try{while(target.opener&&!target.opener.closed&&target.opener.location.origin===location.origin)target=target.opener;}catch{/* isolated native hosts report through IPC */}return target; }
let revision=0,notifying=false;
function notify(){if(notifying)return;notifying=true;requestAnimationFrame(()=>{notifying=false;window.dispatchEvent(new CustomEvent(FLOATING_HITBOX_EVENT,{detail:++revision}));});}
export function updateFloatingHitbox(id:string,hitbox?:Omit<FloatingHitbox,'id'>){
  if(!hitbox){if(records.delete(id))notify();return;}
  if(!valid(hitbox.bounds))return;
  const old=records.get(id);
  records.set(id,{...hitbox,id});
  if(!old||old.group!==hitbox.group||['x','y','width','height'].some(key=>Math.abs(old.bounds[key as keyof Rect]-hitbox.bounds[key as keyof Rect])>.25))notify();
}
export function floatingHitboxes(exclude:readonly string[]=[]):FloatingHitbox[]{return [...records.values()].filter(item=>!exclude.includes(item.group));}
export function receiveNativeHitboxes(source:string,boxes:{id:string;group:string;bounds:Rect}[]){
  const ids=new Set<string>();for(const box of boxes){const id='native:'+source+':'+box.id;ids.add(id);updateFloatingHitbox(id,{group:box.group,bounds:box.bounds});}
  for(const id of nativeSources.get(source)??[])if(!ids.has(id))updateFloatingHitbox(id);
  nativeSources.set(source,ids);
}
export function yieldFloatingRoom(preferred:Rect,viewport:Rect,protectedRects:readonly Rect[]=[],exclude:readonly string[]=['selection']){
  const boxes=floatingHitboxes(exclude),plan=planFloatingRoom(preferred,viewport,[...boxes,...protectedRects.map((bounds,index)=>({id:'protected:'+index,group:'protected',bounds}))]);
  if(!plan)return;
  for(const change of plan.yields)boxes.find(item=>item.id===change.id)?.yield?.(change.bounds);
  return plan.bounds;
}

const selector='[data-floating-hitbox],.floating-side-panel,.activity-rail,.ai-rail,.navigation-capsule,.agent-operation-capsule,.selection-translation-bubble,.ai-result-popover,.selection-tools,.selection-input,.selection-error,.modal,.app-tooltip,[role="menu"],[role="listbox"],[role="dialog"],[role="tooltip"],.zoom-menu,.reader-zoom-menu';
function group(element:Element){return element.closest('.selection-tools')?'selection':element.matches('.navigation-capsule')?'navigation':element.closest('.navigation-capsule')?'navigation-child':element.matches('.floating-side-panel')?'panel':element.matches('.activity-rail,.ai-rail')?'rail':element.matches('.selection-translation-bubble')?'translation':element.matches('.agent-operation-capsule')?'agent':element.matches('.app-tooltip,[role="tooltip"]')?(element.getAttribute('data-floating-owner')||'tooltip'):'floating';}
/** A portal tooltip belongs to its trigger's floating surface. Its source must
 * not avoid its own description and move the hovered button out of reach. */
export function floatingOwnerGroup(element:Element){const owner=element.closest(selector);return owner?group(owner):'tooltip';}
/** One batched geometry pass observes painted boxes, not assumed CSS sizes.
 * Same-origin portal windows forward CSS coordinates to their owning window. */
export function installFloatingHitboxes(doc:Document){
  const win=doc.defaultView!;let disposed=false,frame=0,sequence=0;
  const prefix='dom:'+crypto.randomUUID()+':',nodes=new Map<Element,string>(),root=ownerWindow();
  const nativeHost=root===win&&/^#\/(?:web|agent|ai-result|selection)-toolbar/.test(win.location.hash),nativeBoxes=new Map<string,Omit<FloatingHitbox,'id'>>();
  let sent='',inflight=false;
  const sendNative=()=>{const boxes=[...nativeBoxes].map(([id,box])=>({id,group:box.group,bounds:box.bounds})),signature=JSON.stringify(boxes);if(!nativeHost||signature===sent||inflight||disposed)return;sent=signature;inflight=true;void win.agentViewer?.call('toolbar-action',{action:'hitboxes',boxes}).catch(()=>{}).finally(()=>{inflight=false;if(!disposed)sendNative();});};
  const publish=(id:string,value?:Omit<FloatingHitbox,'id'>)=>{
    if(nativeHost){if(value)nativeBoxes.set(id,value);else nativeBoxes.delete(id);}
    else if(root===win)updateFloatingHitbox(id,value);
    else root.dispatchEvent(new CustomEvent('agentviewer:floating-hitbox-report',{detail:{id,value}}));
  };
  const read=()=>{frame=0;if(disposed)return;let pruned=false;
    for(const [element,id] of nodes){
      if(!element.isConnected){nodes.delete(element);size.unobserve(element);publish(id);pruned=true;continue;}
      if(element.matches('[data-floating-hitbox-managed="true"]')){publish(id);continue;}
      const style=win.getComputedStyle(element),box=element.getBoundingClientRect();
      const hidden=element.closest('[hidden],[data-panel-anchor="true"]')||style.visibility==='hidden'||style.display==='none'||Number(style.opacity)===0;
      if(hidden||box.width<=0||box.height<=0){publish(id);continue;}
      const parent=element.parentElement?.closest(selector);
      if(parent&&nodes.has(parent)&&group(parent)===group(element)){const outer=parent.getBoundingClientRect();if(box.left>=outer.left&&box.top>=outer.top&&box.right<=outer.right&&box.bottom<=outer.bottom){publish(id);continue;}}
      const offset=root===win?{x:0,y:0}:{x:win.screenX-root.screenX,y:win.screenY-root.screenY};
      const bounds={x:box.x+offset.x,y:box.y+offset.y,width:box.width,height:box.height},policy=(element as HTMLElement).dataset.floatingYield??'';
      publish(id,{group:group(element),bounds,canMove:policy.includes('move'),canCollapse:policy.includes('collapse'),yield:next=>element.dispatchEvent(new CustomEvent('agentviewer:floating-yield',{detail:{bounds:next&&{...next,x:next.x-offset.x,y:next.y-offset.y}}}))});
    }
    if(pruned){attributes.disconnect();for(const element of nodes.keys())attributes.observe(element,{attributes:true,attributeFilter:['class','style','hidden','open','data-motion-phase','aria-hidden','data-floating-owner']});}
    sendNative();
  };
  const schedule=()=>{if(!disposed&&!frame)frame=win.requestAnimationFrame(read);};
  const size=new ResizeObserver(schedule),attributes=new MutationObserver(schedule);
  const track=(element:Element)=>{if(nodes.has(element))return;nodes.set(element,prefix+ ++sequence);size.observe(element);attributes.observe(element,{attributes:true,attributeFilter:['class','style','hidden','open','data-motion-phase','aria-hidden','data-floating-owner']});schedule();};
  const discover=(node:Node)=>{if(!(node instanceof Element))return;if(node.matches(selector))track(node);node.querySelectorAll(selector).forEach(track);};
  discover(doc.documentElement);
  const additions=new MutationObserver(changes=>{let removed=false;for(const change of changes){for(const node of change.addedNodes)discover(node);removed ||= change.removedNodes.length>0;}if(removed)schedule();});
  additions.observe(doc.body,{childList:true,subtree:true});
  const receive=(event:Event)=>{const {id,value}=(event as CustomEvent<{id:string;value?:Omit<FloatingHitbox,'id'>}>).detail??{};if(typeof id==='string'&&id.startsWith('dom:'))updateFloatingHitbox(id,value);};
  if(root===win)win.addEventListener('agentviewer:floating-hitbox-report',receive);
  doc.addEventListener('scroll',schedule,true);win.addEventListener('resize',schedule);doc.addEventListener('toggle',schedule,true);
  win.addEventListener(FLOATING_HITBOX_EVENT,schedule);
  const dispose=()=>{if(disposed)return;disposed=true;win.cancelAnimationFrame(frame);size.disconnect();attributes.disconnect();additions.disconnect();for(const id of nodes.values())publish(id);nodes.clear();win.removeEventListener('agentviewer:floating-hitbox-report',receive);doc.removeEventListener('scroll',schedule,true);win.removeEventListener('resize',schedule);win.removeEventListener(FLOATING_HITBOX_EVENT,schedule);doc.removeEventListener('toggle',schedule,true);win.removeEventListener('pagehide',dispose);};
  win.addEventListener('pagehide',dispose);return dispose;
}
