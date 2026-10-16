import { readFile, readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const testRoot = join(root, 'tests');
const suite = JSON.parse(await readFile(join(testRoot, 'suite.json'), 'utf8'));
const mode = process.argv[2] ?? 'unit';
if (process.argv.length > 3 || !['unit', 'desktop', 'office', 'list'].includes(mode)) {
  throw new Error('Usage: node scripts/test.mjs [unit|desktop|office|list]');
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
console.log(`Test budget: ${unitCount} regular tests + ${desktopCount} Electron flows + ${engineCount} engine flows = ${total}/50`);
if (mode === 'list') {
  for (const entry of units) for (const title of entry.titles) console.log('  [unit] ' + title);
  for (const entry of suite.integration) for (const title of entry.cases) console.log(`  [${entry.runtime}:${entry.id}] ${title}`);
  process.exit(0);
}

function run(args, env = {}) {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, env: { ...process.env, ...env }, stdio: 'inherit', windowsHide: true });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 && signal === null ? done() : reject(new Error(`Test process failed: exit=${code}, signal=${signal}`)));
  });
}
if (mode === 'unit' || mode === 'office') {
  const selected = mode === 'office' ? units.filter(entry => /^(office-editing|native-office-mapped-shape-style)\./.test(entry.file)) : units;
  await run(['--import', 'tsx', '--test', ...selected.map(entry => testPath(entry.file))]);
}
if (mode === 'desktop' || mode === 'office') {
  for (const entry of suite.integration.filter(entry => mode === 'office' ? entry.id.startsWith('office') : entry.runtime === 'electron')) {
    console.log('\nIntegration flow: ' + entry.id + ' (' + entry.runtime + ')');
    await run(['--import', 'tsx', testPath(entry.file)], entry.env);
  }
}
