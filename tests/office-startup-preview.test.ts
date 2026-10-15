import test from 'node:test';
import assert from 'node:assert/strict';
import { registerHooks } from 'node:module';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { DocumentInfo, DocumentModel, Sheet, TextBlock } from '../packages/contracts/src/index';
import { OFFICE_PREVIEW_TEXT_LIMIT, OFFICE_PREVIEW_WORD_BLOCKS, officePreviewScope, previewCellText, previewInlineRuns, previewShapeBounds, sheetPreview, sheetPreviewGeometry, sheetPreviewWindow, slidePreview, slidePreviewBlocks, wordPreviewWindow } from '../apps/desktop/src/renderer/lib/office-startup-preview';

const hooks=registerHooks({load(url,context,next){return url.endsWith('.css')?{format:'module',source:'',shortCircuit:true}:next(url,context);}});
const {OfficeStartupPreview}=await import('../apps/desktop/src/renderer/components/OfficeStartupPreview');hooks.deregister();
const document=(model:DocumentModel):DocumentInfo=>({id:'source-doc',title:'真实原文',format:model.format,revision:7,diskRevision:7,dirty:false,model,warnings:[],capabilities:{engine:'test-parsed-source',protocolVersion:'1.0',readText:true,readSelection:false,readViewport:false,editKinds:[],saveFormats:[],limitations:[]}});

test('preview scope identifies exact document, view and source version rather than a native coordinate session',()=>{
  const doc=document({format:'docx'});assert.notEqual(officePreviewScope(doc,'a').key,officePreviewScope(doc,'b').key);assert.notEqual(officePreviewScope(doc,'a',6).key,officePreviewScope(doc,'a',7).key);
  assert.deepEqual(officePreviewScope(doc,'a',6),{documentId:'source-doc',viewId:'a',format:'docx',sourceRevision:6,key:'["source-doc","a","docx",6]'});
});

test('Word preview touches and renders only a bounded true source window with real table row/column indices',()=>{
  const blocks:TextBlock[]=Array.from({length:10000},(_,i)=>({id:'p'+i,text:'原文'+i}));blocks[3]={...blocks[3],tableId:'t',tableRow:4,tableColumn:2};blocks[4]={...blocks[4],tableId:'t',tableRow:4,tableColumn:3};
  const model:DocumentModel={format:'docx',blocks},before=JSON.stringify(blocks.slice(0,50)),preview=wordPreviewWindow(model);
  assert.equal(preview.next,OFFICE_PREVIEW_WORD_BLOCKS);assert.equal(preview.total,10000);assert.equal(preview.hasNext,true);const table=preview.items.find(item=>item.kind==='table');assert.equal(table?.kind,'table');if(table?.kind==='table'){assert.equal(table.rows[0].index,4);assert.deepEqual(table.rows[0].cells.map(cell=>cell.index),[2,3]);assert.equal(table.rows[0].cells[0].blocks[0].text,'原文3');}
  assert.equal(JSON.stringify(blocks.slice(0,50)),before);const next=wordPreviewWindow(model,preview.next);assert.equal(next.from,48);assert.equal(next.items[0].kind,'paragraph');
});

test('oversized Word and slide text remain true prefixes with bounded output, without mutating original data',()=>{
  const original='真实长文本'.repeat(20000),block={id:'p',text:original};const word=wordPreviewWindow({format:'docx',blocks:[block]});assert.equal(word.clipped,true);assert.equal(word.items[0].kind,'paragraph');if(word.items[0].kind==='paragraph')assert.equal(word.items[0].text,original.slice(0,OFFICE_PREVIEW_TEXT_LIMIT));assert.equal(block.text,original);
  const items=slidePreviewBlocks({id:'slide',blocks:Array.from({length:200},(_,index)=>({id:String(index),text:original}))});assert.ok(items.length<=128);assert.ok(items.reduce((n,item)=>n+item.value.length,0)<=OFFICE_PREVIEW_TEXT_LIMIT);
});

test('PPT uses the requested actual source slide and refuses invented bounds or incomplete text-run layouts',()=>{
  const model:DocumentModel={format:'pptx',width:1600,height:900,slides:[{id:'first',blocks:[]},{id:'second',blocks:[{id:'title',text:'第二张真实标题',x:.2,y:.1,width:.5,height:.3}]}]};const result=slidePreview(model,1);assert.equal(result.slide?.id,'second');assert.equal(result.ratio,1600/900);assert.deepEqual(previewShapeBounds(result.slide!.blocks[0]),{left:'20%',top:'10%',width:'50%',height:'30%'});
  assert.equal(previewShapeBounds({id:'unknown',text:'真实但没有位置'}),undefined);assert.equal(previewShapeBounds({id:'bad',text:'x',x:NaN,y:0,width:1,height:1}),undefined);
  assert.equal(previewInlineRuns({id:'p',text:'A\nB',runs:[{text:'AB',bold:true}]},'A\nB'),undefined,'run summaries cannot remove actual paragraph breaks');
});

