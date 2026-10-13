import type { Actor } from '../../contracts/src/index';
import { nativeOfficeCommandPolicy, ViewerError } from '../../contracts/src/index';
import type { NativeOfficeCommand } from '../../contracts/src/native-office';
import type { ViewerCore } from '../../document-core/src/index';
import { officeSessionSchema, officeStatusSchema, officeCommandsSchema, officeCommandStatusSchema, officeQuerySchema, officeExecuteSchema, officeCellSetSchema, officeInputSchema, officeCaptureSchema, officeNavigateSchema, officeUndoSchema, officeExportSchema } from './authoring-schemas';

const decorate = (command: NativeOfficeCommand): NativeOfficeCommand => { const policy=nativeOfficeCommandPolicy(command.command); return policy.blocked ? {...command,available:false,enabled:false,reason:policy.reason} : command; };
/** All native calls stay behind a trusted main-process facade, never HWND input. */
export async function officeSession(core: ViewerCore, method: string, args: Record<string,unknown>, actor: Actor) {
  switch(method) {
    case 'office-session': { const input=officeSessionSchema.parse(args); if(input.action==='open')return core.openNativeOffice(input.viewId);const view=core.getView(input.viewId);await core.closeNativeOffice(view.documentId);return {closed:true,documentId:view.documentId}; }
    case 'office-status': return core.nativeOfficeState(officeStatusSchema.parse(args).viewId);
    case 'office-commands': { const input=officeCommandsSchema.parse(args),state=await core.nativeOfficeState(input.viewId),query=input.query?.toLowerCase();const commands=(await core.nativeOfficeCommands(input.viewId)).map(decorate).filter(command=>(input.group===undefined||String(command.group)===String(input.group))&&(!query||[command.command,command.label].some(value=>value?.toLowerCase().includes(query))));return {state,total:commands.length,offset:input.offset,hasMore:commands.length>input.offset+input.limit,commands:commands.slice(input.offset,input.offset+input.limit)}; }
    case 'office-command-status': { const input=officeCommandStatusSchema.parse(args),result=await core.queryNativeOfficeCommandStatus(input.viewId,input.commands);return {...result,commands:result.commands.map(decorate)}; }
    case 'office-query': {const input=officeQuerySchema.parse(args);return core.queryNativeOffice(input.viewId,input.target);}
    case 'office-execute': return core.executeNativeOffice(officeExecuteSchema.parse(args),actor);
    case 'office-cell-set': {const {sheetName,address,content,...input}=officeCellSetSchema.parse(args);return core.executeNativeOffice({...input,cell:{sheetName,address,content}},actor);}
    case 'office-input': return core.inputNativeOffice(officeInputSchema.parse(args),actor);
    case 'office-capture': return core.captureNativeOffice(officeCaptureSchema.parse(args));
    case 'office-navigate': return core.navigateNativeOffice(officeNavigateSchema.parse(args),actor);
    case 'office-undo': return core.undoNativeOffice(officeUndoSchema.parse(args),actor);
    case 'office-export': { const input=officeExportSchema.parse(args); if(actor==='agent'&&['paused','stopped'].includes(core.agentControl.get(input.viewId)??core.agentControl.get(core.getView(input.viewId).documentId)??''))throw new ViewerError('AGENT_PAUSED','Agent已暂停。');return core.exportNativeOffice(input); }
    default:throw new ViewerError('METHOD_UNSUPPORTED','未知原生Office接口。');
  }
}
