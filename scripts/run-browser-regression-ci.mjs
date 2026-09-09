import { spawn } from 'node:child_process';
import { chromium } from '@playwright/test';

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
