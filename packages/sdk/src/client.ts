import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { dataDir } from './discovery';
import { requestLoopbackJson } from './loopback-json-request';
import { agentTools, toolByName, parseAgentTool, type AgentToolArgs, type AgentToolName } from './agent-tools';
import type { AgentBatchMode, AgentStep, AgentToolResult } from './agent-results';
export type { AgentBatchMode, AgentStep, AgentToolResult } from './agent-results';

export class AgentClientError extends Error {
  constructor(readonly code:string,message:string,readonly details?:unknown){super(message);this.name='AgentClientError';}
}
interface Connection {endpoint:string;token:string;agentProtocolVersion:string;instanceId:string}
export async function connection() {
  const config=JSON.parse(await readFile(process.env.AGENTVIEWER_CONNECTION_FILE??join(dataDir(),'runtime/connection.json'),'utf8')) as Connection;
  if(config.agentProtocolVersion!=='2.0')throw new AgentClientError('PROTOCOL_MISMATCH','请运行当前构建的 AgentViewer；旧公共接口已移除。');
  const url=new URL(config.endpoint);
  if(!['http:','https:'].includes(url.protocol)||!['127.0.0.1','localhost','[::1]'].includes(url.hostname)||url.username||url.password)throw new AgentClientError('INVALID_ENDPOINT','本地发现文件只能指向无URL凭据的HTTP(S) loopback。');
  return config;
}
export type AgentToolClient = {[N in AgentToolName]:(args:AgentToolArgs<N>)=>Promise<AgentToolResult<N>>};
/** Typed operations share one authenticated session; discovery is not read per call. */
export class AgentClient {
  private session?:Promise<{config:Connection;id:string}>;
  readonly tools:AgentToolClient;
  constructor(readonly clientId:string=process.env.AGENTVIEWER_CLIENT_ID??randomUUID(),readonly connectionId:string=randomUUID()) {
    this.tools=Object.fromEntries(agentTools.map(tool=>[tool.name,(args:unknown)=>this.execute(tool.name,args as never)])) as AgentToolClient;
  }
  private connect() {
    if(this.session)return this.session;
    const connecting=(async()=>{const config=await connection(),response=await requestLoopbackJson(new URL(config.endpoint+'/v2/sessions'),config.token,JSON.stringify({client:this.clientId,connection:this.connectionId}));
      if(!response.ok)throw this.error(response.data);return {config,id:String((response.data as {session:string}).session)};})();
    this.session=connecting;void connecting.catch(()=>{if(this.session===connecting)this.session=undefined;});return connecting;
  }
  private error(data:unknown) {const error=(data as {error?:{code?:string;message?:string;details?:unknown}})?.error;return new AgentClientError(error?.code??'SERVICE_ERROR',error?.message??'AgentViewer 请求失败。',error?.details);}
  async execute<N extends AgentToolName>(name:N,args:AgentToolArgs<N>):Promise<AgentToolResult<N>> {
    const tool=toolByName.get(name);if(!tool)throw new AgentClientError('UNKNOWN_TOOL','未知领域工具。');
    const input=parseAgentTool(name,args),current=this.connect(),{config,id}=await current;
    let response;
    try{response=await requestLoopbackJson(new URL(config.endpoint+'/v2/tools/'+name),config.token,JSON.stringify({session:id,input}));}
    catch(error){if(this.session===current)this.session=undefined;throw error;}
    if(!response.ok){const error=this.error(response.data);if(['SESSION_EXPIRED','AGENT_SESSION_CLOSED','AUTH_REQUIRED'].includes(error.code)&&this.session===current)this.session=undefined;throw error;}return response.data as AgentToolResult<N>;
  }
  async close() {const current=this.session;if(!current)return;try{const {config,id}=await current;const response=await requestLoopbackJson(new URL(config.endpoint+'/v2/sessions/close'),config.token,JSON.stringify({session:id}));if(!response.ok)throw this.error(response.data);}finally{if(this.session===current)this.session=undefined;}}
  /** Script-side orchestration keeps intermediate results out of model history. */
  async batch(mode:AgentBatchMode,steps:AgentStep[]) {
    if(!['atomic','ordered-stop-on-error','best-effort'].includes(mode))throw new AgentClientError('INVALID_BATCH_MODE','批次模式必须为atomic、ordered-stop-on-error或best-effort。');
    if(mode==='atomic')throw new AgentClientError('ATOMIC_UNSUPPORTED','跨引擎原子批次不受支持；未执行任何步骤。');
    if(steps.length>100)throw new AgentClientError('BATCH_LIMIT','每批最多100步。');
    for(const step of steps)parseAgentTool(step.tool,step.input);
    const results:({status:'completed'|'pending';result:unknown}|{status:'failed';error:{code:string;message:string}})[]=[];
    for(const step of steps) {
      try {const result=await this.execute(step.tool,step.input),pending='job' in result&&result.status==='running';results.push({status:pending?'pending':'completed',result});if(pending&&mode==='ordered-stop-on-error')break;}
      catch(error){results.push({status:'failed',error:{code:error instanceof AgentClientError?error.code:'CLIENT_ERROR',message:error instanceof Error?error.message:String(error)}});if(mode==='ordered-stop-on-error')break;}
    }
    return {mode,results,remaining:steps.length-results.length};
  }
}
