import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { ViewerCore } from '../packages/document-core/src/index';
import { blankBytes } from '../packages/document-core/src/fixtures';
import { editOperationSchema, type DocumentModel, type EditOperation, type Format } from '../packages/contracts/src/index';
import { shiftSheetFormula } from '../packages/format-adapters/src/sheet-editing';
import { OfficeModelBackground, backgroundOfficeAdapter } from '../packages/format-adapters/src/office-model-background';

const repository = () => ({ load: async <T>() => undefined as T | undefined, save: async (_value: unknown) => {} });
const customPart = 'customXml/agentviewer-proof.xml', customContent = '<proof>unrelated package payload</proof>';
async function withProof(bytes: Uint8Array) { const zip=await JSZip.loadAsync(bytes);zip.file(customPart,customContent);return zip.generateAsync({type:'uint8array'}); }
async function setup(format: Format, bytes?: Uint8Array) {
  const core=new ViewerCore(repository()),directory=await mkdtemp(join(tmpdir(),'agentviewer-office-editing-'));
  await core.initialize();const view=await core.openBytes('editing.'+format,await withProof(bytes??await blankBytes(format)),format);let count=0;
  const model=()=>core.getDocument(view.documentId).info.model;
  const edit=async (input: unknown, check:(model:DocumentModel)=>void) => {
    const operation=editOperationSchema.parse(input),before=core.getDocument(view.documentId).bytes.slice(),patch=core.prepare(view.documentId,core.getDocument(view.documentId).info.revision,operation);
    const receipt=await core.commit(patch.id,'undo-'+count);check(model());
    await core.undo(receipt.transactionId);assert.deepEqual(core.getDocument(view.documentId).bytes,before,'target transaction undo restores its exact source bytes');
    const next=core.prepare(view.documentId,core.getDocument(view.documentId).info.revision,operation);await core.commit(next.id,'apply-'+count);
    const path=join(directory,`${count++}.${format}`);await core.save(view.documentId,path,true);
    const reopened=new ViewerCore(repository());await reopened.initialize();const opened=await reopened.openFile(path);check(reopened.getDocument(opened.documentId).info.model);
    const zip=await JSZip.loadAsync(await readFile(path));assert.equal(await zip.file(customPart)!.async('string'),customContent,'unrelated OOXML part remains byte-identical');
  };
  const reject=async (input:unknown,pattern:RegExp) => {const before=core.getDocument(view.documentId).bytes.slice(),revision=core.getDocument(view.documentId).info.revision;await assert.rejects(async()=>{const op=editOperationSchema.parse(input),patch=core.prepare(view.documentId,revision,op);await core.commit(patch.id,'reject-'+count++);},pattern);assert.deepEqual(core.getDocument(view.documentId).bytes,before);assert.equal(core.getDocument(view.documentId).info.revision,revision);};
  return {core,view,model,edit,reject,directory};
}

