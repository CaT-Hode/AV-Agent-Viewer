import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createWorker } from 'tesseract.js';

const root = resolve('.'), lock = JSON.parse(await readFile(join(root, 'engines.lock.json'), 'utf8'));
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('当前内置引擎包只针对 Windows x64。');
const python = join(root, '.engines', 'babeldoc-runtime', 'python.exe');
const home = join(root, '.engines', 'babeldoc-home');
const libreoffice = join(root, '.engines', 'libreoffice-stage', 'program', 'soffice.com');
for (const path of [python, libreoffice, join(home, '.cache', 'babeldoc', 'models')]) assert.ok(existsSync(path), `缺少内置引擎资源：${path}`);
for (const name of Object.keys(lock.ocr.languages)) assert.ok(existsSync(join(root, 'assets', 'ocr', 'lang', name + '.traineddata.gz')), `缺少OCR语言包：${name}`);
const pandoc=spawnSync(join(root,lock.pandoc.runtimeFolder,'pandoc.exe'),['--version'],{encoding:'utf8',windowsHide:true,timeout:10000});
assert.equal(pandoc.status,0,pandoc.stderr||String(pandoc.error));assert.ok(pandoc.stdout.startsWith('pandoc '+lock.pandoc.version));
const babel = spawnSync(python, ['-m', 'babeldoc.main', '--version'], { encoding: 'utf8', windowsHide: true, timeout: 60_000, env: { ...process.env, USERPROFILE: home, HF_HUB_OFFLINE: '1' } });
assert.equal(babel.status, 0, babel.stderr || String(babel.error));
assert.match(babel.stdout, /0\.6\.4/);
const assetBase = join(home, '.cache', 'babeldoc');
for (const folder of ['models', 'fonts', 'cmap']) assert.ok((await readdir(join(assetBase, folder))).length > 0, `BabelDOC 离线资源为空：${folder}`);
const office = spawnSync(libreoffice, ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
assert.equal(office.status, 0, office.stderr || String(office.error));
assert.match(office.stdout, /26\.8\.1/);
const worker = await createWorker('eng', 1, { langPath: join(root, 'assets', 'ocr', 'lang'), gzip: true, cacheMethod: 'readOnly' });
try { const result = await worker.recognize(join(root, 'assets', 'ocr-english.png')); assert.match(result.data.text, /AGENT VIEWER 123/); }
finally { await worker.terminate(); }
console.log(JSON.stringify({ passed: true, engines: { babeldoc: babel.stdout.trim(), libreoffice: office.stdout.trim(), ocr: lock.ocr.version }, offlineAssets: ['eng', 'chi_sim', 'babeldoc-fonts', 'babeldoc-cmaps', 'babeldoc-layout'] }, null, 2));
