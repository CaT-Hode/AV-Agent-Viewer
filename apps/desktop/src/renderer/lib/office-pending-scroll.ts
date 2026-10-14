export type OfficeScrollIdentity = { viewId: string; sessionId: string; engineEpoch: string };
export type OfficeScrollTarget = OfficeScrollIdentity & { partIndex: number; layoutRevision: number; x: number; y: number };
const sameSource = (left: OfficeScrollIdentity,right: OfficeScrollIdentity) => left.viewId===right.viewId && left.sessionId===right.sessionId && left.engineEpoch===right.engineEpoch;
/** A native reveal must survive the commit that grows a sheet's DOM stage. */
export class OfficePendingScroll {
  private target?: OfficeScrollTarget;
  queue(source:OfficeScrollIdentity,target:OfficeScrollTarget) {
    if (!sameSource(source,target) || ![target.x,target.y,target.layoutRevision].every(Number.isFinite)) return false;
    if (this.target && sameSource(this.target,target) && this.target.layoutRevision>target.layoutRevision) return false;
    this.target={...target,x:Math.max(0,target.x),y:Math.max(0,target.y)};return true;
  }
  take(source:OfficeScrollIdentity,partIndex:number,available:{x:number;y:number}) {
    const target=this.target;if(!target)return;
    if(!sameSource(source,target)){this.clear();return;}
    if(target.partIndex!==partIndex || target.x>available.x+1 || target.y>available.y+1)return;
    this.clear();return target;
  }
  clear(){this.target=undefined;}
  get pending(){return !!this.target;}
}