test('Word rich text, paragraphs, tables and page settings save/reopen and undo',async()=>{
  const t=await setup('docx'),id=t.model().blocks![0].id,source=t.model().blocks![0].text;
  const { build }=await import('esbuild'),workerPath=join(t.directory,'office-model-worker.cjs');
  await build({entryPoints:[join(process.cwd(),'packages/format-adapters/src/office-model-worker.ts')],bundle:true,platform:'node',format:'cjs',target:'node22',outfile:workerPath,logLevel:'silent'});
  const parser=new OfficeModelBackground(workerPath),parserBytes=t.core.getDocument(t.view.documentId).bytes,beforeParser=parserBytes.slice();let heartbeat=0;
  const heartbeatTimer=setInterval(()=>heartbeat++,1);
  try { assert.deepEqual(await parser.open(parserBytes,'docx'),t.model()); } finally {clearInterval(heartbeatTimer);}
  assert.ok(heartbeat>0,'Office model parsing allows the main process event loop to continue');assert.deepEqual(parserBytes,beforeParser,'worker transfer never detaches or edits the source');
  await assert.rejects(parser.open(new Uint8Array([1,2,3]),'docx'),/zip|end of central directory/i);
  assert.deepEqual(await parser.open(parserBytes,'docx'),t.model(),'a failed document does not poison the parser lane');
  for(const format of ['xlsx','pptx']as const){const bytes=await blankBytes(format);assert.deepEqual(await parser.open(bytes,format),await t.core.registry.resolve(format).open(bytes,format),'background and foreground Office models retain exact structure');}
  const compressedZip=await JSZip.loadAsync(parserBytes),xml=await compressedZip.file('word/document.xml')!.async('string'),longText='长段落'.repeat(100000);compressedZip.file('word/document.xml',xml.replace('欢迎使用 AgentViewer',longText));
  const compressedBytes=await compressedZip.generateAsync({type:'uint8array',compression:'DEFLATE'});assert.ok(compressedBytes.byteLength<256*1024);
  let dispatchedLargeXml=0;const originalParserOpen=parser.open.bind(parser);parser.open=(bytes,format)=>{dispatchedLargeXml++;return originalParserOpen(bytes,format);};
  assert.equal((await backgroundOfficeAdapter(t.core.registry.resolve('docx'),parser).open(compressedBytes,'docx')).blocks![0].text,longText);assert.equal(dispatchedLargeXml,1,'highly compressed XML takes the background lane too');
  await t.edit({kind:'office.setTextStyle',blockId:id,from:0,to:2,expectedText:source.slice(0,2),fontName:'Microsoft YaHei',fontSize:18,color:'204060',highlight:'FFF1AA',strike:true,bold:true},model=>{const run=model.blocks![0].runs![0];assert.equal(run.fontSize,18);assert.equal(run.fontName,'Microsoft YaHei');assert.equal(run.color,'204060');assert.equal(run.highlight,'FFF1AA');assert.equal(run.strike,true);assert.equal(model.blocks![0].text,source);});
  await t.edit({kind:'word.setParagraphFormat',blockId:id,alignment:'both',spacingBefore:8,spacingAfter:12,lineSpacing:1.5,indentLeft:18,indentRight:9,indentFirstLine:-12},model=>{const p=model.blocks![0];assert.equal(p.spacingAfter,12);assert.equal(p.lineSpacing,1.5);assert.equal(p.indentFirstLine,-12);assert.equal(p.alignment,'both');});
  await t.edit({kind:'word.insertParagraph',afterBlockId:id,text:'独立插入段落',style:'Heading2'},model=>assert.ok(model.blocks!.some(p=>p.text==='独立插入段落'&&p.style==='Heading2')));
  const remove=t.model().blocks!.find(p=>p.text==='独立插入段落')!.id;
  await t.edit({kind:'word.deleteParagraph',blockId:remove},model=>assert.ok(!model.blocks!.some(p=>p.text==='独立插入段落')));
  await t.edit({kind:'word.insertTable',afterBlockId:id,rows:[['名称','说明'],['Word','保留表格结构']]},model=>{const cells=model.blocks!.filter(p=>p.tableId==='table-0');assert.equal(cells.length,4);assert.equal(cells.find(p=>p.tableRow===1&&p.tableColumn===1)?.text,'保留表格结构');});
  const cell=t.model().blocks!.find(p=>p.tableId&&p.tableRow===1&&p.tableColumn===1)!;
  await t.edit({kind:'word.setBlock',blockId:cell.id,text:'可编辑的表格内容'},model=>assert.equal(model.blocks!.find(p=>p.tableRow===1&&p.tableColumn===1)?.text,'可编辑的表格内容'));
  await t.reject({kind:'word.deleteParagraph',blockId:cell.id},/最后一个段落/);
  await t.edit({kind:'word.setPageLayout',orientation:'landscape',margins:{top:36,left:40,right:40,bottom:36}},model=>{assert.equal(model.pageLayout!.orientation,'landscape');assert.ok(model.pageLayout!.width>model.pageLayout!.height);assert.equal(model.pageLayout!.margins.left,40);});
  await t.reject({kind:'word.setPageLayout',margins:{left:700,right:700}},/页边距/);
  await t.reject({kind:'word.insertTable',afterBlockId:id,rows:[['a','b'],['c']]},/列数/);
  await t.reject({kind:'office.setTextStyle',blockId:id,from:0,to:999,expectedText:'wrong',bold:true},/选区/);
  for(const kind of ['word.deleteParagraph','word.insertTable','word.setPageLayout','office.setTextStyle'])assert.ok(t.core.getDocument(t.view.documentId).info.capabilities.editKinds.includes(kind));
});

