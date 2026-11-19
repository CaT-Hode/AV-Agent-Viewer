/** Shared by the sandboxed HTML reader and the isolated world of the active web page. */
export const installReaderFind = String.raw`(() => {
  let token, ranges = [];
  function clear() { ranges=[]; CSS.highlights.delete('av-reader-current'); }
  return args => {
    if(args.action==='clear'){if(args.token===token)clear();return {};}
    if(args.action==='reveal'){
      const found=ranges[args.index];
      if(token!==args.token||!found||!found.range.startContainer.isConnected||found.range.toString()!==found.match)throw Error('页面内容已变化，请重新查找。');
      found.range.startContainer.parentElement.scrollIntoView({block:'nearest',inline:'nearest'});
      const next=found.range.getBoundingClientRect();
      if(next.top<0||next.bottom>innerHeight)scrollBy(0,next.top-innerHeight*.4);
      CSS.highlights.set('av-reader-current',new Highlight(found.range));return {};
    }
    clear();token=args.token;
    if(!document.getElementById('av-reader-find-colors')){const style=document.createElement('style');style.id='av-reader-find-colors';style.textContent='::highlight(av-reader-current){background:#ffca51;color:#332600}';(document.head||document.documentElement).append(style);}
    const pattern=new RegExp(args.text.replace(/[.*+?^{}$()|[\]\\]/g,'\\$&'),args.caseSensitive?'gu':'giu');
    const hits=[],walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);let node,block,parts=[],text='',limited=false;
    const flush=()=>{for(const m of text.matchAll(pattern)){
      if(hits.length>=500){limited=true;break;}
      const a=m.index,b=a+m[0].length,start=parts.find(p=>a<p.end),end=parts.find(p=>b<=p.end);
      if(!start||!end)continue;const range=document.createRange();range.setStart(start.node,a-start.start);range.setEnd(end.node,b-end.start);
      ranges.push({range,match:m[0]});hits.push({label:document.title||'页面正文',before:text.slice(Math.max(0,a-36),a),match:m[0].slice(0,120),after:text.slice(b,b+60)});
    }parts=[];text='';};
    while(!limited&&(node=walker.nextNode())){const parent=node.parentElement;if(!parent||!node.length||parent.closest('script,style,template,noscript,[hidden],textarea,select')||!parent.checkVisibility({visibilityProperty:true}))continue;
      const next=parent.closest('p,li,td,th,section,article,div,h1,h2,h3,h4,h5,h6,pre,blockquote,body');
      if(next!==block){flush();block=next;}parts.push({node,start:text.length,end:text.length+node.length});text+=node.data;
    }if(!limited)flush();return {hits,limited};
  }
})()`;
