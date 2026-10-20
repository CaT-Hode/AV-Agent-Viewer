import { useEffect, useState, type FormEvent } from 'react';
import { translationProviders, isTranslationProvider, type TranslationProviderId, type TranslationProviderSnapshot, type TranslationProviderStatus } from '../../../../../packages/contracts/src/translation-engine';
import { call } from '../lib/transport';
import { GlassSegmentedControl } from './GlassSegmentedControl';

export function TranslationProviders({ engine }: { engine: string }) {
  const [snapshot,setSnapshot]=useState<TranslationProviderSnapshot>(),[provider,setProvider]=useState<TranslationProviderId>(isTranslationProvider(engine)?engine:'google'),[error,setError]=useState('');
  useEffect(()=>{let live=true;void call<TranslationProviderSnapshot>('translation-providers-read').then(value=>{if(live)setSnapshot(value);}).catch(reason=>{if(live)setError(String(reason));});return()=>{live=false;};},[]);
  useEffect(()=>{if(isTranslationProvider(engine))setProvider(engine);},[engine]);
  const status=snapshot?.providers.find(value=>value.id===provider);
  return <section className="connection-section translation-provider-settings"><h2>普通翻译服务</h2><p>使用服务商官方 API，无需连接 AI 模型。需要开通对应服务并填写自己的凭据，额度和费用以服务商为准。密钥由系统加密保存。</p>
    <GlassSegmentedControl label="配置普通翻译服务" value={provider} options={translationProviders.map(value=>({value:value.id,label:value.label}))} onChange={value=>setProvider(value as TranslationProviderId)} />
    {error&&<p className="settings-error" role="alert">{error}</p>}{status&&<ProviderForm key={provider} status={status} onSaved={setSnapshot} />}
  </section>;
}
function ProviderForm({status,onSaved}:{status:TranslationProviderStatus;onSaved(value:TranslationProviderSnapshot):void}){
  const [apiKey,setApiKey]=useState(''),[appId,setAppId]=useState(status.appId),[region,setRegion]=useState(status.region),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  const act=async(work:()=>Promise<void>)=>{setBusy(true);setError('');setMessage('');try{await work();}catch(reason){setError(String(reason));}finally{setBusy(false);}};
  const save=(event:FormEvent)=>{event.preventDefault();void act(async()=>{onSaved(await call<TranslationProviderSnapshot>('translation-providers-save',{provider:status.id,apiKey,appId,region}));setApiKey('');setMessage('凭据已加密保存。');});};
  return <form className="connection-form translation-provider-form" onSubmit={save} data-translation-provider={status.id}>
    <p className="translation-provider-status">{status.label} · {status.configured?'已配置':'待配置'}{status.id==='google'?' · Cloud Translation Basic v2':status.id==='baidu'?' · 通用翻译 API':' · Translator Text v3'}</p>
    {status.id==='baidu'&&<label>百度 APP ID<input aria-label="百度 APP ID" value={appId} onChange={event=>setAppId(event.target.value)} autoComplete="off" inputMode="numeric" required /></label>}
    <label>{status.label} API 密钥<input aria-label={status.label+' API 密钥'} type="password" autoComplete="off" value={apiKey} onChange={event=>setApiKey(event.target.value)} placeholder={status.hasKey?'已保存，留空保留':'填写服务商 API 密钥'} required={!status.hasKey} /></label>
    {status.id==='microsoft'&&<label>Azure 区域<input aria-label="Azure 区域" value={region} onChange={event=>setRegion(event.target.value)} placeholder="例如 eastasia；全局单服务密钥可留空" autoComplete="off" /></label>}
    <div className="translation-provider-actions"><button className="button primary" disabled={busy} type="submit">保存凭据</button><button className="button" disabled={busy||!status.configured} type="button" onClick={()=>void act(async()=>{const result=await call<{text:string}>('translation-providers-test',{provider:status.id});setMessage('测试已保存凭据：'+result.text);})}>测试翻译</button><button className="button" disabled={busy||!status.hasKey} type="button" onClick={()=>void act(async()=>{onSaved(await call<TranslationProviderSnapshot>('translation-providers-remove',{provider:status.id}));setApiKey('');setAppId('');setRegion('');setMessage('已移除凭据。');})}>移除凭据</button><button className="button" type="button" onClick={()=>void call('open',{uri:translationProviders.find(value=>value.id===status.id)!.docs,windowId:'main'}).catch(reason=>setError(String(reason)))}>官方 API 文档</button></div>
    {busy&&<p role="status">正在处理…</p>}{message&&<p className="settings-notice" role="status">{message}</p>}{error&&<p className="settings-error" role="alert">{error}</p>}
    <small>支持选区、网页及非 PDF 文档翻译。PDF 全文保版式翻译需要 AI 模型与 BabelDOC。</small>
  </form>;
}