test('PowerPoint slides, shapes, style, background and notes save/reopen independently',async()=>{
  const t=await setup('pptx'),original=t.model().slides![0].id,shape=t.model().slides![0].blocks[0].id;
  await t.reject({kind:'slides.deleteSlide',slideId:original},/最后一张/);
  await t.edit({kind:'slides.setShapeStyle',slideId:original,shapeId:shape,fontName:'Arial',fontSize:27,color:'113355',fill:'EEF3FA',lineColor:'557799',lineWidth:1.5,rotation:12,alignment:'center',underline:true},model=>{const block=model.slides![0].blocks.find(b=>b.id===shape)!;assert.equal(block.fontSize,27);assert.equal(block.color,'113355');assert.equal(block.fill,'EEF3FA');assert.equal(block.lineColor,'557799');assert.equal(block.lineWidth,1.5);assert.equal(block.rotation,12);assert.equal(block.alignment,'center');});
  await t.edit({kind:'slides.setBackground',slideId:original,color:'123456'},model=>assert.equal(model.slides![0].background,'123456'));
  await t.edit({kind:'slides.setNotes',slideId:original,text:'第一行备注\n第二行备注'},model=>assert.equal(model.slides![0].notes,'第一行备注\n第二行备注'));
  await t.edit({kind:'slides.duplicateSlide',slideId:original},model=>{assert.equal(model.slides!.length,2);assert.equal(model.slides![1].notes,'第一行备注\n第二行备注');assert.equal(model.slides![1].blocks[0].text,model.slides![0].blocks[0].text);});
  const copy=t.model().slides![1].id;
  await t.edit({kind:'slides.setNotes',slideId:copy,text:'副本独立备注'},model=>{assert.equal(model.slides![1].notes,'副本独立备注');assert.equal(model.slides![0].notes,'第一行备注\n第二行备注');});
  await t.edit({kind:'slides.moveSlide',slideId:copy,index:0},model=>assert.equal(model.slides![0].id,copy));
  await t.edit({kind:'slides.addSlide',afterSlideId:copy,title:'新幻灯片'},model=>{assert.equal(model.slides!.length,3);assert.equal(model.slides![1].blocks[0].text,'新幻灯片');});
  const added=t.model().slides![1].id;
  await t.edit({kind:'slides.addTextShape',slideId:added,text:'新增文字\n第二行',x:.2,y:.3,width:.5,height:.2},model=>assert.ok(model.slides!.find(s=>s.id===added)!.blocks.some(b=>b.text==='新增文字\n第二行')));
  const addedShape=t.model().slides!.find(s=>s.id===added)!.blocks.find(b=>b.text==='新增文字\n第二行')!.id;
  await t.edit({kind:'slides.setShapeBounds',slideId:added,shapeId:addedShape,x:.1,y:.4,width:.6,height:.2},model=>assert.ok(Math.abs(model.slides!.find(s=>s.id===added)!.blocks.find(b=>b.id===addedShape)!.x!-.1)<.000001));
  await t.edit({kind:'slides.deleteShape',slideId:added,shapeId:addedShape},model=>assert.ok(!model.slides!.find(s=>s.id===added)!.blocks.some(b=>b.id===addedShape)));
  await t.edit({kind:'slides.deleteSlide',slideId:added},model=>assert.equal(model.slides!.length,2));
  await t.reject({kind:'slides.moveSlide',slideId:copy,index:9},/超出/);
  await t.reject({kind:'slides.setShapeStyle',slideId:copy,shapeId:'missing',fill:'FFFFFF'},/对象不存在/);
});

