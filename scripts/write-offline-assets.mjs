import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// The root page's manifest describes the chunks its dynamic imports will
// actually request. Another route can have a different chunk layout.
const next = '.next';
const buildId = (await readFile(join(next, 'BUILD_ID'), 'utf8')).trim();
const manifest = JSON.parse(await readFile(join(next, 'server/app/page/react-loadable-manifest.json'), 'utf8'));
const assets = [...new Set(Object.values(manifest).flatMap(({ files }) => files))].sort();
if (!assets.length || assets.some(asset => !/^static\/chunks\/[\w.-]+\.(?:js|css)$/.test(asset))) {
  throw new Error('Expected dynamic assets for the offline root page. Check the Next.js build manifest.');
}
await Promise.all(assets.map(asset => access(join(next, asset))));

const output = join(next, 'static', buildId);
await mkdir(output, { recursive: true });
await writeFile(join(output, 'offline-assets.json'), JSON.stringify(assets.map(asset => `/_next/${asset}`)));
