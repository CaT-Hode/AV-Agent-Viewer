import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { nativeSelectionAnchor, nativeSelectionKey, nativeSelectionLayout } from '../apps/desktop/src/renderer/lib/native-selection';
import type { ReadingContext } from '../packages/contracts/src/index';

const context = (scrollY=0): ReadingContext => ({viewId:'v',documentId:'d',contentRevision:2,viewRevision:3,capturedAt:'now',quality:'confirmed',actor:'human',locator:{kind:'viewport'},visibleText:'selection',selection:{kind:'text',text:'selection',locator:{kind:'quote',quote:'selection'},rect:{x:50,y:200-scrollY,width:100,height:20}},viewport:{width:500,height:400,scrollX:0,scrollY,deviceScaleFactor:1.5,navigationId:'nav',layoutRevision:1}});
describe('native selection placement',()=>{
  it('converts source CSS pixels at page zoom into reader coordinates',()=>{
    assert.deepEqual(nativeSelectionAnchor(context(),{x:100,y:60,width:1000,height:800}),{x:200,y:460,width:200,height:40});
  });
  it('retains the snapshot identity while scrolling but invalidates navigation and different equal text',()=>{
    assert.equal(nativeSelectionKey(context(0)),nativeSelectionKey(context(30)));
    const changed=context();changed.viewport!.navigationId='new';assert.notEqual(nativeSelectionKey(changed),nativeSelectionKey(context()));
    const other=context();other.selection.rect!.y+=60;assert.notEqual(nativeSelectionKey(other),nativeSelectionKey(context()));
  });
  it('follows the text and disappears once it has left the viewport',()=>{
    const reader={x:100,y:60,width:1000,height:800};
    assert.equal(nativeSelectionLayout(context(30),reader,5)!.y,nativeSelectionLayout(context(0),reader,5)!.y-60);
    assert.equal(nativeSelectionLayout(context(500),reader,5),undefined);
  });
  it('keeps a native range lease across scrolling and invalidates a new selection',()=>{
    const first=context(), moved=context(30);
    first.nativeOffice={sessionId:'office',engineEpoch:'e',engineRevision:2,selectionEpoch:4};
    moved.nativeOffice={...first.nativeOffice};moved.viewport!.layoutRevision=8;
    assert.equal(nativeSelectionKey(first),nativeSelectionKey(moved));
    moved.nativeOffice.selectionEpoch=5;
    assert.notEqual(nativeSelectionKey(first),nativeSelectionKey(moved));
  });
});
