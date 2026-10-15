import type {ElectronApplication} from 'playwright';

export type OfficeRuntimeRpcPhase={sequence:number;requestId:string;method:string;startedAt:number;endedAt?:number;elapsedMs?:number;sessionId?:string;viewId?:string;documentId?:string;format?:string;error?:string};
/** Observe only real RPC boundaries and target identity; never copy request
 * bodies, returned text, formulas, file bytes or native image buffers. */
export async function installOfficeRuntimeRpcObserver(app:ElectronApplication){
  await app.evaluate(()=>{
    if((globalThis as any).__officeQaRuntimeRpcObserver)return;
    const emitter=(process.getBuiltinModule('node:events') as any).EventEmitter.prototype,emit=emitter.emit;
    const observer:any={phases:[],sequence:0,runtimeFound:false,seen:new WeakSet(),writers:new WeakSet()};(globalThis as any).__officeQaRuntimeRpcObserver=observer;
    emitter.emit=function(this:any,type:string,...values:any[]){
      if(type==='diagnostic'&&!observer.seen.has(this)&&this.options?.backend==='kit'&&typeof this.request==='function'&&typeof this.surfaceTiles==='function'&&typeof this.surfaceLayout==='function'&&this.options?.dataDir===process.env.AGENTVIEWER_DATA_DIR){
        observer.runtimeFound=true;observer.seen.add(this);if((globalThis as any).__officeQaOpenGate)(globalThis as any).__officeQaOpenGate.runtimeFound=true;
        // The first request() is already awaiting start() when this diagnostic
        // arrives. Observe its later pending registration, rather than replace
        // a method that the in-flight call has already entered.
        const runtime=this,pending=this.pending,set=pending.set,requests=new Map<string,any>();
        pending.set=function(this:any,id:string,entry:any){
          const started=performance.now(),phase:any={sequence:++observer.sequence,requestId:id,method:'unobserved',startedAt:Date.now()},record:any={phase,settled:false};
          requests.set(id,record);observer.phases.push(phase);if(observer.phases.length>2048)observer.phases.shift();
          // rpc is authenticated only after startup. It exists by pending.set,
          // before the original request writes its unchanged JSONL message.
          const rpc=runtime.rpc;
          if(rpc&&!observer.writers.has(rpc)){
            observer.writers.add(rpc);const write=rpc.write;
            rpc.write=function(this:any,chunk:any,...args:any[]){
              try{
                const message=JSON.parse(typeof chunk==='string'?chunk:chunk.toString('utf8')),request=requests.get(message?.id);
                if(request){
                  const input=message.args,safe=request.phase;
                  safe.method=typeof message.method==='string'?message.method:'unobserved';
                  if(typeof input?.sessionId==='string')safe.sessionId=input.sessionId;
                  if(typeof input?.viewId==='string')safe.viewId=input.viewId;
                  if(typeof input?.documentId==='string')safe.documentId=input.documentId;
                  if(typeof input?.format==='string')safe.format=input.format;
                }
              }catch{/* Observation never changes transport or request outcome. */}
              return write.call(this,chunk,...args);
            };
          }
          return set.call(this,id,{...entry,
            resolve(result:any){
              if(record.settled)return;record.settled=true;requests.delete(id);
              phase.endedAt=Date.now();phase.elapsedMs=performance.now()-started;
              const state=result?.state??result;
              if(typeof state?.sessionId==='string')phase.sessionId??=state.sessionId;
              if(typeof state?.viewId==='string')phase.viewId??=state.viewId;
              if(typeof state?.documentId==='string')phase.documentId??=state.documentId;
              if(typeof state?.format==='string')phase.format??=state.format;
              // Runtime.receive has received the real result and cleared its
              // native timeout. Hold only Promise resolution, before open()
              // registers its controller and before Host/Core see readiness.
              const gate=(globalThis as any).__officeQaOpenGate;
              if(gate?.armed&&!gate.held&&phase.method==='open'&&result?.format===gate.format&&result.surfaceKind==='tiled'){
                gate.held=true;gate.receiptAt=phase.endedAt;gate.receipt={viewId:result.viewId,documentId:result.documentId,sessionId:result.sessionId,engineEpoch:result.engineEpoch,nativePid:result.nativePid,status:result.status,surfaceKind:result.surfaceKind};
                setTimeout(()=>{gate.armed=false;gate.released=true;gate.releasedAt=Date.now();entry.resolve(result);},gate.delayMs);
                return;
              }
              if(gate?.receipt&&['close','detachView'].includes(phase.method)&&phase.sessionId===gate.receipt.sessionId)gate.retirement={method:phase.method,ok:true,at:Date.now()};
              return entry.resolve(result);
            },
            reject(error:any){
              if(record.settled)return;record.settled=true;requests.delete(id);
              phase.endedAt=Date.now();phase.elapsedMs=performance.now()-started;phase.error=typeof error?.code==='string'?error.code:typeof error?.name==='string'?error.name:'Error';
              return entry.reject(error);
            }
          });
        };
      }
      return emit.call(this,type,...values);
    };
  });
}

export function officeRuntimeRpcPhases(app:ElectronApplication):Promise<OfficeRuntimeRpcPhase[]>{return app.evaluate(()=>(globalThis as any).__officeQaRuntimeRpcObserver?.phases??[]);}

/** Private QA only: hold a successful real Kit open request result for 5s,
 * before NativeOfficeRuntime.open returns to the Host and Core. */
export async function installOfficeOpenReceiptGate(app:ElectronApplication,format:'docx'|'pptx'|'xlsx'='docx'){
  await installOfficeRuntimeRpcObserver(app);
  await app.evaluate((_,format)=>{(globalThis as any).__officeQaOpenGate={format,armed:true,held:false,released:false,delayMs:5000,runtimeFound:!!(globalThis as any).__officeQaRuntimeRpcObserver?.runtimeFound,receipt:undefined};},format);
}

export function officeOpenReceiptGate(app:ElectronApplication){return app.evaluate(()=>(globalThis as any).__officeQaOpenGate as {held:boolean;released:boolean;receiptAt?:number;releasedAt?:number;delayMs:number;retirement?:{method:string;ok:boolean;at:number};receipt?:{viewId:string;documentId:string;sessionId:string;engineEpoch:string;nativePid:number;status:string;surfaceKind:string}});}
