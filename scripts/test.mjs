import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { assertCurrentBuild } from './build-identity.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = join(root, 'tests');
const suite = JSON.parse(await readFile(join(testRoot, 'suite.json'), 'utf8'));
const mode = process.argv[2] ?? 'unit';
if (process.argv.length > 3 || !['unit', 'desktop', 'office', 'full', 'list'].includes(mode)) {
  throw new Error('Usage: node scripts/test.mjs [unit|desktop|office|full|list]');
}

function testPath(file) {
  const path = resolve(testRoot, file);
  if (relative(testRoot, path).startsWith('..') || path === testRoot) throw new Error('Invalid test path: ' + file);
  return path;
}

const units = await Promise.all(suite.unit.map(async file => {
  const source = ts.createSourceFile(file, await readFile(testPath(file), 'utf8'), ts.ScriptTarget.Latest, true);
  const titles = [];
  function visit(node) {
    if (ts.isCallExpression(node) && (ts.isIdentifier(node.expression) && node.expression.text === 'test'
      || ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
        && (node.expression.expression.text === 'test' || node.expression.expression.text === 't' && node.expression.name.text === 'test'))) {
      if (!ts.isIdentifier(node.expression) || !ts.isExpressionStatement(node.parent)
        || node.parent.parent !== source || !ts.isStringLiteral(node.arguments[0])) {
        throw new Error(file + ': use explicit top-level tests; nested/dynamic/disabled cases are not allowed');
      }
      titles.push(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  if (!titles.length) throw new Error('No tests found: ' + file);
  return { file, titles };
}));
const unitCount = units.reduce((total, entry) => total + entry.titles.length, 0);
const desktopCount = suite.integration.filter(entry => entry.runtime === 'electron').reduce((total, entry) => total + entry.cases.length, 0);
const engineCount = suite.integration.filter(entry => entry.runtime === 'engine').reduce((total, entry) => total + entry.cases.length, 0);
const total = unitCount + desktopCount + engineCount;
if (total > 50) throw new Error(`Test budget exceeded: ${total}/50`);
const registered = new Set([...suite.unit, ...suite.integration.map(entry => entry.file)]);
for (const entry of suite.integration) {
  if (!entry.cases.length || !['electron', 'engine'].includes(entry.runtime)) throw new Error('Invalid integration flow: ' + entry.id);
  await readFile(testPath(entry.file));
}
for (const entry of await readdir(testRoot, { recursive: true, withFileTypes: true })) {
  if (!entry.isFile() || !/\.(test|e2e|integration)\.ts$/.test(entry.name)) continue;
  const file = relative(testRoot, join(entry.parentPath, entry.name)).replaceAll('\\', '/');
  if (!registered.has(file)) throw new Error('Unregistered test outside the 50-case budget: ' + file);
}
console.log(`Test budget: ${unitCount} unit tests (includes simulations) + ${desktopCount} production Electron flows + ${engineCount} engine flows = ${total}/50`);
if (mode === 'list') {
  for (const entry of units) for (const title of entry.titles) console.log('  [unit] ' + title);
  for (const entry of suite.integration) for (const title of entry.cases) console.log(`  [${entry.runtime}:${entry.id}] ${title}`);
  process.exit(0);
}

const identity = mode === 'unit' ? undefined : await assertCurrentBuild();
const temporary = await mkdtemp(join(tmpdir(), 'agentviewer-suite-'));
const artifact = join(root, 'artifacts', 'verification', mode);
const baseEnv = { ...process.env, TEMP: temporary, TMP: temporary };
for (const key of ['ELECTRON_RUN_AS_NODE', 'AGENTVIEWER_TEST_MODE', 'AGENTVIEWER_TEST_TRANSLATOR', 'AGENTVIEWER_VITE_URL', 'AGENTVIEWER_OFFICE_WORKER_MODE', 'AGENTVIEWER_QA_ONLY', 'AGENTVIEWER_QA_EXE', 'AGENTVIEWER_QA_DIR', 'AGENTVIEWER_QA_WIDTH', 'AGENTVIEWER_QA_HEIGHT', 'AGENTVIEWER_AUTHORING_ONLY', 'AGENTVIEWER_EXPORT_ADAPTER']) delete baseEnv[key];
try {
  const local = JSON.parse(await readFile(join(root, '.agentviewer/test-runtime.json'), 'utf8'));
  if (!baseEnv.AGENTVIEWER_ENGINES_DIR && typeof local.enginesDir === 'string') baseEnv.AGENTVIEWER_ENGINES_DIR = local.enginesDir;
} catch (error) { if (error.code !== 'ENOENT') throw error; }
const report = { mode, passed: false, build: identity, unitTests: mode === 'unit' || mode === 'full' ? unitCount : 0, flows: [], temporary };
await mkdir(artifact, { recursive: true });

function run(args, env = {}) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...baseEnv, ...env }, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 && signal === null ? done() : reject(new Error(`Test process failed: exit=${code}, signal=${signal}`)));
  });
}
try {
  if (mode === 'unit' || mode === 'full') await run(['--import', 'tsx', '--test', ...units.map(entry => testPath(entry.file))]);
  const selected = mode === 'unit' ? [] : suite.integration.filter(entry => mode === 'full' || (mode === 'office' ? entry.id.startsWith('office') : entry.runtime === 'electron'));
  for (const entry of selected) {
    const before = new Set(await readdir(temporary)), began = Date.now();
    console.log('\nCurrent production flow: ' + entry.id + ' (' + entry.runtime + ')');
    await run(['--import', 'tsx', testPath(entry.file)], entry.env);
    const destination = join(artifact, entry.id);
    await rm(destination, { recursive: true, force: true });
    let captured = false;
    for (const name of await readdir(temporary)) {
      if (before.has(name)) continue;
      const candidate = join(temporary, name);
      if ((await readdir(candidate, { withFileTypes: true }).catch(() => [])).some(item => item.name === 'evidence' && item.isDirectory())) {
        await cp(join(candidate, 'evidence'), destination, { recursive: true }); captured = true;
      } else if ((await readdir(candidate).catch(() => [])).includes('result.json')) {
        await mkdir(destination, { recursive: true });
        for (const file of ['result.json', 'build-identity.json']) await cp(join(candidate, file), join(destination, file));
        captured = true;
      }
    }
    if (!captured) throw new Error('CURRENT_EVIDENCE_MISSING: ' + entry.id);
    report.flows.push({ id: entry.id, runtime: entry.runtime, cases: entry.cases, passed: true, elapsedMs: Date.now() - began, evidence: relative(root, destination).replaceAll('\\', '/') });
  }
  if (identity) await assertCurrentBuild();
  report.passed = true;
} catch (error) {
  report.error = String(error);
  throw error;
} finally {
  report.completedAt = new Date().toISOString();
  if (report.passed) {
    if (dirname(temporary) !== resolve(tmpdir()) || !temporary.startsWith(join(resolve(tmpdir()), 'agentviewer-suite-'))) throw new Error('Unexpected owned suite directory');
    await rm(temporary, { recursive: true, force: true });
    report.temporaryRemoved = true;
  }
  await writeFile(join(artifact, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('Verification report: ' + join(artifact, 'report.json'));
}
