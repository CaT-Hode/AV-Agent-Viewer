/** Trusted code inserted after sanitization; never executes source document scripts. */
export function htmlNavigationScript() {
  return `let htmlNavigationSequence=0;const navigateHtml=request=>{
    if(request?.type!=='agentviewer-html-navigate')return;
    if(!Number.isInteger(request.index)||request.index<0||request.index>10000||typeof request.title!=='string'||request.title.length>10000)return;
    const sequence=++htmlNavigationSequence;
    const reset=()=>{readingActor='human';readingBlockId=undefined;readingQuote=undefined;};reset();
    const fail=message=>{reset();postReadingMessage({type:'agentviewer-html-navigation-error',requestId:request.requestId,message});};
    const text=node=>['HEAD','SCRIPT','STYLE','TEMPLATE','NOSCRIPT'].includes(node.nodeName)?'':node.nodeType===3?node.textContent??'':node.nodeName==='BR'?' ':Array.from(node.childNodes??[]).map(text).join('');
    const title=node=>text(node).replace(/\\s+/g,' ').trim();
    const headings=Array.from(document.body.querySelectorAll('h1,h2,h3,h4,h5,h6')).filter(node=>title(node));
    const target=headings[request.index];
    if(!target||title(target)!==request.title){fail('HTML 标题已变化，请刷新目录后重试。');return;}
    for(let ancestor=target.parentElement;ancestor;ancestor=ancestor.parentElement)if(ancestor.tagName==='DETAILS')ancestor.open=true;
    getSelection()?.removeAllRanges();
    target.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'});
    requestAnimationFrame(()=>{
      if(sequence!==htmlNavigationSequence)return;
      const rect=target.getBoundingClientRect(),style=getComputedStyle(target);
      if(rect.bottom<=rect.top||rect.right<=rect.left||rect.bottom<=0||rect.right<=0||rect.top>=innerHeight||rect.left>=innerWidth||style.display==='none'||['hidden','collapse'].includes(style.visibility)||style.opacity==='0'||typeof target.checkVisibility==='function'&&!target.checkVisibility({opacityProperty:true,visibilityProperty:true})){fail('HTML 标题未在当前视口中呈现，未完成跳转。');return;}
      readingActor=request.actor==='agent'?'agent':'human';readingBlockId=request.blockId;readingQuote=title(target);send(request);
    });
  };`;
}
