import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { DOMParser, XMLSerializer } from '@xmldom/xmldom';
import { ViewerError, PROTOCOL_VERSION, type Capabilities, type DocumentModel, type EditOperation, type Format, type FormatAdapter, type SheetCell } from '../../contracts/src/index';

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new ViewerError('INVALID_TARGET', message); }
const unsupported = (message: string): never => { throw new ViewerError('CAPABILITY_UNSUPPORTED', message); };
const colNumber = (letters: string) => [...letters].reduce((value, char) => value * 26 + char.charCodeAt(0) - 64, 0);
const colLetters = (number: number) => { let letters = ''; while (number > 0) { number--; letters = String.fromCharCode(65 + number % 26) + letters; number = Math.floor(number / 26); } return letters; };
function address(value: string) { const match = /^([A-Z]+)([1-9]\d*)$/.exec(value); assert(match, '单元格地址无效。'); const column = colNumber(match[1]), row = Number(match[2]); assert(column <= 16384 && row <= 1048576, '单元格地址超出 Excel 范围。'); return { column, row }; }
export function sheetRange(value: string) { const parts = value.split(':'), start = address(parts[0]), end = address(parts[1] ?? parts[0]); assert(end.column >= start.column && end.row >= start.row, '选区必须从左上角到右下角。'); assert((end.column-start.column+1)*(end.row-start.row+1) <= 100000, '一次范围编辑最多 100000 个单元格。'); return { start, end }; }
const overlaps = (a: ReturnType<typeof sheetRange>, b: ReturnType<typeof sheetRange>) => a.start.row<=b.end.row&&a.end.row>=b.start.row&&a.start.column<=b.end.column&&a.end.column>=b.start.column;
// Double-quoted formula strings are opaque. A quote inside a single-quoted
// sheet name is a name character, not the start of a formula string.
function strings(formula: string): string[] {
  const parts: string[] = []; let start = 0, quotedSheet = false;
  for (let index = 0; index < formula.length; index++) {
    if (formula[index] === "'") { if (quotedSheet && formula[index + 1] === "'") index++; else quotedSheet = !quotedSheet; }
    else if (formula[index] === '"' && !quotedSheet) {
      parts.push(formula.slice(start, index)); const opening = index++;
      while (index < formula.length) { if (formula[index] === '"') { if (formula[index + 1] === '"') { index += 2; continue; } break; } index++; }
      parts.push(formula.slice(opening, Math.min(index + 1, formula.length))); start = index + 1;
    }
  }
  parts.push(formula.slice(start)); return parts;
}
const bareSheetName = String.raw`[\p{L}\p{M}\p{N}_.\\]+`;
const quotedSheetName = String.raw`'((?:[^']|'')+)'`;
const qualifierSource = `(?:${quotedSheetName}|(${bareSheetName}))!`;
// Include Unicode in both boundaries. Never match the ASCII suffix of a
// Chinese identifier, a coordinate after an unrecognised !, or #REF!.
const formulaBoundary = String.raw`(?<![\p{L}\p{M}\p{N}_.\\'!\[\]#])`;
const qualifiers = () => new RegExp(formulaBoundary + qualifierSource, 'gu');
const sheetName = (match: RegExpMatchArray) => match[1]?.replace(/''/g, "'") ?? match[2];
const reference = new RegExp(formulaBoundary + `(?:${qualifierSource})?` + String.raw`(\$?)([A-Z]{1,3})(\$?)([1-9]\d*)(?::(\$?)([A-Z]{1,3})(\$?)([1-9]\d*))?(?![\p{L}\p{M}\p{N}_.\\(])`, 'giu');
function unsafeSheetReferences(formula: string) {
  return strings(formula).some((part, index) => {
    if (index % 2) return false;
    if (/[\[\]]/.test(part) || new RegExp(`(?:'(?:(?:[^']|'')+)'|${bareSheetName})\\s*:\\s*(?:'(?:(?:[^']|'')+)'|${bareSheetName})!`, 'u').test(part)) return true;
    const matches = Array.from(part.matchAll(qualifiers()));
    if (matches.some(match => /[:\[\]]/.test(sheetName(match)))) return true;
    // Unrecognised qualifiers are refused rather than treating their A1 tail
    // as a local reference. Excel error literals can legitimately contain !.
    return part.replace(qualifiers(), '').replace(/#[A-Z][A-Z0-9_/]*!/gi, '').includes('!');
  });
}
function assertSheetReferences(formula: string) { assert(!unsafeSheetReferences(formula), '外部链接、三维或无法识别的工作表引用暂不支持此修改。'); }
function formulaReferencesSheet(formula: string, name: string) {
  assertSheetReferences(formula);
  return strings(formula).some((part,index) => !(index % 2) && Array.from(part.matchAll(qualifiers())).some(match => sheetName(match).toLocaleLowerCase() === name.toLocaleLowerCase()));
}

/** Rewrite supported A1 coordinates outside string literals. Absolute markers
 * retain their identity; insert/delete moves references even when absolute. */
export function shiftSheetFormula(formula: string, formulaSheet: string, editedSheet: string, axis: 'row'|'column', index: number, count: number, deleting: boolean): string {
  assertSheetReferences(formula);
  const shift = (value: number) => !deleting ? value>=index?value+count:value : value<index?value:value>=index+count?value-count:undefined;
  return strings(formula).map((part,i)=>i%2?part:part.replace(reference,(match,quoted:string|undefined,bare:string|undefined,dollarC:string,col:string,dollarR:string,row:string,endDollarC:string|undefined,endCol:string|undefined,endDollarR:string|undefined,endRow:string|undefined)=>{
    const qualified=quoted?.replace(/''/g,"'")??bare, owner=qualified??formulaSheet; if(owner.toLocaleLowerCase()!==editedSheet.toLocaleLowerCase())return match;
    const prefix=qualified?match.slice(0,match.lastIndexOf('!')+1):'';
    let c1=colNumber(col.toUpperCase()),r1=Number(row),c2=endCol?colNumber(endCol.toUpperCase()):c1,r2=endRow?Number(endRow):r1;
    if(c1>16384||c2>16384||r1>1048576||r2>1048576)return match;
    if(endCol){const first=axis==='row'?r1:c1,last=axis==='row'?r2:c2;if(deleting&&first>=index&&last<index+count)return '#REF!';const nextFirst=shift(first)??index,nextLast=shift(last)??index-1;if(nextFirst>nextLast)return '#REF!';if(axis==='row'){r1=nextFirst;r2=nextLast;}else{c1=nextFirst;c2=nextLast;}}
    else{const moved=shift(axis==='row'?r1:c1);if(moved===undefined)return '#REF!';if(axis==='row')r1=moved;else c1=moved;}
    if(c1>16384||c2>16384||r1>1048576||r2>1048576)return '#REF!';
    return prefix+dollarC+colLetters(c1)+dollarR+r1+(endCol?':'+(endDollarC??'')+colLetters(c2)+(endDollarR??'')+r2:'');
  })).join('');
}
function renameFormula(formula: string, oldName: string, nextName: string) { assertSheetReferences(formula);return strings(formula).map((part,i)=>i%2?part:part.replace(qualifiers(),(match,quoted:string|undefined,bare:string|undefined)=>(quoted?.replace(/''/g,"'")??bare)?.toLocaleLowerCase()===oldName.toLocaleLowerCase()?"'"+nextName.replace(/'/g,"''")+"'!":match)).join(''); }
const formulaUnsupported = (formula: string) => unsafeSheetReferences(formula) || strings(formula).some((part,i)=>!(i%2)&&/(?:\$?[A-Z]{1,3}:\$?[A-Z]{1,3}|\$?\d+:\$?\d+)|[A-Z]+\d+#/i.test(part));
const mergeNames = (sheet: ExcelJS.Worksheet) => (sheet.model.merges ?? []).map(String);
async function features(bytes: Uint8Array) { const zip=await JSZip.loadAsync(bytes),found=new Set<string>();for(const [path,file]of Object.entries(zip.files)){if(file.dir)continue;if(/^xl\/(charts|drawings|pivot|externalLinks|slicer|embeddings|tables|connections|queryTables|threadedComments)|vbaProject/i.test(path))found.add('图表、绘图、透视表、外部链接、表对象或扩展部件');if(/^xl\/(worksheets\/sheet\d+|workbook|styles)\.xml$/.test(path)){let source=await file.async('string');if(path==="xl/styles.xml")source=source.replace(/<ext\b[^>]*>\s*<(?:\w+:)?(?:slicerStyles|timelineStyles)\b[^>]*\/>\s*<\/ext>/g,"").replace(/<extLst>\s*<\/extLst>/g,"");if(/<(?:\w+:)?(?:extLst|conditionalFormatting|legacyDrawing|controls|oleObjects)\b/.test(source))found.add('条件格式、控件、批注绘图或扩展 XML');}}return [...found]; }

/** ExcelJS owns workbook primitives; preserve unrelated package payloads and
 * metadata instead of silently dropping custom XML/theme/docProps parts. */
async function savePackage(original: Uint8Array, workbook: ExcelJS.Workbook) {
  const zip=await JSZip.loadAsync(original),generated=await JSZip.loadAsync(new Uint8Array(await workbook.xlsx.writeBuffer()));
  for(const [path,file]of Object.entries(generated.files)){if(file.dir||path==='[Content_Types].xml'||path==='_rels/.rels'||(zip.file(path)&&(/^(docProps\/|xl\/theme\/)/.test(path))))continue;zip.file(path,await file.async('uint8array'));}
  const parser=new DOMParser(),serializer=new XMLSerializer(),types=parser.parseFromString(await zip.file('[Content_Types].xml')!.async('string'),'text/xml'),generatedTypes=parser.parseFromString(await generated.file('[Content_Types].xml')!.async('string'),'text/xml');
  for(const node of Array.from(generatedTypes.documentElement!.childNodes)){if(node.nodeType!==1)continue;const item=node as import('@xmldom/xmldom').Element,key=item.localName==='Override'?'PartName':'Extension',name=item.getAttribute(key);if(!Array.from(types.documentElement!.childNodes).some(existing=>existing.nodeType===1&&(existing as import('@xmldom/xmldom').Element).localName===item.localName&&(existing as import('@xmldom/xmldom').Element).getAttribute(key)===name))types.documentElement!.appendChild(types.importNode(item,true));}
  // Formula caches are invalidated below; a previous calculation chain no
  // longer describes their order after structural changes.
  zip.remove('xl/calcChain.xml');for(const node of Array.from(types.documentElement!.childNodes))if(node.nodeType===1&&(node as import('@xmldom/xmldom').Element).getAttribute('PartName')==='/xl/calcChain.xml')types.documentElement!.removeChild(node);
  zip.file('[Content_Types].xml',serializer.serializeToString(types));return zip.generateAsync({type:'uint8array',compression:'DEFLATE'});
}
function cellFormat(cell: ExcelJS.Cell, op: Extract<EditOperation,{kind:'sheets.setCellFormat'|'sheets.setRangeFormat'}>, range: ReturnType<typeof sheetRange>) {
  // XLSX loading interns identical styles: font/fill/alignment setters mutate
  // the shared cell.style object. Detach the complete nested style before a
  // target edit, preserving border colors, protection, number formats and any
  // other fields instead of changing every cell with the same style index.
  cell.style=structuredClone(cell.style);
  const font={...cell.font};for(const key of ['bold','italic','underline','strike']as const)if(op[key]!==undefined)font[key]=op[key];if(op.fontName){font.name=op.fontName;delete font.scheme;}if(op.fontSize!==undefined)font.size=op.fontSize;if(op.color)font.color={argb:'FF'+op.color.toUpperCase()};cell.font=font;
  cell.alignment={...cell.alignment,...(op.horizontal?{horizontal:op.horizontal}:{}),...(op.vertical?{vertical:op.vertical}:{}),...(op.wrap!==undefined?{wrapText:op.wrap}:{})};if(op.numberFormat!==undefined)cell.numFmt=op.numberFormat;if(op.fill||op.highlight)cell.fill={type:'pattern',pattern:'solid',fgColor:{argb:'FF'+(op.fill??op.highlight)!.toUpperCase()}};
  if(op.borders){if(op.borders==='none')cell.border={};else{const edge={style:op.borderStyle??'thin',color:{argb:'FF'+(op.borderColor??'8D99A3').toUpperCase()}},border={...cell.border};for(const [side,active]of [['top',op.borders==='all'||op.borders==='outline'&&Number(cell.row)===range.start.row],['bottom',op.borders==='all'||(op.borders==='bottom'||op.borders==='outline')&&Number(cell.row)===range.end.row],['left',op.borders==='all'||op.borders==='outline'&&Number(cell.col)===range.start.column],['right',op.borders==='all'||op.borders==='outline'&&Number(cell.col)===range.end.column]]as const)if(active)border[side]=edge;cell.border=border;}}
}
function invalidate(workbook: ExcelJS.Workbook) { workbook.calcProperties.fullCalcOnLoad=true;for(const sheet of workbook.worksheets)sheet.eachRow(row=>row.eachCell(cell=>{if(cell.type===ExcelJS.ValueType.Formula)cell.value={...(cell.value as ExcelJS.CellFormulaValue),result:undefined};})); }

export class SheetAdapter implements FormatAdapter {
  id='exceljs-local-v2';formats:Format[]=['xlsx'];
  capabilities(format:Format):Capabilities{return {engine:this.id,protocolVersion:PROTOCOL_VERSION,readText:true,readSelection:true,readViewport:true,saveFormats:[format],editKinds:['sheets.setCell','sheets.setRangeValues','sheets.setCellFormat','sheets.setRangeFormat','sheets.addWorksheet','sheets.renameWorksheet','sheets.deleteWorksheet','sheets.mergeCells','sheets.unmergeCells','sheets.insertRows','sheets.deleteRows','sheets.insertColumns','sheets.deleteColumns','sheets.setColumnWidth','sheets.setRowHeight','sheets.setFreeze','sheets.setAutoFilter','sheets.sortRange'],limitations:['基础表格编辑保留未涉及的包部件；图表、透视表、外部链接和扩展结构只读，需完整 Office 引擎编辑。','不计算公式；数据变更会清理缓存并要求完整引擎重算。结构修改仅处理常规 A1 引用，拒绝数组/三维/结构化引用及受影响的合并。','排序仅支持未合并且范围内无公式的数据；当前渲染模型最多 1000 行 / 50 列，其他内容保存在文件中。']};}
  async open(bytes:Uint8Array,format:Format):Promise<DocumentModel>{const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(bytes as never);const unsupportedFeatures=await features(bytes);const sheets=workbook.worksheets.map(sheet=>({id:String(sheet.id),name:sheet.name,state:sheet.state,rowCount:sheet.rowCount,columnCount:sheet.columnCount,rowHeights:Array.from({length:Math.min(Math.max(sheet.rowCount,20),1000)},(_,i)=>sheet.getRow(i+1).height??sheet.properties.defaultRowHeight??20),columnWidths:Array.from({length:Math.min(Math.max(sheet.columnCount,8),50)},(_,i)=>sheet.getColumn(i+1).width??sheet.properties.defaultColWidth??13),mergedRanges:mergeNames(sheet),freeze:sheet.views?.[0]?.state==='frozen'?{rows:sheet.views?.[0].ySplit??0,columns:sheet.views?.[0].xSplit??0}:undefined,autoFilter:typeof sheet.autoFilter==='string'?sheet.autoFilter:undefined,rows:Array.from({length:Math.min(Math.max(sheet.rowCount,20),1000)},(_,ri)=>Array.from({length:Math.min(Math.max(sheet.columnCount,8),50)},(_,ci):SheetCell=>{const cell=sheet.getCell(ri+1,ci+1),formula=cell.type===ExcelJS.ValueType.Formula?cell.formula:undefined;return {address:cell.address,value:cell.value===null||cell.value===undefined?"":cell.text,formula,valueType:formula?'formula':cell.value instanceof Date?'date':typeof cell.value,bold:cell.font?.bold,italic:cell.font?.italic,underline:!!cell.font?.underline,strike:cell.font?.strike,fontName:cell.font?.name,fontSize:cell.font?.size,color:cell.font?.color?.argb?.slice(-6),horizontal:cell.alignment?.horizontal,vertical:cell.alignment?.vertical,wrap:cell.alignment?.wrapText,numberFormat:cell.numFmt,fill:cell.fill?.type==='pattern'?cell.fill.fgColor?.argb?.slice(-6):undefined,border:{top:cell.border?.top?.style,bottom:cell.border?.bottom?.style,left:cell.border?.left?.style,right:cell.border?.right?.style}};}))}));return {format,sheets,unsupportedFeatures};}
  preview(model:DocumentModel,op:EditOperation){if(!op.kind.startsWith('sheets.'))return unsupported('此操作不属于 Excel。');if(model.unsupportedFeatures?.length)return unsupported('此文件包含 '+model.unsupportedFeatures.join('、')+'，为避免丢失结构，本地编辑暂不可用。');const warnings=this.capabilities('xlsx').limitations;
    if(op.kind==='sheets.addWorksheet'){assert(!model.sheets?.some(s=>s.name.toLocaleLowerCase()===op.name.toLocaleLowerCase()),'同名工作表已存在。');return {before:'',after:op.name,warnings};}
    assert('sheetId'in op,'缺少工作表。');const sheet=model.sheets?.find(s=>s.id===op.sheetId);assert(sheet,'工作表不存在。');
    if(op.kind==='sheets.renameWorksheet')assert(!model.sheets!.some(s=>s.id!==sheet.id&&s.name.toLocaleLowerCase()===op.name.toLocaleLowerCase()),'同名工作表已存在。');
    else if(op.kind==='sheets.deleteWorksheet'){assert(model.sheets!.length>1,'不能删除最后一个工作表。');assert(model.sheets!.some(s=>s.id!==sheet.id&&s.state!=='hidden'&&s.state!=='veryHidden'),'至少需要保留一个可见工作表。');}
    else if(op.kind==="sheets.setRangeValues"){const first=address(op.start);assert(op.rows.every(row=>row.length===op.rows[0].length)&&op.rows.length*op.rows[0].length<=10000,"批量粘贴要求矩形且最多10000个单元格。");assert(first.row+op.rows.length-1<=1048576&&first.column+op.rows[0].length-1<=16384,"粘贴范围超出Excel。");const area={start:first,end:{row:first.row+op.rows.length-1,column:first.column+op.rows[0].length-1}};assert(!(sheet.mergedRanges??[]).some(value=>overlaps(area,sheetRange(value))),"粘贴范围与合并单元格重叠。");}
    else if(op.kind==='sheets.setCell'){address(op.address);if(op.valueType==='number')assert(op.value.trim()!==''&&Number.isFinite(Number(op.value)),'数值要求有效数字。');if(op.valueType==='boolean')assert(['true','false'].includes(op.value),'布尔值只能为 true 或 false。');}
    else if(op.kind==='sheets.setCellFormat'||op.kind==='sheets.setRangeFormat'){if(op.kind==='sheets.setCellFormat')address(op.address);else sheetRange(op.range);assert(Object.entries(op).some(([key,value])=>!['kind','sheetId','address','range','borderColor','borderStyle'].includes(key)&&value!==undefined),'请选择要更改的格式。');}
    else if(op.kind==='sheets.setAutoFilter'){assert(!op.enabled||op.range,'启用筛选需要范围。');if(op.range)sheetRange(op.range);}
    else if(op.kind==='sheets.mergeCells'||op.kind==='sheets.unmergeCells'||op.kind==='sheets.sortRange'){const range=sheetRange(op.range);if(op.kind==='sheets.mergeCells'){assert(range.start.row!==range.end.row||range.start.column!==range.end.column,'请选择至少两个单元格。');assert(!(sheet.mergedRanges??[]).some(value=>overlaps(range,sheetRange(value))),'范围与现有合并重叠。');}if(op.kind==='sheets.unmergeCells')assert(sheet.mergedRanges?.includes(op.range),'请选择完整的现有合并范围。');if(op.kind==='sheets.sortRange'){assert(op.column>=range.start.column&&op.column<=range.end.column,'排序列不在选区内。');assert(!(sheet.mergedRanges??[]).some(value=>overlaps(range,sheetRange(value))),'合并范围不能排序。');}}
    else if(['sheets.insertRows','sheets.deleteRows','sheets.insertColumns','sheets.deleteColumns'].includes(op.kind)&&'index'in op){const rows=op.kind.endsWith('Rows'),limit=rows?1048576:16384,existing=rows?sheet.rowCount??sheet.rows.length:sheet.columnCount??sheet.rows[0]?.length??0,count='count'in op?op.count:1;assert(op.index<=limit&&op.index+(count??1)-1<=limit,'行列范围超出 Excel。');if(op.kind.includes('delete'))assert(op.index+(count??1)-1<=existing,'删除范围超出现有行列。');else assert(existing+(count??1)<=limit,'插入会超出 Excel 范围。');if((sheet.mergedRanges??[]).some(value=>op.index<=(rows?sheetRange(value).end.row:sheetRange(value).end.column)))return unsupported('结构编辑会移动合并区域，请先解除合并。');}
    return {before:sheet.name,after:JSON.stringify(op),warnings};
  }
  async apply(bytes:Uint8Array,model:DocumentModel,op:EditOperation){const preview=this.preview(model,op),actualFeatures=await features(bytes);if(actualFeatures.length)return unsupported('复杂工作簿只能由完整引擎编辑：'+actualFeatures.join('、'));const workbook=new ExcelJS.Workbook();await workbook.xlsx.load(bytes as never);
    if(op.kind==='sheets.addWorksheet')workbook.addWorksheet(op.name);
    else{assert('sheetId'in op,'缺少工作表。');const sheet=workbook.getWorksheet(Number(op.sheetId));assert(sheet,'工作表不存在。');
      if(op.kind==="sheets.setRangeValues"){const start=address(op.start),area={start,end:{row:start.row+op.rows.length-1,column:start.column+op.rows[0].length-1}};assert(!mergeNames(sheet).some(value=>overlaps(area,sheetRange(value))),"粘贴范围与合并单元格重叠。");op.rows.forEach((row,ri)=>row.forEach((text,ci)=>{sheet.getCell(start.row+ri,start.column+ci).value=text.startsWith("=")&&text.length>1?{formula:text.slice(1)}:text;}));invalidate(workbook);}
      else if(op.kind==='sheets.setCell'){const cell=sheet.getCell(op.address);if(op.formula)cell.value={formula:op.formula};else if(op.valueType==='number')cell.value=Number(op.value);else if(op.valueType==='boolean')cell.value=op.value==='true';else cell.value=op.value;invalidate(workbook);}
      else if(op.kind==='sheets.setCellFormat'||op.kind==='sheets.setRangeFormat'){const range=sheetRange(op.kind==='sheets.setCellFormat'?op.address:op.range);for(let row=range.start.row;row<=range.end.row;row++)for(let column=range.start.column;column<=range.end.column;column++)cellFormat(sheet.getCell(row,column),op,range);}
      else if(op.kind==='sheets.renameWorksheet'){const previous=sheet.name;for(const item of workbook.worksheets)item.eachRow(row=>row.eachCell(cell=>{if(cell.type===ExcelJS.ValueType.Formula)cell.value={...(cell.value as ExcelJS.CellFormulaValue),formula:renameFormula(cell.formula,previous,op.name)};}));workbook.definedNames.model=workbook.definedNames.model.map(name=>({...name,ranges:name.ranges.map(range=>renameFormula(range,previous,op.name))}));sheet.name=op.name;invalidate(workbook);}
      else if(op.kind==='sheets.deleteWorksheet'){assert(workbook.worksheets.length>1&&workbook.worksheets.some(item=>item!==sheet&&item.state==="visible"),"至少保留一个可见工作表。");const name=sheet.name;assert(!workbook.definedNames.model.some(item=>item.ranges.some(range=>formulaReferencesSheet(range,name))),"命名范围正在引用该表，请先解除引用。");for(const item of workbook.worksheets)if(item!==sheet)item.eachRow(row=>row.eachCell(cell=>{if(cell.type===ExcelJS.ValueType.Formula&&formulaReferencesSheet(cell.formula,name))unsupported('其他工作表公式正在引用该表，请先解除引用。');}));workbook.removeWorksheet(sheet.id);}
      else if(op.kind==='sheets.mergeCells'){const range=sheetRange(op.range);for(let row=range.start.row;row<=range.end.row;row++)for(let column=range.start.column;column<=range.end.column;column++)if(row!==range.start.row||column!==range.start.column)assert(sheet.getCell(row,column).value===null||sheet.getCell(row,column).value==='','合并会丢失其他单元格内容；请先清空或移出。');sheet.mergeCells(op.range);}
      else if(op.kind==='sheets.unmergeCells')sheet.unMergeCells(op.range);
      else if(op.kind==='sheets.setColumnWidth')sheet.getColumn(op.index).width=op.width;
      else if(op.kind==='sheets.setRowHeight')sheet.getRow(op.index).height=op.height;
      else if(op.kind==='sheets.setFreeze')sheet.views=[{...sheet.views?.[0],state:op.rows||op.columns?'frozen':'normal',xSplit:op.columns,ySplit:op.rows} as ExcelJS.WorksheetView];
      else if(op.kind==='sheets.setAutoFilter')sheet.autoFilter=op.enabled?op.range!:undefined as never;
      else if(op.kind==='sheets.sortRange'){const range=sheetRange(op.range);assert(!mergeNames(sheet).some(value=>overlaps(range,sheetRange(value))),"合并范围不能排序。");const start=range.start.row+(op.header?1:0),records=[];for(let row=start;row<=range.end.row;row++){const cells=[];for(let column=range.start.column;column<=range.end.column;column++){const cell=sheet.getCell(row,column);assert(cell.type!==ExcelJS.ValueType.Formula,'公式范围暂不支持排序。');cells.push({value:structuredClone(cell.value),style:structuredClone(cell.style)});}records.push({cells,key:sheet.getCell(row,op.column).value,order:row});}const sign=op.direction==='asc'?1:-1;records.sort((a,b)=>{const compared=typeof a.key==='number'&&typeof b.key==='number'?a.key-b.key:String(a.key??'').localeCompare(String(b.key??''),'zh-CN',{numeric:true});return sign*compared||a.order-b.order;});records.forEach((record,index)=>record.cells.forEach((data,column)=>{const cell=sheet.getCell(start+index,range.start.column+column);cell.value=data.value;cell.style=data.style;}));invalidate(workbook);}
      else if(['sheets.insertRows','sheets.deleteRows','sheets.insertColumns','sheets.deleteColumns'].includes(op.kind)&&'index'in op&&'count'in op){const rows=op.kind.endsWith('Rows'),deleting=op.kind.includes('delete'),count=op.count??1;assert(!mergeNames(sheet).some(value=>op.index<=(rows?sheetRange(value).end.row:sheetRange(value).end.column)),"结构编辑会移动合并区域，请先解除合并。");if(deleting)assert(op.index+count-1<=(rows?sheet.rowCount:sheet.columnCount),"删除范围超出现有行列。");for(const item of workbook.worksheets)item.eachRow(row=>row.eachCell(cell=>{if(cell.type!==ExcelJS.ValueType.Formula)return;const stored=cell.value as ExcelJS.CellFormulaValue & {shareType?:string};assert(stored.shareType!=='array'&&!formulaUnsupported(cell.formula),'数组、三维、整行/列或结构化公式不支持行列移动。');cell.value={formula:cell.formula};}));const filter=typeof sheet.autoFilter==='string'?sheet.autoFilter:undefined;if(rows){if(deleting)sheet.spliceRows(op.index,count);else sheet.spliceRows(op.index,0,...Array.from({length:count},()=>[]));}else{if(deleting)sheet.spliceColumns(op.index,count);else sheet.spliceColumns(op.index,0,...Array.from({length:count},()=>[]));}for(const item of workbook.worksheets)item.eachRow(row=>row.eachCell(cell=>{if(cell.type===ExcelJS.ValueType.Formula)cell.value={formula:shiftSheetFormula(cell.formula,item.name,sheet.name,rows?'row':'column',op.index,count,deleting)};}));if(filter){const next=shiftSheetFormula(filter,sheet.name,sheet.name,rows?'row':'column',op.index,count,deleting);sheet.autoFilter=next.includes('#REF!')?undefined as never:next;}invalidate(workbook);}
      else return unsupported('此 Excel 操作尚未接入。');
    }
    const output=await savePackage(bytes,workbook);return {bytes:output,model:await this.open(output,'xlsx'),warnings:preview.warnings};
  }
}
