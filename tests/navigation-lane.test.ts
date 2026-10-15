import assert from 'node:assert/strict';
import test from 'node:test';
import { boundedNavigationPresentation, navigationControlMetrics, navigationDensity, navigationLane, preferredNavigationWidth, sidebarNavigationScale } from '../apps/desktop/src/renderer/lib/navigation-lane';
import { sharedReaderPanelLimits } from '../apps/desktop/src/renderer/lib/reader-panel-layout';
import { glassSpringParameters, stepGlassSpring } from '../apps/desktop/src/renderer/lib/glass-elasticity';
import { KUBE_GLASS_SPRINGS } from '../apps/desktop/src/renderer/lib/glass-presets';
import { advanceSidebarSpring, sidebarSpringPresentation } from '../apps/desktop/src/renderer/lib/sidebar-presence';

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
  for (const width of [124,350,450,650,820]) assert.deepEqual({...navigationControlMetrics(navigationDensity(width)),buttonSize:0},{height:60,radius:30,buttonSize:0},'spacing yields to available width without changing capsule height or radius');
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

test('a requested pair of panes makes navigation yield continuously, with visible pane edges always outside it',()=>{
  for (const mode of ['standard','elegant'] as const) for (const width of [754,1080,1294]) {
    const canvas = navigationLane({left:0,right:width});
    const panelWidths = {left:sharedReaderPanelLimits('left',width,true).max,right:sharedReaderPanelLimits('right',width,true).max};
    const panels = [{side:'left' as const,bounds:{left:0,right:panelWidths.left}},{side:'right' as const,bounds:{left:width-panelWidths.right,right:width}}];
    const target = navigationLane({left:0,right:width},panels);
    const initialWidth = preferredNavigationWidth(canvas.width), targetWidth = preferredNavigationWidth(target.width);
    let navWidth = {value:initialWidth,velocity:0}, navCenter = {value:canvas.center,velocity:0}, pane = {value:0,velocity:0}, previousWidth=initialWidth;
    const parameters = glassSpringParameters(KUBE_GLASS_SPRINGS.lensShape,mode);
    for (let i=0;i<360;i++) {
      navWidth=stepGlassSpring(navWidth,targetWidth,1/120,parameters);navCenter=stepGlassSpring(navCenter,target.center,1/120,parameters);
      const fitted=boundedNavigationPresentation(canvas,navWidth.value,navCenter.value);
      if (!i) { assert.ok(fitted.width>targetWidth+100,'first frame cannot jump straight to the narrow lane'); assert.ok(initialWidth-fitted.width<8,'planned lane starts a real elastic contraction'); }
      assert.ok(Math.abs(fitted.width-previousWidth)<70,'bounded frame displacement rather than an immediate cut'); previousWidth=fitted.width;
      pane=advanceSidebarSpring(pane,true,1/120,mode);
      const navigation={left:fitted.center-fitted.width/2,right:fitted.center+fitted.width/2};
      for (const panel of panels) {
        const shape=sidebarSpringPresentation(pane.value,panel.side), scale=Math.min(shape.scaleX,sidebarNavigationScale(panel.side,panel.bounds,navigation,shape.x));
        const edge=panel.side==='left'?panel.bounds.left+shape.x+(panel.bounds.right-panel.bounds.left)*scale:panel.bounds.right+shape.x-(panel.bounds.right-panel.bounds.left)*scale;
        assert.ok(panel.side==='left'?edge<=navigation.left-12+1e-7:edge>=navigation.right+12-1e-7,'every visible pane shape respects actual moving navigation edge');
      }
    }
    assert.ok(Math.abs(navWidth.value-targetWidth)<.01 && Math.abs(pane.value-1)<.001,'both independent springs reach their requested geometry');
  }
});

test('reservation projection is symmetric, honors translation and releases without affecting a document',()=>{
  const canvas=Object.freeze({left:0,right:1080}), nav={left:400,right:680};
  const left=sidebarNavigationScale('left',{left:0,right:500},nav,-6),right=sidebarNavigationScale('right',{left:580,right:1080},nav,6);
  assert.equal(left,right);assert.equal(left,.788);
  assert.equal(sidebarNavigationScale('left',{left:0,right:500},{left:12,right:1068},0),0,'near-full navigation initially leaves a pane invisible');
  assert.equal(sidebarNavigationScale('right',{left:580,right:1080},{left:100,right:200}),1.12,'released room permits only the restrained spring overshoot');
  assert.deepEqual(canvas,{left:0,right:1080});
});
