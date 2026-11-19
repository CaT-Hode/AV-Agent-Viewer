import type {DocumentInfo, ViewInfo} from '../../../../../packages/contracts/src/index';

const slidePreviews = new Map<string,string>();
export function tabSlideKey(viewId:string,epoch:string,revision:number,index:number) {
  return JSON.stringify([viewId,epoch,revision,index]);
}
export function rememberTabSlide(key:string,image:string) {
  slidePreviews.delete(key);
  slidePreviews.set(key,image);
  if(slidePreviews.size>8) slidePreviews.delete(slidePreviews.keys().next().value!);
}
export function readTabSlide(key?:string) {return key ? slidePreviews.get(key) : undefined;}
export function tabPreview(document:DocumentInfo, view:ViewInfo) {
  const context=view.context, location=context?.locator, page=location?.pageIndex;
  const native=document.nativeOffice;
  let detail='';
  if(document.format==='xlsx') detail=[context?.nativeOffice?.sheetName ?? document.model.sheets?.find(sheet=>sheet.id===location?.sheetId)?.name,context?.nativeOffice?.range ?? location?.cell].filter(Boolean).join(' · ');
  else if(page!==undefined) detail=(document.format==='pptx'?'幻灯片 ':'第 ')+(page+1)+(document.format==='pptx'?'':' 页');
  else if(location?.quote) detail=location.quote.slice(0,72);
  return {detail:detail || ({docx:'Word 文档',xlsx:'Excel 工作簿',pptx:'PowerPoint 演示文稿',pdf:'PDF 文档',markdown:'Markdown 文档',web:'网页',html:'HTML 文档'}[document.format]),slideKey:document.format==='pptx' && native && page!==undefined ? tabSlideKey(view.id,native.engineEpoch,native.engineRevision,page) : undefined};
}