async function workbookBytes(){const workbook=new ExcelJS.Workbook(),data=workbook.addWorksheet('Data');data.addRows([['name','score','check'],['b',20,{formula:'SUM(B2:B3)',result:30}],['a',10,null],['c',30,null]]);const ref=workbook.addWorksheet('References');ref.getCell('A1').value={formula:'\'Data\'!B2+"B2"',result:20};return new Uint8Array(await workbook.xlsx.writeBuffer());}
test('Excel styles, merges, dimensions, structure, filter and data tools retain formulas/types',async()=>{
  const t=await setup('xlsx',await workbookBytes()),sheet=t.model().sheets![0].id,other=t.model().sheets![1].id;
  await t.edit({kind:'sheets.setRangeFormat',sheetId:sheet,range:'A1:B2',fontName:'Arial',fontSize:15,color:'334455',underline:true,strike:true,wrap:true,vertical:'middle',borders:'all',borderColor:'AABBCC',fill:'EDF5FA'},model=>{const cell=model.sheets![0].rows[1][1];assert.equal(cell.fontSize,15);assert.equal(cell.color,'334455');assert.equal(cell.underline,true);assert.equal(cell.strike,true);assert.equal(cell.wrap,true);assert.equal(cell.border!.left,'thin');assert.equal(cell.valueType,'number');assert.equal(cell.value,'20');});
  await t.edit({kind:'sheets.mergeCells',sheetId:sheet,range:'D1:E1'},model=>assert.deepEqual(model.sheets![0].mergedRanges,['D1:E1']));
  await t.reject({kind:'sheets.mergeCells',sheetId:sheet,range:'A1:B1'},/丢失/);
  await t.reject({kind:'sheets.mergeCells',sheetId:sheet,range:'D1:F1'},/重叠/);
  await t.edit({kind:'sheets.unmergeCells',sheetId:sheet,range:'D1:E1'},model=>assert.deepEqual(model.sheets![0].mergedRanges,[]));
  await t.edit({kind:'sheets.setColumnWidth',sheetId:sheet,index:2,width:28},model=>assert.equal(model.sheets![0].columnWidths![1],28));
  await t.edit({kind:'sheets.setRowHeight',sheetId:sheet,index:2,height:38},model=>assert.equal(model.sheets![0].rowHeights![1],38));
  await t.edit({kind:'sheets.setFreeze',sheetId:sheet,rows:1,columns:1},model=>assert.deepEqual(model.sheets![0].freeze,{rows:1,columns:1}));
  await t.edit({kind:'sheets.setAutoFilter',sheetId:sheet,range:'A1:C4',enabled:true},model=>assert.equal(model.sheets![0].autoFilter,'A1:C4'));
  await t.edit({kind:'sheets.insertRows',sheetId:sheet,index:2,count:1},model=>{assert.equal(model.sheets![0].rows[2][2].formula,'SUM(B3:B4)');assert.equal(model.sheets![1].rows[0][0].formula,'\'Data\'!B3+"B2"');assert.equal(model.sheets![0].autoFilter,'A1:C5');});
  await t.edit({kind:'sheets.deleteRows',sheetId:sheet,index:2,count:1},model=>assert.equal(model.sheets![0].rows[1][2].formula,'SUM(B2:B3)'));
  await t.edit({kind:'sheets.insertColumns',sheetId:sheet,index:2,count:1},model=>{assert.equal(model.sheets![0].rows[1][3].formula,'SUM(C2:C3)');assert.equal(model.sheets![1].rows[0][0].formula,'\'Data\'!C2+"B2"');});
  await t.edit({kind:'sheets.deleteColumns',sheetId:sheet,index:2,count:1},model=>assert.equal(model.sheets![0].rows[1][2].formula,'SUM(B2:B3)'));
  await t.edit({kind:'sheets.sortRange',sheetId:sheet,range:'A2:B4',column:2,direction:'asc',header:false},model=>assert.deepEqual(model.sheets![0].rows.slice(1,4).map(row=>row[1].value),['10','20','30']));
  await t.reject({kind:'sheets.sortRange',sheetId:sheet,range:'A2:C4',column:2,direction:'asc',header:false},/公式范围/);
  await t.edit({kind:'sheets.addWorksheet',name:'临时'},model=>assert.equal(model.sheets!.length,3));const temporary=t.model().sheets![2].id;
  await t.edit({kind:'sheets.renameWorksheet',sheetId:temporary,name:'归档'},model=>assert.equal(model.sheets![2].name,'归档'));
  await t.edit({kind:'sheets.deleteWorksheet',sheetId:temporary},model=>assert.equal(model.sheets!.length,2));
  await t.reject({kind:'sheets.deleteWorksheet',sheetId:sheet},/正在引用/);
  await t.reject({kind:'sheets.setCell',sheetId:other,address:'XFE1',value:'bad'},/超出/);
  await t.reject({kind:'sheets.deleteRows',sheetId:sheet,index:99,count:1},/超出/);
  await t.edit({kind:'sheets.setRangeValues',sheetId:sheet,start:'E2',rows:[['plain','001'],['=SUM(B2:B3)','tail']]},model=>{assert.equal(model.sheets![0].rows[1][5].value,'001');assert.equal(model.sheets![0].rows[1][5].valueType,'string');assert.equal(model.sheets![0].rows[2][4].formula,'SUM(B2:B3)');});
  await t.reject({kind:'sheets.setRangeValues',sheetId:sheet,start:'A1',rows:[['a','b'],['c']]},/矩形/);
  const single=await setup('xlsx');await single.reject({kind:'sheets.deleteWorksheet',sheetId:single.model().sheets![0].id},/最后一个/);
});

