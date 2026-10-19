import { AgentClient } from './client';
import { toolByName, type AgentToolName } from './agent-tools';
const command=process.argv.slice(2),position=command.indexOf('--client');
const clientId=position>=0?command.splice(position,2)[1]:process.env.AGENTVIEWER_CLIENT_ID;
const [name='av_workspace',json='{}']=command;
try {
  if(!toolByName.has(name))throw new Error('未知 av_* 工具；通过 av_tools 按类型发现。');
  if(!clientId)throw new Error('CLI需要 --client <独立工作身份>，以复用引用与幂等记录。');
  const client=new AgentClient(clientId,'cli:'+clientId);
  process.stdout.write(JSON.stringify(await client.execute(name as AgentToolName,JSON.parse(json)))+'\n');
} catch(error) {process.stderr.write(String(error)+'\n');process.exitCode=1;}
