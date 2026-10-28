import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { NativeOfficeRuntime } from '../packages/office-runtime/src/index';

// Explicit packaging command, never called by frontend build or ordinary app startup.
// npx tsx scripts/generate-office-bootstrap-seed.ts [LibreOffice program directory]
const root=resolve('.'),program=resolve(process.argv[2]??'.engines/libreoffice-stage/program');
const output=join(root,'dist','main','office-kit-bootstrap');
assert.ok(existsSync(join(program,'soffice.exe'))&&existsSync(join(program,'mergedlo.dll')),'A complete staged Windows engine is required.');
assert.ok(existsSync(join(root,'dist','main','office-kit-windows.dll')),'Build the verified native adapter before generating the seed.');
const dataDir=await mkdtemp(join(tmpdir(),'agentviewer-docless-bootstrap-'));
const runtime=new NativeOfficeRuntime({appRoot:root,dataDir,sofficePath:join(program,'soffice.exe'),bootstrapSeedPath:join(dataDir,'no-existing-seed'),requestTimeoutMs:90000});
const began=performance.now();let nativePid:number|undefined;
const watchdog=setTimeout(()=>{const worker=(runtime as unknown as {worker?:{pid?:number;kill():void}}).worker;nativePid=worker?.pid;worker?.kill();},120000);watchdog.unref();
try{
  const seed=await runtime.bootstrapSeed();
  assert.equal(seed.manifest.schemaVersion,1);assert.equal(seed.manifest.pathMode,'registration-macros');
  await mkdir(output,{recursive:true});
  for(const item of seed.manifest.files){
    assert.match(item.blob,/^payload\/[0-9a-f]{32}$/);
    const destination=resolve(output,item.blob),scope=relative(output,destination);
    assert.ok(scope&&!scope.startsWith('..'+sep)&&!scope.startsWith(sep),'Seed output escaped its generated artifact.');
    const bytes=await readFile(join(seed.directory,item.blob));
    assert.equal(bytes.length,item.bytes);
    await mkdir(dirname(destination),{recursive:true});await writeFile(destination,bytes);
  }
  const manifestTemp=join(output,'manifest.pending.json');await writeFile(manifestTemp,JSON.stringify(seed.manifest,null,2)+'\n');await rename(manifestTemp,join(output,'manifest.json'));
  console.log(JSON.stringify({output,files:seed.manifest.files.length,bytes:seed.manifest.files.reduce((sum,item)=>sum+item.bytes,0),elapsedMs:Math.round(performance.now()-began),scope:'Docless bootstrap registration only. No document, credentials, history, hardware cache or live profile.'}));
}finally{
  clearTimeout(watchdog);await runtime.shutdown({discard:true});
  if(nativePid)console.error('The owned bootstrap worker exceeded its deadline; no user process was stopped.');
}
