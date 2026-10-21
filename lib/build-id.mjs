import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';

export async function coreBuildId(root) {
  const files = ['server.mjs', 'lib/coordinator.mjs', 'lib/http-server.mjs', 'lib/owner-access.mjs', 'lib/aliases.mjs', 'lib/policy.mjs', 'lib/build-id.mjs', 'lib/roadmap.mjs', 'lib/rules.mjs', 'lib/storage.mjs'];
  const hash = createHash('sha256');for (const file of files) {hash.update(file + '\0');hash.update(await readFile(path.join(root, file)));}
  return hash.digest('hex').slice(0, 24);
}
