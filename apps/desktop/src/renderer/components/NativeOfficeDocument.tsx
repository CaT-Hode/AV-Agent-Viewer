import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { call, windowId } from '../lib/transport';
import type { DocumentInfo, ViewInfo, NativeOfficeState } from '../../../../../packages/contracts/src/index';
import type { OfficeDraftController } from './OfficeDocument';
import { NativeOfficeFormulaBar } from './NativeOfficeFormulaBar';
import { shareNativeOfficeState, subscribeNativeOfficeState } from '../lib/native-office-observer';

/** Native Office paints the real document; Chromium owns only the surrounding workspace. */
export function NativeOfficeDocument({document,view,obscured,onOfficeDraftController,reportError,onOfficeDraftChange}:{document:DocumentInfo;view:ViewInfo;obscured?:boolean;onOfficeDraftController?(controller:OfficeDraftController|undefined):void;onOfficeDraftChange?(value:{viewId:string;dirty:boolean}):void;reportError(error:unknown):void}) {
  const host=useRef<HTMLDivElement>(null),callbacks=useRef({reportError,onOfficeDraftController});callbacks.current={reportError,onOfficeDraftController};
  const [ready,setReady]=useState(false),[failure,setFailure]=useState('');
  const engineFailed=document.nativeOffice?.status==='failed';
  const [state,setState]=useState<NativeOfficeState>(),formula=useRef<OfficeDraftController|undefined>(undefined);
  useLayoutEffect(()=>{const controller:OfficeDraftController={viewId:view.id,flush:async()=>{await formula.current?.flush();await call('office-flush',{viewId:view.id});},hasDrafts:()=>formula.current?.hasDrafts()??false,discard:()=>formula.current?.discard()};callbacks.current.onOfficeDraftController?.(controller);return()=>callbacks.current.onOfficeDraftController?.(undefined);},[view.id]);
  useEffect(()=>{if(document.format!=='xlsx'||!ready||obscured||engineFailed)return;return subscribeNativeOfficeState(call,view.id,document.id,{state:next=>setState(previous=>shareNativeOfficeState(previous,next))},650);},[document.format,document.id,view.id,ready,obscured,engineFailed]);
  useEffect(()=>{let disposed=false,frame=0,flight=false,queued=false,lastLayout='';
    const update=async()=>{if(disposed)return;if(flight){queued=true;return;}const box=host.current?.getBoundingClientRect();if(!box)return;const views=obscured?[]:[{viewId:view.id,bounds:{x:box.x,y:box.y,width:box.width,height:box.height}}],signature=JSON.stringify(views);if(signature===lastLayout)return;flight=true;
      try{await call('office-layout',{windowId,views});if(!disposed){lastLayout=signature;setReady(!obscured);setFailure('');}}
      catch(error){if(!disposed){setFailure(String(error));callbacks.current.reportError(error);}}
      finally{flight=false;if(queued){queued=false;void update();}}
    };
    const resize=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>void update());},observer=new ResizeObserver(resize);if(host.current)observer.observe(host.current);window.addEventListener('resize',resize);void update();
    return()=>{disposed=true;observer.disconnect();cancelAnimationFrame(frame);window.removeEventListener('resize',resize);void call('office-layout',{windowId,views:[]}).catch(()=>{});};
  },[view.id,document.id,obscured]);
  return <div className={'document-content native-office-content format-'+document.format} data-native-office={view.id} data-native-ready={ready&&!engineFailed}>{document.format==='xlsx'&&<div className="native-office-formula-host"><NativeOfficeFormulaBar documentId={document.id} viewId={view.id} state={state} active={ready&&!obscured&&!engineFailed} onState={next=>setState(previous=>shareNativeOfficeState(previous,next))} onError={reportError} onDraftController={controller=>{formula.current=controller;}} onDraftChange={dirty=>onOfficeDraftChange?.({viewId:view.id,dirty})}/></div>}<div ref={host} className="native-office-surface"><div className="native-office-placeholder" role="status">{engineFailed?'Office 编辑器已退出。最近确认的恢复点已保留，请重新启动应用继续。':failure||(!ready?'正在打开内置 Office 编辑器…':'')}</div></div></div>;
}
