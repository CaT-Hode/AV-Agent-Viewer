import assert from 'node:assert/strict';
import { _electron as electron, type Page } from 'playwright';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Actual Chromium compositing and computed paint, in an isolated profile.
// This intentionally opens no Office document and never changes authored files.
const require = createRequire(import.meta.url), directory = await mkdtemp(join(tmpdir(), 'agentviewer-frosted-shadow-'));
const evidence = join(directory, 'evidence'); await mkdir(evidence);
const port = await new Promise<number>((done, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const address = server.address(); assert.ok(address && typeof address !== 'string'); server.close(error => error ? reject(error) : done(address.port)); }); });
const env = { ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string,string] => typeof entry[1] === 'string')), AGENTVIEWER_DATA_DIR: directory, AGENTVIEWER_PORT: String(port) };
for (const key of ['ELECTRON_RUN_AS_NODE','AGENTVIEWER_TEST_MODE','AGENTVIEWER_VITE_URL','AGENTVIEWER_OFFICE_WORKER_MODE']) delete (env as Record<string,string>)[key];
const app = await electron.launch({ executablePath: require('electron'), args: ['.'], cwd: resolve('.'), env, timeout: 60000 });
const main = await app.firstWindow(), errors: string[] = [], checks: unknown[] = [];
const watch = (page: Page) => { page.on('pageerror', error => errors.push(error.message)); page.on('console', entry => { if (entry.type() === 'error') errors.push(entry.text()); }); }; watch(main); app.context().on('page',watch);
const invoke = <T>(page: Page, method: string, args: Record<string,unknown> = {}) => page.evaluate(input => window.agentViewer!.call(input.method,input.args),{method,args}) as Promise<T>;
const until = async (check: () => Promise<boolean>, label: string) => { const deadline = Date.now() + 20000; while (Date.now() < deadline) { if (await check()) return; await new Promise(done => setTimeout(done,80)); } throw new Error(label); };
const inspect = async (page: Page, label: string) => {
  const data = await page.evaluate(String.raw`(() => {
    const split = value => { const parts = []; let depth = 0, start = 0; for (let i = 0; i < value.length; i++) { if (value[i] === '(') depth++; else if (value[i] === ')') depth--; else if (value[i] === ',' && !depth) { parts.push(value.slice(start,i)); start=i+1; } } parts.push(value.slice(start)); return parts; };
    const darkInset = value => split(value).filter(shadow => { if (!shadow.includes('inset')) return false; const color=shadow.match(/rgba?\(([^)]+)\)/); if (!color) return false; const channels=color[1].split(/[\s,\/]+/).map(Number); return (channels[3] ?? 1) > 0 && channels.slice(0,3).every(channel=>channel < 180); });
    const visible = node => { const rect=node.getBoundingClientRect(); return rect.width>0 && rect.height>0 && getComputedStyle(node).visibility!=='hidden'; };
    const frosts = [...document.querySelectorAll('.material-host')].filter(node=>visible(node) && node.querySelector(':scope > .liquid-glass-surface[data-glass-effect="frosted"]'));
    const rows = frosts.map(host=> { const highlight=host.querySelector(':scope > .liquid-glass-surface > .liquid-glass-highlight'), center=host.querySelector(':scope > .liquid-glass-surface > .liquid-glass-center'); const body=getComputedStyle(host), rim=highlight?getComputedStyle(highlight):{boxShadow:'none'}, cast=getComputedStyle(host,'::after'); return { className:host.className, hostShadow:body.boxShadow, highlightShadow:rim.boxShadow, castShadow:cast.boxShadow, castZ:cast.zIndex, filter:center?getComputedStyle(center).backdropFilter:'none', darkInsets:[...darkInset(body.boxShadow),...darkInset(rim.boxShadow),...darkInset(cast.boxShadow)] }; });
    const ordinary = [...document.querySelectorAll('.settings-nav,.settings-group-card,.settings-search,.app-tooltip-content')].filter(visible).map(node=>({className:node.className,shadow:getComputedStyle(node).boxShadow,darkInsets:darkInset(getComputedStyle(node).boxShadow)}));
    const refractive=[...document.querySelectorAll('.liquid-glass-surface[data-glass-effect="refractive"]')].filter(visible).map(node=>({variant:node.dataset.glassVariant,className:node.className}));
    return {theme:document.documentElement.dataset.theme, rows, ordinary, refractive};
  })()` ) as { theme?: string; rows: {className:string;hostShadow:string;highlightShadow:string;castShadow:string;castZ:string;filter:string;darkInsets:string[]}[];ordinary:{className:string;shadow:string;darkInsets:string[]}[];refractive:unknown[] };
  assert.ok(data.rows.length>0,label+' contains actual frosted materials');
  for (const row of [...data.rows,...data.ordinary]) assert.deepEqual(row.darkInsets,[],`${label}: dark inset ${row.className}`);
  for (const row of data.rows.filter(row=>!row.className.includes('app-tooltip'))) { assert.equal(row.hostShadow,'none',label+' cast must be above its own optical sampling'); assert.notEqual(row.castShadow,'none',label+' outer cast remains'); assert.equal(row.castZ,'2'); }
  checks.push({label,...data}); await page.screenshot({path:join(evidence,label+'.png'),scale:'css'});
};
try {
  await main.locator('.prose h1').waitFor({timeout:60000});
  await invoke(main,'settings-set',{id:'appearance.motion',value:'off'}); await invoke(main,'settings-set',{id:'appearance.glass',value:'standard'}); await invoke(main,'settings-set',{id:'appearance.autoHideToolbar',value:false});
  for (const theme of ['light','dark']) {
    await invoke(main,'settings-set',{id:'appearance.theme',value:theme}); await main.locator(`html[data-theme="${theme}"]`).waitFor();
    if (!await main.locator('.format-sidebar').isVisible()) await main.getByRole('button',{name:'目录与结构',exact:true}).click();
    await main.getByRole('button',{name:'AI 工具',exact:true}).click(); await main.locator('.ai-drawer').waitFor(); await inspect(main,'reader-'+theme);
    if (theme==='dark' && process.env.AGENTVIEWER_QA_SHADOW_DIAGNOSTIC==='1') {
      const noCast=await main.addStyleTag({content:'.material-host:has(> .liquid-glass-surface[data-glass-effect="frosted"])::after { box-shadow:none!important; }'}); await main.screenshot({path:join(evidence,'diagnostic-reader-dark-no-cast.png'),scale:'css'}); await noCast.evaluate(node=>(node as Element).remove());
      const noRim=await main.addStyleTag({content:'.material-host > .liquid-glass-surface[data-glass-effect="frosted"] > .liquid-glass-highlight { box-shadow:none!important; }.material-host > .liquid-glass-surface[data-glass-effect="frosted"] > .liquid-glass-highlight::after { background:none!important; }'}); await main.screenshot({path:join(evidence,'diagnostic-reader-dark-no-white-rim.png'),scale:'css'}); await noRim.evaluate(node=>(node as Element).remove());
    }
    await main.getByRole('button',{name:'关闭 AI 抽屉',exact:true}).click();
    await main.locator('.top-utility button').hover(); await main.locator('.app-tooltip').waitFor(); await inspect(main,'tooltip-'+theme); await main.mouse.move(700,500);
    await main.keyboard.press('Control+l'); await main.getByRole('dialog').waitFor(); await inspect(main,'modal-'+theme); await main.keyboard.press('Escape'); await main.getByRole('dialog').waitFor({state:'hidden'});
  }
  await invoke(main,'settings-open',{category:'外观与布局'}); await until(async()=>app.context().pages().some(page=>page.url().includes('#/settings')),'settings opens in its own window');
  const settings=app.context().pages().find(page=>page.url().includes('#/settings'))!;
  await settings.getByRole('heading',{name:'外观与布局',exact:true}).waitFor();
  for (const theme of ['light','dark']) { await invoke(main,'settings-set',{id:'appearance.theme',value:theme}); await settings.locator(`html[data-theme="${theme}"]`).waitFor(); await inspect(settings,'settings-'+theme); }
  assert.deepEqual(errors,[]); await writeFile(join(evidence,'results.json'),JSON.stringify({passed:true,directory,evidence,checks,errors},null,2)); console.log('Actual frosted inner / outer shadow and preserved refractive surfaces: PASS',evidence);
} catch(cause) { await main.screenshot({path:join(evidence,'failure.png'),scale:'css'}).catch(()=>{}); await writeFile(join(evidence,'failure.json'),JSON.stringify({passed:false,cause:String(cause),checks,errors},null,2)); console.error('Frosted shadow evidence:',evidence); throw cause; }
finally { await app.close(); }
