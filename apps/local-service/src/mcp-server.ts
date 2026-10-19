import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { AgentClient } from '../../../packages/sdk/src/client';
import { agentTools, catalogVersion, formatInstructions, parseAgentTool, type AgentToolName, type AgentFormat } from '../../../packages/sdk/src/agent-tools';
import { version } from '../../../package.json';

const json=(value:unknown)=>({content:[{type:'text' as const,text:JSON.stringify(value)}]});
/** Each transport gets independent registrations; human tabs never change this catalog. */
export function createAgentMcpServer(options:{catalogOnly?:boolean;invoke?:(name:AgentToolName,args:Record<string,unknown>)=>Promise<unknown>}={}) {
  const server=new McpServer({name:'agent-viewer',version}),client=new AgentClient();
  const loaded=new Set<string>(),instructions=new Set<string>();
  const catalogOnly=options.catalogOnly??process.env.AGENTVIEWER_CATALOG_ONLY==='1';
  server.server.onclose=()=>{if(!catalogOnly&&!options.invoke)void client.close().catch(()=>{});};
  const register=(names:string[])=>{
    for(const tool of agentTools)if(names.includes(tool.name)&&!loaded.has(tool.name)) {
      loaded.add(tool.name);
      server.registerTool(tool.name,{description:tool.description,inputSchema:tool.schema.shape,annotations:{readOnlyHint:!tool.mutates,openWorldHint:tool.owner==='web'}},async (args:Record<string,unknown>)=>{
        try {
          const input=parseAgentTool(tool.name,args);
          let result:unknown;
          if(tool.name==='av_tools') {
            if(catalogOnly) {
              if(input.ref)throw Object.assign(new Error('Catalog-only discovery accepts type, not live refs.'),{code:'CATALOG_ONLY'});
              const type=input.type as AgentFormat|undefined,pack=String(input.pack??'base');
              const candidates=agentTools.filter(value=>value.pack==='entry'||value.owner==='shared'&&(pack==='all'||value.pack===pack||!!type&&['read','lifecycle'].includes(value.pack))||value.owner===type&&(pack==='all'||value.pack===pack));
              const added=candidates.filter(value=>!loaded.has(value.name)).map(value=>value.name),guide=type&&!instructions.has(type)?formatInstructions[type]:undefined;
              if(type)instructions.add(type);
              result={version:catalogVersion,type,pack,tools:added,...(guide?{instructions:guide}:{})};
            } else result=await (options.invoke?options.invoke(tool.name,input):client.execute(tool.name,input as never));
            register((result as {tools:string[]}).tools);
          } else {
            if(catalogOnly)throw Object.assign(new Error('Catalog-only mode does not execute document tools.'),{code:'CATALOG_ONLY'});
            result=await (options.invoke?options.invoke(tool.name,input):client.execute(tool.name,input as never));
          }
          const value=result as {mimeType?:string;data?:string};
          if(value&&typeof value==='object'&&value.mimeType?.startsWith('image/')&&typeof value.data==='string') {
            const {data,mimeType,...metadata}=value;
            return {content:[{type:'image' as const,mimeType,data},{type:'text' as const,text:JSON.stringify(metadata)}]};
          }
          return json(result);
        } catch(error) {const value=error as {code?:string;message?:string;issues?:unknown};return {...json({error:{code:value.issues?'INVALID_ARGUMENT':value.code??'INTERNAL_ERROR',message:value.message??String(error)}}),isError:true};}
      });
    }
  };
  register(['av_workspace','av_tools']);return server;
}
