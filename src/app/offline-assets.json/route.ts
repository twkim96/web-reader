import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const dynamic = 'force-static';

export function GET() {
  // Render this response during next build so the hosting adapter publishes
  // it alongside the page and the exact chunks the root page will request.
  let assets: string[] = [];
  if (process.env.NODE_ENV === 'production') {
    const path = join(process.cwd(), '.next/server/app/page/react-loadable-manifest.json');
    const manifest: Record<string, { files: string[] }> = JSON.parse(readFileSync(path, 'utf8'));
    const files = [...new Set(Object.values(manifest).flatMap(({ files }) => files))].sort();
    if (!files.length || files.some(file => !/^static\/(?:immutable\/)?chunks\/[\w.-]+\.(?:js|css)$/.test(file))) {
      throw new Error('Unexpected dynamic assets for the offline root page.');
    }
    assets = files.map(file => `/_next/${file}`);
  }

  return Response.json({ buildId: process.env.NEXT_PUBLIC_APP_BUILD_ID, assets }, {
    headers: { 'Cache-Control': 'no-cache' },
  });
}
