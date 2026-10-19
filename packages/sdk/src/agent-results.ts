import type { AgentFormat, AgentToolArgs, AgentToolName } from './agent-tools';

export interface AgentDocument {ref:string;type:AgentFormat;title:string;dirty:boolean;revision:number;ready:boolean}
export interface AgentJob {job:string;status:'running'|'completed'|'failed'|'cancelled'|'unknown';effect:'pending'|'applied'|'none'|'unknown';error?:{code:string;message:string};elapsedMs?:number;reconcile?:boolean;reason?:string;resultUnavailable?:boolean;replayed?:boolean}
export interface AgentMutation {ref?:string;effect:string;check?:string;durability?:'pending'|'recoverable'|'saved';transaction?:string;dirty?:boolean;readback?:unknown;warnings?:string[]}
export interface AgentRead {ref?:string;text?:string;cursor?:string;truncated?:boolean;items?:{ref:string;kind:string;text?:string}[];results?:{ref?:string;quote:string}[];[field:string]:unknown}
export interface AgentCatalog {version:string;type?:AgentFormat;pack:string;tools:AgentToolName[];instructions?:string;capabilities?:unknown}
export type AgentToolResult<N extends AgentToolName>=N extends 'av_workspace'?AgentDocument|{documents:AgentDocument[];cursor?:string}|AgentJob:N extends 'av_tools'?AgentCatalog:N extends 'av_task'?AgentJob&{text?:string;cursor?:string}:AgentRead|AgentMutation|AgentJob;
export type AgentStep = {[N in AgentToolName]:{tool:N;input:AgentToolArgs<N>}}[AgentToolName];
export type AgentBatchMode='atomic'|'ordered-stop-on-error'|'best-effort';
