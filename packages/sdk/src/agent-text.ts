import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { parse } from 'parse5';
import { markdownTransform } from '../../markdown/src/commands';
import { ViewerError } from '../../contracts/src/index';

export interface SourceBlock {from:number;to:number;kind:string;level?:number;tag?:string;contentFrom?:number;contentTo?:number;text?:string}
type HtmlNode={tagName?:string;value?:string;attrs?:{name:string;value:string}[];childNodes?:HtmlNode[];sourceCodeLocation?:{startOffset:number;endOffset:number;startTag?:{endOffset:number};endTag?:{startOffset:number}}};
export function sourceBlocks(source:string,format:'markdown'|'html'):SourceBlock[] {
  if(format==='markdown')return fromMarkdown(source,{extensions:[gfm()],mdastExtensions:[gfmFromMarkdown()]}).children.flatMap(node=>node.position?.start.offset!==undefined&&node.position?.end.offset!==undefined?[{from:node.position.start.offset,to:node.position.end.offset,kind:node.type,...('depth' in node?{level:Number(node.depth)}:{})}]:[]);
  const result:SourceBlock[]=[];
  const excluded=new Set(['script','style','head','template','noscript','input','textarea','select','option']);
  const preview=(node:HtmlNode,depth=0):string=>{
    if(depth>128||excluded.has(node.tagName??''))return '';
    if(node.value!==undefined)return node.value.slice(0,240);
    let text='';for(const child of node.childNodes??[]){text+=preview(child,depth+1);if(text.length>=240)break;}return text.slice(0,240);
  };
  const visit=(node:HtmlNode)=>{
    if(excluded.has(node.tagName??''))return;
    const location=node.sourceCodeLocation;
    if(node.tagName&&location)result.push({from:location.startOffset,to:location.endOffset,kind:'element',tag:node.tagName,contentFrom:location.startTag?.endOffset,contentTo:location.endTag?.startOffset,text:preview(node)});
    for(const child of node.childNodes??[])visit(child);
  };
  visit(parse(source,{sourceCodeLocationInfo:true}) as HtmlNode);return result;
}
export const escapeHtml=(text:string)=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function inlineMarkdown(source:string,from:number,to:number,style:string,enabled:boolean) {
  const marker=({bold:'**',italic:'*',strike:'~~',code:'`',highlight:'=='} as Record<string,string>)[style];
  if(!marker)throw new ViewerError('INVALID_ARGUMENT','不支持的行内格式。');
  const selected=source.slice(from,to);
  if(enabled) {
    if(source.slice(Math.max(0,from-marker.length),from)===marker&&source.slice(to,to+marker.length)===marker)return {from,to,text:selected};
    return {from,to,text:marker+selected+marker};
  }
  if(selected.startsWith(marker)&&selected.endsWith(marker)&&selected.length>=marker.length*2)return {from,to,text:selected.slice(marker.length,-marker.length)};
  if(source.slice(Math.max(0,from-marker.length),from)===marker&&source.slice(to,to+marker.length)===marker)return {from:from-marker.length,to:to+marker.length,text:selected};
  return {from,to,text:selected};
}
export function tableMarkdown(rows:string[][]) {
  if(!rows.length||rows.some(row=>row.length!==rows[0].length))throw new ViewerError('INVALID_ARGUMENT','表格必须是非空矩形。');
  const cell=(value:string)=>value.replaceAll('\\','\\\\').replaceAll('|','\\|').replace(/\r?\n/g,'<br>');
  const lines=rows.map(row=>'| '+row.map(cell).join(' | ')+' |');lines.splice(1,0,'| '+rows[0].map(()=>'---').join(' | ')+' |');return lines.join('\n');
}
export function markdownStructure(source:string,from:number,to:number,action:string,value?:unknown) {
  if(action==='yaml'){
    if(from!==0&&!(from===1&&source.charCodeAt(0)===0xfeff))throw new ViewerError('INVALID_TARGET','YAML需要文档首块引用。');
    return markdownTransform(source,from,to,'frontmatter',value);
  }
  if(['list','task','quote'].includes(action)){
    const start=from===0?0:source.lastIndexOf('\n',from-1)+1,lineEnd=source.indexOf('\n',Math.max(from,to-1)),end=lineEnd<0?source.length:lineEnd>0&&source[lineEnd-1]==='\r'?lineEnd-1:lineEnd,eol=source.includes('\r\n')?'\r\n':'\n';let number=0;
    const text=source.slice(start,end).split(/\r?\n/).map(line=>{
      if(!line.trim())return line;
      if(action==='quote')return /^ {0,3}>[ \t]?/.test(line)?line:'> '+line;
      const indent=/^[ \t]*/.exec(line)![0],body=line.slice(indent.length),prior=/^(?:[-+*]|\d+[.)])[ \t]+(?:\[([ xX])\][ \t]+)?/.exec(body),content=prior?body.slice(prior[0].length):body;
      return indent+(action==='task'?'- ['+(typeof value==='boolean'?(value?'x':' '):prior?.[1]?.toLowerCase()==='x'?'x':' ')+'] ':value===true?++number+'. ':'- ')+content;
    }).join(eol);
    return {from:start,to:end,text};
  }
  if(action==='code'&&/^\s*(`{3,}|~{3,})[^\r\n]*\r?\n/.test(source.slice(from,to))){
    return value===undefined?{from,to,text:source.slice(from,to)}:markdownTransform(source,from,to,'codeLanguage',value);
  }
  const command=action==='heading'?'heading'+(typeof value==='number'?value:1):({code:'codeBlock'} as Record<string,string>)[action];
  if(action==='delete')return {from,to,text:''};
  if(!command)throw new ViewerError('INVALID_ARGUMENT','未知结构操作。');
  return markdownTransform(source,from,to,command as Parameters<typeof markdownTransform>[3],value);
}
