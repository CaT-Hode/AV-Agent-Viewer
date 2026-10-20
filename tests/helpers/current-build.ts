import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { assertCurrentBuild } from '../../scripts/build-identity.mjs';

// Direct execution must reject stale dist just like the registered runner.
const identity = await assertCurrentBuild();
export async function recordCurrentBuild(directory: string) {
  await writeFile(join(directory, 'build-identity.json'), JSON.stringify(identity, null, 2) + '\n');
}
