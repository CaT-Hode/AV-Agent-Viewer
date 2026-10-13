import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { ViewerError } from '../../contracts/src/index';
import { babelDocLaunch, type EngineLaunch } from '../../engines/src/index';
import { assertTranslationActive } from './request';

export type PdfTranslationResult = { bytes: Uint8Array; warnings: string[] };
export class BabelDocAdapter {
  constructor(readonly directory: string, readonly generatePrompt: (prompt: string, signal: AbortSignal) => Promise<string>, readonly launch: EngineLaunch | undefined = babelDocLaunch(process.cwd())) {}
  get command() { return this.launch?.command ?? '未配置'; }
  available() { return !!this.launch; }
  async translate(bytes: Uint8Array, language: string, signal: AbortSignal): Promise<PdfTranslationResult> {
    assertTranslationActive(signal);
    if (!['zh-CN','en'].includes(language)) throw new ViewerError('CAPABILITY_UNSUPPORTED', 'BabelDOC 当前接入仅开放中文或英文目标语言。');
    const jobDirectory = resolve(join(this.directory, randomUUID())), output = join(jobDirectory, 'output'), input = join(jobDirectory, 'source.pdf');
    await mkdir(output, { recursive: true }); await writeFile(input, bytes);
    assertTranslationActive(signal);
    const token = randomUUID();
    const server = createServer(async (request, response) => {
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions' || request.headers.authorization !== 'Bearer ' + token) { response.writeHead(403); response.end(); return; }
      try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of request) { size += chunk.length; if (size > 4_000_000) throw new Error('请求体过大'); chunks.push(chunk); }
        const payload = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages?: { role?: string; content?: string | { type?: string; text?: string }[] }[] };
        const prompt = (payload.messages ?? []).map(message => message.role + ': ' + (typeof message.content === 'string' ? message.content : (message.content ?? []).map(part => part.text ?? '').join('\n'))).join('\n\n');
        assertTranslationActive(signal);
        const answer = await this.generatePrompt(prompt, signal);
        assertTranslationActive(signal);
        response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({ id: randomUUID(), object: 'chat.completion', choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }] }));
      } catch (error) { response.writeHead(500, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : String(error) } })); }
    });
    let diagnostic = '';
    try {
      await new Promise<void>((done, fail) => { server.listen(0, '127.0.0.1', done); server.once('error', fail); });
      assertTranslationActive(signal);
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('本地翻译桥启动失败');
      const args = ['--files', input, '--output', output, '--no-dual', '--no-auto-extract-glossary', '--qps', '2', '--watermark-output-mode', 'no_watermark', '--openai', '--openai-base-url', 'http://127.0.0.1:' + address.port + '/v1', '--openai-api-key', token, '--openai-model', 'agentviewer', '--lang-in', language === 'en' ? 'zh-CN' : 'en', '--lang-out', language];
      await new Promise<void>((done, fail) => {
        assertTranslationActive(signal);
        if (!this.launch) { fail(new ViewerError('ENGINE_REQUIRED', '未找到内置 BabelDOC 引擎。')); return; }
        const child = spawn(this.launch.command, [...this.launch.argsPrefix, ...args], { cwd: jobDirectory, env: { ...process.env, ...this.launch.env }, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
        const onOutput = (chunk: Buffer) => { diagnostic = (diagnostic + chunk.toString()).slice(-3000); };
        child.stdout.on('data', onOutput); child.stderr.on('data', onOutput);
        const cancel = () => child.kill(); signal.addEventListener('abort', cancel, { once: true });
        if (signal.aborted) cancel();
        child.on('error', error => { signal.removeEventListener('abort', cancel); fail(error); });
        child.on('exit', code => { signal.removeEventListener('abort', cancel); if (signal.aborted) fail(new ViewerError('CANCELLED', 'PDF 翻译已取消。')); else if (code === 0) done(); else fail(new ViewerError('BABELDOC_FAILED', 'BabelDOC 未完成：' + diagnostic.slice(-700))); });
      });
      assertTranslationActive(signal);
      const names = (await readdir(output)).filter(name => name.endsWith('.mono.pdf'));
      if (names.length !== 1) throw new ViewerError('BABELDOC_OUTPUT_MISSING', 'BabelDOC 未产生唯一的独立单语 PDF。');
      const result = new Uint8Array(await readFile(join(output, names[0])));
      assertTranslationActive(signal);
      if (result.length < 100 || new TextDecoder().decode(result.slice(0, 4)) !== '%PDF') throw new ViewerError('BABELDOC_OUTPUT_INVALID', '译文 PDF 不完整。');
      return { bytes: result, warnings: ['PDF 版面由 BabelDOC 重建；扫描件、图片内文字与复杂图表请人工检查。'] };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new ViewerError('ENGINE_REQUIRED', '未找到 BabelDOC。请安装后设置 AGENTVIEWER_BABELDOC。');
      throw error;
    } finally { await new Promise<void>(done => { server.close(() => done()); if (signal.aborted) server.closeAllConnections(); }); }
  }
}
