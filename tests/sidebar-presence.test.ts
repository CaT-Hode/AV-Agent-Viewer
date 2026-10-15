import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceSidebarSpring, sidebarExitFinished, sidebarPopupProjection, sidebarSpringPresentation, sidebarSpringSettled } from '../apps/desktop/src/renderer/lib/sidebar-presence';
test('sidebars carry velocity through reversal, settle without a fixed-duration jump and keep bounds modest', () => {
  for (const mode of ['standard','elegant'] as const) {
    let axis = { value: 0, velocity: 0 }, maximum = 0;
    for(let i=0;i<180;i++){axis=advanceSidebarSpring(axis,true,1/120,mode);maximum=Math.max(maximum,axis.value);}
    assert.ok(maximum > 1.01 && maximum < 1.1); assert.ok(sidebarSpringSettled(axis,true));
    for(let i=0;i<12;i++)axis=advanceSidebarSpring(axis,false,1/120,mode);
    const before={...axis};axis=advanceSidebarSpring(axis,true,1/120,mode);
    assert.ok(axis.value < before.value,'retarget preserves closing momentum on its first frame');
    assert.ok(Math.abs(axis.value-before.value)<.08,'reversal cannot jump to an endpoint');
    for(let i=0;i<160;i++)axis=advanceSidebarSpring(axis,true,1/120,mode);
    assert.ok(sidebarSpringSettled(axis,true));
    const left=sidebarSpringPresentation(.5,'left'),right=sidebarSpringPresentation(.5,'right');
    assert.equal(left.x,-right.x);assert.ok(left.alpha<=1&&left.alpha>=0);
    assert.equal(sidebarSpringPresentation(1.1,'left').alpha,1);
  }
});

test('closing unmounts at its invisible crossing without waiting for a bouncing transparent tail', () => {
  for (const mode of ['standard','elegant'] as const) {
    let axis={value:1,velocity:0},previousAlpha=1,elapsed=0;
    while(!sidebarExitFinished(axis) && elapsed<2.5) {
      const next=advanceSidebarSpring(axis,false,1/240,mode);
      const alpha=sidebarSpringPresentation(next.value,'left').alpha;
      assert.ok(alpha<=previousAlpha+1e-9,'a closing material cannot reappear');
      previousAlpha=alpha;axis=next;elapsed+=1/240;
    }
    assert.ok(sidebarExitFinished(axis));
    assert.equal(sidebarSpringPresentation(axis.value,'right').alpha,0,'removal occurs at a fully invisible frame');
    assert.ok(elapsed>.1 && elapsed<.5,'no retained transparent settling tail');
  }
});

test('reversing a still visible closing panel keeps its physical position and velocity', () => {
  for (const mode of ['standard','elegant'] as const) {
    let axis={value:1,velocity:0};
    while(sidebarSpringPresentation(axis.value,'left').alpha>.35)axis=advanceSidebarSpring(axis,false,1/240,mode);
    assert.equal(sidebarExitFinished(axis),false);
    const next=advanceSidebarSpring(axis,true,1/240,mode);
    assert.ok(next.value<axis.value,'closing momentum survives the retarget');
    assert.ok(Math.abs(next.value-axis.value)<.03,'no endpoint snap on reversal');
    assert.ok(sidebarSpringPresentation(next.value,'left').alpha>0,'same material remains visible');
  }
});

test('popup paint preserves both rounded edges inside its owned gutter without changing DOM spring motion',()=>{
  for(const width of [180,248,380,620,720])for(const side of ['left','right'])for(const progress of [-.02,0,.2,.8,1,1.02,1.038,1.08]) {
    const original=sidebarSpringPresentation(progress,side),paint=sidebarPopupProjection(side,width,original.x),scale=Math.min(original.scaleX,paint.scaleX);
    const left=side==='left'?12+paint.x:12+width+paint.x-width*scale,right=left+width*scale;
    assert.ok(left>=-1e-7&&right<=width+24+1e-7,`${side} ${width}px physical overshoot fits actual owned popup`);
    assert.equal(sidebarSpringPresentation(progress,side).scaleX,original.scaleX,'the DOM spring and physical axis are unchanged');
    if(progress>1)assert.ok(scale>1,'a modest real width overshoot survives the geometric limit');
  }
  assert.ok(sidebarPopupProjection('right',720,-.456).scaleX<sidebarPopupProjection('right',380,-.456).scaleX,'resize recalculates the same physical gutter rather than retaining a narrow-pane limit');
});