test('formula adjustments preserve quoted strings, absolute refs, partial ranges and other sheets',()=>{
  assert.equal(shiftSheetFormula('SUM($B$2:B5)+"B2"+Other!B2','Data','Data','row',2,1,false),'SUM($B$3:B6)+"B2"+Other!B2');
  assert.equal(shiftSheetFormula('SUM(A2:A8)+A4','Data','Data','row',3,3,true),'SUM(A2:A5)+#REF!');
  assert.equal(shiftSheetFormula('SUM(A3:A5)','Data','Data','row',3,3,true),'SUM(#REF!)');
  assert.equal(shiftSheetFormula('LOG10(B2)+\'含 空格\'!B2','Data','含 空格','column',2,1,false),'LOG10(B2)+\'含 空格\'!C2');
  assert.equal(shiftSheetFormula('数据!$B$2+Other!B2+"数据!B2"','References','数据','row',2,1,false),'数据!$B$3+Other!B2+"数据!B2"');
  assert.equal(shiftSheetFormula('数据!B2+SUM(B2:B3)+"数据!B2"','Other','Other','row',2,1,false),'数据!B2+SUM(B3:B4)+"数据!B2"');
  assert.equal(shiftSheetFormula('数据B2+LOG10(B2)+"B2"+#REF!','数据','数据','row',2,1,false),'数据B2+LOG10(B3)+"B2"+#REF!');
  assert.equal(shiftSheetFormula("'含\"引号'!B2+\"含引号!B2\"",'Other','含"引号','column',2,1,false),"'含\"引号'!C2+\"含引号!B2\"");
  assert.equal(shiftSheetFormula("'数据!表'!B2+'O''Brien'!B2",'Other','数据!表','row',2,1,false),"'数据!表'!B3+'O''Brien'!B2");
  assert.equal(shiftSheetFormula('équipe!B2+e\u0301quipe!B2+"\"\"数据!B2\"\""','Other','équipe','row',2,1,false),'équipe!B3+e\u0301quipe!B2+"\"\"数据!B2\"\""');
  assert.throws(()=>shiftSheetFormula('[book.xlsx]数据!B2','Other','数据','row',2,1,false),/外部链接/);
  assert.throws(()=>shiftSheetFormula("'[book.xlsx]数据'!B2",'Other','数据','row',2,1,false),/外部链接/);
  assert.throws(()=>shiftSheetFormula('数据:归档!B2','Other','归档','row',2,1,false),/三维/);
  assert.throws(()=>shiftSheetFormula("'数据:归档'!B2",'Other','归档','row',2,1,false),/三维/);
});

