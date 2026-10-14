import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedNavigationPresentation, navigationControlMetrics, navigationDensity, navigationLane, preferredNavigationWidth } from '../apps/desktop/src/renderer/lib/navigation-lane';
import { sharedReaderPanelLimits } from '../apps/desktop/src/renderer/lib/reader-panel-layout';

test('reading canvas is immutable while real pane edges bound the navigation lane', () => {
  const canvas = Object.freeze({left:73,right:1367});
  const expanded = navigationLane(canvas,[{side:'left',bounds:{left:73,right:421}},{side:'right',bounds:{left:967,right:1367}}]);
  assert.deepEqual(expanded,{left:433,right:955,width:522,center:694});
  const closing = navigationLane(canvas,[{side:'left',bounds:{left:-20,right:220}}]);
  assert.equal(closing.left,232,'exiting panes are avoided until their actual edge clears the capsule');
  assert.deepEqual(canvas,{left:73,right:1367});
});

test('both maximum panes reserve usable core controls at desktop viewport widths', () => {
  for (const canvasWidth of [754,1134,1294,1774]) {
    const left = sharedReaderPanelLimits('left',canvasWidth,true), right = sharedReaderPanelLimits('right',canvasWidth,true);
    assert.ok(left.max >= left.min && right.max >= right.min);
    const lane = navigationLane({left:0,right:canvasWidth},[{side:'left',bounds:{left:0,right:left.max}},{side:'right',bounds:{left:canvasWidth-right.max,right:canvasWidth}}]);
    assert.ok(lane.width >= 124,`${canvasWidth}px canvas retains zoom/save/more lane`);
    assert.notEqual(navigationDensity(lane.width),'micro');
    assert.ok(preferredNavigationWidth(lane.width) <= lane.width);
  }
  assert.equal(sharedReaderPanelLimits('right',1000,false).max,720,'a sole pane can use the freed space');
  assert.equal(sharedReaderPanelLimits('right',1000,true).max,426);
  assert.equal(navigationDensity(300),'minimal','title/history yield before they squeeze the core controls');
  assert.deepEqual(navigationControlMetrics(navigationDensity(124)),{height:44,radius:22,buttonSize:22});
});

test('spring overshoot is interrupted at real boundaries while enlargement remains elastic', () => {
  const lane = navigationLane({left:0,right:1000},[{side:'left',bounds:{left:0,right:300}},{side:'right',bounds:{left:700,right:1000}}]);
  for (const [width,center] of [[820,500],[540,800],[190,150],[170,500]] as const) {
    const fitted = boundedNavigationPresentation(lane,width,center);
    assert.ok(fitted.center-fitted.width/2 >= lane.left);
    assert.ok(fitted.center+fitted.width/2 <= lane.right);
  }
  assert.equal(boundedNavigationPresentation(lane,170,500).width,170,'a growing spring is not forced immediately to its target');
});
