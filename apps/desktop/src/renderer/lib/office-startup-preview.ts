import type { DocumentInfo, DocumentModel, OfficeTextStyle, Sheet, SheetCell, Slide, TextBlock } from '../../../../../packages/contracts/src/index';

export const OFFICE_PREVIEW_WORD_BLOCKS = 48;
export const OFFICE_PREVIEW_TEXT_LIMIT = 48000;
export const OFFICE_PREVIEW_CELL_LIMIT = 2000;
const text = (value: unknown) => typeof value === 'string' ? value : '';
const positive = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
const index = (value: number, fallback = 0) => Number.isSafeInteger(value) && value >= 0 ? value : fallback;

/** This identity belongs to source preview data, never native layout/selection. */
export function officePreviewScope(document: Pick<DocumentInfo, 'id' | 'format' | 'revision'>, viewId: string, sourceRevision = document.revision) {
  return { documentId: document.id, viewId, format: document.format, sourceRevision, key: JSON.stringify([document.id,viewId,document.format,sourceRevision]) };
}
export type WordPreviewItem = { kind: 'paragraph'; block: TextBlock; text: string; sourceIndex: number; truncated: boolean } | { kind: 'table'; id: string; rows: { index: number; cells: { index: number; blocks: Extract<WordPreviewItem,{kind:'paragraph'}>[] }[] }[]; partial: boolean };

/** Reading pages use a bounded source window; no full-book grouping/render pass. */
export function wordPreviewWindow(model: DocumentModel, start = 0) {
  const source = model.blocks ?? [], from = Math.min(index(start),Math.max(0,source.length-1)), stop = Math.min(source.length,from+OFFICE_PREVIEW_WORD_BLOCKS);
  const items: WordPreviewItem[] = [];let remaining = OFFICE_PREVIEW_TEXT_LIMIT, next = from, clipped = false;
  for (;next<stop && remaining>0;next++) {
    const block=source[next], original=text(block.text), value=original.slice(0,remaining), paragraph: Extract<WordPreviewItem,{kind:'paragraph'}> = {kind:'paragraph',block,text:value,sourceIndex:next,truncated:value.length!==original.length};remaining-=value.length;clipped ||= paragraph.truncated;
    if (!block.tableId || !Number.isSafeInteger(block.tableRow) || block.tableRow!<0 || !Number.isSafeInteger(block.tableColumn) || block.tableColumn!<0) { items.push(paragraph);continue; }
    let table=items.at(-1);
    if (!table || table.kind!=='table' || table.id!==block.tableId) { table={kind:'table',id:block.tableId,rows:[],partial:source[next-1]?.tableId===block.tableId};items.push(table); }
    let row=table.rows.find(row=>row.index===block.tableRow);if(!row){row={index:block.tableRow!,cells:[]};table.rows.push(row);}
    let cell=row.cells.find(cell=>cell.index===block.tableColumn);if(!cell){cell={index:block.tableColumn!,blocks:[]};row.cells.push(cell);}cell.blocks.push(paragraph);
  }
  for(const item of items)if(item.kind==='table'){item.rows.sort((a,b)=>a.index-b.index);for(const row of item.rows)row.cells.sort((a,b)=>a.index-b.index);item.partial ||= source[next]?.tableId===item.id;}
  return { items, from, next, total:source.length, hasPrevious:from>0, hasNext:next<source.length, clipped };
}

