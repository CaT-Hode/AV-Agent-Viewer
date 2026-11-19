/** Carry an incomplete needle and its snippet across stream chunks. Columns use UTF-16, like the editor. */
export async function* workspaceMatches(chunks:AsyncIterable<string>|Iterable<string>,query:string,caseSensitive:boolean,cancelled:()=>boolean){
  if(!query)return;
  const escaped=query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const regex=new RegExp(escaped,caseSensitive?'gu':'giu');
  let line=1,column=0,buffer='',next=0;
  function* scan(end:boolean){
    const limit=end?buffer.length:Math.max(0,buffer.length-query.length-60);
    regex.lastIndex=next;let m:RegExpExecArray|null;
    while((m=regex.exec(buffer))&&m.index<limit){
      const from=m.index,to=from+m[0].length;next=to;
      yield {line,column:column+from+1,length:m[0].length,preview:buffer.slice(Math.max(0,from-36),to+60).replace(/\r$/,'')};
    }
    next=Math.max(next,limit);
    if(end){buffer='';column=0;next=0;line++;}
    else {const drop=Math.max(0,next-36);column+=drop;buffer=buffer.slice(drop);next-=drop;}
  }
  for await(const chunk of chunks){if(cancelled())return;const parts=chunk.split('\n');for(let i=0;i<parts.length;i++){
    buffer+=parts[i];yield* scan(i<parts.length-1);
  }}
  yield* scan(true);
}
