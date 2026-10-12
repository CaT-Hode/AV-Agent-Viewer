import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isNativeTooltipRelocation, nativeTooltipLayout, placeTooltip } from '../apps/desktop/src/renderer/lib/tooltip-placement';
test('measured tooltips stay near the left rail and preserve a 7px anchor gap',()=>{
  const position=placeTooltip({x:17,y:90,width:30,height:30},{width:80,height:32},{width:1440,height:900});
  assert.equal(position.x,6);assert.equal(position.y,127);assert.equal(position.above,false);
  const middle=placeTooltip({x:400,y:50,width:30,height:30},{width:80,height:32},{width:1440,height:900});assert.equal(middle.x,375);
});
test('bottom and right edges choose above without an arbitrary 150px offset',()=>{
  const position=placeTooltip({x:910,y:710,width:28,height:28},{width:150,height:34},{width:960,height:760});
  assert.equal(position.above,true);assert.equal(position.y,669);assert.equal(position.x,804);
});
test('native top-gutter expansion preserves control position and exact anchor gap',()=>{
  for(const zoom of [1,1.25,1.5,2]){
    const base={x:400,y:800,width:240,height:74},anchor={x:175/zoom,y:22/zoom,width:30/zoom,height:30/zoom},size={width:130/zoom,height:34/zoom};
    const layout=nativeTooltipLayout(anchor,size,base,base,{width:1440,height:892},zoom);
    assert.ok(layout.placement.above);assert.equal(layout.bounds.width,base.width);
    assert.ok(Math.abs(layout.bounds.y+(anchor.y+layout.offsetY)*zoom-(base.y+anchor.y*zoom))<1e-8,'expansion cancels viewport-origin change');
    assert.ok(Math.abs(layout.bounds.y+(layout.placement.y+size.height)*zoom-(base.y+anchor.y*zoom-7*zoom))<1e-8);
    assert.ok(layout.placement.x>=6&&layout.placement.x+size.width<=layout.bounds.width/zoom-6);
  }
});
test('native below expansion grows only empty space and ignores page DPR',()=>{
  const base={x:350,y:70,width:720,height:92},anchor={x:30,y:29,width:34,height:34},size={width:104,height:34};
  const layout=nativeTooltipLayout(anchor,size,base,base,{width:1440,height:900});
  assert.equal(layout.placement.above,false);assert.equal(layout.bounds.y,base.y);assert.equal(layout.offsetY,0);assert.equal(layout.placement.y,70);assert.equal(layout.bounds.height,110);
});
test('native relocation keeps a stationary physical pointer attached at all DPRs',()=>{
  for(const dpr of [1,1.5,2]){
    // Chromium can report the old clientY=37 after the host expands upward.
    // Its physical screen point is unchanged; DPR never enters CSS offsets.
    const previous={x:194.56,y:37,screenX:1325.56,screenY:1095,offsetY:0};
    const current={...previous,offsetY:25},target={x:180,y:46,width:32,height:32};
    assert.equal(isNativeTooltipRelocation(current,previous,target),true,'DPR '+dpr);
    assert.equal(isNativeTooltipRelocation({...current,y:62},previous,target),true,'already updated client coordinates describe the same screen point');
    assert.equal(isNativeTooltipRelocation({...current,screenY:previous.screenY+1/dpr},previous,target),false,'any real screen movement is not suppressed');
    assert.equal(isNativeTooltipRelocation(current,previous,{...target,y:80}),false,'the compensated point must actually remain in the original target');
    assert.equal(isNativeTooltipRelocation(current,undefined,target),false,'cleared hover state cannot revive a tooltip');
    assert.equal(isNativeTooltipRelocation({...previous},previous,target),false,'ordinary over/out without viewport relocation is never suppressed');
  }
});
test('native relocation accounts for toolbar zoom and a recorded nonzero gutter',()=>{
  for(const zoom of [1,1.25,1.5,2]){
    const previous={x:100/zoom,y:30/zoom,screenX:900,screenY:1000,offsetY:10/zoom};
    const current={...previous,offsetY:35/zoom},target={x:85/zoom,y:42/zoom,width:30/zoom,height:30/zoom};
    assert.equal(isNativeTooltipRelocation(current,previous,target),true);
    assert.equal(isNativeTooltipRelocation({...current,screenX:901},previous,target),false);
    assert.equal(isNativeTooltipRelocation({...current,offsetY:Number.NaN},previous,target),false);
    assert.equal(isNativeTooltipRelocation(current,previous,{...target,width:0}),false);
  }
});