export function previewHex(value: unknown) { return typeof value==='string' && /^[a-f\d]{6}$/i.test(value) ? '#'+value : undefined; }
export function previewTextStyle(source: OfficeTextStyle) {
  return { fontFamily: typeof source.fontName==='string' ? source.fontName.slice(0,100).replace(/[;{}\r\n]/g,'') : undefined, fontSize: positive(source.fontSize) ? Math.min(160,source.fontSize!*4/3) : undefined, fontWeight:source.bold?700:undefined,fontStyle:source.italic?'italic':undefined,textDecoration:[source.underline?'underline':'',source.strike?'line-through':''].filter(Boolean).join(' ')||undefined,color:previewHex(source.color),backgroundColor:previewHex(source.highlight) };
}
export function previewInlineRuns(block: TextBlock, renderedText: string) {
  if(!block.runs?.length || block.runs.length>96 || renderedText!==text(block.text) || block.runs.some(run=>typeof run.text!=='string') || block.runs.reduce((n,run)=>n+run.text.length,0)>OFFICE_PREVIEW_TEXT_LIMIT || block.runs.map(run=>run.text).join('')!==renderedText)return undefined;
  return block.runs;
}
export function previewWordPage(model: DocumentModel) {
  const source=model.pageLayout,width=Math.min(2400,Math.max(320,(positive(source?.width)??595.3)*4/3)),height=Math.min(3200,Math.max(400,(positive(source?.height)??841.9)*4/3));
  const margin=(value:unknown,limit:number)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?Math.min(limit,value*4/3):64;
  return {width,height,padding:`${margin(source?.margins?.top,height/3)}px ${margin(source?.margins?.right,width/3)}px ${margin(source?.margins?.bottom,height/3)}px ${margin(source?.margins?.left,width/3)}px`};
}
export function slidePreview(model: DocumentModel, requested=0): { slide?: Slide; index:number; count:number; ratio?:number } {
  const source=model.slides??[], selected=Math.min(index(requested),Math.max(0,source.length-1)),width=positive(model.width),height=positive(model.height);
  const ratio=width&&height?width/height:undefined;
  return {slide:source[selected],index:selected,count:source.length,ratio:ratio&&Number.isFinite(ratio)?ratio:undefined};
}
export function slidePreviewBlocks(slide?: Slide) { const items:{block:TextBlock;value:string}[]=[];let remaining=OFFICE_PREVIEW_TEXT_LIMIT;for(const block of slide?.blocks?.slice(0,128)??[]){if(!remaining)break;const value=text(block.text).slice(0,Math.min(12000,remaining));remaining-=value.length;items.push({block,value});}return items; }
export function previewShapeBounds(block: TextBlock) {
  const values=[block.x,block.y,block.width,block.height];
  if(!values.every(value=>typeof value==='number'&&Number.isFinite(value)) || block.width!<=0 || block.height!<=0 || block.x! < -2 || block.y! < -2 || block.x! > 3 || block.y! > 3 || block.width!>4 || block.height!>4)return undefined;
  return {left:block.x!*100+'%',top:block.y!*100+'%',width:block.width!*100+'%',height:block.height!*100+'%'};
}
export function sheetPreview(model: DocumentModel,requested=0) {
  const sheets=model.sheets??[], chosen=sheets[index(requested)],sheet=chosen&& !['hidden','veryHidden'].includes(chosen.state??'')?chosen:sheets.find(sheet=>!['hidden','veryHidden'].includes(sheet.state??''));
  return {sheet,index:sheet?sheets.indexOf(sheet):0,count:sheets.length};
}
export function previewCellText(cell?: SheetCell) { const cached=text(cell?.value);return cached|| (typeof cell?.formula==='string'&&cell.formula ? (cell.formula.startsWith('=')?'':'=')+cell.formula : ''); }
export function previewColumnName(column: number) { let n=index(column)+1,result='';while(n){n--;result=String.fromCharCode(65+n%26)+result;n=Math.floor(n/26);}return result; }
export type SheetPreviewGeometry = { rows:number;columns:number;rowOffsets:number[];columnOffsets:number[];width:number;height:number;partial:boolean };
export function sheetPreviewGeometry(sheet?: Sheet): SheetPreviewGeometry {
  const source=sheet?.rows??[],rows=Math.min(source.length,1000,typeof sheet?.rowCount==='number'?index(sheet.rowCount):source.length),availableColumns=source.slice(0,rows).reduce((count,row)=>Math.max(count,row.length),0),columns=Math.min(availableColumns,50,typeof sheet?.columnCount==='number'?index(sheet.columnCount):availableColumns);
  const rowOffsets=[0],columnOffsets=[0];
  for(let row=0;row<rows;row++)rowOffsets.push(rowOffsets[row]+Math.min(96,Math.max(22,(positive(sheet?.rowHeights?.[row])??21)*4/3)));
  for(let column=0;column<columns;column++)columnOffsets.push(columnOffsets[column]+Math.min(360,Math.max(48,(positive(sheet?.columnWidths?.[column])??13)*7+12)));
  return {rows,columns,rowOffsets,columnOffsets,width:columnOffsets.at(-1)!,height:rowOffsets.at(-1)!,partial:(sheet?.rowCount??rows)>rows||(sheet?.columnCount??columns)>columns};
}
function offsetIndex(offsets:number[],position:number) { let low=0,high=Math.max(0,offsets.length-2);while(low<high){const middle=Math.floor((low+high+1)/2);if(offsets[middle]<=position)low=middle;else high=middle-1;}return low; }
/** Only visible source cells and small overscan become DOM nodes. */
export function sheetPreviewWindow(geometry: SheetPreviewGeometry, viewport: {x:number;y:number;width:number;height:number}) {
  const coordinate=(value:number)=>Number.isFinite(value)?Math.max(0,value):0;
  const row=Math.max(0,offsetIndex(geometry.rowOffsets,coordinate(viewport.y))-2),column=Math.max(0,offsetIndex(geometry.columnOffsets,coordinate(viewport.x))-1);
  return {rowStart:row,rowEnd:Math.min(geometry.rows,row+48,offsetIndex(geometry.rowOffsets,coordinate(viewport.y)+coordinate(viewport.height))+4),columnStart:column,columnEnd:Math.min(geometry.columns,column+18,offsetIndex(geometry.columnOffsets,coordinate(viewport.x)+coordinate(viewport.width))+3)};
}
