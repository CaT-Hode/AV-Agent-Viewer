import { useEffect, useState, type FormEvent } from 'react';
import { translationProviders, isTranslationProvider, type TranslationProviderId, type TranslationProviderSnapshot, type TranslationProviderStatus, type GoogleTranslationMode } from '../../../../../packages/contracts/src/translation-engine';
import { call } from '../lib/transport';
import { GlassSegmentedControl } from './GlassSegmentedControl';

export function TranslationProviders({ engine }: { engine: string }) {
  const [snapshot,setSnapshot]=useState<TranslationProviderSnapshot>(),[provider,setProvider]=useState<TranslationProviderId>(isTranslationProvider(engine)?engine:'google'),[error,setError]=useState('');
  useEffect(()=>{let live=true;void call<TranslationProviderSnapshot>('translation-providers-read').then(value=>{if(live)setSnapshot(value);}).catch(reason=>{if(live)setError(String(reason));});return()=>{live=false;};},[]);
  useEffect(()=>{if(isTranslationProvider(engine))setProvider(engine);},[engine]);
  const status=snapshot?.providers.find(value=>value.id===provider);
  return <section className="connection-section translation-provider-settings"><h2>普通翻译服务</h2><p>Google、百度与 Microsoft 翻译，独立于 AI 模型配置。</p>
    <GlassSegmentedControl label="配置普通翻译服务" value={provider} options={translationProviders.map(value=>({value:value.id,label:value.label}))} onChange={value=>setProvider(value as TranslationProviderId)} />
    {error&&<p className="settings-error" role="alert">{error}</p>}{status&&<ProviderForm key={provider} status={status} onSaved={setSnapshot} />}
  </section>;
}
function ProviderForm({status,onSaved}:{status:TranslationProviderStatus;onSaved(value:TranslationProviderSnapshot):void}){
  const [apiKey,setApiKey]=useState(''),[appId,setAppId]=useState(status.appId),[region,setRegion]=useState(status.region),[googleMode,setGoogleMode]=useState<GoogleTranslationMode>(status.googleMode??'cloud'),[busy,setBusy]=useState(false),[message,setMessage]=useState(''),[error,setError]=useState('');
  const googleWeb=status.id==='google'&&googleMode==='web',needsSave=status.id==='google'&&googleMode!==(status.googleMode??'cloud');
  const act=async(work:()=>Promise<void>)=>{setBusy(true);setError('');setMessage('');try{await work();}catch(reason){setError(String(reason));}finally{setBusy(false);}};
  const save=(event:FormEvent)=>{event.preventDefault();void act(async()=>{onSaved(await call<TranslationProviderSnapshot>('translation-providers-save',{provider:status.id,apiKey,appId,region,...(status.id==='google'?{googleMode}:{})}));setApiKey('');setMessage(googleWeb?'Google 网页翻译已启用。':'翻译设置已保存。');});};
  return <form className="connection-form translation-provider-form" onSubmit={save} data-translation-provider={status.id}>
    {status.id==='google'&&<GlassSegmentedControl label="Google 翻译方式" value={googleMode} options={[{value:'cloud',label:'官方 API'},{value:'web',label:'网页翻译'}]} onChange={value=>{setGoogleMode(value as GoogleTranslationMode);setMessage('');setError('');}} />}
    <p className="translation-provider-status">{status.label}{needsSave?' · 待保存':status.configured?' · 已配置':' · 待配置'}{status.id==='google'?googleWeb?' · 网页接口，无需 API 密钥':' · Cloud Translation Basic v2':status.id==='baidu'?' · 通用翻译 API':' · Translator Text v3'}</p>
    {status.id==='baidu'&&<label>百度 APP ID<input aria-label="百度 APP ID" value={appId} onChange={event=>setAppId(event.target.value)} autoComplete="off" inputMode="numeric" required /></label>}
    {!googleWeb&&<label>{status.label} API 密钥<input aria-label={status.label+' API 密钥'} type="password" autoComplete="off" value={apiKey} onChange={event=>setApiKey(event.target.value)} placeholder={status.hasKey?'已保存，留空保留':'填写服务商 API 密钥'} required={!status.hasKey} /></label>}
    {status.id==='microsoft'&&<label>Azure 区域<input aria-label="Azure 区域" value={region} onChange={event=>setRegion(event.target.value)} placeholder="例如 eastasia；全局单服务密钥可留空" autoComplete="off" /></label>}
    <div className="translation-provider-actions"><button className="button primary" disabled={busy} type="submit">保存设置</button><button className="button" disabled={busy||!status.configured||needsSave} type="button" onClick={()=>void act(async()=>{const result=await call<{text:string}>('translation-providers-test',{provider:status.id});setMessage('测试已保存设置：'+result.text);})}>测试翻译</button><button className="button" disabled={busy||!status.configured} type="button" onClick={()=>void act(async()=>{onSaved(await call<TranslationProviderSnapshot>('translation-providers-remove',{provider:status.id}));setApiKey('');setAppId('');setRegion('');setGoogleMode('cloud');setMessage('已重置翻译设置。');})}>{status.id==='google'?'重置设置':'移除凭据'}</button><button className="button" type="button" onClick={()=>void call('open',{uri:googleWeb?'https://blog.csdn.net/u012419303/article/details/106263338':translationProviders.find(value=>value.id===status.id)!.docs,windowId:'main'}).catch(reason=>setError(String(reason)))}>{googleWeb?'接口说明':'官方 API 文档'}</button></div>
    {busy&&<p role="status">正在处理…</p>}{message&&<p className="settings-notice" role="status">{message}</p>}{error&&<p className="settings-error" role="alert">{error}</p>}
  </form>;
}
