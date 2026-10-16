import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import type { ViewerCore } from '../../document-core/src/index';
import { ViewerError } from '../../contracts/src/index';

export const markdownPreferencesSchema = z.object({
  themeCss: z.string().max(100000).default(''),
  keybindings: z.record(z.string().max(80)).default({}),
  imageRoot: z.string().max(4000).default(''),
  upload: z.object({ command: z.string().max(4000), args: z.array(z.string().max(4000)).max(100) }).nullable().default(null),
  export: z.object({ header: z.string().max(20000).default(''), footer: z.string().max(20000).default(''), templatePath: z.string().max(4000).default('') }).default({}),
}).strict();
export type MarkdownPreferences = z.infer<typeof markdownPreferencesSchema>;
type Store = { values: Map<string, MarkdownPreferences>; load: Promise<void>; pending: Promise<void>; path?: string };
const stores = new WeakMap<ViewerCore, Store>();
function store(core: ViewerCore) {
  let record = stores.get(core); if (record) return record;
  const repositoryPath = (core.repository as { path?: string }).path;
  const path = repositoryPath ? join(dirname(repositoryPath), 'markdown-preferences.json') : undefined;
  record = { values: new Map(), load: Promise.resolve(), pending: Promise.resolve(), path };
  const current = record;
  current.load = (async () => {
    if (!path) return;
    try { const saved = JSON.parse(await readFile(path, 'utf8')); for (const [id, preferences] of saved) current.values.set(id, markdownPreferencesSchema.parse(preferences)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  })();
  stores.set(core, record); return record;
}
export async function readMarkdownPreferences(core: ViewerCore, documentId: string) {
  core.getDocument(documentId); const record = store(core); await record.load;
  return { preferences: structuredClone(record.values.get(documentId) ?? markdownPreferencesSchema.parse({})) };
}
export async function saveMarkdownPreferences(core: ViewerCore, documentId: string, value: unknown) {
  const record = store(core); await record.load; core.getDocument(documentId);
  const preferences = markdownPreferencesSchema.parse(value);
  if (Object.keys(preferences.keybindings).length > 100) throw new ViewerError('INVALID_ARGUMENT', '快捷键配置最多 100 项。');
  record.values.set(documentId, preferences);
  const payload = JSON.stringify([...record.values]);
  record.pending = record.pending.catch(() => {}).then(async () => {
    if (!record.path) return;
    await mkdir(dirname(record.path), { recursive: true }); await writeFile(record.path + '.tmp', payload, { mode: 0o600 }); await rename(record.path + '.tmp', record.path);
  });
  await record.pending; core.event('markdown.preferences', { documentId }); return { preferences };
}
