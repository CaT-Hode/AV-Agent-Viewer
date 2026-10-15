import { _electron as electron, type Page } from 'playwright';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import assert from 'node:assert/strict';
import type { WorkspaceState } from '../packages/contracts/src/index';
import { NAVIGATION_METRICS } from '../apps/desktop/src/renderer/lib/navigation-optics';
import { navigationControlMetrics, type NavigationDensity } from '../apps/desktop/src/renderer/lib/navigation-lane';
import { REFRACTIVE_BLUR_LIMIT_PX } from '../apps/desktop/src/renderer/lib/glass-presets';

const require = createRequire(import.meta.url);
const directory = await mkdtemp(join(tmpdir(), 'agentviewer-navigation-'));
const qa = process.env.AGENTVIEWER_QA_DIR ? resolve(process.env.AGENTVIEWER_QA_DIR, 'ui-navigation') : join(directory, 'evidence');
await mkdir(qa, { recursive: true });
const port = await new Promise<number>((resolvePort, reject) => {
  const server = createServer(); server.once('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    server.close(error => error ? reject(error) : resolvePort(address.port));
  });
});
const env: Record<string, string> = {
  ...Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
  AGENTVIEWER_DATA_DIR: directory, AGENTVIEWER_PORT: String(port), AGENTVIEWER_TEST_MODE: '1', AGENTVIEWER_TEST_TRANSLATOR: '1',
};
delete env.ELECTRON_RUN_AS_NODE;
const scale=Number(process.env.AGENTVIEWER_QA_SCALE??1),clientWidth=Number(process.env.AGENTVIEWER_QA_WIDTH??(scale>=2?1080:1440)),clientHeight=Number(process.env.AGENTVIEWER_QA_HEIGHT??(scale>=2?676:900));
const releaseExecutable=process.env.AGENTVIEWER_QA_EXE?.trim(),executable=releaseExecutable?resolve(releaseExecutable):require('electron') as string,assetRoot=releaseExecutable?join(dirname(executable),'resources/app/dist'):resolve('dist');
const assets={executable,mainSha:createHash('sha256').update(await readFile(join(assetRoot,'main/index.cjs'))).digest('hex'),rendererIndex:await readFile(join(assetRoot,'renderer/index.html'),'utf8')};
const app = await electron.launch({ executablePath: executable, args: [...(releaseExecutable?[]:['.']),'--force-device-scale-factor='+scale], cwd: resolve('.'), env, timeout: 45000 });
const page = await app.firstWindow(), errors: string[] = [];
const processReceipt={launchPid:app.process().pid,mainPid:await app.evaluate(()=>process.pid),directory,qa,scale,assets};await writeFile(join(qa,'startup-receipt.json'),JSON.stringify(processReceipt,null,2));console.log('Navigation QA started',JSON.stringify({launchPid:processReceipt.launchPid,mainPid:processReceipt.mainPid,directory,qa,scale,mainSha:assets.mainSha}));
const watch = (target: Page) => {
  target.on('pageerror', error => errors.push(`${target.url()}: ${error.message}`));
  target.on('console', message => { if (/same key|unique.*key|Encountered two children/i.test(message.text())) errors.push(`${target.url()}: ${message.text()}`); });
};
app.context().pages().forEach(watch); app.context().on('page', watch);
const invoke = <T = unknown>(method: string, args: Record<string, unknown> = {}) => page.evaluate(value => window.agentViewer!.call(value.method, value.args), { method, args }) as Promise<T>;
const state = () => invoke<WorkspaceState>('state');
const until = async (check: () => Promise<boolean>, label: string) => {
  for (let attempt = 0; attempt < 100; attempt++) { if (await check()) return; await new Promise(resolveWait => setTimeout(resolveWait, 100)); }
  throw new Error(`等待失败：${label}`);
};
const setting = (id: string, value: unknown) => invoke('settings-set', { id, value });
const activeFormat = async () => { const current = await state(); return current.documents.find(document => document.id === current.views.find(view => view.id === current.activeViewId)?.documentId)?.format; };
const capsuleSelector = '.reader-toolbar > .floating-capsule.navigation-capsule';
const capsuleStyle = (target: Page) => target.locator(capsuleSelector).evaluate(element => {
  const style = getComputedStyle(element), glass = element.querySelector<HTMLElement>('.navigation-glass');
  const center = glass?.querySelector('.navigation-glass-center');
  const optical = center ? getComputedStyle(center) : undefined;
  const button = element.querySelector<HTMLButtonElement>('.icon-button')!, buttonStyle = getComputedStyle(button);
  return {
    height: element.getBoundingClientRect().height, border: style.borderTopWidth, borderStyle: style.borderTopStyle,
    radius: style.borderTopLeftRadius, blur: style.getPropertyValue('--navigation-blur').trim(),
    refractionWidth: style.getPropertyValue('--navigation-refraction-width').trim(),
    opticalFilter: optical ? optical.filter + ' ' + optical.backdropFilter : style.backdropFilter,
    gaussianBlur: Number(element.querySelector('feGaussianBlur')?.getAttribute('stdDeviation')),
    buttonWidth: button.getBoundingClientRect().width, buttonHeight: button.getBoundingClientRect().height,
    buttonRadius: buttonStyle.borderTopLeftRadius,
  };
});
const noOuterMask = async (target: Page, native = false) => {
  const surfaces = await target.evaluate(nativeSurface => {
    const selectors = nativeSurface ? ['html', 'body', '#root', '.native-toolbar', '.reader-toolbar'] : ['.reader-toolbar'];
    return selectors.flatMap(selector => [...document.querySelectorAll<HTMLElement>(selector)].map(element => {
      const style = getComputedStyle(element);
      return { selector, color: style.backgroundColor, image: style.backgroundImage, shadow: style.boxShadow, filter: style.backdropFilter, border: style.borderBottomWidth };
    }));
  }, native);
  for (const surface of surfaces) {
    assert.match(surface.color, /^(transparent|rgba\([^)]*,\s*0\))$/, `${surface.selector} draws a rectangular background`);
    assert.equal(surface.image, 'none', `${surface.selector} background image extends beyond the capsule`);
    assert.equal(surface.shadow, 'none', `${surface.selector} outer shadow`);
    assert.equal(surface.filter, 'none', `${surface.selector} outer backdrop`);
    assert.equal(surface.border, '0px', `${surface.selector} outer border`);
  }
  const geometry = await target.locator(capsuleSelector).evaluate(element => {
    const capsule = element.getBoundingClientRect(), glass = element.querySelector('.navigation-glass')!.getBoundingClientRect();
    return { opticalVisible: getComputedStyle(element.querySelector('.navigation-glass')!).display !== 'none', capsule: { x: capsule.x, y: capsule.y, width: capsule.width, height: capsule.height }, glass: { x: glass.x, y: glass.y, width: glass.width, height: glass.height } };
  });
  if (geometry.opticalVisible) {
    assert.ok(Math.abs(geometry.capsule.width - geometry.glass.width) <= 2, 'optical layer follows capsule width');
    assert.ok(Math.abs(geometry.capsule.height - geometry.glass.height) <= 2, 'optical layer follows capsule height');
  }
};
const nativeGeometry = () => app.evaluate(({ BrowserWindow }, rootUrl) => {
  const windows = BrowserWindow.getAllWindows(), root = windows.find(window => window.webContents.getURL() === rootUrl)!; const origin = root.getContentBounds();
  return windows.filter(window => window === root || window.getParentWindow() === root).flatMap(window => window.contentView.children.map((view: any) => {
    const rect = view.getBounds(), position = window.getContentBounds();
    return { url: view.webContents?.getURL() as string | undefined, bounds: { ...rect, x: rect.x + position.x - origin.x, y: rect.y + position.y - origin.y }, visible: view.getVisible() && window.isVisible(), host: window === root ? 'reader' : 'owned-overlay' };
  }));
}, page.url());
const toolbarVisible = async () => !!(await nativeGeometry()).find(view => view.url?.includes('#/web-toolbar'))?.visible;
const fixtureScript = <T = unknown>(script: string) => app.evaluate(async ({ webContents }, expression) => {
  const target = webContents.getAllWebContents().find(contents => contents.getURL().includes('/fixtures/interaction.html'));
  if (!target) throw new Error('fixture WebContents is unavailable');
  return target.executeJavaScript(expression);
}, script) as Promise<T>;
const webScroll = (y: number) => fixtureScript<number>(`window.scrollTo(0,${y}); window.scrollY`);
const fixtureUrl = `http://127.0.0.1:${port}/fixtures/interaction.html`;
const awaitFixtureUrl = (url: string) => until(async () => await fixtureScript<string>('location.href') === url, `fixture navigated to ${url}`);
const noRefraction = async (target: Page) => {
  const layers = await target.locator('.navigation-glass').evaluate(element => getComputedStyle(element).display === 'none' ? [] : [element, ...element.querySelectorAll<HTMLElement>('*')].flatMap(layer => [null, '::before', '::after'].map(pseudo => {
    const style = getComputedStyle(layer, pseudo);
    return { display: style.display, opacity: style.opacity, filter: style.filter, backdrop: style.backdropFilter };
  })));
  assert.ok(layers.every(layer => layer.display === 'none' || layer.opacity === '0' || !/url\(/.test(layer.filter + layer.backdrop)), 'refraction filters are disabled');
};
// CDP directed at a WebContents bypasses the OS overlay hit test. This small
// Windows helper targets only this private root HWND and uses actual SendInput.
const nativePointerScript=join(directory,'private-pointer.ps1'),run=promisify(execFile);
await writeFile(nativePointerScript,`param([long]$WindowHandle,[int]$ExpectedPid,[double]$X,[double]$Y,[double]$ViewportWidth,[double]$ViewportHeight,[string]$Action)
Add-Type -TypeDefinition @'
using System; using System.Runtime.InteropServices; using System.Text;
public static class QaPointer {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X,Y; }
 [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx,dy; public uint mouseData,dwFlags,time; public IntPtr extra; }
 [StructLayout(LayoutKind.Explicit,Size=40)] public struct INPUT { [FieldOffset(0)] public uint type; [FieldOffset(8)] public MOUSEINPUT mouse; }
 [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
 [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr value,out RECT rect);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr value,out RECT rect);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr value,StringBuilder text,int count);
 [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr value,ref POINT point);
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr value,out uint pid);
 [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr value);
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);
 [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT point);
 [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT point);
 [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr value,uint flags);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr value);
 [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetWindowLongPtr(IntPtr value,int index);
 [DllImport("user32.dll",SetLastError=true)] public static extern bool SetWindowPos(IntPtr value,IntPtr after,int x,int y,int width,int height,uint flags);
 [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr value,int attribute,out int result,int size);
 [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);
 [DllImport("user32.dll",SetLastError=true)] public static extern uint SendInput(uint count,INPUT[] values,int size);
 public static void MouseAt(int x,int y,bool click) {
  int left=GetSystemMetrics(76),top=GetSystemMetrics(77),width=GetSystemMetrics(78),height=GetSystemMetrics(79);
  if(width<=0||height<=0||x<left||y<top||x>=left+width||y>=top+height)throw new InvalidOperationException("Private pointer outside virtual desktop");
  int dx=Math.Min(65535,(int)Math.Floor((x-left+.5)*65536/width)),dy=Math.Min(65535,(int)Math.Floor((y-top+.5)*65536/height));
  const uint move=1|0x8000|0x4000;
  var values=click?new[]{new INPUT{mouse=new MOUSEINPUT{dx=dx,dy=dy,dwFlags=move|2}},new INPUT{mouse=new MOUSEINPUT{dx=dx,dy=dy,dwFlags=move|4}}}:new[]{new INPUT{mouse=new MOUSEINPUT{dx=dx,dy=dy,dwFlags=move|2048,mouseData=unchecked((uint)-360)}}};
  if(SendInput((uint)values.Length,values,40)!=(uint)values.Length)throw new InvalidOperationException("SendInput rejected");
 }
}
'@
$target=[IntPtr]$WindowHandle;[uint32]$ownerPid=0;[void][QaPointer]::GetWindowThreadProcessId($target,[ref]$ownerPid);if($ownerPid-ne$ExpectedPid){throw 'Private HWND identity mismatch'}
if([QaPointer]::SetThreadDpiAwarenessContext([IntPtr](-4))-eq[IntPtr]::Zero){throw 'DPI context rejected'}
[void][QaPointer]::SetForegroundWindow($target);Start-Sleep -Milliseconds 80
$topmost=[QaPointer]::SetWindowPos($target,[IntPtr](-1),0,0,0,0,83);Start-Sleep -Milliseconds 80
$rect=New-Object QaPointer+RECT;if(-not[QaPointer]::GetClientRect($target,[ref]$rect)){throw 'Client rect unavailable'}
$point=New-Object QaPointer+POINT;$point.X=[int][Math]::Round($X*($rect.Right-$rect.Left)/$ViewportWidth);$point.Y=[int][Math]::Round($Y*($rect.Bottom-$rect.Top)/$ViewportHeight)
if(-not[QaPointer]::ClientToScreen($target,[ref]$point)){throw 'Client origin unavailable'}
if(-not[QaPointer]::SetCursorPos($point.X,$point.Y)){throw 'Private pointer placement rejected'}
$cursor=New-Object QaPointer+POINT;if(-not[QaPointer]::GetCursorPos([ref]$cursor)-or$cursor.X-ne$point.X-or$cursor.Y-ne$point.Y){@{inputSent=$false;expectedCursor=@{x=$point.X;y=$point.Y};actualCursor=@{x=$cursor.X;y=$cursor.Y}}|ConvertTo-Json -Compress;throw 'Private pointer moved before input'}
$hit=[QaPointer]::WindowFromPoint($point);[uint32]$hitPid=0;[void][QaPointer]::GetWindowThreadProcessId($hit,[ref]$hitPid);$ancestor=[QaPointer]::GetAncestor($hit,2)
$class=New-Object System.Text.StringBuilder 256;[void][QaPointer]::GetClassName($hit,$class,256);$window=New-Object QaPointer+RECT;[void][QaPointer]::GetWindowRect($target,[ref]$window);$hitRect=New-Object QaPointer+RECT;[void][QaPointer]::GetWindowRect($ancestor,[ref]$hitRect);$cloaked=0;$cloakStatus=[QaPointer]::DwmGetWindowAttribute($target,14,[ref]$cloaked,4)
@{target=$WindowHandle;hit=$hit.ToInt64();ancestor=$ancestor.ToInt64();pid=$ownerPid;hitPid=$hitPid;class=$class.ToString();x=$point.X;y=$point.Y;action=$Action;foreground=[QaPointer]::GetForegroundWindow().ToInt64();visible=[QaPointer]::IsWindowVisible($target);topmost=$topmost;extendedStyle=[QaPointer]::GetWindowLongPtr($target,-20).ToInt64();targetRoot=[QaPointer]::GetAncestor($target,2).ToInt64();cloaked=$cloaked;cloakStatus=$cloakStatus;window=@{left=$window.Left;top=$window.Top;right=$window.Right;bottom=$window.Bottom};hitRoot=@{left=$hitRect.Left;top=$hitRect.Top;right=$hitRect.Right;bottom=$hitRect.Bottom};client=@{width=$rect.Right-$rect.Left;height=$rect.Bottom-$rect.Top};targetCorrect=($hitPid-eq$ExpectedPid-and$ancestor-eq$target)}|ConvertTo-Json -Compress -Depth 4
if($hitPid-ne$ExpectedPid){throw 'Private QA point is occluded by an external application; no input sent'}
if($ancestor-ne$target){throw 'Owned overlay intercepts private webpage target; no input sent'}
if($Action-eq'click'){[QaPointer]::MouseAt($point.X,$point.Y,$true)}elseif($Action-eq'wheel'){[QaPointer]::MouseAt($point.X,$point.Y,$false)}else{throw 'Unknown private pointer action'}
Start-Sleep -Milliseconds 100
$cursorAfter=New-Object QaPointer+POINT;[void][QaPointer]::GetCursorPos([ref]$cursorAfter)
@{afterInput=$true;foreground=[QaPointer]::GetForegroundWindow().ToInt64();hit=[QaPointer]::WindowFromPoint($point).ToInt64();cursor=@{x=$cursorAfter.X;y=$cursorAfter.Y};action=$Action}|ConvertTo-Json -Compress
`);
const osPointer=async(point:{x:number;y:number},action:'click'|'wheel')=>{
  const identity=await app.evaluate(({BrowserWindow},rootUrl)=>{const root=BrowserWindow.getAllWindows().find(window=>!window.isDestroyed()&&!window.webContents.isDestroyed()&&window.webContents.getURL()===rootUrl)!;root.setAlwaysOnTop(true);root.show();root.focus();const bytes=root.getNativeWindowHandle();return{handle:String(bytes.length>=8?bytes.readBigUInt64LE():bytes.readUInt32LE()),pid:process.pid};},page.url());
  const viewport=await page.evaluate(()=>({width:innerWidth,height:innerHeight,devicePixelRatio}));
  const candidates=await app.evaluate(({BrowserWindow,screen})=>({windows:BrowserWindow.getAllWindows().filter(window=>!window.isDestroyed()&&!window.webContents.isDestroyed()).map(window=>({id:window.id,parent:window.getParentWindow()?.id,handle:String(window.getNativeWindowHandle().readBigUInt64LE()),bounds:window.getBounds(),content:window.getContentBounds(),zoom:window.webContents.getZoomFactor(),visible:window.isVisible(),focused:window.isFocused(),url:window.webContents.getURL(),childUrls:window.contentView.children.map((child:any)=>child.webContents?.getURL())})),displays:screen.getAllDisplays().map(display=>({bounds:display.bounds,workArea:display.workArea,scaleFactor:display.scaleFactor}))}));
  await writeFile(join(qa,'native-pointer-candidates-'+action+'.json'),JSON.stringify({identity,viewport,point,candidates},null,2));
  try {
    const reply=await run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',nativePointerScript,identity.handle,String(identity.pid),String(point.x),String(point.y),String(viewport.width),String(viewport.height),action],{timeout:15000,windowsHide:true});
    const receipt=reply.stdout.trim().split(/\r?\n/).map(line=>JSON.parse(line) as Record<string,unknown>);
    await writeFile(join(qa,'native-pointer-receipt-'+action+'.json'),JSON.stringify(receipt,null,2));
    return receipt;
  } catch(error) { const failure=error as Error&{stdout?:string;stderr?:string};await writeFile(join(qa,'native-pointer-failure.json'),JSON.stringify({error:String(error),stdout:failure.stdout,stderr:failure.stderr},null,2));throw error; }
};

try {
  const placement=await app.evaluate(({ BrowserWindow,screen },size) => {const root=BrowserWindow.getAllWindows()[0];root.setContentSize(size.width,size.height);const secondary=screen.getAllDisplays().find(display=>display.id!==screen.getPrimaryDisplay().id&&display.workArea.width>=size.width&&display.workArea.height>=size.height);if(secondary)root.setPosition(secondary.workArea.x+Math.floor((secondary.workArea.width-size.width)/2),secondary.workArea.y+Math.floor((secondary.workArea.height-size.height)/2));return{bounds:root.getBounds(),display:screen.getDisplayMatching(root.getBounds())};},{width:clientWidth,height:clientHeight});
  await writeFile(join(qa,'private-window-placement.json'),JSON.stringify(placement,null,2));
  await page.locator('.prose h1').waitFor();
  await setting('appearance.theme', 'light'); await setting('appearance.motion', 'off');
  await setting('appearance.toolbarDelayMs', 10000); await setting('appearance.autoHideToolbar', true);
  await page.locator('html[data-theme="light"][data-motion="off"]').waitFor();
  await page.locator(capsuleSelector).waitFor();
  assert.equal(await page.locator(capsuleSelector).count(), 1);
  assert.equal((await page.locator('.capsule-document-title').innerText()).trim(), '欢迎.md');
  assert.doesNotMatch(await page.locator(capsuleSelector).innerText(), /[A-Z]:[\\/]|file:\/\//i, 'document path is absent');
  const localStyle = await capsuleStyle(page);
  assert.equal(localStyle.blur, NAVIGATION_METRICS.blur + 'px'); assert.equal(localStyle.refractionWidth, NAVIGATION_METRICS.bezelWidth + 'px');
  assert.match(localStyle.opticalFilter, /url\(/, 'document glass uses the source SVG optical pipeline');
  assert.equal(localStyle.gaussianBlur, Math.min(NAVIGATION_METRICS.blur, REFRACTIVE_BLUR_LIMIT_PX));
  const density = await page.locator('.navigation-toolbar').getAttribute('data-navigation-density') as NavigationDensity, metrics = navigationControlMetrics(density);
  assert.equal(localStyle.height, metrics.height); assert.equal(localStyle.radius, metrics.radius + 'px'); await noOuterMask(page);
  await page.screenshot({ path: join(qa, 'document-navigation.png'), scale: 'css' });

  // Real document history is exercised through the same common controls.
  await page.locator('.tab').filter({ hasText: '示例.pdf' }).locator('.tab-select').click();
  await page.locator('.pdf-page .textLayer span').first().waitFor();
  await page.locator(capsuleSelector).getByRole('button', { name: '后退', exact: true }).click();
  await page.locator('.prose h1').waitFor(); assert.equal(await activeFormat(), 'markdown');
  await page.locator(capsuleSelector).getByRole('button', { name: '前进', exact: true }).click();
  await page.locator('.pdf-page .textLayer span').first().waitFor(); assert.equal(await activeFormat(), 'pdf');
  await page.locator(capsuleSelector).getByRole('button', { name: '后退', exact: true }).click();
  await page.locator('.prose h1').waitFor();
  await page.mouse.move(700, 500);
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.locator('.document-content').evaluate(element => { element.scrollTop = 20; });
  await page.waitForTimeout(250); // Must observe the small-scroll frame, not just the final hidden state.
  assert.equal(await page.locator('.reader-toolbar').evaluate(element => getComputedStyle(element).opacity), '1', 'small scroll preserves navigation');
  await page.locator('.document-content').evaluate(element => { element.scrollTop = 180; });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.navigation-module')!).opacity === '0');
  await page.locator('.document-content').evaluate(element => { element.scrollTop = 0; });
  await page.waitForFunction(() => getComputedStyle(document.querySelector('.navigation-module')!).opacity === '1');

  await page.locator('.tab').filter({ hasText: '交互测试页' }).locator('.tab-select').click();
  await page.locator('.reader-format-web').waitFor();
  await until(async () => app.context().pages().some(target => target.url().includes('#/web-toolbar')), 'native shared toolbar created');
  const toolbar = app.context().pages().find(target => target.url().includes('#/web-toolbar'))!;
  await toolbar.locator(capsuleSelector).waitFor(); await until(toolbarVisible, 'native toolbar visible');
  await toolbar.locator('html[data-theme="light"][data-motion="off"]').waitFor();
  await toolbar.locator('.navigation-glass[data-source="sampled"]').waitFor();
  const nativeStyle = await capsuleStyle(toolbar);
  assert.match(nativeStyle.opticalFilter, /url\(/, 'sampled native glass uses the same source SVG pipeline');
  assert.equal(nativeStyle.gaussianBlur, Math.min(NAVIGATION_METRICS.blur, REFRACTIVE_BLUR_LIMIT_PX));
  for (const key of ['height', 'border', 'borderStyle', 'radius', 'blur', 'refractionWidth'] as const) {
    assert.equal(nativeStyle[key], localStyle[key], `local/native shared style: ${key}`);
  }
  const nativeMetrics=navigationControlMetrics(await toolbar.locator('.navigation-toolbar').getAttribute('data-navigation-density') as NavigationDensity);
  assert.equal(nativeStyle.height,60);assert.equal(nativeStyle.buttonWidth,nativeMetrics.buttonSize);assert.equal(nativeStyle.buttonHeight,nativeMetrics.buttonSize);assert.equal(nativeStyle.buttonRadius,nativeMetrics.buttonSize/2+'px');
  await noOuterMask(toolbar, true);
  const native = (await nativeGeometry()).find(view => view.url?.startsWith(fixtureUrl))!;
  const overlay = (await nativeGeometry()).find(view => view.url?.includes('#/web-toolbar'))!;
  assert.equal(native.visible,true,'underlying native webpage is visible');assert.equal(overlay.visible,true,'native toolbar host is visible');
  const reader = await page.locator('.reader-panel').boundingBox(); assert.ok(reader);
  assert.ok(Math.abs(native.bounds.y - reader.y) <= 2, 'native page begins at reader top, without a reserved rectangular header');
  assert.ok(Math.abs(overlay.bounds.width-native.bounds.width-2*NAVIGATION_METRICS.shadowGutter)<=2,'stable full reader host leaves capsule free to spring; its OS shape limits the hit region');
  assert.equal(overlay.bounds.height, NAVIGATION_METRICS.height + 2 * NAVIGATION_METRICS.shadowGutter);
  await setting('appearance.autoHideToolbar',false);
  const capsuleBox=(await toolbar.locator(capsuleSelector).boundingBox())!,point={x:reader.x+20,y:reader.y+NAVIGATION_METRICS.top+30};
  assert.ok(point.x<overlay.bounds.x+capsuleBox.x-NAVIGATION_METRICS.shadowGutter-8,'test target lies inside the transparent host, outside capsule/shadow shape');
  for(const surface of [native,overlay])assert.ok(point.x>=surface.bounds.x&&point.y>=surface.bounds.y&&point.x<surface.bounds.x+surface.bounds.width&&point.y<surface.bounds.y+surface.bounds.height,'OS test point lies within both actual underlying page and transparent host bounds');
  const fixtureViewport=await fixtureScript<{width:number;height:number}>('({width:innerWidth,height:innerHeight})');
  const pagePoint={x:(point.x-native.bounds.x)*fixtureViewport.width/native.bounds.width,y:(point.y-native.bounds.y)*fixtureViewport.height/native.bounds.height};
  await fixtureScript(`(() => { const button=document.createElement('button');button.id='qa-transparent-host-click';button.textContent='QA';button.style.cssText='position:fixed;left:${pagePoint.x-10}px;top:${pagePoint.y-10}px;width:24px;height:24px;padding:0;z-index:9999';window.__qaOutsideClicks=0;window.__qaPointerEvents=[];for(const type of ['pointermove','pointerdown','pointerup','click','wheel'])window.addEventListener(type,event=>window.__qaPointerEvents.push({type,target:event.target?.id,x:event.clientX,y:event.clientY,deltaY:event.deltaY}),true);button.onclick=()=>window.__qaOutsideClicks++;document.body.append(button); })()`);
  const pointerFixture=()=>fixtureScript(`(() => {const button=document.getElementById('qa-transparent-host-click'),box=button?.getBoundingClientRect(),hit=document.elementFromPoint(${pagePoint.x},${pagePoint.y});return{count:window.__qaOutsideClicks,events:window.__qaPointerEvents,button:box&&{x:box.x,y:box.y,width:box.width,height:box.height},hit:hit?.outerHTML,viewport:{width:innerWidth,height:innerHeight,devicePixelRatio},scrollY,visibility:document.visibilityState,focus:document.hasFocus()}})()`);
  await writeFile(join(qa,'native-fixture-before-click.json'),JSON.stringify({native,overlay,reader,point,pagePoint,fixture:await pointerFixture()},null,2));
  for(const target of [page,toolbar])await target.evaluate(()=>{(window as any).__qaSurfacePointerEvents=[];for(const type of ['pointermove','pointerdown','pointerup','click','wheel'])window.addEventListener(type,(event:any)=>(window as any).__qaSurfacePointerEvents.push({type,target:event.target?.outerHTML?.slice(0,350),x:event.clientX,y:event.clientY,deltaY:event.deltaY}),true);});
  const outsideClick=await osPointer(point,'click');
  try { await until(async()=>await fixtureScript<number>('window.__qaOutsideClicks')===1,'actual OS click reaches document below transparent host'); }
  finally { await writeFile(join(qa,'native-fixture-after-click.json'),JSON.stringify({fixture:await pointerFixture(),geometry:await nativeGeometry(),mainSurface:await page.evaluate(()=>(window as any).__qaSurfacePointerEvents),toolbarSurface:await toolbar.evaluate(()=>(window as any).__qaSurfacePointerEvents)},null,2)); }
  const beforeWheel=await fixtureScript<number>('scrollY'),outsideWheel=await osPointer(point,'wheel');await until(async()=>await fixtureScript<number>('scrollY')>beforeWheel+20,'actual OS wheel scrolls underlying webpage');
  await writeFile(join(qa,'native-transparent-hit-test.json'),JSON.stringify({scale,clientWidth,clientHeight,point,capsuleBox,native,overlay,outsideClick,outsideWheel,scrollAfter:await fixtureScript<number>('scrollY')},null,2));
  await fixtureScript('document.getElementById("qa-transparent-host-click").remove();window.scrollTo(0,0)');await setting('appearance.autoHideToolbar',true);
  for (const name of ['源码', '分栏', '撤销最近修改', '保存']) assert.equal(await toolbar.getByRole('button', { name, exact: true }).count(), 0, `web has no ${name} module`);
  assert.equal(await toolbar.locator('.view-modes').count(), 0);
  assert.equal(await toolbar.getByRole('textbox', { name: '网页地址', exact: true }).count(), 1);
  assert.equal(await toolbar.getByRole('button', { name: '建立阅读副本', exact: true }).count(), 1);
  assert.equal(await toolbar.getByRole('button', { name: '翻译网页', exact: true }).count(), 1);

  // All navigation stays on the bundled fixture; query variants exercise genuine native history.
  const firstUrl = fixtureUrl + '?navigation=first', secondUrl = fixtureUrl + '?navigation=second';
  await toolbar.getByRole('textbox', { name: '网页地址', exact: true }).fill(firstUrl); await toolbar.keyboard.press('Enter'); await awaitFixtureUrl(firstUrl);
  await toolbar.getByRole('textbox', { name: '网页地址', exact: true }).fill(secondUrl); await toolbar.keyboard.press('Enter'); await awaitFixtureUrl(secondUrl);
  await toolbar.getByRole('button', { name: '后退', exact: true }).click(); await awaitFixtureUrl(firstUrl);
  await toolbar.getByRole('button', { name: '前进', exact: true }).click(); await awaitFixtureUrl(secondUrl);
  await toolbar.getByRole('button', { name: '刷新', exact: true }).click(); await awaitFixtureUrl(secondUrl);
  await until(async () => await fixtureScript<string>('document.readyState') === 'complete', 'fixture reload complete');

  const sourceText = await fixtureScript<string>('document.getElementById("selectable").textContent');
  await toolbar.getByRole('button', { name: '翻译网页', exact: true }).click();
  await toolbar.getByRole('button', { name: '显示原文', exact: true }).waitFor();
  await until(async () => (await fixtureScript<string>('document.getElementById("selectable").textContent')).startsWith('【'), 'real in-place translation');
  assert.equal(await fixtureScript<string>('document.getElementById("name").placeholder'), '支持中文键盘输入', 'form input is excluded from replacement');
  await toolbar.getByRole('button', { name: '显示原文', exact: true }).click();
  await until(async () => await fixtureScript<string>('document.getElementById("selectable").textContent') === sourceText, 'restore original text');
  await toolbar.getByRole('button', { name: '翻译网页', exact: true }).waitFor();

  for (const [id, enabled, disabled] of [
    ['appearance.glass', 'off', 'standard'], ['appearance.highContrast', true, false], ['appearance.reduceTransparency', true, false],
  ] as const) {
    await setting(id, enabled);
    await until(async () => await toolbar.locator('html').getAttribute(id === 'appearance.highContrast' ? 'data-contrast' : 'data-glass') === (id === 'appearance.highContrast' ? 'high' : 'off'), `${id} synchronized to native`);
    await noRefraction(toolbar); await noOuterMask(toolbar, true);
    await setting(id, disabled);
    await until(async () => await toolbar.locator('html').getAttribute(id === 'appearance.highContrast' ? 'data-contrast' : 'data-glass') === 'standard', `${id} restored`);
  }

  // Address keyboard focus prevents scroll hiding; after blur the native page remains usable.
  await page.keyboard.press('Control+l');
  await toolbar.waitForFunction(() => document.activeElement?.classList.contains('address-input'));
  await webScroll(180); await page.waitForTimeout(1000); assert.equal(await toolbarVisible(), true, 'address focus retains toolbar');
  await toolbar.getByRole('textbox', { name: '网页地址', exact: true }).blur();
  await toolbar.mouse.move(2, 60); // Leave the capsule before exercising scroll; hover deliberately holds it open.
  await webScroll(0); await until(toolbarVisible, 'upward scroll restores native toolbar');
  await webScroll(20); await page.waitForTimeout(1000); assert.equal(await toolbarVisible(), true, 'small native scroll does not hide toolbar');
  await webScroll(220); await until(async () => !await toolbarVisible(), 'downward native scroll hides the complete overlay');
  await webScroll(0); await until(toolbarVisible, 'upward native scroll reveals capsule');
  await noOuterMask(toolbar, true);
  await toolbar.screenshot({ path: join(qa, 'native-navigation.png'), omitBackground: true, scale: 'css' });

  await toolbar.getByRole('button', { name: '建立阅读副本', exact: true }).click();
  await until(async () => await activeFormat() === 'html', 'reading copy opens a local HTML view');
  const copyState = await state(), copyView = copyState.views.find(view => view.id === copyState.activeViewId)!;
  const copy = copyState.documents.find(document => document.id === copyView.documentId)!;
  assert.match(copy.model.text ?? '', /这段文字用于验证/);
  assert.doesNotMatch(copy.model.text ?? '', /sample-secret-e2e|hidden-secret-e2e|<script[\s>]/i, 'reading copy excludes scripts and sensitive input values');
  await until(async () => !await toolbarVisible(), 'native navigation hides after local copy activation');
  await page.locator(capsuleSelector).waitFor();
  assert.equal((await page.locator(capsuleSelector).innerText()).includes(fixtureUrl), false, 'local copy uses its name rather than source URL');
  const chrome = await page.evaluate(() => ({ top: document.querySelector('.tab-strip')!.getBoundingClientRect().top, bottom: document.querySelector('.workbench')!.getBoundingClientRect().bottom, footers: document.querySelectorAll('.status-bar').length, shellScroll: document.querySelector('.app-shell')!.scrollTop, scroll: scrollY, height: innerHeight }));
  assert.equal(chrome.footers, 0, 'main window has no persistent footer');
  assert.ok(Math.abs(chrome.top) < 1 && Math.abs(chrome.bottom - chrome.height) < 1); assert.equal(chrome.shellScroll, 0); assert.equal(chrome.scroll, 0);
  await writeFile(join(qa, 'navigation-styles.json'), JSON.stringify({ assets,scale,clientWidth,clientHeight,localStyle, nativeStyle, native, overlay, chrome }, null, 2));
  assert.deepEqual(errors, []);
  console.log('Shared local/native navigation, capsule-only glass, module gating, history, translation, copy and scroll/focus: PASS', qa);
} catch (error) {
  await page.screenshot({ path: join(qa, 'failure-main.png'), scale: 'css' }).catch(() => {});
  const diagnostics = await page.evaluate(() => ({ url: location.href, navigation: [...document.querySelectorAll('.reader-toolbar')].map(element => ({
    format: element.getAttribute('data-navigation-format'), native: !!element.closest('.native-toolbar'), reader: element.closest('.reader-panel')?.className,
    ancestors: [...(function* () { let parent = element.parentElement; while (parent) { yield parent.tagName + '.' + parent.className; parent = parent.parentElement; } })()],
    html: element.outerHTML,
  })) })).catch(() => ({ unavailable: true }));
  await writeFile(join(qa, 'failure.json'), JSON.stringify({ error: String(error), diagnostics }, null, 2));
  console.error('Navigation regression evidence:', qa); throw error;
} finally {
  const child=app.process(),exit=new Promise<{code:number|null;signal:NodeJS.Signals|null}>((done,reject)=>{if(child.exitCode!==null){done({code:child.exitCode,signal:child.signalCode});return;}const timer=setTimeout(()=>reject(new Error('Private navigation QA did not exit naturally')),20000);child.once('exit',(code,signal)=>{clearTimeout(timer);done({code,signal});});});
  await app.close();const status=await exit;await writeFile(join(qa,'qa-exit.json'),JSON.stringify({pid:child.pid,...status},null,2));assert.equal(status.code,0);assert.equal(status.signal,null);
}
