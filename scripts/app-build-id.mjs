import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

// Content based so uncommitted fixes and repeated builds of one version are covered.
export const computeAppBuildId = (root, publicEnv = {}) => {
  const hash = createHash('sha256');
  const add = (path) => {
    hash.update(relative(root, path));
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  };
  const walk = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) add(path);
    }
  };
  for (const directory of ['src', 'public']) walk(join(root, directory));
  for (const file of ['package.json', 'package-lock.json', 'next.config.ts', 'scripts/app-build-id.mjs']) add(join(root, file));
  hash.update(JSON.stringify(Object.entries(publicEnv)
    .filter(([key]) => key.startsWith('NEXT_PUBLIC_') && key !== 'NEXT_PUBLIC_APP_BUILD_ID')
    .sort(([a], [b]) => a.localeCompare(b))));
  return hash.digest('hex').slice(0, 20);
};
