import test from 'node:test';
import assert from 'node:assert/strict';

import nextConfig from '../next.config.ts';

test('allows Google Identity popup communication through COOP', async () => {
  const rules = await nextConfig.headers();
  const catchAll = rules.find(({ source }) => source === '/:path*');
  assert.ok(catchAll);
  assert.deepEqual(
    catchAll.headers.find(({ key }) => key === 'Cross-Origin-Opener-Policy'),
    { key: 'Cross-Origin-Opener-Policy', value: 'same-origin-allow-popups' },
  );
});
