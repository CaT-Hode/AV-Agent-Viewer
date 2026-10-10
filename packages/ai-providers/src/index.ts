import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { safeStorage } from 'electron';
import { ViewerError } from '../../contracts/src/index';

export type ProviderProtocol = 'openai-responses' | 'chat-completions' | 'anthropic-messages';
export type ToolRoute = 'selection' | 'full' | 'web' | 'chat';
export type ProviderProfile = { id: string; name: string; protocol: ProviderProtocol; baseUrl: string; modelId: string; enabled: boolean; hasKey: boolean };
type StoredProfile = Omit<ProviderProfile, 'hasKey'> & { secret?: string };
type ConnectionFile = { schemaVersion: 1; profiles: StoredProfile[]; routes: Record<ToolRoute, string> };
const defaults: Record<ToolRoute, string> = { selection: '', full: '', web: '', chat: '' };
function endpoint(profile: StoredProfile, suffix: string) { return profile.baseUrl.replace(/\/+$/, '') + suffix; }
async function parseResponse(response: Response) { const text = await response.text(); if (!response.ok) throw new ViewerError('PROVIDER_ERROR', response.status + ': ' + text.slice(0, 800)); try { return JSON.parse(text) as Record<string, unknown>; } catch { throw new ViewerError('PROVIDER_ERROR', '模型服务返回了非 JSON 内容。'); } }

