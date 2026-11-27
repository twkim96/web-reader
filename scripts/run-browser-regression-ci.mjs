import { spawn } from 'node:child_process';
import { chromium, devices, expect } from '@playwright/test';

const processes = [];
let browser;

const start = (command, args, options = {}) => {
  const child = spawn(command, args, { stdio: 'inherit', ...options });
  processes.push(child);
  return child;
};

const waitForUrl = async (url, label, timeout = 120_000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`${label} did not become ready: ${url}`);
};

const waitForExit = (child) => new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    if (code === 0) resolve();
    else reject(new Error(`browser regression exited with ${code ?? signal}`));
  });
});

const terminateAndWait = async (child) => {
  if (child.exitCode != null || child.signalCode != null) return;

  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const forceTimer = setTimeout(() => child.kill('SIGKILL'), 5_000);
    const fallbackTimer = setTimeout(resolve, 10_000);
    child.once('exit', () => {
      clearTimeout(forceTimer);
      clearTimeout(fallbackTimer);
      resolve();
    });
  });
};

const verifyFirstOfflineReaderOpen = async (browser, origin) => {
  const context = await browser.newContext({ ...devices['Pixel 7'], baseURL: origin });
  try {
    await context.route(url => url.origin !== origin, route => route.abort());
    await context.route(/\/__\/auth\/iframe(?:\?|$)/, route => route.fulfill({
      contentType: 'text/html', body: '<!doctype html><html></html>',
    }));
    await context.addInitScript(() => {
      localStorage.setItem('isGuest', 'true');
      localStorage.setItem('neverShowInstallPrompt', 'true');
    });
    const page = await context.newPage();
    await page.goto('/');
    await expect.poll(() => page.evaluate(async () => (
      (await navigator.serviceWorker.getRegistration())?.active?.state === 'activated'
    )), { timeout: 15_000 }).toBe(true);
    if (!await page.evaluate(() => Boolean(navigator.serviceWorker.controller))) {
      await page.goto('about:blank');
      await page.goto('/');
    }
    await page.waitForFunction(() => Boolean(navigator.serviceWorker.controller));

    const proof = 'Cold offline reader proof';
    await page.locator('button[title="Add Local Book"]:visible').first().click();
    await page.locator('input[type="file"]').setInputFiles({
      name: 'cold-offline-reader.txt', mimeType: 'text/plain', buffer: Buffer.from(`${proof}\n`.repeat(25)),
    });
    await page.getByRole('button', { name: '추가', exact: true }).click();
    const book = page.locator('[data-shelf-book-id]').filter({ hasText: 'cold-offline-reader' });
    await expect(book).toBeVisible({ timeout: 15_000 });
    await context.setOffline(true);
    await book.click();
    await page.waitForFunction(text => document.querySelector('foliate-view')?.renderer?.getContents()
      .some(({ doc }) => doc.body?.textContent?.includes(text)), proof, { timeout: 15_000 });
    console.log('First local TXT open rendered offline in a fresh production browser context.');
  } finally {
    await context.close();
  }
};

try {
  start('npm', ['run', 'start', '--', '--hostname', '127.0.0.1', '--port', '3000']);
  await waitForUrl('http://127.0.0.1:3000', 'Next production server');

  // Use Playwright's supported headless runtime and launch defaults. Launching
  // the headed executable with --headless=new can stall RAF on macOS.
  browser = await chromium.launch({
    headless: true,
    args: ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9223'],
  });
  await waitForUrl('http://127.0.0.1:9223/json/version', 'Chromium CDP endpoint');
  await verifyFirstOfflineReaderOpen(browser, 'http://127.0.0.1:3000');

  await waitForExit(start(process.execPath, ['tests/browserRegression.mjs'], {
    env: {
      ...process.env,
      APP_URL: 'http://127.0.0.1:3000',
      CHROME_DEBUG_URL: 'http://127.0.0.1:9223',
    },
  }));
} finally {
  await browser?.close();
  await Promise.all(processes.reverse().map(terminateAndWait));
}