test('Unicode sheet references rename, move and protect referenced sheet deletion after save/reopen',async()=>{
  const workbook=new ExcelJS.Workbook(),data=workbook.addWorksheet('数据'),other=workbook.addWorksheet('引用');workbook.addWorksheet('临时');
  data.addRows([[1,10],[2,20],[3,30]]);
  other.getCell('A1').value={formula:'数据!B2+SUM(A2:A3)+"数据!B2"+LOG10(100)',result:22};
  other.getCell('A2').value=1;other.getCell('A3').value=1;
  other.getCell('C1').value={formula:'"临时!A1"',result:'临时!A1'};
  const t=await setup('xlsx',new Uint8Array(await workbook.xlsx.writeBuffer())),sheet=t.model().sheets![0].id,ref=t.model().sheets![1].id,temp=t.model().sheets![2].id;
  await t.edit({kind:'sheets.insertRows',sheetId:sheet,index:2,count:1},model=>assert.equal(model.sheets!.find(s=>s.id===ref)!.rows[0][0].formula,'数据!B3+SUM(A2:A3)+"数据!B2"+LOG10(100)'));
  await t.edit({kind:'sheets.deleteRows',sheetId:sheet,index:2,count:1},model=>assert.equal(model.sheets!.find(s=>s.id===ref)!.rows[0][0].formula,'数据!B2+SUM(A2:A3)+"数据!B2"+LOG10(100)'));
  await t.edit({kind:'sheets.insertColumns',sheetId:sheet,index:2,count:1},model=>assert.equal(model.sheets!.find(s=>s.id===ref)!.rows[0][0].formula,'数据!C2+SUM(A2:A3)+"数据!B2"+LOG10(100)'));
  await t.edit({kind:'sheets.deleteColumns',sheetId:sheet,index:2,count:1},model=>assert.equal(model.sheets!.find(s=>s.id===ref)!.rows[0][0].formula,'数据!B2+SUM(A2:A3)+"数据!B2"+LOG10(100)'));
  await t.reject({kind:'sheets.deleteWorksheet',sheetId:sheet},/正在引用/);
  await t.edit({kind:'sheets.renameWorksheet',sheetId:sheet,name:'新数据'},model=>assert.equal(model.sheets!.find(s=>s.id===ref)!.rows[0][0].formula,'\'新数据\'!B2+SUM(A2:A3)+"数据!B2"+LOG10(100)'));
  await t.reject({kind:'sheets.deleteWorksheet',sheetId:sheet},/正在引用/);
  await t.edit({kind:'sheets.deleteWorksheet',sheetId:temp},model=>{assert.equal(model.sheets!.length,2);assert.equal(model.sheets!.find(s=>s.id===ref)!.rows[0][2].formula,'"临时!A1"');});
});

test('sheet changes refuse external and 3D qualifiers without rewriting their ASCII or Unicode tails',async()=>{
  for(const formula of ['[book.xlsx]数据!B2',"'[book.xlsx]数据'!B2",'数据:归档!B2',"'数据:归档'!B2"]){
    const workbook=new ExcelJS.Workbook(),data=workbook.addWorksheet('数据'),other=workbook.addWorksheet('归档');data.addRows([[1,2],[3,4]]);other.getCell('A1').value={formula};
    const t=await setup('xlsx',new Uint8Array(await workbook.xlsx.writeBuffer())),sheet=t.model().sheets![0].id;
    await t.reject({kind:'sheets.renameWorksheet',sheetId:sheet,name:'新数据'},/外部链接|三维/);
    await t.reject({kind:'sheets.deleteWorksheet',sheetId:sheet},/外部链接|三维/);
    await t.reject({kind:'sheets.insertRows',sheetId:sheet,index:2,count:1},/外部链接|三维/);
  }
});

test('unsupported package/formula operations reject without changing source bytes',async()=>{
  const original=await workbookBytes(),zip=await JSZip.loadAsync(original);zip.file('xl/charts/chart1.xml','<chart/>');const complex=await setup('xlsx',await zip.generateAsync({type:'uint8array'}));assert.ok(complex.model().unsupportedFeatures!.length);await complex.reject({kind:'sheets.setCell',sheetId:complex.model().sheets![0].id,address:'A1',value:'changed'},/复杂|图表/);
  const t=await setup('xlsx',original),sheet=t.model().sheets![0].id;await t.edit({kind:'sheets.setCell',sheetId:sheet,address:'D2',value:'',formula:'SUM(B:B)'},model=>assert.equal(model.sheets![0].rows[1][3].formula,'SUM(B:B)'));await t.reject({kind:'sheets.insertRows',sheetId:sheet,index:2,count:1},/结构化公式|三维|整行/);
  const operation:EditOperation={kind:'sheets.setCell',sheetId:sheet,address:'A2',value:'first'},patch=t.core.prepare(t.view.documentId,t.core.getDocument(t.view.documentId).info.revision,operation),receipt=await t.core.commit(patch.id,'first');const next=t.core.prepare(t.view.documentId,t.core.getDocument(t.view.documentId).info.revision,{...operation,value:'second'});await t.core.commit(next.id,'second');await assert.rejects(t.core.undo(receipt.transactionId),/其他编辑/);
  const bad=new ViewerCore(repository());await assert.rejects(bad.openBytes('bad.docx',new Uint8Array([1,2,3]),'docx'));
});