test('Calc source window is bounded at distant scroll offsets and never computes formulas or exposes hidden sheets',()=>{
  const sheet:Sheet={id:'s',name:'真实工作表',rowCount:1000,columnCount:50,rows:Array.from({length:1000},(_,row)=>Array.from({length:50},(_,column)=>({address:String.fromCharCode(65+column%26)+(row+1),value:'原值-'+row+'-'+column}))),columnWidths:Array(50).fill(13),rowHeights:Array(1000).fill(21)};
  const geometry=sheetPreviewGeometry(sheet),window=sheetPreviewWindow(geometry,{x:2400,y:18000,width:800,height:550});assert.ok(window.rowStart>500);assert.ok(window.columnStart>15);assert.ok((window.rowEnd-window.rowStart)*(window.columnEnd-window.columnStart)<=48*18);
  assert.equal(previewCellText({address:'A1',value:'42',formula:'SUM(20,22)'}),'42');assert.equal(previewCellText({address:'A1',value:'',formula:'SUM(20,22)'}),'=SUM(20,22)');
  assert.equal(sheetPreview({format:'xlsx',sheets:[sheet,{...sheet,id:'hidden',state:'hidden'}]},1).sheet,sheet);
});

test('source Word SSR renders escaped real paragraphs and tables as read-only preview with no initial navigation report',()=>{
  let reports=0;const html=renderToStaticMarkup(createElement(OfficeStartupPreview,{document:document({format:'docx',blocks:[{id:'p',text:'<script>bad()</script>'},{id:'t',text:'真实表格',tableId:'table',tableRow:0,tableColumn:0}]}),viewId:'view',onViewport:()=>reports++}));
  assert.match(html,/data-testid="office-startup-preview"/);assert.match(html,/aria-label="快速预览"/);assert.match(html,/data-preview-source-revision="7"/);assert.match(html,/&lt;script&gt;bad\(\)&lt;\/script&gt;/);assert.match(html,/<table/);assert.match(html,/真实表格/);assert.doesNotMatch(html,/<script|contenteditable|<textarea|<input|data-block-id=/i);assert.equal(reports,0);
});

test('native failure remains visible alongside readable source, without a perpetual preparing claim',()=>{
  const html=renderToStaticMarkup(createElement(OfficeStartupPreview,{document:document({format:'docx',blocks:[{id:'p',text:'仍然可阅读的正文'}]}),viewId:'view',error:'初始化失败 <retry>'}));
  assert.match(html,/仍然可阅读的正文/);assert.match(html,/role="status"/);assert.match(html,/编辑器暂不可用：初始化失败 &lt;retry&gt;/);assert.doesNotMatch(html,/完整编辑器准备中/);
});

test('PPT source SSR contains only selected slide text; missing source stays explicit and does not generate placeholder content',()=>{
  const html=renderToStaticMarkup(createElement(OfficeStartupPreview,{document:document({format:'pptx',width:1600,height:900,slides:[{id:'a',blocks:[{id:'a',text:'第一张不应显示'}]},{id:'b',blocks:[{id:'b',text:'第二张真内容',x:.1,y:.2,width:.5,height:.2}]}]}),viewId:'view',initialPartIndex:1}));assert.match(html,/第二张真内容/);assert.doesNotMatch(html,/第一张不应显示/);assert.match(html,/left:10%/);
  const missing=renderToStaticMarkup(createElement(OfficeStartupPreview,{document:document({format:'docx'}),viewId:'view'}));assert.match(missing,/没有可用的已解析文本/);assert.doesNotMatch(missing,/<article|<table/);
});

test('Calc SSR renders a small window of source values rather than the complete 50000-cell model',()=>{
  const sheet:Sheet={id:'s',name:'数据',rowCount:1000,columnCount:50,rows:Array.from({length:1000},(_,row)=>Array.from({length:50},(_,column)=>({address:'A'+(row+1),value:'真实-'+row+'-'+column})))};
  const html=renderToStaticMarkup(createElement(OfficeStartupPreview,{document:document({format:'xlsx',sheets:[sheet]}),viewId:'view'}));assert.match(html,/真实-0-0/);assert.doesNotMatch(html,/真实-999-49/);assert.ok((html.match(/role="cell"/g)??[]).length<=48*18);assert.doesNotMatch(html,/<textarea|<input|contenteditable/i);
});
