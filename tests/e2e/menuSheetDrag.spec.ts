import { expect, test } from '@playwright/test';

test('mobile sheet headers follow a drag, snap back, and dismiss without dragging desktop dialogs', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route(/\/__\/auth\/iframe(?:\?|$)/, route => route.fulfill({ contentType: 'text/html', body: '<html></html>' }));
  await page.goto('/');
  await page.evaluate(() => {
    localStorage.setItem('isGuest', 'true');
    localStorage.setItem('neverShowInstallPrompt', 'true');
    localStorage.setItem('viewer_settings', JSON.stringify({ autoOpenLastBook: false }));
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Guest Library', exact: true })).toBeVisible();
  const open = page.locator('[data-shelf-filter-control]:visible').first();
  const sheet = page.locator('[data-menu-sheet="true"]');
  const header = page.locator('[data-menu-sheet-header]');
  const drag = async (distance: number, cancel = false) => {
    const bounds = (await header.boundingBox())!;
    const start = { x: bounds.x + bounds.width * 0.6, y: bounds.y + bounds.height / 2 };
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x, start.y + distance, { steps: 5 });
    if (cancel) await header.dispatchEvent('pointercancel');
  };
  await open.click();
  await expect(sheet).toBeVisible();
  await drag(15);
  await expect(sheet).toHaveAttribute('data-sheet-dragging', 'true');
  await page.mouse.up();
  await expect(sheet).not.toHaveAttribute('data-sheet-dragging');
  await expect(sheet).toBeVisible();
  await expect(sheet).toHaveCSS('translate', /^0px(?: 0px)?$/);

  await drag(80, true);
  await page.mouse.up();
  await expect(sheet).toBeVisible();
  await expect(sheet).not.toHaveAttribute('data-sheet-dragging');
  await expect(sheet).toHaveCSS('translate', /^0px(?: 0px)?$/);

  await drag(80);
  await expect(sheet).toHaveAttribute('data-sheet-dragging', 'true');
  await expect.poll(() => sheet.evaluate(element => parseFloat((element as HTMLElement).style.getPropertyValue('--sheet-drag-y')))).toBeGreaterThan(60);
  await page.mouse.up();
  await expect(sheet).toBeHidden();

  await page.setViewportSize({ width: 1000, height: 800 });
  await open.click();
  await drag(100);
  await page.mouse.up();
  await expect(sheet).toBeVisible();
  await expect(sheet).not.toHaveAttribute('data-sheet-dragging');
  await header.getByRole('button', { name: '책장 정렬·필터 닫기', exact: true }).click();
  await expect(sheet).toBeHidden();
});
