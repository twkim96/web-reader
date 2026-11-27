import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// The root page's manifest describes the chunks its dynamic imports will
// actually request. Another route can have a different chunk layout.
const next = '.next';
// Hosting adapters can replace Next's BUILD_ID. Use the ID the installed
// worker will actually request, from the already-generated public script.
const workerBuild = await readFile(join(next, 'server/app/sw-build.js.body'), 'utf8');
const buildId = workerBuild.match(/^self\.PC_READER_BUILD_ID = "([a-f0-9]{20})";/)?.[1];
if (!buildId) throw new Error('Missing app build ID in the rendered service worker script.');
const manifest = JSON.parse(await readFile(join(next, 'server/app/page/react-loadable-manifest.json'), 'utf8'));
const assets = [...new Set(Object.values(manifest).flatMap(({ files }) => files))].sort();
const invalid = assets.filter(asset => typeof asset !== 'string' || !/^static\/(?:immutable\/)?chunks\/[\w.-]+\.(?:js|css)$/.test(asset));
if (!assets.length || invalid.length) {
  throw new Error(`Unexpected dynamic assets for the offline root page: ${JSON.stringify(invalid.slice(0, 5))}`);
}
await Promise.all(assets.map(asset => access(join(next, asset))));

const output = join(next, 'static', buildId);
await mkdir(output, { recursive: true });
await writeFile(join(output, 'offline-assets.json'), JSON.stringify(assets.map(asset => `/_next/${asset}`)));
