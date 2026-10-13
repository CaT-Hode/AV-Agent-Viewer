export const readContextScript = `(() => {
  const selection = window.getSelection();
  const visibility=new WeakMap();
  const isPainted=element=>{
    if(visibility.has(element))return visibility.get(element);
    const style=getComputedStyle(element);let shown=style.display!=='none'&&!['hidden','collapse'].includes(style.visibility);
    if(shown&&element instanceof HTMLElement&&typeof element.checkVisibility==='function')shown=element.checkVisibility({opacityProperty:true,visibilityProperty:true,contentVisibilityAuto:true});
    else if(shown)for(let p=element;p;p=p.parentElement){
      const s=getComputedStyle(p);if(s.display==='none'||Number(s.opacity)===0){shown=false;break;}
      if(p.tagName==='DETAILS'&&!p.open){const summary=[...p.children].find(child=>child.tagName==='SUMMARY');if(!summary?.contains(element)){shown=false;break;}}
    }
    visibility.set(element,shown);return shown;
  };
  const walker=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT), visible=[];
  let node, visited=0;
  while((node=walker.nextNode()) && visited++<20000){
    const parent=node.parentElement, value=node.textContent?.trim();
    if(!parent||!value||['SCRIPT','STYLE','NOSCRIPT','TEMPLATE'].includes(parent.tagName))continue;
    if(!isPainted(parent))continue;
    const range=document.createRange();range.selectNodeContents(node);
    const shown=[...range.getClientRects()].some(r=>{
      let left=Math.max(0,r.left),right=Math.min(innerWidth,r.right),top=Math.max(0,r.top),bottom=Math.min(innerHeight,r.bottom);
      for(let p=parent;p&&p!==document.body;p=p.parentElement){const s=getComputedStyle(p),b=p.getBoundingClientRect();if(/auto|scroll|hidden|clip/.test(s.overflowX)){left=Math.max(left,b.left);right=Math.min(right,b.right)}if(/auto|scroll|hidden|clip/.test(s.overflowY)){top=Math.max(top,b.top);bottom=Math.min(bottom,b.bottom)}}
      return right>left&&bottom>top;
    });if(shown)visible.push(value);
  }
  for(const input of document.querySelectorAll('input,textarea')){if(input.type==='password'||input.type==='hidden'||/current-password|new-password|one-time-code|cc-/.test(input.autocomplete||'')||!isPainted(input))continue;const r=input.getBoundingClientRect();if(r.bottom>0&&r.top<innerHeight&&r.right>0&&r.left<innerWidth&&input.value)visible.push(input.value)}
  const text = visible.join('\\n').slice(0,24000);
  const heading = [...document.querySelectorAll('h1,h2,h3')].filter(n=>isPainted(n)&&n.getBoundingClientRect().height>0&&n.getBoundingClientRect().top<=innerHeight/2).at(-1)?.textContent || document.title;
  const box=selection?.rangeCount?selection.getRangeAt(0).getBoundingClientRect():null; const selectionRect=box?{x:box.x,y:box.y,width:box.width,height:box.height}:undefined;
  return { selectionRect, title: document.title, url: location.href, heading, visibleText:text, selection:selection?.toString()||'', width:innerWidth, height:innerHeight, scrollX, scrollY, deviceScaleFactor:devicePixelRatio, frameCount:document.querySelectorAll('iframe,frame').length };
})()`;
