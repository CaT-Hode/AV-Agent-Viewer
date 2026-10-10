import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const root = resolve(import.meta.dirname, '..');
const svg = await readFile(resolve(root, 'apps/desktop/src/renderer/assets/agentviewer-logo.svg'));
await mkdir(resolve(root, 'assets'), { recursive: true });
const browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 }, deviceScaleFactor: 1 });
  const image = 'data:image/svg+xml;base64,' + svg.toString('base64');
  await page.setContent(`<html><body style="margin:0;width:512px;height:512px;display:grid;place-items:center;background:transparent"><img src="${image}" style="display:block;width:496px;height:auto" /></body></html>`);
  await page.screenshot({ path: resolve(root, 'assets/agentviewer-icon.png'), omitBackground: true });
} finally { await browser.close(); }
