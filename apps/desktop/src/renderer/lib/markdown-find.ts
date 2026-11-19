import { EditorView } from '@codemirror/view';
import { Transaction } from '@codemirror/state';
import { isolateHistory } from '@codemirror/commands';
import { findPattern, registerFind, snippet } from './reader-find';

export function registerTextFind(viewId:string, view:EditorView, composing:()=>boolean) {
  return registerFind(viewId,options=>{
    const doc=view.state.doc, source=doc.toString(), regex=findPattern(options);
    const matches:RegExpExecArray[]=[];
    for(const match of source.matchAll(regex)){matches.push(match);if(matches.length>500)break;}
    const limited=matches.length>500;if(limited)matches.pop();
    const check=()=>{if(view.state.doc!==doc)throw new Error('正文已更改，请使用最新结果。');};
    return {limited,hits:matches.map(m=>snippet(source,m.index,m.index+m[0].length,'第 '+doc.lineAt(m.index).number+' 行')),
      reveal(i){check();const m=matches[i];if(!m)return;
        const selection={anchor:m.index,head:m.index+m[0].length};
        view.dispatch({selection,effects:EditorView.scrollIntoView(selection.anchor,{y:'center'}),annotations:Transaction.addToHistory.of(false)});
        const preview=document.querySelector<HTMLElement>('[data-markdown-preview="'+CSS.escape(viewId)+'"] .cm-editor');
        const other=preview&&EditorView.findFromDOM(preview);
        if(other&&other.state.doc.eq(doc))other.dispatch({selection,effects:EditorView.scrollIntoView(selection.anchor,{y:'center'})});
      },
      replace(index,value){check();if(composing()||view.composing)throw new Error('请先完成输入法组字。');
        const selected=index==='all'?source.matchAll(regex):[matches[index]].filter(Boolean);
        const changes=Array.from(selected,m=>({from:m.index,to:m.index+m[0].length,insert:options.regexp?value.replace(/\$(\$|&|\d{1,2}|<[^>]+>)/g,(raw,key:string)=>key==='$'?'$':key==='&'?m[0]:key[0]==='<'?(m.groups?.[key.slice(1,-1)]??''):Number(key)>0&&Number(key)<m.length?(m[Number(key)]??''):raw):value}));
        if(changes.length)view.dispatch({changes,annotations:[Transaction.userEvent.of('input.replace'),isolateHistory.of('full')]});
      }
    };
  });
}
