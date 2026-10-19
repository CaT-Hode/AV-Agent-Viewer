import { appendFile, writeFile } from 'node:fs/promises';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ViewerCore } from '../packages/document-core/src/index';
import { AgentSession } from '../packages/sdk/src/agent-session';
import { createAgentMcpServer } from '../apps/local-service/src/mcp-server';
const logPath=process.env.AGENTVIEWER_PROBE_LOG!;
const record=(value:unknown)=>appendFile(logPath,JSON.stringify(value)+'\n');
const core=new ViewerCore({load:async()=>undefined,save:async()=>{}});
await core.initialize();await core.openBytes('DiscoveryFixture.md',new TextEncoder().encode('# DiscoveryFixture\n\nSynthetic probe content.\n'),'markdown');
const agent=new AgentSession(core,'codex-host-probe',process.env.AGENTVIEWER_PROBE_DIR!);
if(process.env.AGENTVIEWER_PROBE_SEED_REFS==='1'){
  const value=await agent.invoke('av_workspace',{action:'list'}) as {documents:{ref:string}[]};
  if(!process.env.AGENTVIEWER_PROBE_TARGET_FILE)throw new Error('Missing probe target metadata path');
  await writeFile(process.env.AGENTVIEWER_PROBE_TARGET_FILE,JSON.stringify({ref:value.documents[0].ref}));
}
const server=createAgentMcpServer({invoke:async(name,args)=>{
  await record({event:'invoke',tool:name,argumentKeys:Object.keys(args).sort(),...(name==='av_tools'?{type:args.type,pack:args.pack}:{})});
  const result=await agent.invoke(name,args);
  await record({event:'result',tool:name,keys:result&&typeof result==='object'?Object.keys(result):[],...(name==='av_tools'?{loaded:(result as {tools:string[]}).tools}:{})});
  return result;
}});
const transport=new StdioServerTransport();const send=transport.send.bind(transport);
transport.send=async(message:any)=>{if(message.method==='notifications/tools/list_changed')await record({event:'wire-list-changed'});if(message.error)await record({event:'wire-error',code:message.error.code,category:/argument|validation|schema|parameter/i.test(message.error.message??'')?'SCHEMA':'OTHER'});if(message.result?.isError){const block=message.result.content?.find((value:any)=>value.type==='text');let code;try{code=JSON.parse(block?.text??'{}').error?.code}catch{}await record({event:'wire-tool-error',code:typeof code==='string'?code:'UNKNOWN'});}if(message.result?.tools)await record({event:'wire-tools-list',tools:message.result.tools.map((tool:any)=>tool.name)});return send(message);};
await server.connect(transport);const receive=transport.onmessage;transport.onmessage=(message:any)=>{if(message.method==='tools/call')void record({event:'wire-tools-call',tool:message.params?.name,argumentKeys:Object.keys(message.params?.arguments??{}).sort()});return receive?.(message);};
