import { test as base } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export { expect } from '@playwright/test';

export const test = base.extend({
  context: async ({ browserName, context, playwright, headless, launchOptions }, runTestWithContext) => {
    if (browserName !== 'webkit') {
      await runTestWithContext(context);
      return;
    }

    // Ephemeral WebKit sessions reject Blob and File values in IndexedDB.
    // Use a clean, disposable profile to exercise the real storage path.
    const profile = await mkdtemp(join(tmpdir(), 'web-reader-webkit-'));
    try {
      const persistent = await playwright.webkit.launchPersistentContext(profile, { ...launchOptions, headless });
      try {
        await runTestWithContext(persistent);
      } finally {
        await persistent.close();
      }
    } finally {
      await rm(profile, { recursive: true, force: true });
    }
  },
});
