type CanvasBacking = { width:number; height:number; readonly isConnected:boolean };

/** Release the backing only after React has really detached the old DOM node.
 * A hidden/minimized/obscured view keeps its pixels. The microtask also allows
 * StrictMode or a ref handoff to reattach the same node without clearing it. */
export function createOfficeCanvasBinding<T extends CanvasBacking>(reference:{current:T|null}) {
  return (node:T|null)=>{
    const previous=reference.current;reference.current=node;
    if(!previous||previous===node)return;
    queueMicrotask(()=>{
      if(reference.current===previous||previous.isConnected)return;
      previous.width=1;previous.height=1;
    });
  };
}
