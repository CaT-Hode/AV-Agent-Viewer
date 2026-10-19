import { ViewerError, type HarnessDriver, type ReadingSnapshot } from '../../contracts/src/index';

/** A read-only model call may stop local waiting even if its provider ignores
 * AbortSignal. Never apply this boundary to an already dispatched mutation. */
export class AgentAnalysisWait {
  private readonly controller=new AbortController();
  private readonly stopped:Promise<never>;
  private reject!:(reason:unknown)=>void;
  private readonly timer:ReturnType<typeof setTimeout>;
  private closed=false;
  private failure:unknown;
  private readonly cancelled=()=>this.fail(new ViewerError('CANCELLED','阅读分析已取消。'));
  readonly signal=this.controller.signal;
  constructor(private readonly parent?:AbortSignal,timeoutMs=180000) {
    if(!Number.isFinite(timeoutMs)||timeoutMs<1||timeoutMs>180000)throw new ViewerError('INVALID_ARGUMENT','阅读分析等待上限必须在1–180000毫秒内。');
    this.stopped=new Promise<never>((_resolve,reject)=>{this.reject=reject;});void this.stopped.catch(()=>{});
    this.timer=setTimeout(()=>this.fail(new ViewerError('AI_TIMEOUT','阅读分析超过180秒，已停止本地等待；模型服务可能仍在处理。')),timeoutMs);this.timer.unref();
    parent?.addEventListener('abort',this.cancelled,{once:true});if(parent?.aborted)this.cancelled();
  }
  private cleanup(){clearTimeout(this.timer);this.parent?.removeEventListener('abort',this.cancelled);}
  fail(reason:unknown) {
    if(this.closed)return;this.closed=true;this.failure=reason;this.cleanup();this.reject(reason);this.controller.abort(reason);
  }
  wait<T>(operation:()=>Promise<T>):Promise<T> {
    if(this.closed)return Promise.reject(this.failure??new ViewerError('CANCELLED','阅读分析等待已结束。'));
    return Promise.race([this.stopped,Promise.resolve().then(()=>{this.signal.throwIfAborted();return operation();})]);
  }
  async submit(driver:HarnessDriver,prompt:string,snapshot:ReadingSnapshot,onChunk:(chunk:string)=>void) {
    // The provider retains only this detachable sink and a <=32k snapshot,
    // rather than the full evidence collection or accumulated output callback.
    const receiver:{emit?:typeof onChunk}={emit:onChunk},signal=this.signal;
    try {
      await this.wait(()=>driver.submit(prompt,snapshot,chunk=>{
        if(!receiver.emit||this.closed||signal.aborted)return;
        try {if(typeof chunk!=='string')throw new ViewerError('INVALID_MODEL_OUTPUT','阅读模型返回了非文本内容。');receiver.emit(chunk);}catch(error){this.fail(error);}
      },signal));
    } finally {receiver.emit=undefined;}
  }
  dispose(){this.closed=true;this.cleanup();this.controller.abort();}
}
