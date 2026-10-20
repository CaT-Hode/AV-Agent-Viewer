import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseFragment } from 'parse5';
import { ViewerError } from '../../contracts/src/index';
import { isTranslationProvider, translationProviders, type TranslationProviderId, type TranslationProviderInput, type TranslationProviderSnapshot } from '../../contracts/src/translation-engine';
import { abortable, assertTranslationActive, translationLanguage } from './request';

type StoredProvider = { secret: string; appId: string; region: string };
export type TranslationCredentialVault = { available(): boolean; encrypt(value: string): string; decrypt(value: string): string };
type ProviderOptions = { fetch?: typeof fetch; baiduIntervalMs?: number; timeoutMs?: number };
const names = Object.fromEntries(translationProviders.map(provider => [provider.id, provider.label]));

export function providerTargetLanguage(provider: TranslationProviderId, language: string) {
  const canonical = translationLanguage(language), base = canonical.split('-')[0];
  if (base === 'zh') {
    const traditional = /(?:Hant|TW|HK|MO)/i.test(canonical);
    return provider === 'baidu' ? traditional ? 'cht' : 'zh' : provider === 'microsoft' ? traditional ? 'zh-Hant' : 'zh-Hans' : traditional ? 'zh-TW' : 'zh-CN';
  }
  if (provider !== 'baidu') return canonical;
  const mapped: Record<string,string> = { en:'en',ja:'jp',ko:'kor',fr:'fra',de:'de',es:'spa',ru:'ru',pt:'pt',it:'it',ar:'ara',th:'th',vi:'vie',id:'id',nl:'nl',pl:'pl',fi:'fin',sv:'swe',da:'dan',el:'el',hu:'hu',ro:'rom',cs:'cs',bg:'bul',tr:'tr',uk:'ukr',hi:'hi',ms:'may',he:'heb' };
  if (!mapped[base]) throw new ViewerError('TRANSLATION_LANGUAGE_UNSUPPORTED', `百度通用翻译暂未接入目标语言 ${canonical}。`);
  return mapped[base];
}

/** Stay below each provider's per-request character and UTF-8 byte budgets.
 * Prefer a sentence/word boundary and never split a UTF-16 surrogate pair. */
export function splitTranslationSource(source: string) {
  const parts: string[] = []; let start = 0;
  while (start < source.length) {
    let end = start, bytes = 0, chars = 0, boundary = start;
    for (const char of source.slice(start)) {
      const size = Buffer.byteLength(char);
      if (bytes + size > 4500 || chars >= 3000) break;
      bytes += size; chars++; end += char.length;
      if (/[\s。！？.!?；;]/u.test(char)) boundary = end;
    }
    if (end < source.length && boundary > start + (end-start)/2) end = boundary;
    parts.push(source.slice(start,end)); start = end;
  }
  return parts;
}

function decodeGoogleText(text: string) {
  const node = parseFragment(text.replace(/</g,'&lt;'));
  return node.childNodes.map(child => 'value' in child ? child.value : '').join('');
}
function providerError(provider: TranslationProviderId, code: string | number, status?: number) {
  const invalid = status === 401 || status === 403 || ['52003','54001','58002'].includes(String(code));
  const quota = status === 429 || ['54003','54004','54005'].includes(String(code));
  return new ViewerError(invalid ? 'TRANSLATION_CREDENTIAL_INVALID' : quota ? 'TRANSLATION_QUOTA' : 'TRANSLATION_PROVIDER_ERROR', `${names[provider]} 翻译${invalid ? '认证失败，请检查翻译设置中的凭据和服务权限' : quota ? '配额不足或请求过快，请稍后重试并检查服务额度' : '服务未完成请求，请检查目标语言及服务状态'}。`);
}

/** Plain translation APIs only. Credentials never enter a renderer snapshot or
 * a request URL; capture freezes the selected provider for the entire task. */
