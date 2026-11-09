import { execFileSync } from 'node:child_process';
import { expect, test } from './fixtures';

test('sync recovery notice stays inside the viewport in every menu material', async ({ page, request }) => {
  const html = await (await request.get('/')).text();
  const styles = html.match(/<link\b[^>]*rel="stylesheet"[^>]*>/g) ?? [];
  expect(styles.length).toBeGreaterThan(0);
  // Render the actual component with tsx rather than Playwright's JSX transform.
  const notice = execFileSync(process.execPath, ['--import', 'tsx', '-e', `
    const React = require('react');
    const { renderToStaticMarkup } = require('react-dom/server');
    const { SyncRecoveryNotice } = require('./src/components/reader/SyncRecoveryNotice.tsx');
    process.stdout.write(renderToStaticMarkup(React.createElement(SyncRecoveryNotice, {
      visible: true, busy: false, onMove() {}, onDismiss() {},
    })));
  `], { encoding: 'utf8' });
  await page.route('**/__sync-notice-fixture', route => route.fulfill({
    contentType: 'text/html',
    body: `<!doctype html><html data-viewer-menu-style="glass"><head><meta charset="utf-8">${styles.join('')}</head>
      <body style="margin:0;--viewer-theme-bg:#141517;--viewer-theme-text:#d2d3d6">
      <main style="height:100vh;overflow:hidden"><div style="height:100%">Reader content</div>${notice}</main></body></html>`,
  }));
  await page.goto('/__sync-notice-fixture');
  const panel = page.locator('[data-sync-recovery-notice]');
  for (const [width, height] of [[1280, 800], [600, 900], [320, 640]]) {
    await page.setViewportSize({ width, height });
    for (const material of ['glass', 'standard', 'modern']) {
      await page.locator('html').evaluate((root, material) => root.setAttribute('data-viewer-menu-style', material), material);
      await expect(panel).toHaveCSS('position', 'fixed');
      const box = (await panel.boundingBox())!;
      expect(box.x, `${material} ${width}: left edge`).toBeGreaterThanOrEqual(8);
      expect(box.x + box.width, `${material} ${width}: right edge`).toBeLessThanOrEqual(width - 8);
      expect(box.y, `${material} ${width}: top edge`).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height, `${material} ${width}: bottom edge`).toBeLessThanOrEqual(height - 16);
      expect(box.y, `${material} ${width}: near bottom`).toBeGreaterThan(height / 2);
      for (const button of await panel.getByRole('button').all()) {
        await expect(button).toBeInViewport({ ratio: 1 });
      }
    }
  }
});