export class AIConnectionService {
  private profiles: StoredProfile[] = [];
  private routes: Record<ToolRoute, string> = { ...defaults };
  constructor(readonly path: string) {}
  async load() { try { const data = JSON.parse(await readFile(this.path, 'utf8')) as Partial<ConnectionFile>; if (data.schemaVersion !== 1) throw new ViewerError('SCHEMA_MISMATCH', '模型连接配置版本不兼容。'); this.profiles = data.profiles ?? []; this.routes = { ...defaults, ...data.routes }; } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  snapshot() { return { profiles: this.profiles.map(({ secret: _secret, ...profile }) => ({ ...profile, hasKey: !!_secret })), routes: { ...this.routes } }; }
  private async persist() { await mkdir(dirname(this.path), { recursive: true }); const temp = this.path + '.' + randomUUID() + '.tmp'; await writeFile(temp, JSON.stringify({ schemaVersion: 1, profiles: this.profiles, routes: this.routes }, null, 2)); await rename(temp, this.path); }
  async upsert(input: { id?: string; name: string; protocol: ProviderProtocol; baseUrl: string; modelId: string; enabled?: boolean; apiKey?: string }) {
    if (!input.name.trim() || !input.modelId.trim() || !['openai-responses','chat-completions','anthropic-messages'].includes(input.protocol)) throw new ViewerError('INVALID_ARGUMENT', '连接名称、协议和模型 ID 必填。');
    const url = new URL(input.baseUrl); if (!['http:', 'https:'].includes(url.protocol)) throw new ViewerError('INVALID_URL', '模型地址只允许 HTTP(S)。');
    const existing = this.profiles.find(profile => profile.id === input.id);
    if (input.apiKey && !safeStorage.isEncryptionAvailable()) throw new ViewerError('CREDENTIAL_STORAGE_UNAVAILABLE', '系统凭据加密暂不可用，未保存密钥。');
    const profile: StoredProfile = { id: existing?.id ?? randomUUID(), name: input.name.trim(), protocol: input.protocol, baseUrl: url.toString().replace(/\/+$/, ''), modelId: input.modelId.trim(), enabled: input.enabled ?? true, secret: input.apiKey ? safeStorage.encryptString(input.apiKey).toString('base64') : existing?.secret };
    if (existing) this.profiles[this.profiles.indexOf(existing)] = profile; else this.profiles.push(profile);
    await this.persist(); return this.snapshot();
  }
  async remove(id: string) { this.profiles = this.profiles.filter(profile => profile.id !== id); for (const route of Object.keys(this.routes) as ToolRoute[]) if (this.routes[route] === id) this.routes[route] = ''; await this.persist(); return this.snapshot(); }
  async route(tool: ToolRoute, id: string) { if (id && !this.profiles.some(profile => profile.id === id && profile.enabled)) throw new ViewerError('TARGET_NOT_FOUND', '所选模型连接不可用。'); this.routes[tool] = id; await this.persist(); return this.snapshot(); }
  routeFor(tool: ToolRoute) { return this.routes[tool]; }
  profileFor(tool: ToolRoute) { const id = this.routes[tool]; return this.profiles.find(profile => profile.id === id && profile.enabled); }
  capture(tool: ToolRoute) { const source = this.profileFor(tool); if (!source) return undefined; const profile = structuredClone(source); return { fingerprint: createHash('sha256').update(JSON.stringify(profile)).digest('hex'), model: profile.protocol + ':' + profile.modelId, generate: (prompt: string, signal: AbortSignal) => this.generateProfile(profile, prompt, signal) }; }
  private key(profile: StoredProfile) { return profile.secret ? safeStorage.decryptString(Buffer.from(profile.secret, 'base64')) : ''; }
  private headers(profile: StoredProfile): Record<string, string> { const key = this.key(profile); return profile.protocol === 'anthropic-messages' ? { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' } : { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key }; }
  private async request(profile: StoredProfile, suffix: string, options: RequestInit, signal?: AbortSignal) { const headers = new Headers(this.headers(profile)); new Headers(options.headers).forEach((value, key) => headers.set(key, value)); return parseResponse(await fetch(endpoint(profile, suffix), { ...options, headers, signal })); }
  async discover(id: string) {
    const profile = this.profiles.find(item => item.id === id); if (!profile) throw new ViewerError('TARGET_NOT_FOUND', '模型连接不存在。');
    const path = profile.protocol === 'anthropic-messages' ? '/v1/models' : '/models';
    const data = await this.request(profile, path, { method: 'GET' });
    return ((data.data as { id?: string }[] | undefined) ?? []).map(model => model.id).filter((model): model is string => !!model).slice(0, 200);
  }
  async generate(tool: ToolRoute, prompt: string, signal: AbortSignal) {
    const profile = this.profileFor(tool); if (!profile) throw new ViewerError('MODEL_UNCONFIGURED', '此工具未选择可用模型连接。');
    return this.generateProfile(profile, prompt, signal);
  }
  async test(id: string) { const profile = this.profiles.find(item => item.id === id); if (!profile) throw new ViewerError('TARGET_NOT_FOUND', '模型连接不存在。'); return this.generateProfile(profile, 'Reply with OK.', new AbortController().signal); }
  private async generateProfile(profile: StoredProfile, prompt: string, signal: AbortSignal) {
    if (profile.protocol === 'anthropic-messages') {
      const data = await this.request(profile, '/v1/messages', { method: 'POST', body: JSON.stringify({ model: profile.modelId, max_tokens: 2048, messages: [{ role: 'user', content: prompt }] }) }, signal);
      const content = data.content as { type?: string; text?: string }[] | undefined; return content?.filter(block => block.type === 'text').map(block => block.text ?? '').join('') ?? '';
    }
    if (profile.protocol === 'chat-completions') {
      const data = await this.request(profile, '/chat/completions', { method: 'POST', body: JSON.stringify({ model: profile.modelId, messages: [{ role: 'user', content: prompt }] }) }, signal);
      return String((data.choices as { message?: { content?: string } }[] | undefined)?.[0]?.message?.content ?? '');
    }
    const data = await this.request(profile, '/responses', { method: 'POST', body: JSON.stringify({ model: profile.modelId, input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }] }) }, signal);
    if (typeof data.output_text === 'string') return data.output_text;
    return ((data.output as { content?: { type?: string; text?: string }[] }[] | undefined) ?? []).flatMap(item => item.content ?? []).filter(item => item.type === 'output_text').map(item => item.text ?? '').join('');
  }
}
