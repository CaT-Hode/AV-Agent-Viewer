import assert from 'node:assert/strict';
import {test} from 'node:test';
import {officePresentationFit,OfficePresentationFitController,officePresentationManualLayout} from '../apps/desktop/src/renderer/lib/office-presentation-fit';
const page={width:19200,height:10800};
test('a landscape or portrait slide fits its real safe viewport without changing its aspect or engine zoom limits',()=>{
  assert.equal(officePresentationFit(page,{width:976,height:616}),.75);
  assert.equal(officePresentationFit({width:10800,height:19200},{width:976,height:616}),.46);
  assert.equal(officePresentationFit(page,{width:124,height:616}),.25);
  assert.equal(officePresentationFit({width:15,height:15},{width:976,height:616}),4);
  assert.equal(officePresentationFit(page,{width:NaN,height:616}),undefined);
});
test('manual slide scrolling can uncover both pane-covered page edges without narrowing its real viewport',()=>{
  for(const pageWidth of [320,900,1600,3400]){
    const viewport={width:1100,height:700},gaps={left:260,right:380},layout=officePresentationManualLayout({width:pageWidth,height:900},viewport,gaps),maximum=layout.stageSize.width-viewport.width;
    assert.ok(layout.offsetX>=gaps.left,'at scroll zero the left document edge is in the unobstructed lane');
    assert.ok(layout.offsetX+pageWidth-maximum<=viewport.width-gaps.right,'at maximum scroll the right document edge is in the unobstructed lane');
    assert.equal(layout.safeViewport.width,viewport.width-gaps.left-gaps.right);assert.ok(maximum>=0);
    if(pageWidth>layout.safeViewport.width)assert.ok(layout.offsetX-maximum<gaps.left,'intermediate scrolling is allowed underneath a floating pane');
  }
});
test('fit requests wait for their real zoom acknowledgement and height changes do not issue redundant native zooms',()=>{
  const fit=new OfficePresentationFitController();assert.equal(fit.request(page,{width:976,height:616},1),.75);
  assert.equal(fit.request(page,{width:976,height:616},1),undefined,'a pending request is not duplicated');fit.observeZoom(.75);assert.equal(fit.enabled,true);assert.equal(fit.pending,false);
  assert.equal(fit.request(page,{width:976,height:640},.75),undefined,'width already constrains this slide');assert.equal(fit.request(page,{width:656,height:640},.75),.5);fit.observeZoom(.5);
  fit.observeZoom(1.2);assert.equal(fit.enabled,false);assert.equal(fit.request(page,{width:512,height:640},1.2),undefined,'an explicit navigation zoom survives subsequent panel resizes');
});
test('a manual gesture immediately exits fit even while an earlier fit acknowledgement is still arriving',()=>{
  const fit=new OfficePresentationFitController();fit.request(page,{width:976,height:616},1);fit.manual();fit.observeZoom(.75);fit.observeZoom(.9);assert.equal(fit.enabled,false);assert.equal(fit.request(page,{width:656,height:640},.9),undefined);
});
test('a nonintegral fitted percentage survives the Core canonical zoom acknowledgement without becoming manual or overflowing',()=>{
  const fit=new OfficePresentationFitController(),portrait={width:10800,height:19200},viewport={width:976,height:616};
  const requested=fit.request(portrait,viewport,1)!;assert.ok(requested<.46875);
  const acknowledged=Math.round(requested*100)/100;assert.equal(requested,acknowledged,'Core whole-percent canonicalization is already satisfied');
  fit.observeZoom(acknowledged);assert.equal(fit.enabled,true);assert.equal(fit.pending,false);assert.ok(portrait.height*acknowledged/15<=viewport.height-16);
  assert.equal(fit.request(portrait,{width:976,height:760},acknowledged),.58,'a later available-height change still generates an automatic fit');
});
