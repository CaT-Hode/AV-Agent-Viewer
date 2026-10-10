import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface WorkspaceRepository { load<T>(): Promise<T | undefined>; save(value: unknown): Promise<void> }
export class JsonWorkspaceRepository implements WorkspaceRepository {
  private pending = Promise.resolve();
  constructor(readonly path: string) {}
  async load<T>() { try { return JSON.parse(await readFile(this.path, 'utf8')) as T; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error; } }
  save(value: unknown) {
    const payload = JSON.stringify(value);
    this.pending = this.pending.catch(() => {}).then(async () => {
      await mkdir(dirname(this.path), { recursive: true });
      const temp = this.path + '.tmp'; await writeFile(temp, payload, { mode: 0o600 }); await rename(temp, this.path);
    });
    return this.pending;
  }
}
