import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const processes = [];
const userDataDir = await mkdtemp(join(tmpdir(), 'web-reader-chromium-'));

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

try {
  start('npm', ['run', 'start', '--', '--hostname', '127.0.0.1', '--port', '3000']);
  await waitForUrl('http://127.0.0.1:3000', 'Next production server');

  start(chromium.executablePath(), [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=9223',
    `--user-data-dir=${userDataDir}`,
    'about:blank',
  ]);
  await waitForUrl('http://127.0.0.1:9223/json/version', 'Chromium CDP endpoint');

  await waitForExit(start(process.execPath, ['tests/browserRegression.mjs'], {
    env: {
      ...process.env,
      APP_URL: 'http://127.0.0.1:3000',
      CHROME_DEBUG_URL: 'http://127.0.0.1:9223',
    },
  }));
} finally {
  for (const child of processes.reverse()) {
    if (child.exitCode == null && child.signalCode == null) child.kill('SIGTERM');
  }
  await rm(userDataDir, { recursive: true, force: true });
}