export class TranslationProviderService {
  private providers: Partial<Record<TranslationProviderId,StoredProvider>> = {};
  private writing = Promise.resolve();
  private baiduTail = Promise.resolve();
  private baiduStarted = 0;
  constructor(readonly path: string, private readonly vault: TranslationCredentialVault, private readonly options: ProviderOptions = {}) {}
  async load() {
    try {
      const data = JSON.parse(await readFile(this.path,'utf8'));
      if (data.schemaVersion !== 1 || !data.providers || typeof data.providers !== 'object') throw new ViewerError('SCHEMA_MISMATCH','普通翻译服务配置无效。');
      for (const [id, value] of Object.entries(data.providers)) {
        const item = value as StoredProvider;
        if (!isTranslationProvider(id) || !item || typeof item.secret !== 'string' || item.secret.length > 32768 || typeof item.appId !== 'string' || typeof item.region !== 'string') throw new ViewerError('SCHEMA_MISMATCH','普通翻译服务配置无效。');
        this.providers[id] = { secret:item.secret,appId:item.appId,region:item.region };
      }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  configured(provider: TranslationProviderId) { const value = this.providers[provider]; return !!value?.secret && (provider !== 'baidu' || !!value.appId); }
  snapshot(): TranslationProviderSnapshot { return { providers: translationProviders.map(({id,label}) => ({ id,label,configured:this.configured(id),hasKey:!!this.providers[id]?.secret,appId:this.providers[id]?.appId??'',region:this.providers[id]?.region??'' })) }; }
  private async persist() {
    const data = JSON.stringify({schemaVersion:1,providers:this.providers},null,2);
    const work = this.writing.catch(()=>{}).then(async()=>{await mkdir(dirname(this.path),{recursive:true});const temporary=this.path+'.'+randomUUID()+'.tmp';await writeFile(temporary,data);await rename(temporary,this.path);});
    this.writing=work;await work;
  }
  async save(input: TranslationProviderInput) {
    if (!isTranslationProvider(input.provider)) throw new ViewerError('INVALID_ARGUMENT','未知的普通翻译服务。');
    if (['apiKey','appId','region'].some(field=>input[field as keyof TranslationProviderInput]!==undefined&&typeof input[field as keyof TranslationProviderInput]!=='string')) throw new ViewerError('INVALID_ARGUMENT','翻译凭据字段需要文本。');
    const previous = this.providers[input.provider], key = input.apiKey?.trim(), appId = (input.appId??previous?.appId??'').trim(), region = (input.region??previous?.region??'').trim();
    if (key !== undefined && (typeof key !== 'string' || key.length > 8192 || /[\r\n]/.test(key))) throw new ViewerError('INVALID_ARGUMENT','翻译密钥格式无效。');
    if (input.provider === 'baidu' && !/^\d{6,32}$/.test(appId)) throw new ViewerError('INVALID_ARGUMENT','请填写百度翻译开放平台的数字 APP ID。');
    if (input.provider === 'microsoft' && !/^[a-z0-9-]{0,48}$/.test(region)) throw new ViewerError('INVALID_ARGUMENT','Azure 区域应为 eastasia 等区域标识。');
    if (!key && !previous?.secret) throw new ViewerError('TRANSLATION_CREDENTIAL_REQUIRED',`请填写 ${names[input.provider]} 翻译密钥。`);
    if (key && !this.vault.available()) throw new ViewerError('CREDENTIAL_STORAGE_UNAVAILABLE','系统凭据加密暂不可用，未保存翻译密钥。');
    this.providers[input.provider]={secret:key?this.vault.encrypt(key):previous!.secret,appId:input.provider==='baidu'?appId:'',region:input.provider==='microsoft'?region:''};
    await this.persist();return this.snapshot();
  }
  async remove(provider: TranslationProviderId) { if (!isTranslationProvider(provider)) throw new ViewerError('INVALID_ARGUMENT','未知的普通翻译服务。');delete this.providers[provider];await this.persist();return this.snapshot(); }
  capture(provider: TranslationProviderId) {
    if (!isTranslationProvider(provider)) throw new ViewerError('INVALID_ARGUMENT','未知的普通翻译服务。');
    if (!this.configured(provider)) throw new ViewerError('TRANSLATION_CREDENTIAL_REQUIRED',`请先在“翻译”设置中保存 ${names[provider]} 的官方 API 凭据。`);
    const stored = this.providers[provider]!;let key: string;
    try { key=this.vault.decrypt(stored.secret); } catch { throw new ViewerError('CREDENTIAL_STORAGE_UNAVAILABLE','无法解密翻译凭据，请在本机重新保存。'); }
    const config = { provider,key,appId:stored.appId,region:stored.region };
    return { engine:provider,model:names[provider]+' · 普通翻译',fingerprint:createHash('sha256').update(JSON.stringify(config)).digest('hex'),translate:async(source:string,language:string,signal:AbortSignal)=>{
      const target=providerTargetLanguage(provider,language),results:string[]=[];
      for(const part of splitTranslationSource(source)){
        assertTranslationActive(signal);if(!part.trim()){results.push(part);continue;}
        const leading=/^\s*/.exec(part)![0],trailing=/\s*$/.exec(part)![0];
        const request=()=>this.request(config,part.trim(),target,signal);
        const translated=provider==='baidu'?await this.baiduQueue(request,signal):await request();
        results.push(leading+translated+trailing);
      }
      assertTranslationActive(signal);return results.join('');
    } };
  }
  private baiduQueue<T>(request:()=>Promise<T>,signal:AbortSignal) {
    const work=this.baiduTail.then(async()=>{assertTranslationActive(signal);const wait=Math.max(0,this.baiduStarted+(this.options.baiduIntervalMs??1000)-Date.now());if(wait)await delay(wait,undefined,{signal});assertTranslationActive(signal);this.baiduStarted=Date.now();return request();});
    this.baiduTail=work.then(()=>{},()=>{});return abortable(work,signal);
  }
  private async request(config:{provider:TranslationProviderId;key:string;appId:string;region:string},text:string,target:string,caller:AbortSignal) {
    const {provider,key,appId,region}=config,signal=AbortSignal.any([caller,AbortSignal.timeout(this.options.timeoutMs??30000)]);
    const headers:Record<string,string>={'Content-Type':'application/json; charset=utf-8'};let url:string,body:string;
    if(provider==='google'){url='https://translation.googleapis.com/language/translate/v2';headers['X-Goog-Api-Key']=key;body=JSON.stringify({q:text,target,format:'text'});}
    else if(provider==='baidu'){url='https://fanyi-api.baidu.com/api/trans/vip/translate';headers['Content-Type']='application/x-www-form-urlencoded';const salt=randomBytes(16).toString('hex'),sign=createHash('md5').update(appId+text+salt+key,'utf8').digest('hex');body=new URLSearchParams({q:text,from:'auto',to:target,appid:appId,salt,sign}).toString();}
    else{url='https://api.cognitive.microsofttranslator.com/translate?api-version=3.0&textType=plain&to='+encodeURIComponent(target);headers['Ocp-Apim-Subscription-Key']=key;if(region)headers['Ocp-Apim-Subscription-Region']=region;headers['X-ClientTraceId']=randomUUID();body=JSON.stringify([{Text:text}]);}
    try{
      const response=await abortable((this.options.fetch??globalThis.fetch)(url,{method:'POST',headers,body,signal,redirect:'error'}),signal);
      if(!response.ok){await response.body?.cancel();throw providerError(provider,response.status,response.status);}
      if(!response.body)throw providerError(provider,'EMPTY');
      const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
      try{for(;;){const item=await abortable(reader.read(),signal);if(item.done)break;size+=item.value.byteLength;if(size>1024*1024)throw new ViewerError('TRANSLATION_RESPONSE_LIMIT','翻译服务响应过大，已停止读取。');chunks.push(item.value);}}finally{await reader.cancel().catch(()=>{});}
      const data=JSON.parse(Buffer.concat(chunks).toString('utf8'));let result:unknown;
      if(provider==='google')result=data.data?.translations?.[0]?.translatedText;
      else if(provider==='baidu'){if(data.error_code)throw providerError(provider,String(data.error_code));if(Array.isArray(data.trans_result)&&data.trans_result.every((item:Record<string,unknown>)=>typeof item.dst==='string'))result=data.trans_result.map((item:{dst:string})=>item.dst).join('\n');}
      else result=data[0]?.translations?.[0]?.text;
      if(typeof result!=='string'||!result.trim())throw new ViewerError('TRANSLATION_EMPTY',`${names[provider]} 没有返回有效译文。`);
      assertTranslationActive(signal);return provider==='google'?decodeGoogleText(result).trim():result.trim();
    }catch(error){
      assertTranslationActive(caller);if(signal.aborted)throw new ViewerError('REQUEST_TIMEOUT',`${names[provider]} 翻译请求超时，请重试。`);
      if(error instanceof ViewerError)throw error;
      throw new ViewerError('TRANSLATION_NETWORK',`${names[provider]} 翻译连接失败或返回了无效数据，请检查网络及服务状态。`);
    }
  }
}
