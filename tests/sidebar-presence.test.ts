import assert from 'node:assert/strict';
import test from 'node:test';
import { advanceSidebarSpring, sidebarSpringPresentation, sidebarSpringSettled } from '../apps/desktop/src/renderer/lib/sidebar-presence';
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
