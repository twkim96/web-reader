import assert from 'node:assert/strict';
import JSZip from 'jszip';
import { createSolidSevenZipFixture } from './solidSevenZipFixture.mjs';

const debugUrl = process.env.CHROME_DEBUG_URL ?? 'http://127.0.0.1:9223';
const appUrl = process.env.APP_URL ?? 'http://127.0.0.1:3000';
const sleep = (milliseconds) => new Promise((resolve) => {
  setTimeout(resolve, milliseconds);
});

const oversizedPng = new Uint8Array(24);
oversizedPng.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
new DataView(oversizedPng.buffer).setUint32(8, 13);
oversizedPng.set([0x49, 0x48, 0x44, 0x52], 12);
new DataView(oversizedPng.buffer).setUint32(16, 8193);
new DataView(oversizedPng.buffer).setUint32(20, 8192);
const oversizedArchive = new JSZip();
oversizedArchive.file('huge.png', oversizedPng);
const oversizedArchiveBase64 = Buffer.from(
  await oversizedArchive.generateAsync({ type: 'uint8array' }),
).toString('base64');
const solidArchiveBytes = await createSolidSevenZipFixture();
const solidArchiveBase64 = Buffer.from(solidArchiveBytes).toString('base64');

const page = await fetch(
  `${debugUrl}/json/new?${appUrl}/?browser-regression=${Date.now()}`,
  { method: 'PUT' },
).then((response) => response.json());
if (!page?.webSocketDebuggerUrl) {
  throw new Error(`Chrome page target not found at ${debugUrl}`);
}

const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener('open', resolve, { once: true });
  socket.addEventListener('error', reject, { once: true });
});

let nextId = 1;
const pending = new Map();
socket.addEventListener('message', ({ data }) => {
  const message = JSON.parse(data);
  if (!message.id || !pending.has(message.id)) return;
  const request = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

const evaluate = async (expression) => {
  const result = await command('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description
      ?? result.exceptionDetails.text,
    );
  }
  return result.result.value;
};

const waitFor = async (expression, label, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(expression);
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(100);
  }
  const body = await evaluate('document.body?.innerText?.slice(0, 1200) ?? ""')
    .catch(() => '');
  throw new Error(
    `Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}\n${body}`,
  );
};

const setInputValue = (selector, value) => evaluate(`(() => {
  const input = document.querySelector(${JSON.stringify(selector)});
  if (!input) return false;
  const setter = Object.getOwnPropertyDescriptor(
    HTMLInputElement.prototype,
    'value',
  ).set;
  setter.call(input, ${JSON.stringify(value)});
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return true;
})()`);

try {
  await command('Page.enable');
  await command('Runtime.enable');
  await command('Network.enable');
  await command('Network.setBypassServiceWorker', { bypass: true });
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await command('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      try {
        const storedSettings = JSON.parse(localStorage.getItem('viewer_settings') || '{}');
        localStorage.setItem('viewer_settings', JSON.stringify({
          ...storedSettings,
          theme: 'dark',
          accentColor: 'emerald'
        }));
      } catch {}
      requestAnimationFrame(() => {
        const rootStyle = getComputedStyle(document.documentElement);
        window.__themeBootstrapEarly = {
          rootThemeBg: rootStyle.getPropertyValue('--viewer-theme-bg').trim(),
          rootAccent: rootStyle.getPropertyValue('--accent-500').trim(),
          rootBackground: rootStyle.backgroundColor,
          bootstrapped: document.documentElement.dataset.viewerThemeBootstrapped,
        };
      });
      window.__regressionErrors = [];
      window.__regressionLongTasks = [];
      addEventListener('error', (event) => {
        window.__regressionErrors.push(String(event.error?.stack || event.message));
      });
      addEventListener('unhandledrejection', (event) => {
        window.__regressionErrors.push(String(event.reason?.stack || event.reason));
      });
      try {
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            window.__regressionLongTasks.push(entry.duration);
          }
        }).observe({ type: 'longtask', buffered: true });
      } catch {}
    })()`,
  });
  await command('Page.navigate', { url: appUrl });
  await waitFor(
    'document.readyState === "complete"',
    'initial production page',
  );
  assert.equal(
    await evaluate(`fetch('/sw-update-fixture.js').then((response) => response.status)`),
    404,
  );
  const themeBootstrapEarly = await waitFor(
    'window.__themeBootstrapEarly',
    'early theme bootstrap',
  );
  assert.equal(themeBootstrapEarly.rootThemeBg, '#272728');
  assert.equal(themeBootstrapEarly.rootAccent, '#10b981');
  assert.equal(themeBootstrapEarly.rootBackground, 'rgb(39, 39, 40)');

  await evaluate(`(() => {
    localStorage.setItem('isGuest', 'true');
    localStorage.setItem('web_reader_guest_install_id', 'browser-regression');
    localStorage.setItem('neverShowInstallPrompt', 'true');
    localStorage.setItem('shelf_viewMode', 'grid');
    localStorage.setItem('shelf_sortMode', 'recent');
    localStorage.removeItem('viewer_settings');
    localStorage.removeItem('last_reader_session');
    return true;
  })()`);

  await command('Page.reload', { ignoreCache: true });
  await waitFor(
    'document.querySelector("h1")?.textContent?.includes("Guest Library")',
    'empty guest shelf',
  );

  await evaluate(`new Promise((resolve, reject) => {
    const request = indexedDB.open('web-reader-db');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(
        ['metadata-v5', 'progress-v5'],
        'readwrite',
      );
      tx.objectStore('metadata-v5').clear();
      tx.objectStore('progress-v5').clear();
      const metadata = tx.objectStore('metadata-v5');
      for (let index = 0; index < 1100; index += 1) {
        const suffix = String(index).padStart(4, '0');
        metadata.put({
          ownerKey: 'guest:device-library|library:local',
          id: 'book-' + suffix,
          name: 'Book ' + suffix + '.epub',
          mimeType: 'application/epub+zip',
          size: 100,
          source: index < 100 ? 'local' : 'cloud',
          sourceFormat: 'epub',
          readerFormat: 'epub',
        });
      }
      const progress = tx.objectStore('progress-v5');
      progress.put({
        ownerKey: 'guest:browser-regression|library:local',
        bookId: 'book-0100',
        progressPercent: 50,
        lastRead: Date.parse('2026-06-14T10:00:00Z'),
      });
      progress.put({
        ownerKey: 'guest:browser-regression|library:local',
        bookId: 'book-0900',
        progressPercent: 50,
        lastRead: Date.parse('2026-06-14T11:00:00Z'),
      });
      progress.put({
        ownerKey: 'guest:browser-regression|library:local',
        bookId: 'book-0999',
        progressPercent: 100,
        lastRead: Date.parse('2026-06-14T12:00:00Z'),
      });
      progress.put({
        ownerKey: 'guest:browser-regression|library:local',
        bookId: 'book-0800',
        progressPercent: 0,
        lastRead: Date.parse('2026-06-14T13:00:00Z'),
      });
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => reject(tx.error);
    };
  })`);

  await command('Page.reload', { ignoreCache: true });
  await waitFor(
    'document.querySelector("h1")?.textContent?.includes("Guest Library")',
    'guest shelf',
  );
  await waitFor(
    'document.querySelectorAll("main h3").length === 50',
    'initial 50 shelf cards',
  );

  const initialShelf = await evaluate(`(() => ({
    cardCount: document.querySelectorAll('main h3').length,
    titles: [...document.querySelectorAll('main h3')]
      .slice(0, 4)
      .map((node) => node.textContent?.trim()),
  }))()`);
  assert.equal(initialShelf.cardCount, 50);
  assert.deepEqual(initialShelf.titles.slice(0, 2), ['Book 0900', 'Book 0100']);
  assert.ok(!initialShelf.titles.slice(0, 2).includes('Book 0999'));

  await evaluate(`(() => {
    const sentinel = document.querySelector('main')?.nextElementSibling;
    sentinel?.scrollIntoView({ block: 'center' });
    window.dispatchEvent(new Event('scroll'));
    return Boolean(sentinel);
  })()`);
  await waitFor(
    'document.querySelectorAll("main h3").length >= 100',
    'second shelf page',
  );
  const secondPageCount = await evaluate(
    'document.querySelectorAll("main h3").length',
  );
  assert.equal(secondPageCount, 100);

  await evaluate(`(() => {
    window.scrollTo(0, 0);
    window.__regressionLongTasks = [];
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.title === 'Search Books');
    button?.click();
    return Boolean(button);
  })()`);
  await waitFor(
    'Boolean(document.querySelector(\'input[placeholder="도서 이름으로 검색..."]\'))',
    'shelf search modal',
  );
  assert.equal(
    await setInputValue('input[placeholder="도서 이름으로 검색..."]', 'Book 0'),
    true,
  );
  await waitFor(
    `(() => {
      const modal = document.querySelector('div.fixed.inset-0');
      return modal && [...modal.querySelectorAll('button')]
        .filter((button) => button.textContent?.includes('Book')).length === 5;
    })()`,
    'five sorted search previews',
  );
  const previewTitles = await evaluate(`(() => {
    const modal = document.querySelector('div.fixed.inset-0');
    return [...modal.querySelectorAll('button')]
      .filter((button) => button.textContent?.includes('Book'))
      .slice(0, 2)
      .map((button) => button.textContent.replace(/\\s+/g, ' ').trim());
  })()`);
  assert.match(previewTitles[0], /Book 0900/);
  assert.match(previewTitles[1], /Book 0100/);

  assert.equal(
    await setInputValue('input[placeholder="도서 이름으로 검색..."]', 'Book 1099'),
    true,
  );
  const searchStarted = Date.now();
  await evaluate('document.querySelector(\'input[placeholder="도서 이름으로 검색..."]\')?.form?.requestSubmit()');
  await waitFor(
    `document.querySelectorAll('main h3').length === 1
      && document.querySelector('main h3')?.textContent?.includes('Book 1099')`,
    'full-set search result',
  );
  const searchDurationMs = Date.now() - searchStarted;
  assert.ok(searchDurationMs < 2_000, `Search took ${searchDurationMs}ms`);

  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.textContent?.trim() === 'Clear Filter');
    button?.click();
    return Boolean(button);
  })()`);
  await waitFor(
    'document.querySelectorAll("main h3").length === 50',
    'pagination reset after clearing search',
  );

  const sortStarted = Date.now();
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.title === '최근에 읽은 순');
    button?.click();
    return Boolean(button);
  })()`);
  await waitFor(
    `document.querySelector('main h3')?.textContent?.includes('Book 0100')`,
    'alpha sort result',
  );
  const sortDurationMs = Date.now() - sortStarted;
  assert.ok(sortDurationMs < 2_000, `Sort took ${sortDurationMs}ms`);

  const shelfMetrics = await evaluate(`(() => ({
    cardCount: document.querySelectorAll('main h3').length,
    firstTitles: [...document.querySelectorAll('main h3')]
      .slice(0, 3)
      .map((node) => node.textContent?.trim()),
    longTasks: window.__regressionLongTasks,
    errors: window.__regressionErrors,
  }))()`);
  assert.equal(shelfMetrics.cardCount, 50);
  assert.deepEqual(shelfMetrics.firstTitles.slice(0, 2), ['Book 0100', 'Book 0900']);
  assert.ok(
    Math.max(0, ...shelfMetrics.longTasks) < 1_000,
    `Shelf long task exceeded 1s: ${JSON.stringify(shelfMetrics.longTasks)}`,
  );
  assert.deepEqual(shelfMetrics.errors, []);

  await evaluate(`(() => {
    window.__archiveAlerts = [];
    window.__nativeArchiveAlert = window.alert;
    window.alert = (message) => window.__archiveAlerts.push(String(message));
    window.scrollTo(0, Math.min(
      320,
      Math.max(0, document.documentElement.scrollHeight - innerHeight),
    ));
    window.__modalScrollBefore = window.scrollY;
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.title === 'Add Local Book');
    button?.click();
    return Boolean(button);
  })()`);
  await waitFor(
    'Boolean(document.querySelector(\'input[type="file"]\'))',
    'archive import modal',
  );
  const modalScrollLock = await evaluate(`(() => ({
    scrollBefore: window.__modalScrollBefore,
    bodyPosition: document.body.style.position,
    bodyOverflow: document.body.style.overflow,
    bodyTop: document.body.style.top,
    htmlOverflow: document.documentElement.style.overflow,
  }))()`);
  assert.ok(modalScrollLock.scrollBefore > 0, JSON.stringify(modalScrollLock));
  assert.equal(modalScrollLock.bodyPosition, 'fixed');
  assert.equal(modalScrollLock.bodyOverflow, 'hidden');
  assert.equal(modalScrollLock.htmlOverflow, 'hidden');
  assert.equal(
    Number.parseFloat(modalScrollLock.bodyTop),
    -modalScrollLock.scrollBefore,
  );
  await command('Input.dispatchMouseEvent', {
    type: 'mouseWheel',
    x: 10,
    y: 10,
    deltaX: 0,
    deltaY: 600,
  });
  await sleep(100);
  assert.equal(
    await evaluate('document.body.style.top'),
    modalScrollLock.bodyTop,
  );
  await command('Emulation.setDeviceMetricsOverride', {
    width: 360,
    height: 640,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await evaluate(`(() => {
    const button = document.querySelector(
      'button[aria-label^="파일 형식별 용량 제한"]',
    );
    button?.click();
    return Boolean(button);
  })()`);
  await waitFor(
    `document.body.innerText.includes('TXT')
      && document.body.innerText.includes('50MB')
      && document.body.innerText.includes('100MB')
      && document.body.innerText.includes('200MB')
      && document.body.innerText.includes('300MB')`,
    'file size limit details',
  );
  const sizeLimitUi = await evaluate(`(() => {
    const input = document.querySelector('input[type="file"]');
    const modal = input?.parentElement;
    return {
      expanded: document.querySelector(
        'button[aria-label^="파일 형식별 용량 제한"]',
      )?.getAttribute('aria-expanded'),
      overflowY: modal ? getComputedStyle(modal).overflowY : '',
      maxHeight: modal ? getComputedStyle(modal).maxHeight : '',
      modalHeight: modal?.getBoundingClientRect().height ?? 0,
      viewportHeight: innerHeight,
      visualViewportHeight: visualViewport?.height ?? 0,
      horizontalOverflow: document.documentElement.scrollWidth - innerWidth,
    };
  })()`);
  assert.equal(sizeLimitUi.expanded, 'true');
  assert.equal(sizeLimitUi.overflowY, 'auto');
  assert.ok(
    sizeLimitUi.modalHeight <= sizeLimitUi.viewportHeight,
    JSON.stringify(sizeLimitUi),
  );
  assert.ok(sizeLimitUi.horizontalOverflow <= 0);
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate(`(() => {
    const bytes = Uint8Array.from(
      atob(${JSON.stringify(oversizedArchiveBase64)}),
      (character) => character.charCodeAt(0),
    );
    const file = new File([bytes], 'oversized.cbz', {
      type: 'application/vnd.comicbook+zip',
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.querySelector('input[type="file"]');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.files.length;
  })()`);
  await waitFor(
    `document.body.innerText.includes('oversized.cbz')`,
    'oversized archive selection',
  );
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.textContent?.trim() === '추가');
    button?.click();
    return Boolean(button);
  })()`);
  await waitFor(
    `(async () => {
      const request = indexedDB.open('web-reader-db');
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const ownerKey = 'guest:device-library|library:local';
      const tx = db.transaction('metadata-v5', 'readonly');
      const get = tx.objectStore('metadata-v5').get([ownerKey, 'oversized.cbz']);
      const value = await new Promise((resolve, reject) => {
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
      });
      db.close();
      return Boolean(value);
    })()`,
    'oversized archive import',
  );
  await waitFor(
    `!document.querySelector('input[type="file"]')`,
    'archive import modal close',
  );
  const modalScrollRestore = await evaluate(`(() => ({
    bodyPosition: document.body.style.position,
    bodyOverflow: document.body.style.overflow,
    htmlOverflow: document.documentElement.style.overflow,
    scrollY: window.scrollY,
    scrollBefore: window.__modalScrollBefore,
  }))()`);
  assert.equal(modalScrollRestore.bodyPosition, '');
  assert.equal(modalScrollRestore.bodyOverflow, '');
  assert.equal(modalScrollRestore.htmlOverflow, '');
  assert.ok(
    Math.abs(modalScrollRestore.scrollY - modalScrollRestore.scrollBefore) <= 1,
    JSON.stringify(modalScrollRestore),
  );
  await evaluate(`new Promise((resolve, reject) => {
    const request = indexedDB.open('web-reader-db');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const ownerKey = 'guest:device-library|library:local';
      const tx = db.transaction('metadata-v5', 'readwrite');
      const store = tx.objectStore('metadata-v5');
      const cursorRequest = store.openCursor();
      cursorRequest.onerror = () => reject(cursorRequest.error);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        if (cursor.value.ownerKey === ownerKey && cursor.value.id !== 'oversized.cbz') {
          cursor.delete();
        }
        cursor.continue();
      };
      tx.oncomplete = () => {
        db.close();
        resolve(true);
      };
      tx.onerror = () => reject(tx.error);
    };
  })`);
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.title === 'Manage Offline Books');
    button?.click();
    return Boolean(button);
  })()`);
  await waitFor(
    `[...document.querySelectorAll('h2')]
      .some((node) => node.textContent?.trim() === 'Offline Storage')`,
    'offline storage modal',
  );
  await waitFor(
    `Boolean([...document.querySelectorAll('div.fixed.inset-0')]
      .find((node) => node.querySelector('h2')?.textContent?.trim() === 'Offline Storage')
      ?.querySelector('button[title="Delete"]'))`,
    'offline storage delete button',
  );
  await evaluate(`(() => {
    const modal = [...document.querySelectorAll('div.fixed.inset-0')]
      .find((node) => node.querySelector('h2')?.textContent?.trim() === 'Offline Storage');
    const button = [...(modal?.querySelectorAll('button') ?? [])]
      .find((node) => node.title === 'Delete');
    button?.click();
    return Boolean(button);
  })()`);
  await waitFor(
    `[...document.querySelectorAll('p')]
      .some((node) => node.textContent?.trim() === '이 도서를 삭제하시겠습니까?')`,
    'nested delete confirmation',
  );
  const nestedModalLock = await evaluate(`(() => ({
    bodyPosition: document.body.style.position,
    confirmVisible: [...document.querySelectorAll('p')]
      .some((node) => node.textContent?.trim() === '이 도서를 삭제하시겠습니까?'),
  }))()`);
  assert.equal(nestedModalLock.bodyPosition, 'fixed');
  assert.equal(nestedModalLock.confirmVisible, true);
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.textContent?.trim() === '취소');
    button?.click();
    return Boolean(button);
  })()`);
  await waitFor(
    `![...document.querySelectorAll('p')]
      .some((node) => node.textContent?.trim() === '이 도서를 삭제하시겠습니까?')`,
    'nested delete confirmation close',
  );
  assert.equal(await evaluate('document.body.style.position'), 'fixed');
  await evaluate(`(() => {
    const heading = [...document.querySelectorAll('h2')]
      .find((node) => node.textContent?.trim() === 'Offline Storage');
    heading?.parentElement?.parentElement?.querySelector('button')?.click();
    return Boolean(heading);
  })()`);
  await waitFor(
    `![...document.querySelectorAll('h2')]
      .some((node) => node.textContent?.trim() === 'Offline Storage')`,
    'offline storage modal close',
  );
  assert.equal(await evaluate('document.body.style.position'), '');
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.title === 'Search Books');
    button?.click();
    return Boolean(button);
  })()`);
  await waitFor(
    'Boolean(document.querySelector(\'input[placeholder="도서 이름으로 검색..."]\'))',
    'archive search modal',
  );
  assert.equal(
    await setInputValue(
      'input[placeholder="도서 이름으로 검색..."]',
      'oversized',
    ),
    true,
  );
  await evaluate('document.querySelector(\'input[placeholder="도서 이름으로 검색..."]\')?.form?.requestSubmit()');
  await waitFor(
    `document.querySelectorAll('main h3').length === 1
      && document.querySelector('main h3')?.textContent?.includes('oversized')`,
    'oversized archive search result',
  );
  await evaluate(`(() => {
    window.__archiveCreatedUrls = 0;
    window.__nativeArchiveCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (...args) => {
      window.__archiveCreatedUrls += 1;
      return window.__nativeArchiveCreateObjectURL(...args);
    };
    document.querySelector('main h3')?.closest('.group')?.click();
  })()`);
  await waitFor(
    `window.__archiveAlerts.some((message) => message.includes('64MP 제한'))`,
    'oversized archive reader rejection',
  );
  const archiveLimitResult = await evaluate(`(() => {
    const result = {
      alerts: [...window.__archiveAlerts],
      createdUrls: window.__archiveCreatedUrls,
    };
    URL.createObjectURL = window.__nativeArchiveCreateObjectURL;
    window.alert = window.__nativeArchiveAlert;
    return result;
  })()`);
  assert.equal(archiveLimitResult.createdUrls, 0);
  assert.ok(archiveLimitResult.alerts.some((message) => (
    message.includes('64MP 제한')
  )));

  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.title === 'Add Local Book');
    button?.click();
    return Boolean(button);
  })()`);
  await waitFor(
    'Boolean(document.querySelector(\'input[type="file"]\'))',
    'selection TXT import modal',
  );
  await evaluate(`(() => {
    const text = Array.from({ length: 180 }, (_, index) => (
      'Selection probe paragraph ' + index + ' allows text range testing in paged reading mode.'
    )).join('\\n\\n');
    const file = new File([text], 'selection-probe.txt', { type: 'text/plain' });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.querySelector('input[type="file"]');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.files.length;
  })()`);
  await waitFor(
    `document.body.innerText.includes('selection-probe.txt')`,
    'selection TXT selection',
  );
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.textContent?.trim() === '추가');
    button?.click();
    return Boolean(button);
  })()`);
  await waitFor(
    `(async () => {
      const request = indexedDB.open('web-reader-db');
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction('metadata-v5', 'readonly');
      const get = tx.objectStore('metadata-v5').get([
        'guest:device-library|library:local',
        'selection-probe.txt',
      ]);
      const value = await new Promise((resolve, reject) => {
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
      });
      db.close();
      return Boolean(value);
    })()`,
    'selection TXT import',
  );
  await evaluate(`(() => {
    const settings = JSON.parse(localStorage.getItem('viewer_settings') || '{}');
    localStorage.setItem('viewer_settings', JSON.stringify({
      ...settings,
      navMode: 'left-right',
    }));
    localStorage.removeItem('last_reader_session');
  })()`);
  await command('Page.reload', { ignoreCache: true });
  await waitFor(
    `document.querySelector("h1")?.textContent?.includes("Guest Library")
      && !document.querySelector('foliate-view')`,
    'selection TXT shelf reload',
  );
  await evaluate(`(async () => {
    const staleCache = await caches.open('pc-reader-v1.7.10');
    await staleCache.put('/foliate-js/view.js', new Response(
      'throw new Error("stale Foliate runtime loaded")',
      { headers: { 'Content-Type': 'text/javascript' } },
    ));
    return Boolean(await staleCache.match('/foliate-js/view.js'));
  })()`);
  await evaluate(`(() => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text) => { window.__selectionCopiedText = text; } },
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async ({ text }) => { window.__selectionSharedText = text; },
    });
  })()`);
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.title === 'Search Books');
    button?.click();
    return Boolean(button);
  })()`);
  await waitFor(
    'Boolean(document.querySelector(\'input[placeholder="도서 이름으로 검색..."]\'))',
    'selection TXT search modal',
  );
  assert.equal(
    await setInputValue('input[placeholder="도서 이름으로 검색..."]', 'selection-probe'),
    true,
  );
  await evaluate('document.querySelector(\'input[placeholder="도서 이름으로 검색..."]\')?.form?.requestSubmit()');
  await waitFor(
    `document.querySelectorAll('main h3').length === 1
      && document.querySelector('main h3')?.textContent?.includes('selection-probe')`,
    'selection TXT search result',
  );
  await evaluate(`document.querySelector('main h3')?.closest('.group')?.click()`);
  await waitFor(
    `(() => {
      const view = document.querySelector('foliate-view');
      const doc = view?.renderer?.getContents?.()[0]?.doc;
      return Boolean(doc?.body?.innerText?.includes('Selection probe paragraph'));
    })()`,
    'selection TXT reader',
    60_000,
  );
  await waitFor(
    `![...document.querySelectorAll('[role="status"]')]
      .some((node) => node.textContent?.trim() === 'Loading...')`,
    'selection TXT reader ready',
  );
  const actualTextTapProbe = await evaluate(`(() => {
    const view = document.querySelector('foliate-view');
    const renderer = view?.renderer;
    const doc = renderer?.getContents?.()[0]?.doc;
    const frame = doc?.defaultView?.frameElement;
    if (!renderer || !doc || !frame) return { missing: true };
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let tapRect = null;
    let fallbackTapRect = null;
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent?.includes('Selection probe paragraph')) continue;
      const range = doc.createRange();
      range.selectNodeContents(walker.currentNode);
      const visibleRects = [...range.getClientRects()].filter((rect) => (
        rect.width > 40
        && rect.height > 0
        && rect.bottom > 0
        && rect.top < doc.defaultView.innerHeight
      ));
      fallbackTapRect ??= visibleRects[0] ?? null;
      tapRect = visibleRects.find((rect) => (
        rect.top >= doc.defaultView.innerHeight * 0.3
        && rect.bottom <= doc.defaultView.innerHeight * 0.7
      )) ?? null;
      if (tapRect) break;
    }
    tapRect ??= fallbackTapRect;
    if (!tapRect) return { missingRect: true };
    const frameRect = frame.getBoundingClientRect();
    const scaleX = frameRect.width / frame.clientWidth;
    const scaleY = frameRect.height / frame.clientHeight;
    const frameX = tapRect.left + tapRect.width / 2;
    const frameY = tapRect.top + tapRect.height / 2;
    const x = frameRect.left + frameX * scaleX;
    const y = frameRect.top + frameY * scaleY;
    window.__actualTextTapEvents = [];
    for (const name of ['pointerdown', 'mousedown', 'selectstart', 'selectionchange', 'pointerup', 'mouseup', 'click']) {
      doc.addEventListener(name, (event) => {
        window.__actualTextTapEvents.push({
          name,
          target: event.target?.nodeName ?? null,
          selection: doc.getSelection()?.toString() ?? '',
          collapsed: doc.getSelection()?.isCollapsed ?? null,
          defaultPrevented: event.defaultPrevented,
        });
      });
    }
    return {
      x,
      y,
      frameX,
      frameY,
      frameTarget: doc.elementFromPoint(frameX, frameY)?.nodeName ?? null,
      topTarget: document.elementFromPoint(x, y)?.nodeName ?? null,
      beforeStart: renderer.start,
      controlsOpenBefore: document.querySelector('nav')?.classList.contains('translate-y-0'),
    };
  })()`);
  assert.equal(actualTextTapProbe.missing, undefined);
  assert.equal(actualTextTapProbe.missingRect, undefined);
  const dispatchActualTextClick = async () => {
    await command('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: actualTextTapProbe.x,
      y: actualTextTapProbe.y,
      button: 'left',
      clickCount: 1,
    });
    await command('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: actualTextTapProbe.x,
      y: actualTextTapProbe.y,
      button: 'left',
      clickCount: 1,
    });
    await sleep(100);
  };
  await dispatchActualTextClick();
  const actualTextTapOpened = await evaluate(`(() => ({
    controlsOpen: document.querySelector('nav')?.classList.contains('translate-y-0'),
    start: document.querySelector('foliate-view')?.renderer?.start,
    events: window.__actualTextTapEvents,
  }))()`);
  assert.equal(
    actualTextTapOpened.controlsOpen,
    !actualTextTapProbe.controlsOpenBefore,
    JSON.stringify({ actualTextTapProbe, actualTextTapOpened }),
  );
  assert.equal(actualTextTapOpened.start, actualTextTapProbe.beforeStart);
  await dispatchActualTextClick();
  const actualTextTapClosed = await evaluate(`(() => ({
    controlsClosed: !document.querySelector('nav')?.classList.contains('translate-y-0'),
    start: document.querySelector('foliate-view')?.renderer?.start,
    staleFoliateRemoved: false,
    versionedEntry: [...document.scripts].some((script) => (
      script.src.endsWith('/foliate-js/view.js?v=1.8.2')
    )),
  }))()`);
  actualTextTapClosed.staleFoliateRemoved = await evaluate(`(async () => {
    const staleCache = await caches.open('pc-reader-v1.7.10');
    return !(await staleCache.match('/foliate-js/view.js'));
  })()`);
  assert.equal(
    actualTextTapClosed.controlsClosed,
    !actualTextTapProbe.controlsOpenBefore,
    JSON.stringify({ actualTextTapProbe, actualTextTapClosed }),
  );
  assert.equal(actualTextTapClosed.start, actualTextTapProbe.beforeStart);
  assert.equal(actualTextTapClosed.staleFoliateRemoved, true);
  assert.equal(actualTextTapClosed.versionedEntry, true);
  const selectionActions = await evaluate(`(async () => {
    const view = document.querySelector('foliate-view');
    const renderer = view?.renderer;
    const doc = renderer?.getContents?.()[0]?.doc;
    if (!view || !renderer || !doc) return { missing: true };
    const relocateReasons = [];
    view.addEventListener('relocate', (event) => {
      relocateReasons.push(event.detail?.reason ?? null);
    });
    await new Promise((resolve) => setTimeout(resolve, 500));
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let textNode = null;
    while (walker.nextNode()) {
      if (!walker.currentNode.textContent?.includes('Selection probe paragraph')) continue;
      const probe = doc.createRange();
      probe.selectNodeContents(walker.currentNode);
      const probeRect = probe.getBoundingClientRect();
      if (probeRect.width > 0
        && probeRect.height > 0
        && probeRect.bottom > 0
        && probeRect.top < doc.defaultView.innerHeight) {
        textNode = walker.currentNode;
        break;
      }
    }
    if (!textNode) return { missingText: true };
    const text = textNode.textContent;
    const selectionProbe = ' probe paragraph ';
    const start = text.indexOf(selectionProbe);
    const range = doc.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + selectionProbe.length);
    const selectedText = range.toString();
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    doc.dispatchEvent(new doc.defaultView.Event('selectionchange'));
    const menuDeadline = performance.now() + 2000;
    while (!document.querySelector('[data-reader-selection-menu="true"]')
      && performance.now() < menuDeadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const menu = document.querySelector('[data-reader-selection-menu="true"]');
    const menuRect = menu?.getBoundingClientRect();
    const selectionStyle = doc.querySelector('style[data-reader-text-selection]');
    const selectedContextMenuEvent = new doc.defaultView.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    const selectedContextMenuDispatch = textNode.parentElement?.dispatchEvent(
      selectedContextMenuEvent,
    );
    const nativeContextMenuSuppressed = selectedContextMenuDispatch === false
      && selectedContextMenuEvent.defaultPrevented;
    const beforeSuppressedClick = renderer.start;
    const selectedRect = range.getBoundingClientRect();
    textNode.parentElement?.dispatchEvent(new doc.defaultView.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: selectedRect.left + selectedRect.width / 2,
      clientY: selectedRect.top + selectedRect.height / 2,
    }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const afterSuppressedClick = renderer.start;
    const currentMenu = document.querySelector('[data-reader-selection-menu="true"]');
    const actionRects = [...(currentMenu?.querySelectorAll('button') ?? [])]
      .map((button) => {
        const rect = button.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
    const copyButton = [...(currentMenu?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent?.includes('복사'));
    copyButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const shareButton = [...(document.querySelector('[data-reader-selection-menu="true"]')
      ?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent?.includes('공유'));
    shareButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const yellowHighlightButton = document.querySelector(
      '[data-reader-selection-menu="true"] button[aria-label="노랑 하이라이트 추가"]',
    );
    yellowHighlightButton?.click();
    const highlightDeadline = performance.now() + 3000;
    while (document.querySelector('[data-reader-selection-menu="true"]')
      && performance.now() < highlightDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const readAnnotations = async () => {
      const request = indexedDB.open('web-reader-db');
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction('annotations-v8', 'readonly');
      const getAll = tx.objectStore('annotations-v8').getAll();
      const records = await new Promise((resolve, reject) => {
        getAll.onsuccess = () => resolve(getAll.result);
        getAll.onerror = () => reject(getAll.error);
      });
      db.close();
      return records.filter((record) => record.bookId === 'selection-probe.txt');
    };
    const hasHighlightOverlay = () => renderer.getContents().some(({ overlayer }) => (
      overlayer?.element?.querySelector('[data-reader-highlight="true"]')
    ));
    const createdAnnotations = await readAnnotations();
    const createdOverlay = hasHighlightOverlay();
    const beforeHighlightClick = renderer.start;
    const controlsBeforeHighlightClick = document.querySelector('nav')?.classList.contains('translate-y-0');
    const highlightTapInit = {
      bubbles: true,
      cancelable: true,
      clientX: selectedRect.left + selectedRect.width / 2,
      clientY: selectedRect.top + selectedRect.height / 2,
      pointerId: 41,
      pointerType: 'touch',
      isPrimary: true,
      button: 0,
    };
    textNode.parentElement?.dispatchEvent(new doc.defaultView.PointerEvent('pointerdown', {
      ...highlightTapInit,
      buttons: 1,
    }));
    textNode.parentElement?.dispatchEvent(new doc.defaultView.PointerEvent('pointerup', {
      ...highlightTapInit,
      buttons: 0,
    }));
    textNode.parentElement?.dispatchEvent(new doc.defaultView.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: highlightTapInit.clientX,
      clientY: highlightTapInit.clientY,
    }));
    const touchHighlightMenuDeadline = performance.now() + 2000;
    while (!document.querySelector('[data-reader-highlight-menu="true"]')
      && performance.now() < touchHighlightMenuDeadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const highlightTouchMenuShown = Boolean(
      document.querySelector('[data-reader-highlight-menu="true"]'),
    );
    const afterHighlightTouch = renderer.start;
    document.querySelector(
      '[data-reader-highlight-menu="true"] button[aria-label="하이라이트 메뉴 닫기"]',
    )?.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    textNode.parentElement?.dispatchEvent(new doc.defaultView.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: selectedRect.left + selectedRect.width / 2,
      clientY: selectedRect.top + selectedRect.height / 2,
    }));
    const highlightMenuDeadline = performance.now() + 2000;
    while (!document.querySelector('[data-reader-highlight-menu="true"]')
      && performance.now() < highlightMenuDeadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const highlightMenu = document.querySelector('[data-reader-highlight-menu="true"]');
    const highlightMouseMenuShown = Boolean(highlightMenu);
    const highlightMenuRect = highlightMenu?.getBoundingClientRect();
    const highlightActionRects = [...(highlightMenu?.querySelectorAll('button') ?? [])]
      .map((button) => {
        const rect = button.getBoundingClientRect();
        return { width: rect.width, height: rect.height };
      });
    const afterHighlightClick = renderer.start;
    const controlsAfterHighlightClick = document.querySelector('nav')?.classList.contains('translate-y-0');
    document.querySelector(
      '[data-reader-highlight-menu="true"] button[aria-label="파랑 하이라이트"]',
    )?.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const recoloredAnnotations = await readAnnotations();
    const recoloredOverlay = hasHighlightOverlay();
    document.querySelector(
      '[data-reader-highlight-menu="true"] button[aria-label="하이라이트 삭제"]',
    )?.click();
    await new Promise((resolve) => setTimeout(resolve, 80));
    const deletedAnnotations = await readAnnotations();
    [...document.querySelectorAll('[data-reader-annotation-feedback="true"] button')]
      .find((button) => button.textContent?.includes('실행 취소'))?.click();
    const restoredOverlayDeadline = performance.now() + 2000;
    while (!hasHighlightOverlay()
      && performance.now() < restoredOverlayDeadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const restoredAnnotations = await readAnnotations();
    const restoredOverlay = hasHighlightOverlay();

    const failureProbe = 'Selection';
    const failureStart = text.indexOf(failureProbe);
    const failureRange = doc.createRange();
    failureRange.setStart(textNode, failureStart);
    failureRange.setEnd(textNode, failureStart + failureProbe.length);
    selection.removeAllRanges();
    selection.addRange(failureRange);
    doc.dispatchEvent(new doc.defaultView.Event('selectionchange'));
    const creationFailureMenuDeadline = performance.now() + 2000;
    while (!document.querySelector('[data-reader-selection-menu="true"]')
      && performance.now() < creationFailureMenuDeadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const originalCreationAddAnnotation = view.addAnnotation.bind(view);
    view.addAnnotation = async () => {
      throw new Error('injected creation overlay failure');
    };
    document.querySelector(
      '[data-reader-selection-menu="true"] button[aria-label="분홍 하이라이트 추가"]',
    )?.click();
    const creationFailureDeadline = performance.now() + 3000;
    let creationFailureAnnotations = await readAnnotations();
    while (!creationFailureAnnotations.some((annotation) => (
      annotation.quote === failureProbe && annotation.anchorState === 'unresolved'
    )) && performance.now() < creationFailureDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      creationFailureAnnotations = await readAnnotations();
    }
    [...document.querySelectorAll('[data-reader-annotation-feedback="true"] button')]
      .find((button) => button.textContent?.includes('실행 취소'))?.click();
    const creationFailureUndoDeadline = performance.now() + 3000;
    let creationFailureUndoAnnotations = await readAnnotations();
    while (creationFailureUndoAnnotations.some(({ quote }) => quote === failureProbe)
      && performance.now() < creationFailureUndoDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      creationFailureUndoAnnotations = await readAnnotations();
    }
    view.addAnnotation = originalCreationAddAnnotation;

    selection.removeAllRanges();
    selection.addRange(range);
    doc.dispatchEvent(new doc.defaultView.Event('selectionchange'));
    const duplicateMenuDeadline = performance.now() + 2000;
    while (!document.querySelector('[data-reader-selection-menu="true"]')
      && performance.now() < duplicateMenuDeadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    document.querySelector(
      '[data-reader-selection-menu="true"] button[aria-label="초록 하이라이트 추가"]',
    )?.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const exactRangeAnnotations = await readAnnotations();
    textNode.parentElement?.dispatchEvent(new doc.defaultView.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: selectedRect.left + selectedRect.width / 2,
      clientY: selectedRect.top + selectedRect.height / 2,
    }));
    const overlayFailureMenuDeadline = performance.now() + 2000;
    while (!document.querySelector('[data-reader-highlight-menu="true"]')
      && performance.now() < overlayFailureMenuDeadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const originalDeleteAnnotation = view.deleteAnnotation.bind(view);
    view.deleteAnnotation = async () => {
      throw new Error('injected overlay delete failure');
    };
    document.querySelector(
      '[data-reader-highlight-menu="true"] button[aria-label="하이라이트 삭제"]',
    )?.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const overlayFailureDeletedAnnotations = await readAnnotations();
    const overlayFailureDeleteFeedback = document.querySelector(
      '[data-reader-annotation-feedback="true"]',
    )?.textContent ?? '';
    const overlayFailureUndoButton = [...document.querySelectorAll(
      '[data-reader-annotation-feedback="true"] button',
    )].find((button) => button.textContent?.includes('실행 취소'));
    view.deleteAnnotation = originalDeleteAnnotation;
    const originalAddAnnotation = view.addAnnotation.bind(view);
    view.addAnnotation = async () => {
      throw new Error('injected overlay restore failure');
    };
    overlayFailureUndoButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const overlayFailureRestoredAnnotations = await readAnnotations();
    const overlayFailureUndoFeedback = document.querySelector(
      '[data-reader-annotation-feedback="true"]',
    )?.textContent ?? '';
    view.addAnnotation = originalAddAnnotation;
    renderer.setStyles(['', 'body { font-size: 21px !important; line-height: 2 !important; }']);
    await new Promise((resolve) => setTimeout(resolve, 150));
    const overlayAfterStyleChange = hasHighlightOverlay();
    renderer.setAttribute('flow', 'scrolled');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const overlayAfterLayoutChange = hasHighlightOverlay();
    renderer.setAttribute('flow', 'paginated');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const beforeTap = renderer.start;
    const frame = doc.defaultView.frameElement;
    const frameRect = frame?.getBoundingClientRect();
    const tapClientX = frame && frameRect
      ? (innerWidth * 0.95 - frameRect.left) * frame.clientWidth / frameRect.width
      : doc.defaultView.innerWidth * 0.95;
    const tapClientY = frame && frameRect
      ? (innerHeight / 2 - frameRect.top) * frame.clientHeight / frameRect.height
      : doc.defaultView.innerHeight / 2;
    const tapTarget = doc.elementFromPoint(tapClientX, tapClientY)
      ?? doc.body;
    tapTarget.dispatchEvent(new doc.defaultView.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: tapClientX,
      clientY: tapClientY,
    }));
    await new Promise((resolve) => setTimeout(resolve, 350));
    const afterTap = renderer.start;
    const toFramePoint = (topX, topY) => {
      const currentFrameRect = frame?.getBoundingClientRect();
      return {
        x: frame && currentFrameRect
          ? (topX - currentFrameRect.left) * frame.clientWidth / currentFrameRect.width
          : topX,
        y: frame && currentFrameRect
          ? (topY - currentFrameRect.top) * frame.clientHeight / currentFrameRect.height
          : topY,
      };
    };
    const dispatchDocumentClick = ({ x, y }) => {
      const target = doc.elementFromPoint(x, y) ?? doc.body;
      target.dispatchEvent(new doc.defaultView.MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: x,
        clientY: y,
      }));
    };
    dispatchDocumentClick(toFramePoint(innerWidth / 2, innerHeight / 2));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const controlsOpened = document.querySelector('nav')?.classList.contains('translate-y-0');
    const beforeControlsCloseTap = renderer.start;
    dispatchDocumentClick(toFramePoint(innerWidth * 0.95, innerHeight / 2));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const controlsClosed = !document.querySelector('nav')?.classList.contains('translate-y-0');
    const afterControlsCloseTap = renderer.start;
    const dispatchPointerTap = (pointerId) => {
      const rapidTapPoint = toFramePoint(innerWidth * 0.95, innerHeight / 2);
      const target = doc.body;
      target.dispatchEvent(new doc.defaultView.PointerEvent('pointerdown', {
        bubbles: true,
        cancelable: true,
        pointerId,
        pointerType: 'touch',
        isPrimary: true,
        button: 0,
        buttons: 1,
        clientX: rapidTapPoint.x,
        clientY: rapidTapPoint.y,
      }));
      target.dispatchEvent(new doc.defaultView.PointerEvent('pointerup', {
        bubbles: true,
        cancelable: true,
        pointerId,
        pointerType: 'touch',
        isPrimary: true,
        button: 0,
        buttons: 0,
        clientX: rapidTapPoint.x,
        clientY: rapidTapPoint.y,
      }));
    };
    const beforeRapidTaps = renderer.start;
    dispatchPointerTap(401);
    await new Promise((resolve) => setTimeout(resolve, 130));
    selection.removeAllRanges();
    selection.addRange(range);
    doc.dispatchEvent(new doc.defaultView.Event('selectionchange'));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const nativeSelectionBeforeRapidSecondTap = selection.toString();
    dispatchPointerTap(402);
    await new Promise((resolve) => setTimeout(resolve, 130));
    const afterRapidTaps = renderer.start;
    const rapidTapSelectionCleared = !selection.toString()
      && !document.querySelector('[data-reader-selection-menu="true"]');
    const inactiveContextMenuEvent = new doc.defaultView.MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
    });
    const inactiveContextMenuAllowed = doc.body.dispatchEvent(inactiveContextMenuEvent)
      && !inactiveContextMenuEvent.defaultPrevented;
    return {
      selectedText,
      selectionStyleInstalled: Boolean(selectionStyle),
      nativeCalloutStyleSuppressed: selectionStyle?.textContent?.includes(
        '-webkit-touch-callout: none !important',
      ) ?? false,
      touchActionManipulation: selectionStyle?.textContent?.includes(
        'touch-action: manipulation',
      ) ?? false,
      nativeContextMenuSuppressed,
      inactiveContextMenuAllowed,
      copyButtonFound: Boolean(copyButton),
      actionRects,
      shareButtonFound: Boolean(shareButton),
      highlightButtonFound: Boolean(yellowHighlightButton),
      createdAnnotationCount: createdAnnotations.length,
      createdColor: createdAnnotations[0]?.colorId ?? null,
      createdAnchorState: createdAnnotations[0]?.anchorState ?? null,
      createdOverlay,
      highlightMenuVisible: Boolean(document.querySelector('[data-reader-highlight-menu="true"]')),
      highlightMenuShown: Boolean(highlightMenu),
      highlightTouchMenuShown,
      highlightMouseMenuShown,
      highlightMenuInViewport: Boolean(highlightMenuRect
        && highlightMenuRect.left >= 0
        && highlightMenuRect.top >= 0
        && highlightMenuRect.right <= innerWidth
        && highlightMenuRect.bottom <= innerHeight),
      highlightActionRects,
      beforeHighlightClick,
      afterHighlightTouch,
      afterHighlightClick,
      controlsBeforeHighlightClick,
      controlsAfterHighlightClick,
      recoloredColor: recoloredAnnotations[0]?.colorId ?? null,
      recoloredAnchorState: recoloredAnnotations[0]?.anchorState ?? null,
      recoloredOverlay,
      deletedAnnotationCount: deletedAnnotations.length,
      restoredAnnotationCount: restoredAnnotations.length,
      restoredColor: restoredAnnotations[0]?.colorId ?? null,
      restoredAnchorState: restoredAnnotations[0]?.anchorState ?? null,
      restoredOverlay,
      creationFailureAnchorState: creationFailureAnnotations.find(
        ({ quote }) => quote === failureProbe,
      )?.anchorState ?? null,
      creationFailureUndoCount: creationFailureUndoAnnotations.filter(
        ({ quote }) => quote === failureProbe,
      ).length,
      exactRangeAnnotationCount: exactRangeAnnotations.length,
      exactRangeColor: exactRangeAnnotations[0]?.colorId ?? null,
      overlayFailureDeletedAnnotationCount: overlayFailureDeletedAnnotations.length,
      overlayFailureDeleteFeedback,
      overlayFailureUndoAvailable: Boolean(overlayFailureUndoButton),
      overlayFailureRestoredAnnotationCount: overlayFailureRestoredAnnotations.length,
      overlayFailureRestoredColor: overlayFailureRestoredAnnotations[0]?.colorId ?? null,
      overlayFailureUndoFeedback,
      overlayAfterStyleChange,
      overlayAfterLayoutChange,
      clipboardAvailable: typeof navigator.clipboard?.writeText === 'function',
      shareAvailable: typeof navigator.share === 'function',
      overlayAbsent: !document.querySelector('[data-reader-interaction-overlay="true"]'),
      menuVisible: Boolean(menu),
      menuInViewport: Boolean(menuRect
        && menuRect.left >= 0
        && menuRect.top >= 0
        && menuRect.right <= innerWidth
        && menuRect.bottom <= innerHeight),
      beforeSuppressedClick,
      afterSuppressedClick,
      copiedText: window.__selectionCopiedText,
      sharedText: window.__selectionSharedText,
      selectionCleared: !document.querySelector('[data-reader-selection-menu="true"]')
        && !doc.getSelection()?.toString(),
      navMode: JSON.parse(localStorage.getItem('viewer_settings') || '{}').navMode,
      swipeNavigation: renderer.getAttribute('swipe-navigation'),
      tapClientX,
      tapClientY,
      frameRect: frameRect ? {
        left: frameRect.left,
        top: frameRect.top,
        width: frameRect.width,
        height: frameRect.height,
      } : null,
      frameClientWidth: frame?.clientWidth,
      frameClientHeight: frame?.clientHeight,
      rendererPages: renderer.pages,
      rendererSize: renderer.size,
      controlsOpenAfterTap: document.querySelector('nav')?.classList.contains('translate-y-0'),
      beforeTap,
      afterTap,
      controlsOpened,
      controlsClosed,
      beforeControlsCloseTap,
      afterControlsCloseTap,
      beforeRapidTaps,
      afterRapidTaps,
      nativeSelectionBeforeRapidSecondTap,
      rapidTapSelectionCleared,
      relocateReasons,
    };
  })()`);
  assert.equal(selectionActions.missing, undefined);
  assert.equal(selectionActions.missingText, undefined);
  assert.equal(selectionActions.overlayAbsent, true);
  assert.equal(selectionActions.menuVisible, true, JSON.stringify(selectionActions));
  assert.equal(selectionActions.menuInViewport, true);
  assert.equal(selectionActions.nativeCalloutStyleSuppressed, true);
  assert.equal(selectionActions.touchActionManipulation, true);
  assert.equal(selectionActions.nativeContextMenuSuppressed, true);
  assert.equal(selectionActions.inactiveContextMenuAllowed, true, JSON.stringify(selectionActions));
  assert.ok(
    selectionActions.actionRects.every(({ width, height }) => width >= 44 && height >= 44),
    JSON.stringify(selectionActions.actionRects),
  );
  assert.equal(selectionActions.afterSuppressedClick, selectionActions.beforeSuppressedClick);
  assert.equal(selectionActions.copiedText, selectionActions.selectedText, JSON.stringify(selectionActions));
  assert.equal(selectionActions.sharedText, selectionActions.selectedText);
  assert.equal(selectionActions.highlightButtonFound, true, JSON.stringify(selectionActions));
  assert.equal(selectionActions.createdAnnotationCount, 1, JSON.stringify(selectionActions));
  assert.equal(selectionActions.createdColor, 'yellow');
  assert.equal(selectionActions.createdOverlay, true);
  assert.equal(selectionActions.highlightMenuShown, true, JSON.stringify(selectionActions));
  assert.equal(selectionActions.highlightTouchMenuShown, true, JSON.stringify(selectionActions));
  assert.equal(selectionActions.highlightMouseMenuShown, true, JSON.stringify(selectionActions));
  assert.equal(selectionActions.highlightMenuInViewport, true, JSON.stringify(selectionActions));
  assert.ok(
    selectionActions.highlightActionRects.every(({ width, height }) => width >= 44 && height >= 44),
    JSON.stringify(selectionActions.highlightActionRects),
  );
  assert.equal(selectionActions.beforeHighlightClick, selectionActions.afterHighlightClick);
  assert.equal(selectionActions.beforeHighlightClick, selectionActions.afterHighlightTouch);
  assert.equal(selectionActions.controlsBeforeHighlightClick, selectionActions.controlsAfterHighlightClick);
  assert.equal(selectionActions.recoloredColor, 'blue');
  assert.equal(selectionActions.deletedAnnotationCount, 0);
  assert.equal(selectionActions.restoredAnnotationCount, 1);
  assert.equal(selectionActions.restoredColor, 'blue');
  assert.equal(selectionActions.restoredOverlay, true);
  assert.equal(selectionActions.creationFailureAnchorState, 'unresolved');
  assert.equal(selectionActions.creationFailureUndoCount, 0);
  assert.equal(selectionActions.exactRangeAnnotationCount, 1);
  assert.equal(selectionActions.exactRangeColor, 'green');
  assert.equal(selectionActions.overlayFailureDeletedAnnotationCount, 0);
  assert.match(selectionActions.overlayFailureDeleteFeedback, /하이라이트 삭제됨/);
  assert.equal(selectionActions.overlayFailureUndoAvailable, true);
  assert.equal(selectionActions.overlayFailureRestoredAnnotationCount, 1);
  assert.equal(selectionActions.overlayFailureRestoredColor, 'green');
  assert.match(selectionActions.overlayFailureUndoFeedback, /실행 취소됨/);
  assert.equal(selectionActions.overlayAfterStyleChange, true);
  assert.equal(selectionActions.overlayAfterLayoutChange, true);
  assert.equal(selectionActions.selectionCleared, true);
  assert.equal(selectionActions.navMode, 'left-right');
  assert.equal(selectionActions.swipeNavigation, 'false');
  assert.notEqual(selectionActions.afterTap, selectionActions.beforeTap, JSON.stringify(selectionActions));
  assert.ok(selectionActions.relocateReasons.includes('page'), JSON.stringify(selectionActions));
  assert.equal(selectionActions.controlsOpened, true, JSON.stringify(selectionActions));
  assert.equal(selectionActions.controlsClosed, true, JSON.stringify(selectionActions));
  assert.equal(
    selectionActions.afterControlsCloseTap,
    selectionActions.beforeControlsCloseTap,
    JSON.stringify(selectionActions),
  );
  assert.ok(selectionActions.nativeSelectionBeforeRapidSecondTap.length > 0);
  assert.equal(selectionActions.rapidTapSelectionCleared, true, JSON.stringify(selectionActions));
  assert.notEqual(selectionActions.afterRapidTaps, selectionActions.beforeRapidTaps, JSON.stringify(selectionActions));
  await evaluate(`(() => {
    delete navigator.clipboard;
    delete navigator.share;
    document.querySelector('button[aria-label="Close reader"]')?.click();
  })()`);
  await waitFor(
    `document.querySelector("h1")?.textContent?.includes("Guest Library")`,
    'shelf after selection TXT reader',
  );
  await evaluate(`(() => {
    const title = [...document.querySelectorAll('main h3')]
      .find((node) => node.textContent?.includes('selection-probe'));
    title?.closest('.group')?.click();
    return Boolean(title);
  })()`);
  await waitFor(
    `(() => {
      const view = document.querySelector('foliate-view');
      return Boolean(view?.renderer?.getContents?.().some(({ overlayer }) => (
        overlayer?.element?.querySelector('[data-reader-highlight="true"]')
      )));
    })()`,
    'persisted local highlight after reader reopen',
    60_000,
  );
  const highlightReopen = await evaluate(`(async () => {
    const view = document.querySelector('foliate-view');
    const hasOverlay = view?.renderer?.getContents?.().some(({ overlayer }) => (
      overlayer?.element?.querySelector('[data-reader-highlight="true"]')
    ));
    const request = indexedDB.open('web-reader-db');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const getAll = db.transaction('annotations-v8', 'readonly')
      .objectStore('annotations-v8').getAll();
    const records = await new Promise((resolve, reject) => {
      getAll.onsuccess = () => resolve(getAll.result);
      getAll.onerror = () => reject(getAll.error);
    });
    db.close();
    const saved = records.find((record) => record.bookId === 'selection-probe.txt');
    return {
      overlayVisible: Boolean(hasOverlay),
      savedCount: records.filter((record) => record.bookId === 'selection-probe.txt').length,
      colorId: saved?.colorId ?? null,
      sectionIndex: saved?.sectionIndex ?? null,
      anchorState: saved?.anchorState ?? null,
      quote: saved?.quote ?? null,
    };
  })()`);
  assert.equal(highlightReopen.overlayVisible, true, JSON.stringify(highlightReopen));
  assert.equal(highlightReopen.savedCount, 1);
  assert.equal(highlightReopen.colorId, 'green');
  assert.equal(highlightReopen.sectionIndex, 0);
  assert.equal(highlightReopen.anchorState, 'active');
  assert.equal(highlightReopen.quote, selectionActions.selectedText);
  const annotationEntry = await evaluate(`(() => {
    const separateAnnotationButton = document.querySelector('button[aria-label="하이라이트와 메모"]');
    document.querySelector('button[aria-label="북마크"]')?.click();
    return { separateAnnotationButton: Boolean(separateAnnotationButton) };
  })()`);
  assert.equal(annotationEntry.separateAnnotationButton, false, JSON.stringify(annotationEntry));
  await waitFor(
    `Boolean(document.querySelector('[data-reader-bookmark-panel="true"]'))`,
    'combined records modal after reader reopen',
  );
  const compactRecordsModal = await evaluate(`(() => {
    const bookmarkPanel = document.querySelector('[data-reader-bookmark-panel="true"]');
    const width = bookmarkPanel?.getBoundingClientRect().width ?? null;
    document.querySelector('[data-reader-records-tab="annotations"]')?.click();
    return { width };
  })()`);
  assert.equal(typeof compactRecordsModal.width, 'number', JSON.stringify(compactRecordsModal));
  assert.ok(compactRecordsModal.width <= 340, JSON.stringify(compactRecordsModal));
  await waitFor(
    `Boolean(document.querySelector('[data-reader-annotation-modal="true"]'))`,
    'annotation manager after reader reopen',
  );
  const annotationManager = await evaluate(`(async () => {
    const initialItemCount = document.querySelectorAll('[data-reader-annotation-item]').length;
    const greenGroup = document.querySelector('[data-reader-annotation-group="green"]');
    const modalWidth = document.querySelector('[data-reader-annotation-modal="true"]')
      ?.getBoundingClientRect().width ?? null;
    const searchHeight = document.querySelector('[data-reader-annotation-search="true"]')
      ?.closest('label')?.getBoundingClientRect().height ?? null;
    const collapsedGroupHeight = greenGroup?.getBoundingClientRect().height ?? null;
    const initiallyCollapsed = greenGroup?.getAttribute('aria-expanded') === 'false';
    greenGroup?.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const expandedItemCount = document.querySelectorAll('[data-reader-annotation-item]').length;
    document.querySelector('[data-reader-annotation-item] button[aria-label="메모 편집"]')?.click();
    const noteDeadline = performance.now() + 2000;
    while (!document.querySelector('[data-reader-annotation-note-dialog="true"]')
      && performance.now() < noteDeadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    history.back();
    const backDeadline = performance.now() + 2000;
    while (document.querySelector('[data-reader-annotation-note-dialog="true"]')
      && performance.now() < backDeadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const managerStayedOpenAfterBack = Boolean(
      document.querySelector('[data-reader-annotation-modal="true"]'),
    );
    document.querySelector('[data-reader-annotation-item] button[aria-label="메모 편집"]')?.click();
    const reopenDeadline = performance.now() + 2000;
    while (!document.querySelector('[data-reader-annotation-note-dialog="true"]')
      && performance.now() < reopenDeadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const textarea = document.querySelector('[data-reader-annotation-note-dialog="true"] textarea');
    const noteDraft = \`회귀 메모 \${Date.now()}\`;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    valueSetter?.call(textarea, noteDraft);
    textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    document.querySelector('[data-reader-annotation-note-dialog="true"]')?.requestSubmit();
    const saveDeadline = performance.now() + 3000;
    while (document.querySelector('[data-reader-annotation-note-dialog="true"]')
      && performance.now() < saveDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const feedbackDeadline = performance.now() + 2000;
    while (!document.querySelector('[data-reader-annotation-modal-feedback="true"]')
      && performance.now() < feedbackDeadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const modalFeedback = document.querySelector(
      '[data-reader-annotation-modal-feedback="true"]',
    )?.textContent ?? '';

    const search = document.querySelector('[data-reader-annotation-search="true"]');
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    inputSetter?.call(search, '회귀 메모');
    search?.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const searchedItemCount = document.querySelectorAll('[data-reader-annotation-item]').length;
    greenGroup?.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const collapsedItemCount = document.querySelectorAll('[data-reader-annotation-item]').length;
    greenGroup?.click();

    const request = indexedDB.open('web-reader-db');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const getAll = db.transaction('annotations-v8', 'readonly')
      .objectStore('annotations-v8').getAll();
    const records = await new Promise((resolve, reject) => {
      getAll.onsuccess = () => resolve(getAll.result);
      getAll.onerror = () => reject(getAll.error);
    });
    db.close();
    return {
      initialItemCount,
      modalWidth,
      searchHeight,
      collapsedGroupHeight,
      initiallyCollapsed,
      expandedItemCount,
      searchedItemCount,
      collapsedItemCount,
      note: records.find((record) => record.bookId === 'selection-probe.txt')?.note ?? null,
      noteDraft,
      noteDialogClosed: !document.querySelector('[data-reader-annotation-note-dialog="true"]'),
      managerStayedOpenAfterBack,
      modalFeedback,
    };
  })()`);
  assert.equal(annotationManager.initialItemCount, 0, JSON.stringify(annotationManager));
  assert.equal(typeof annotationManager.modalWidth, 'number', JSON.stringify(annotationManager));
  assert.equal(typeof annotationManager.searchHeight, 'number', JSON.stringify(annotationManager));
  assert.equal(typeof annotationManager.collapsedGroupHeight, 'number', JSON.stringify(annotationManager));
  assert.ok(annotationManager.modalWidth <= 340, JSON.stringify(annotationManager));
  assert.ok(annotationManager.searchHeight <= 40, JSON.stringify(annotationManager));
  assert.ok(annotationManager.collapsedGroupHeight <= 40, JSON.stringify(annotationManager));
  assert.equal(annotationManager.initiallyCollapsed, true, JSON.stringify(annotationManager));
  assert.equal(annotationManager.expandedItemCount, 1, JSON.stringify(annotationManager));
  assert.equal(annotationManager.searchedItemCount, 1, JSON.stringify(annotationManager));
  assert.equal(annotationManager.collapsedItemCount, 0, JSON.stringify(annotationManager));
  assert.equal(annotationManager.note, annotationManager.noteDraft);
  assert.equal(annotationManager.noteDialogClosed, true);
  assert.equal(annotationManager.managerStayedOpenAfterBack, true);
  assert.match(annotationManager.modalFeedback, /메모 저장됨/);
  assert.match(annotationManager.modalFeedback, /실행 취소/);
  await evaluate(`document.querySelector('button[aria-label="책갈피와 주석 닫기"]')?.click()`);
  await waitFor(
    `!document.querySelector('[data-reader-annotation-modal="true"]')`,
    'combined records modal close before reopen',
  );
  await evaluate(`document.querySelector('button[aria-label="북마크"]')?.click()`);
  await waitFor(
    `Boolean(document.querySelector('[data-reader-bookmark-panel="true"]'))`,
    'combined records modal reopen',
  );
  await evaluate(`document.querySelector('[data-reader-records-tab="annotations"]')?.click()`);
  await waitFor(
    `Boolean(document.querySelector('[data-reader-annotation-modal="true"]'))`,
    'annotation manager reopen',
  );
  await evaluate(`document.querySelector('button[aria-label="책갈피와 주석 닫기"]')?.click()`);
  await evaluate(`document.querySelector('button[aria-label="Close reader"]')?.click()`);
  await waitFor(
    `document.querySelector("h1")?.textContent?.includes("Guest Library")`,
    'shelf after highlight reopen',
  );
  await evaluate(`(async () => {
    const request = indexedDB.open('web-reader-db');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction('annotations-v8', 'readwrite');
    const store = tx.objectStore('annotations-v8');
    const getAll = store.getAll();
    const records = await new Promise((resolve, reject) => {
      getAll.onsuccess = () => resolve(getAll.result);
      getAll.onerror = () => reject(getAll.error);
    });
    const annotation = records.find((record) => record.bookId === 'selection-probe.txt');
    await new Promise((resolve, reject) => {
      const put = store.put({ ...annotation, sectionIndex: 99 });
      put.onsuccess = () => resolve();
      put.onerror = () => reject(put.error);
    });
    db.close();
  })()`);
  await evaluate(`(() => {
    const title = [...document.querySelectorAll('main h3')]
      .find((node) => node.textContent?.includes('selection-probe'));
    title?.closest('.group')?.click();
  })()`);
  await waitFor(
    `(async () => {
      const view = document.querySelector('foliate-view');
      const overlayVisible = view?.renderer?.getContents?.().some(({ overlayer }) => (
        overlayer?.element?.querySelector('[data-reader-highlight="true"]')
      ));
      const request = indexedDB.open('web-reader-db');
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const getAll = db.transaction('annotations-v8', 'readonly')
        .objectStore('annotations-v8').getAll();
      const records = await new Promise((resolve, reject) => {
        getAll.onsuccess = () => resolve(getAll.result);
        getAll.onerror = () => reject(getAll.error);
      });
      db.close();
      return overlayVisible
        && records.find((record) => record.bookId === 'selection-probe.txt')?.sectionIndex === 0;
    })()`,
    'resolved annotation section index reconciled',
    60_000,
  );
  const highlightResolution = await evaluate(`(async () => {
    const request = indexedDB.open('web-reader-db');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const getAll = db.transaction('annotations-v8', 'readonly')
      .objectStore('annotations-v8').getAll();
    const records = await new Promise((resolve, reject) => {
      getAll.onsuccess = () => resolve(getAll.result);
      getAll.onerror = () => reject(getAll.error);
    });
    db.close();
    const saved = records.find((record) => record.bookId === 'selection-probe.txt');
    return {
      sectionIndex: saved?.sectionIndex ?? null,
      colorId: saved?.colorId ?? null,
      quote: saved?.quote ?? null,
      anchorState: saved?.anchorState ?? null,
    };
  })()`);
  assert.equal(highlightResolution.sectionIndex, 0);
  assert.equal(highlightResolution.colorId, 'green');
  assert.equal(highlightResolution.quote, selectionActions.selectedText);
  assert.equal(highlightResolution.anchorState, 'active');
  await evaluate(`document.querySelector('button[aria-label="Close reader"]')?.click()`);
  await waitFor(
    `document.querySelector("h1")?.textContent?.includes("Guest Library")`,
    'shelf after annotation section reconciliation',
  );
  await evaluate(`(async () => {
    const request = indexedDB.open('web-reader-db');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction('annotations-v8', 'readwrite');
    const store = tx.objectStore('annotations-v8');
    const getAll = store.getAll();
    const records = await new Promise((resolve, reject) => {
      getAll.onsuccess = () => resolve(getAll.result);
      getAll.onerror = () => reject(getAll.error);
    });
    const annotation = records.find((record) => record.bookId === 'selection-probe.txt');
    if (!annotation) throw new Error('annotation fixture missing');
    const invalidRangeCfi = annotation.rangeCfi.replace(/:\\d+/g, ':999999');
    if (invalidRangeCfi === annotation.rangeCfi) {
      throw new Error('annotation CFI offset fixture missing');
    }
    store.put({
      ...annotation,
      id: 'invalid-cfi-probe',
      rangeCfi: invalidRangeCfi,
      createdAtClient: annotation.createdAtClient + 1,
      updatedAtClient: annotation.updatedAtClient + 1,
      anchorState: 'active',
    });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  })()`);
  await evaluate(`(() => {
    const title = [...document.querySelectorAll('main h3')]
      .find((node) => node.textContent?.includes('selection-probe'));
    title?.closest('.group')?.click();
  })()`);
  await waitFor(
    `(async () => {
      const view = document.querySelector('foliate-view');
      const overlayVisible = view?.renderer?.getContents?.().some(({ overlayer }) => (
        overlayer?.element?.querySelector('[data-reader-highlight="true"]')
      ));
      const request = indexedDB.open('web-reader-db');
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const getAll = db.transaction('annotations-v8', 'readonly')
        .objectStore('annotations-v8').getAll();
      const records = await new Promise((resolve, reject) => {
        getAll.onsuccess = () => resolve(getAll.result);
        getAll.onerror = () => reject(getAll.error);
      });
      db.close();
      const invalid = records.find((record) => record.id === 'invalid-cfi-probe');
      const normal = records.find((record) => (
        record.bookId === 'selection-probe.txt' && record.id !== 'invalid-cfi-probe'
      ));
      return overlayVisible
        && invalid?.anchorState === 'unresolved'
        && normal?.anchorState === 'active';
    })()`,
    'invalid CFI marked unresolved beside active highlight',
    60_000,
  );
  const invalidCfiResolution = await evaluate(`(async () => {
    const view = document.querySelector('foliate-view');
    const overlayVisible = view?.renderer?.getContents?.().some(({ overlayer }) => (
      overlayer?.element?.querySelector('[data-reader-highlight="true"]')
    ));
    const request = indexedDB.open('web-reader-db');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const getAll = db.transaction('annotations-v8', 'readonly')
      .objectStore('annotations-v8').getAll();
    const records = await new Promise((resolve, reject) => {
      getAll.onsuccess = () => resolve(getAll.result);
      getAll.onerror = () => reject(getAll.error);
    });
    db.close();
    const invalid = records.find((record) => record.id === 'invalid-cfi-probe');
    const normal = records.find((record) => (
      record.bookId === 'selection-probe.txt' && record.id !== 'invalid-cfi-probe'
    ));
    return {
      overlayVisible: Boolean(overlayVisible),
      invalidAnchorState: invalid?.anchorState ?? null,
      normalAnchorState: normal?.anchorState ?? null,
    };
  })()`);
  assert.equal(invalidCfiResolution.overlayVisible, true, JSON.stringify(invalidCfiResolution));
  assert.equal(invalidCfiResolution.invalidAnchorState, 'unresolved');
  assert.equal(invalidCfiResolution.normalAnchorState, 'active');
  await evaluate(`document.querySelector('button[aria-label="Close reader"]')?.click()`);
  await waitFor(
    `document.querySelector("h1")?.textContent?.includes("Guest Library")`,
    'shelf after invalid CFI check',
  );
  await evaluate(`(async () => {
    const request = indexedDB.open('web-reader-db');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction('annotations-v8', 'readwrite');
    const store = tx.objectStore('annotations-v8');
    const getAll = store.getAll();
    const records = await new Promise((resolve, reject) => {
      getAll.onsuccess = () => resolve(getAll.result);
      getAll.onerror = () => reject(getAll.error);
    });
    const invalid = records.find((record) => record.id === 'invalid-cfi-probe');
    const annotation = records.find((record) => (
      record.bookId === 'selection-probe.txt' && record.id !== 'invalid-cfi-probe'
    ));
    if (!annotation || !invalid) throw new Error('annotation CFI fixtures missing');
    store.delete([invalid.ownerKey, invalid.bookId, invalid.id]);
    store.put({
      ...annotation,
      quote: 'different text at the same CFI',
      anchorState: 'active',
    });
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  })()`);
  await evaluate(`(() => {
    const title = [...document.querySelectorAll('main h3')]
      .find((node) => node.textContent?.includes('selection-probe'));
    title?.closest('.group')?.click();
  })()`);
  await waitFor(
    `(async () => {
      const request = indexedDB.open('web-reader-db');
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const getAll = db.transaction('annotations-v8', 'readonly')
        .objectStore('annotations-v8').getAll();
      const records = await new Promise((resolve, reject) => {
        getAll.onsuccess = () => resolve(getAll.result);
        getAll.onerror = () => reject(getAll.error);
      });
      db.close();
      return records.find((record) => record.bookId === 'selection-probe.txt')
        ?.anchorState === 'unresolved';
    })()`,
    'mismatched annotation marked unresolved',
    60_000,
  );
  const highlightDrift = await evaluate(`(() => {
    const view = document.querySelector('foliate-view');
    return {
      overlayVisible: Boolean(view?.renderer?.getContents?.().some(({ overlayer }) => (
        overlayer?.element?.querySelector('[data-reader-highlight="true"]')
      ))),
    };
  })()`);
  assert.equal(highlightDrift.overlayVisible, false, JSON.stringify(highlightDrift));
  const highlightRepair = await evaluate(`(async () => {
    const view = document.querySelector('foliate-view');
    const renderer = view?.renderer;
    const doc = renderer?.getContents?.()[0]?.doc;
    if (!renderer || !doc) return { missing: true };
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    let textNode = null;
    while (walker.nextNode()) {
      if (walker.currentNode.textContent?.includes('Selection probe paragraph')) {
        textNode = walker.currentNode;
        break;
      }
    }
    if (!textNode) return { missingText: true };
    const selectionProbe = ' probe paragraph ';
    const start = textNode.textContent.indexOf(selectionProbe);
    const range = doc.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, start + selectionProbe.length);
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    doc.dispatchEvent(new doc.defaultView.Event('selectionchange'));
    const menuDeadline = performance.now() + 2000;
    while (!document.querySelector('[data-reader-selection-menu="true"]')
      && performance.now() < menuDeadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    document.querySelector(
      '[data-reader-selection-menu="true"] button[aria-label="초록 하이라이트 추가"]',
    )?.click();
    const overlayDeadline = performance.now() + 3000;
    const hasOverlay = () => renderer.getContents().some(({ overlayer }) => (
      overlayer?.element?.querySelector('[data-reader-highlight="true"]')
    ));
    while (!hasOverlay() && performance.now() < overlayDeadline) {
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const request = indexedDB.open('web-reader-db');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const getAll = db.transaction('annotations-v8', 'readonly')
      .objectStore('annotations-v8').getAll();
    const records = await new Promise((resolve, reject) => {
      getAll.onsuccess = () => resolve(getAll.result);
      getAll.onerror = () => reject(getAll.error);
    });
    db.close();
    const saved = records.find((record) => record.bookId === 'selection-probe.txt');
    return {
      overlayVisible: Boolean(hasOverlay()),
      savedCount: records.filter((record) => record.bookId === 'selection-probe.txt').length,
      colorId: saved?.colorId ?? null,
      anchorState: saved?.anchorState ?? null,
      quote: saved?.quote ?? null,
    };
  })()`);
  assert.equal(highlightRepair.overlayVisible, true, JSON.stringify(highlightRepair));
  assert.equal(highlightRepair.savedCount, 1);
  assert.equal(highlightRepair.colorId, 'green');
  assert.equal(highlightRepair.anchorState, 'active');
  assert.equal(highlightRepair.quote, selectionActions.selectedText);
  await evaluate(`document.querySelector('button[aria-label="Close reader"]')?.click()`);
  await waitFor(
    `document.querySelector("h1")?.textContent?.includes("Guest Library")`,
    'shelf after unresolved highlight check',
  );
  await evaluate(`caches.delete('pc-reader-v1.7.10')`);

  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.title === 'Add Local Book');
    button?.click();
    return Boolean(button);
  })()`);
  await waitFor(
    'Boolean(document.querySelector(\'input[type="file"]\'))',
    'solid 7z import modal',
  );
  await evaluate(`(() => {
    const bytes = Uint8Array.from(
      atob(${JSON.stringify(solidArchiveBase64)}),
      (character) => character.charCodeAt(0),
    );
    const file = new File([bytes], 'solid-pages.7z', {
      type: 'application/x-7z-compressed',
    });
    const transfer = new DataTransfer();
    transfer.items.add(file);
    const input = document.querySelector('input[type="file"]');
    input.files = transfer.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input.files.length;
  })()`);
  await waitFor(
    `document.body.innerText.includes('solid-pages.7z')`,
    'solid 7z selection',
  );
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.textContent?.trim() === '추가');
    button?.click();
    return Boolean(button);
  })()`);
  await waitFor(
    `(async () => {
      const request = indexedDB.open('web-reader-db');
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const ownerKey = 'guest:device-library|library:local';
      const tx = db.transaction('metadata-v5', 'readonly');
      const get = tx.objectStore('metadata-v5').get([ownerKey, 'solid-pages.7z']);
      const value = await new Promise((resolve, reject) => {
        get.onsuccess = () => resolve(get.result);
        get.onerror = () => reject(get.error);
      });
      db.close();
      return Boolean(value);
    })()`,
    'solid 7z import',
  );
  await evaluate(`(() => {
    localStorage.setItem('last_reader_session', JSON.stringify({
      version: 2,
      bookId: 'solid-pages.7z',
      updatedAt: Date.now()
    }));
  })()`);
  await command('Page.reload', { ignoreCache: true });
  await waitFor(
    `document.querySelector('foliate-view')?.renderer?.index === 0`,
    'auto-open last reader session',
    60_000,
  );
  const autoOpenSession = await evaluate(`(() => ({
    readerVisible: Boolean(document.querySelector('foliate-view')),
    bookTitle: document.body.innerText.includes('solid-pages'),
    storedSession: JSON.parse(localStorage.getItem('last_reader_session') || 'null')?.bookId ?? null,
  }))()`);
  assert.equal(autoOpenSession.readerVisible, true);
  assert.equal(autoOpenSession.bookTitle, true);
  assert.equal(autoOpenSession.storedSession, 'solid-pages.7z');
  await evaluate(`document.querySelector('button[aria-label="Close reader"]')?.click()`);
  await waitFor(
    'document.querySelector("h1")?.textContent?.includes("Guest Library")',
    'shelf after auto-open close',
  );
  await waitFor(
    `localStorage.getItem('last_reader_session') === null`,
    'last reader intent cleared after reader close',
  );
  await command('Page.reload', { ignoreCache: true });
  await waitFor(
    `document.querySelector("h1")?.textContent?.includes("Guest Library")
      && !document.querySelector('foliate-view')`,
    'shelf remains after reader close reload',
  );
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.title === 'Search Books');
    button?.click();
    return Boolean(button);
  })()`);
  await waitFor(
    'Boolean(document.querySelector(\'input[placeholder="도서 이름으로 검색..."]\'))',
    'solid 7z search modal',
  );
  assert.equal(
    await setInputValue(
      'input[placeholder="도서 이름으로 검색..."]',
      'solid-pages',
    ),
    true,
  );
  await evaluate('document.querySelector(\'input[placeholder="도서 이름으로 검색..."]\')?.form?.requestSubmit()');
  await waitFor(
    `document.querySelectorAll('main h3').length === 1
      && document.querySelector('main h3')?.textContent?.includes('solid-pages')`,
    'solid 7z search result',
  );
  await evaluate(`(() => {
    const NativeWorker = window.Worker;
    const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
    const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
    const activeUrls = new Set();
    const stats = {
      extracts: [],
      initialized: 0,
      terminated: 0,
    };
    window.__solidSevenZip = {
      NativeWorker,
      nativeCreateObjectURL,
      nativeRevokeObjectURL,
      activeUrls,
      stats,
    };
    window.Worker = class TrackedWorker extends NativeWorker {
      constructor(url, options) {
        super(url, options);
        this.__isSevenZipWorker = String(url).includes('/7z/archive-worker.js');
      }
      postMessage(message, ...args) {
        if (this.__isSevenZipWorker && message?.type === 'init') {
          stats.initialized += 1;
        }
        if (this.__isSevenZipWorker && message?.type === 'extract') {
          stats.extracts.push(message.entryName);
        }
        return super.postMessage(message, ...args);
      }
      terminate() {
        if (this.__isSevenZipWorker) stats.terminated += 1;
        return super.terminate();
      }
    };
    URL.createObjectURL = (blob) => {
      const url = nativeCreateObjectURL(blob);
      activeUrls.add(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      activeUrls.delete(url);
      return nativeRevokeObjectURL(url);
    };
    document.querySelector('main h3')?.closest('.group')?.click();
  })()`);
  await waitFor(
    `document.querySelector('foliate-view')?.renderer?.index === 0`,
    'solid 7z first page',
    60_000,
  );
  await evaluate(`(() => {
    const clientX = innerWidth / 2;
    const clientY = innerHeight / 2;
    document.elementFromPoint(clientX, clientY)?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, clientX, clientY }),
    );
  })()`);
  await waitFor(
    `document.querySelector('nav')?.classList.contains('translate-y-0')`,
    'reader controls',
  );
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.textContent?.trim() === '설정');
    button?.click();
    return Boolean(button);
  })()`);
  await waitFor(
    `document.body.innerText.includes('TOP/BOTTOM')
      && document.body.innerText.includes('LEFT/RIGHT')
      && document.body.innerText.includes('마지막으로 읽던 책 자동 열기')`,
    'settings modal base controls',
  );
  const tapSettings = await evaluate(`(async () => {
    const autoOpenCheckbox = document.querySelector('input[type="checkbox"]');
    const autoOpenInitially = autoOpenCheckbox?.checked;
    autoOpenCheckbox?.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const storedDisabled = JSON.parse(localStorage.getItem('viewer_settings') || '{}');
    autoOpenCheckbox?.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const getRowText = (label) => {
      const labelNode = [...document.querySelectorAll('label')]
        .find((node) => node.textContent?.trim() === label);
      return labelNode?.parentElement?.textContent?.replace(/\\s+/g, ' ').trim() ?? '';
    };
    const initial = {
      topBottom: getRowText('Top/Bottom'),
      leftRight: getRowText('Left/Right'),
      bodyPosition: document.body.style.position,
    };
    const topIncrease = document.querySelector(
      'button[aria-label="Increase top and bottom tap area"]',
    );
    const leftDecrease = document.querySelector(
      'button[aria-label="Decrease left and right tap area"]',
    );
    topIncrease?.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    topIncrease?.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    leftDecrease?.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const updated = {
      topBottom: getRowText('Top/Bottom'),
      leftRight: getRowText('Left/Right'),
    };
    const stored = JSON.parse(localStorage.getItem('viewer_settings') || '{}');
    const renderer = document.querySelector('foliate-view')?.renderer;
    const scaleBeforeModalKey = renderer?.userScale ?? null;
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'ArrowUp',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const scaleAfterModalKey = renderer?.userScale ?? null;
    const heading = [...document.querySelectorAll('h2')]
      .find((node) => node.textContent?.trim() === '리더 설정');
    heading?.parentElement?.querySelector('button')?.click();
    return {
      initial,
      updated,
      stored,
      autoOpenInitially,
      storedDisabled,
      scaleBeforeModalKey,
      scaleAfterModalKey,
    };
  })()`);
  assert.match(tapSettings.initial.topBottom, /33%/);
  assert.match(tapSettings.initial.leftRight, /30%/);
  assert.equal(tapSettings.initial.bodyPosition, 'fixed');
  assert.equal(tapSettings.autoOpenInitially, true);
  assert.equal(tapSettings.storedDisabled.autoOpenLastBook, false);
  assert.match(tapSettings.updated.topBottom, /35%/);
  assert.match(tapSettings.updated.leftRight, /29%/);
  assert.equal(tapSettings.stored.tapTopBottomPercent, 35);
  assert.equal(tapSettings.stored.tapLeftRightPercent, 29);
  assert.equal(tapSettings.stored.autoOpenLastBook, true);
  assert.equal(tapSettings.scaleAfterModalKey, tapSettings.scaleBeforeModalKey);

  const controlsOverlayWheel = await evaluate(`(async () => {
    const renderer = document.querySelector('foliate-view')?.renderer;
    if (!renderer) return null;
    const navVisible = document.querySelector('nav')?.classList.contains('translate-y-0');
    if (!navVisible) {
      const clientX = innerWidth / 2;
      const clientY = innerHeight / 2;
      document.elementFromPoint(clientX, clientY)?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, clientX, clientY }),
      );
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    const before = renderer.userScale;
    const clientX = innerWidth / 2;
    const clientY = innerHeight / 2;
    const target = document.elementFromPoint(clientX, clientY);
    const event = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -120,
      clientX,
      clientY,
    });
    target?.dispatchEvent(event);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return {
      before,
      after: renderer.userScale,
      defaultPrevented: event.defaultPrevented,
      overlay: target?.className ?? '',
    };
  })()`);
  assert.equal(controlsOverlayWheel.after, controlsOverlayWheel.before);
  assert.equal(controlsOverlayWheel.defaultPrevented, true);

  const controlsOverlayTouchPan = await evaluate(`(async () => {
    const renderer = document.querySelector('foliate-view')?.renderer;
    const overlay = document.querySelector('[data-reader-controls-overlay="true"]');
    if (!renderer || !overlay || typeof Touch !== 'function') return null;
    renderer.setUserScale(2, { x: innerWidth / 2, y: innerHeight / 2 });
    await new Promise((resolve) => requestAnimationFrame(resolve));
    renderer.scrollLeft = 0;
    renderer.scrollTop = 0;
    const before = {
      scrollLeft: renderer.scrollLeft,
      scrollTop: renderer.scrollTop,
    };
    const makeTouch = (identifier, clientX, clientY) => new Touch({
      identifier,
      target: overlay,
      clientX,
      clientY,
      screenX: clientX,
      screenY: clientY,
      pageX: clientX,
      pageY: clientY,
    });
    const startTouch = makeTouch(1, innerWidth / 2, innerHeight / 2);
    overlay.dispatchEvent(new TouchEvent('touchstart', {
      bubbles: true,
      cancelable: true,
      touches: [startTouch],
      targetTouches: [startTouch],
      changedTouches: [startTouch],
    }));
    const moveTouch = makeTouch(1, innerWidth / 2 - 80, innerHeight / 2 - 70);
    const moveEvent = new TouchEvent('touchmove', {
      bubbles: true,
      cancelable: true,
      touches: [moveTouch],
      targetTouches: [moveTouch],
      changedTouches: [moveTouch],
    });
    overlay.dispatchEvent(moveEvent);
    overlay.dispatchEvent(new TouchEvent('touchend', {
      bubbles: true,
      cancelable: true,
      touches: [],
      targetTouches: [],
      changedTouches: [moveTouch],
    }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    return {
      before,
      after: {
        scrollLeft: renderer.scrollLeft,
        scrollTop: renderer.scrollTop,
      },
    };
  })()`);
  assert.ok(controlsOverlayTouchPan);
  assert.ok(controlsOverlayTouchPan.after.scrollLeft > controlsOverlayTouchPan.before.scrollLeft);
  assert.ok(controlsOverlayTouchPan.after.scrollTop > controlsOverlayTouchPan.before.scrollTop);

  const themeSettings = await evaluate(`(async () => {
    const themeButton = [...document.querySelectorAll('button')]
      .find((node) => node.textContent?.trim() === '테마');
    themeButton?.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const darkTheme = [...document.querySelectorAll('button')]
      .find((node) => node.textContent?.includes('dark')
        && node.textContent?.includes('Comfortable reading'));
    darkTheme?.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const emeraldAccent = document.querySelector('button[title="emerald"]');
    emeraldAccent?.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve, reject) => {
      const deadline = performance.now() + 3000;
      const waitForPaint = () => {
        const readerRoot = document.querySelector('foliate-view')?.closest('.h-screen.w-screen');
        const rootStyle = getComputedStyle(document.documentElement);
        const readerRootStyle = readerRoot ? getComputedStyle(readerRoot) : null;
        const hasThemePaint = rootStyle.getPropertyValue('--accent-500').trim() === '#10b981'
          && rootStyle.getPropertyValue('--viewer-reader-surface').trim() === 'rgba(39, 39, 40, 0.68)'
          && readerRootStyle?.backgroundColor === 'rgb(39, 39, 40)';

        if (hasThemePaint) {
          resolve(true);
          return;
        }
        if (performance.now() > deadline) {
          reject(new Error('Timed out waiting for reader shell theme paint'));
          return;
        }
        requestAnimationFrame(waitForPaint);
      };
      waitForPaint();
    });

    const stored = JSON.parse(localStorage.getItem('viewer_settings') || '{}');
    const rootStyle = getComputedStyle(document.documentElement);
    const bodyStyle = getComputedStyle(document.body);
    const readerRoot = document.querySelector('foliate-view')?.closest('.h-screen.w-screen');
    const themeModalFrame = [...document.querySelectorAll('div.fixed.inset-0 > div')]
      .find((node) => node.textContent?.includes('테마 설정'));
    const toolbarSurface = getComputedStyle(document.querySelector('nav button')).backgroundColor;
    const heading = [...document.querySelectorAll('h2')]
      .find((node) => node.textContent?.trim() === '테마 설정');
    heading?.parentElement?.querySelector('button[aria-label="커스텀 테마 추가"]')
      ?.parentElement?.querySelector('button:last-child')?.click();
    return {
      opened: Boolean(themeButton),
      selected: Boolean(darkTheme),
      accentSelected: Boolean(emeraldAccent),
      storedTheme: stored.theme,
      storedAccent: stored.accentColor,
      rootAccent: rootStyle.getPropertyValue('--accent-500').trim(),
      rootReaderSurface: rootStyle.getPropertyValue('--viewer-reader-surface').trim(),
      bodyBackground: bodyStyle.backgroundColor,
      readerRootBackground: readerRoot ? getComputedStyle(readerRoot).backgroundColor : '',
      themeModalBackground: themeModalFrame ? getComputedStyle(themeModalFrame).backgroundColor : '',
      toolbarSurface,
    };
  })()`);
  assert.equal(themeSettings.opened, true);
  assert.equal(themeSettings.selected, true);
  assert.equal(themeSettings.accentSelected, true);
  assert.equal(themeSettings.storedTheme, 'dark');
  assert.equal(themeSettings.storedAccent, 'emerald');
  assert.equal(themeSettings.rootAccent, '#10b981');
  assert.equal(themeSettings.rootReaderSurface, 'rgba(39, 39, 40, 0.68)');
  assert.equal(themeSettings.bodyBackground, 'rgb(39, 39, 40)');
  assert.equal(themeSettings.readerRootBackground, 'rgb(39, 39, 40)');
  assert.equal(themeSettings.themeModalBackground, 'rgb(39, 39, 40)');
  assert.equal(themeSettings.toolbarSurface, 'rgba(39, 39, 40, 0.68)');

  await evaluate(`(async () => {
    document.querySelector('[data-reader-controls-overlay="true"]')?.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    document.querySelector('[data-reader-controls-overlay="true"]')?.click();
  })()`);
  await waitFor(
    `!document.querySelector('nav')?.classList.contains('translate-y-0')`,
    'reader controls close after tap settings',
  );
  const tapBoundary = await evaluate(`(async () => {
    const dispatchTap = (xRatio) => {
      const clientX = innerWidth * xRatio;
      const clientY = innerHeight / 2;
      document.elementFromPoint(clientX, clientY)?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, clientX, clientY }),
      );
    };
    const controlsAreOpen = () => document.querySelector('nav')
      ?.classList.contains('translate-y-0') ?? false;

    dispatchTap(0.295);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const controlsAtTwentyNinePointFive = controlsAreOpen();

    document.querySelector('div.fixed.inset-0.z-40.touch-none')?.click();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    dispatchTap(0.28);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const controlsAtTwentyEight = controlsAreOpen();
    const indexAfterTwentyEight = document.querySelector('foliate-view')?.renderer?.index ?? -1;
    return {
      controlsAtTwentyNinePointFive,
      controlsAtTwentyEight,
      indexAfterTwentyEight,
    };
  })()`);
  assert.equal(tapBoundary.controlsAtTwentyNinePointFive, true);
  assert.equal(tapBoundary.controlsAtTwentyEight, false);
  assert.equal(tapBoundary.indexAfterTwentyEight, 0);

  const fixedLayoutMouseZoomDrag = await evaluate(`(async () => {
    const view = document.querySelector('foliate-view');
    const renderer = view?.renderer;
    const overlay = document.querySelector('[data-reader-interaction-overlay="true"]');
    if (!renderer || !overlay) return { missing: true };

    await renderer.goToSpread(0, 'center', 'mouse-zoom-drag-test');
    await new Promise((resolve) => requestAnimationFrame(resolve));
    renderer.resetUserScale();
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    const pointerId = 765;
    const clientX = Math.round(innerWidth / 2);
    const clientY = Math.round(innerHeight / 2);
    const modifier = isMac ? { metaKey: true } : { ctrlKey: true };
    const dispatchPointer = (type, y, buttons) => overlay.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId,
      pointerType: 'mouse',
      button: 0,
      buttons,
      clientX,
      clientY: y,
      ...modifier,
    }));

    dispatchPointer('pointerdown', clientY, 1);
    dispatchPointer('pointermove', clientY - 110, 1);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    dispatchPointer('pointerup', clientY - 110, 0);
    await new Promise((resolve) => requestAnimationFrame(resolve));

    const scaleAfterDrag = renderer.userScale;
    const indexBeforeSuppressedClick = renderer.index;
    overlay.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(innerWidth * 0.9),
      clientY,
      ...modifier,
    }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const indexAfterSuppressedClick = renderer.index;

    renderer.resetUserScale();
    await new Promise((resolve) => requestAnimationFrame(resolve));
    dispatchPointer('pointerdown', clientY, 1);
    dispatchPointer('pointermove', clientY - 90, 1);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    overlay.dispatchEvent(new PointerEvent('lostpointercapture', {
      bubbles: true,
      cancelable: true,
      pointerId,
      pointerType: 'mouse',
      button: 0,
      buttons: 0,
      clientX,
      clientY: clientY - 90,
      ...modifier,
    }));
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const scaleAfterLostCapture = renderer.userScale;

    return {
      isMac,
      scaleAfterDrag,
      scaleAfterLostCapture,
      indexBeforeSuppressedClick,
      indexAfterSuppressedClick,
    };
  })()`);
  assert.equal(fixedLayoutMouseZoomDrag.missing, undefined);
  assert.ok(fixedLayoutMouseZoomDrag.scaleAfterDrag > 1);
  assert.ok(fixedLayoutMouseZoomDrag.scaleAfterLostCapture > 1);
  assert.equal(
    fixedLayoutMouseZoomDrag.indexAfterSuppressedClick,
    fixedLayoutMouseZoomDrag.indexBeforeSuppressedClick,
  );

  const solidSevenZipResult = await evaluate(`(async () => {
    const view = document.querySelector('foliate-view');
    const renderer = view.renderer;
    const first = renderer.goToSpread(1, 'center', 'page');
    const stale = renderer.goToSpread(5, 'center', 'page');
    const latest = renderer.goToSpread(2, 'center', 'page');
    const navigation = await Promise.allSettled([first, stale, latest]);
    const deadline = performance.now() + 60_000;
    while (
      performance.now() < deadline
      && (
        renderer.index !== 2
        || renderer.getContents().length !== 1
        || !renderer.getContents()[0]?.doc?.querySelector('img')?.complete
      )
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const state = window.__solidSevenZip;
    const finalIndex = renderer.index;
    const finalFrameCount = renderer.getContents().length;
    const finalImageComplete = Boolean(
      renderer.getContents()[0]?.doc?.querySelector('img')?.complete,
    );
    view.close();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const result = {
      activeBlobUrls: state.activeUrls.size,
      errors: [...window.__regressionErrors],
      extracts: [...state.stats.extracts],
      finalFrameCount,
      finalIndex,
      finalImageComplete,
      initialized: state.stats.initialized,
      navigation: navigation.map(({ status, reason }) => ({
        status,
        reason: reason?.name ?? null,
      })),
      terminated: state.stats.terminated,
    };
    window.Worker = state.NativeWorker;
    URL.createObjectURL = state.nativeCreateObjectURL;
    URL.revokeObjectURL = state.nativeRevokeObjectURL;
    return result;
  })()`);
  const solidSevenZipDebug = JSON.stringify(solidSevenZipResult);
  assert.equal(solidSevenZipResult.initialized, 1, solidSevenZipDebug);
  assert.equal(solidSevenZipResult.finalIndex, 2, solidSevenZipDebug);
  assert.equal(solidSevenZipResult.finalFrameCount, 1, solidSevenZipDebug);
  assert.equal(solidSevenZipResult.finalImageComplete, true, solidSevenZipDebug);
  assert.ok(solidSevenZipResult.extracts.some((name) => name.endsWith('02.bmp')));
  assert.ok(solidSevenZipResult.extracts.some((name) => name.endsWith('03.bmp')));
  assert.ok(!solidSevenZipResult.extracts.some((name) => name.endsWith('06.bmp')));
  assert.equal(solidSevenZipResult.terminated, 1, solidSevenZipDebug);
  assert.equal(solidSevenZipResult.activeBlobUrls, 0, solidSevenZipDebug);
  assert.deepEqual(solidSevenZipResult.errors, [], solidSevenZipDebug);

  await evaluate(`document.querySelector('button[aria-label="Close reader"]')?.click()`);
  await waitFor(
    'document.querySelector("h1")?.textContent?.includes("Guest Library")',
    'shelf after themed reader close',
  );
  const shelfThemeAfterReaderClose = await evaluate(`(() => {
    const stored = JSON.parse(localStorage.getItem('viewer_settings') || '{}');
    const rootStyle = getComputedStyle(document.documentElement);
    const shelfRoot = document.querySelector('main')?.closest('.min-h-screen');
    const shelfStyle = shelfRoot ? getComputedStyle(shelfRoot) : null;
    return {
      storedTheme: stored.theme,
      storedAccent: stored.accentColor,
      rootAccent: rootStyle.getPropertyValue('--accent-500').trim(),
      rootThemeBg: rootStyle.getPropertyValue('--viewer-theme-bg').trim(),
      shelfBackground: shelfStyle?.backgroundColor ?? '',
      shelfColor: shelfStyle?.color ?? '',
    };
  })()`);
  assert.equal(shelfThemeAfterReaderClose.storedTheme, 'dark');
  assert.equal(shelfThemeAfterReaderClose.storedAccent, 'emerald');
  assert.equal(shelfThemeAfterReaderClose.rootAccent, '#10b981');
  assert.equal(shelfThemeAfterReaderClose.rootThemeBg, '#272728');
  assert.equal(shelfThemeAfterReaderClose.shelfBackground, 'rgb(39, 39, 40)');
  assert.equal(shelfThemeAfterReaderClose.shelfColor, 'rgb(184, 184, 184)');

  const fixedLayout = await evaluate(`(async () => {
    document.body.replaceChildren();
    const { FixedLayout } = await import('/foliate-js/fixed-layout.js');
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const pageUrls = Array.from({ length: 3 }, (_, index) => URL.createObjectURL(
      new Blob([
        '<!doctype html><meta name="viewport" content="width=600,height=800">'
          + '<body>Page ' + index + '</body>',
      ], { type: 'text/html' }),
    ));
    const delays = [0, 80, 5];
    const sections = pageUrls.map((src, index) => ({
      id: 'page-' + index,
      load: async () => {
        await sleep(delays[index]);
        return src;
      },
    }));
    const renderer = new FixedLayout();
    renderer.style.cssText = 'width:700px;height:800px';
    document.body.append(renderer);
    const relocations = [];
    renderer.addEventListener('relocate', (event) => {
      relocations.push(event.detail.index);
    });
    renderer.open({
      rendition: { layout: 'pre-paginated', spread: 'none' },
      sections,
      dir: 'ltr',
    });
    await renderer.goToSpread(0, 'center', 'initial');
    const next = renderer.next();
    await sleep(2);
    const previous = renderer.prev();
    await Promise.all([next, previous]);
    const firstNext = renderer.next();
    await sleep(2);
    const secondNext = renderer.next();
    await Promise.all([firstNext, secondNext]);
    await sleep(30);
    const result = {
      index: renderer.index,
      frameCount: renderer.getContents().length,
      relocations,
    };
    renderer.destroy();

    const zoomRenderer = new FixedLayout();
    zoomRenderer.style.cssText = 'width:700px;height:800px';
    document.body.append(zoomRenderer);
    zoomRenderer.open({
      rendition: { layout: 'pre-paginated', spread: 'none' },
      sections,
      dir: 'ltr',
    });
    await zoomRenderer.goToSpread(0, 'center', 'initial');
    const baseScale = zoomRenderer.effectiveScale;
    zoomRenderer.setUserScale(2, { x: 350, y: 400 });
    const zoomedScale = zoomRenderer.userScale;
    const zoomedEffectiveScale = zoomRenderer.effectiveScale;
    const zoomedAlignment = {
      justifyContent: getComputedStyle(zoomRenderer).justifyContent,
      alignItems: getComputedStyle(zoomRenderer).alignItems,
    };
    const beforePan = {
      scrollLeft: zoomRenderer.scrollLeft,
      scrollTop: zoomRenderer.scrollTop,
    };
    const afterPan = zoomRenderer.panBy(40, 50);
    await zoomRenderer.next();
    await sleep(30);
    const afterPageTurn = {
      scrollLeft: zoomRenderer.scrollLeft,
      scrollTop: zoomRenderer.scrollTop,
    };
    const pageTurnScale = zoomRenderer.userScale;
    const pageTurnIndex = zoomRenderer.index;
    const pageTurnAlignment = {
      justifyContent: getComputedStyle(zoomRenderer).justifyContent,
      alignItems: getComputedStyle(zoomRenderer).alignItems,
    };
    const afterResetScale = zoomRenderer.resetUserScale();
    result.zoom = {
      baseScale,
      zoomedScale,
      zoomedEffectiveScale,
      zoomedAlignment,
      beforePan,
      afterPan,
      pageTurnScale,
      pageTurnIndex,
      pageTurnScroll: afterPageTurn,
      pageTurnAlignment,
      afterResetScale,
      afterResetScroll: {
        scrollLeft: zoomRenderer.scrollLeft,
        scrollTop: zoomRenderer.scrollTop,
      },
      afterResetAlignment: {
        justifyContent: getComputedStyle(zoomRenderer).justifyContent,
        alignItems: getComputedStyle(zoomRenderer).alignItems,
      },
    };
    zoomRenderer.destroy();

    const centeredZoomRenderer = new FixedLayout();
    centeredZoomRenderer.style.cssText = 'width:1200px;height:800px';
    document.body.append(centeredZoomRenderer);
    centeredZoomRenderer.open({
      rendition: { layout: 'pre-paginated', spread: 'none' },
      sections,
      dir: 'ltr',
    });
    await centeredZoomRenderer.goToSpread(0, 'center', 'initial');
    centeredZoomRenderer.setUserScale(1.5, { x: 600, y: 400 });
    result.centeredZoom = {
      userScale: centeredZoomRenderer.userScale,
      scrollWidth: centeredZoomRenderer.scrollWidth,
      clientWidth: centeredZoomRenderer.clientWidth,
      scrollHeight: centeredZoomRenderer.scrollHeight,
      clientHeight: centeredZoomRenderer.clientHeight,
      alignment: {
        justifyContent: getComputedStyle(centeredZoomRenderer).justifyContent,
        alignItems: getComputedStyle(centeredZoomRenderer).alignItems,
      },
    };
    centeredZoomRenderer.destroy();
    pageUrls.forEach((url) => URL.revokeObjectURL(url));
    return result;
  })()`);
  assert.equal(fixedLayout.index, 2);
  assert.equal(fixedLayout.frameCount, 1);
  assert.deepEqual(fixedLayout.relocations, [0, 2]);
  assert.equal(fixedLayout.zoom.zoomedScale, 2);
  assert.ok(fixedLayout.zoom.zoomedEffectiveScale > fixedLayout.zoom.baseScale);
  assert.equal(fixedLayout.zoom.zoomedAlignment.justifyContent, 'flex-start');
  assert.equal(fixedLayout.zoom.zoomedAlignment.alignItems, 'flex-start');
  assert.ok(fixedLayout.zoom.afterPan.scrollLeft > fixedLayout.zoom.beforePan.scrollLeft);
  assert.ok(fixedLayout.zoom.afterPan.scrollTop > fixedLayout.zoom.beforePan.scrollTop);
  assert.equal(fixedLayout.zoom.pageTurnScale, 2);
  assert.equal(fixedLayout.zoom.pageTurnIndex, 1);
  assert.equal(fixedLayout.zoom.pageTurnAlignment.justifyContent, 'flex-start');
  assert.equal(fixedLayout.zoom.pageTurnAlignment.alignItems, 'flex-start');
  assert.ok(Math.abs(fixedLayout.zoom.pageTurnScroll.scrollLeft - fixedLayout.zoom.afterPan.scrollLeft) <= 1);
  assert.ok(Math.abs(fixedLayout.zoom.pageTurnScroll.scrollTop - fixedLayout.zoom.afterPan.scrollTop) <= 1);
  assert.equal(fixedLayout.zoom.afterResetScale, 1);
  assert.equal(fixedLayout.zoom.afterResetScroll.scrollLeft, 0);
  assert.equal(fixedLayout.zoom.afterResetScroll.scrollTop, 0);
  assert.equal(fixedLayout.zoom.afterResetAlignment.justifyContent, 'center');
  assert.equal(fixedLayout.zoom.afterResetAlignment.alignItems, 'center');
  assert.equal(fixedLayout.centeredZoom.userScale, 1.5);
  assert.ok(fixedLayout.centeredZoom.scrollWidth <= fixedLayout.centeredZoom.clientWidth);
  assert.ok(fixedLayout.centeredZoom.scrollHeight > fixedLayout.centeredZoom.clientHeight);
  assert.equal(fixedLayout.centeredZoom.alignment.justifyContent, 'center');
  assert.equal(fixedLayout.centeredZoom.alignment.alignItems, 'flex-start');

  const pdfResult = await evaluate(`(async () => {
    document.body.replaceChildren();
    window.__regressionErrors = [];
    const nativeWorkerTerminate = Worker.prototype.terminate;
    const workerStats = { terminated: 0 };
    Worker.prototype.terminate = function(...args) {
      workerStats.terminated += 1;
      return nativeWorkerTerminate.apply(this, args);
    };
    const nativeCreateObjectURL = URL.createObjectURL.bind(URL);
    const nativeRevokeObjectURL = URL.revokeObjectURL.bind(URL);
    const activeUrls = new Set();
    URL.createObjectURL = (blob) => {
      const url = nativeCreateObjectURL(blob);
      activeUrls.add(url);
      return url;
    };
    URL.revokeObjectURL = (url) => {
      activeUrls.delete(url);
      return nativeRevokeObjectURL(url);
    };

    const createPdf = (pageCount) => {
      const objects = new Map();
      const pageIds = [];
      let nextObject = 3;
      for (let page = 1; page <= pageCount; page += 1) {
        const pageId = nextObject++;
        const contentId = nextObject++;
        pageIds.push(pageId);
        const stream = 'BT /F1 24 Tf 72 720 Td (Page ' + page + ') Tj ET';
        objects.set(pageId,
          '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] '
          + '/Resources << /Font << /F1 ' + (3 + pageCount * 2)
          + ' 0 R >> >> /Contents ' + contentId + ' 0 R >>');
        objects.set(contentId,
          '<< /Length ' + stream.length + ' >>\\nstream\\n'
          + stream + '\\nendstream');
      }
      const fontId = nextObject;
      objects.set(1, '<< /Type /Catalog /Pages 2 0 R >>');
      objects.set(2,
        '<< /Type /Pages /Kids ['
        + pageIds.map((id) => id + ' 0 R').join(' ')
        + '] /Count ' + pageCount + ' >>');
      objects.set(fontId,
        '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');

      let pdf = '%PDF-1.4\\n';
      const offsets = [0];
      for (let id = 1; id <= fontId; id += 1) {
        offsets[id] = pdf.length;
        pdf += id + ' 0 obj\\n' + objects.get(id) + '\\nendobj\\n';
      }
      const xref = pdf.length;
      pdf += 'xref\\n0 ' + (fontId + 1) + '\\n';
      pdf += '0000000000 65535 f \\n';
      for (let id = 1; id <= fontId; id += 1) {
        pdf += String(offsets[id]).padStart(10, '0') + ' 00000 n \\n';
      }
      pdf += 'trailer\\n<< /Size ' + (fontId + 1)
        + ' /Root 1 0 R >>\\nstartxref\\n' + xref + '\\n%%EOF';
      return new TextEncoder().encode(pdf);
    };

    const { makePDF } = await import('/foliate-js/pdf.js');
    const file = new File([createPdf(7)], 'regression.pdf', {
      type: 'application/pdf',
    });
    const book = await makePDF(file);
    const renderDebug = {
      calls: 0,
      cleanups: 0,
      destroys: 0,
      resolved: 0,
      rejected: [],
    };
    const firstPageSource = await book.sections[0].load();
    const firstPageOnZoom = firstPageSource.onZoom;
    const trackedOnZoom = (...args) => {
      renderDebug.calls += 1;
      renderDebug.scales = [...(renderDebug.scales || []), args[0]?.scale];
      renderDebug.previewFlags = [...(renderDebug.previewFlags || []), Boolean(args[0]?.preview)];
      return firstPageOnZoom(...args).then(
        (value) => {
          renderDebug.resolved += 1;
          renderDebug.canvasAfterResolve = args[0]?.doc
            ?.querySelectorAll('#canvas canvas').length;
          renderDebug.documentUrl = args[0]?.doc?.URL;
          return value;
        },
        (error) => {
          renderDebug.rejected.push(String(error?.stack || error));
          throw error;
        },
      );
    };
    trackedOnZoom.cleanup = (...args) => {
      renderDebug.cleanups += 1;
      return firstPageOnZoom.cleanup(...args);
    };
    trackedOnZoom.destroy = (...args) => {
      renderDebug.destroys += 1;
      return firstPageOnZoom.destroy(...args);
    };
    firstPageSource.onZoom = trackedOnZoom;
    const probe = document.createElement('iframe');
    probe.style.display = 'none';
    document.body.append(probe);
    await new Promise((resolve, reject) => {
      probe.addEventListener('load', resolve, { once: true });
      probe.addEventListener('error', reject, { once: true });
      probe.src = firstPageSource.src;
    });
    await firstPageOnZoom({ doc: probe.contentDocument, scale: 1 });
    const directCanvas = probe.contentDocument.querySelector('#canvas canvas');
    renderDebug.directCanvasCount = probe.contentDocument
      .querySelectorAll('#canvas canvas').length;
    renderDebug.previewBefore = {
      height: directCanvas.height,
      transform: probe.contentDocument.documentElement.style.transform,
      width: directCanvas.width,
    };
    await firstPageOnZoom({ doc: probe.contentDocument, preview: true, scale: 2 });
    const previewCanvas = probe.contentDocument.querySelector('#canvas canvas');
    renderDebug.previewAfter = {
      height: previewCanvas.height,
      transform: probe.contentDocument.documentElement.style.transform,
      width: previewCanvas.width,
    };
    await firstPageOnZoom({ doc: probe.contentDocument, scale: 20 });
    const highScaleCanvas = probe.contentDocument.querySelector('#canvas canvas');
    renderDebug.highScaleCanvas = {
      height: highScaleCanvas.height,
      width: highScaleCanvas.width,
    };
    firstPageOnZoom.cleanup(probe.contentDocument);
    probe.remove();
    const renderer = document.createElement('foliate-fxl');
    renderer.style.cssText = 'display:block;width:640px;height:800px';
    document.body.append(renderer);
    renderer.addEventListener('error', (event) => {
      window.__regressionErrors.push(String(
        event.detail?.error?.stack || event.detail?.error || 'PDF renderer error',
      ));
    });
    renderer.open(book);
    await renderer.goToSpread(0, 'center', 'initial');

    const waitForCanvas = async () => {
      const deadline = performance.now() + 20_000;
      while (performance.now() < deadline) {
        const doc = renderer.getContents()[0]?.doc;
        if (doc?.querySelector('#canvas canvas')) return doc;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(
        'PDF canvas render timed out: '
        + JSON.stringify({
          errors: window.__regressionErrors,
          contents: renderer.getContents().length,
          frameText: renderer.getContents()[0]?.doc?.body?.innerText,
          renderDebug,
        }),
      );
    };
    const waitForLayers = async () => {
      const deadline = performance.now() + 20_000;
      while (performance.now() < deadline) {
        const doc = renderer.getContents()[0]?.doc;
        if (
          doc?.querySelectorAll('#canvas canvas').length === 1
          && doc.querySelectorAll('.textLayer').length === 1
          && doc.querySelectorAll('.annotationLayer').length === 1
          && doc.querySelectorAll('.endOfContent').length === 1
        ) return doc;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      throw new Error(
        'PDF layers render timed out: '
        + JSON.stringify({
          errors: window.__regressionErrors,
          contents: renderer.getContents().length,
        }),
      );
    };
    await waitForCanvas();
    const previewDoc = renderer.getContents()[0]?.doc;
    const previewCanvasBefore = previewDoc.querySelector('#canvas canvas');
    const previewCallsBefore = renderDebug.calls;
    renderer.setUserScale(1.2, { x: 320, y: 400 }, { preview: true });
    renderer.setUserScale(1.4, { x: 320, y: 400 }, { preview: true });
    await new Promise((resolve) => setTimeout(resolve, 100));
    const previewCanvasDuring = previewDoc.querySelector('#canvas canvas');
    renderer.commitUserScale();
    const previewCommitDeadline = performance.now() + 20_000;
    while (
      performance.now() < previewCommitDeadline
      && previewDoc.querySelector('#canvas canvas')?.width === previewCanvasBefore.width
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const previewCanvasAfterCommit = previewDoc.querySelector('#canvas canvas');
    renderDebug.previewGesture = {
      callsDuringPreview: renderDebug.calls - previewCallsBefore,
      duringHeight: previewCanvasDuring.height,
      duringTransform: previewDoc.documentElement.style.transform,
      duringWidth: previewCanvasDuring.width,
      finalHeight: previewCanvasAfterCommit.height,
      finalTransform: previewDoc.documentElement.style.transform,
      finalWidth: previewCanvasAfterCommit.width,
      initialHeight: previewCanvasBefore.height,
      initialWidth: previewCanvasBefore.width,
    };
    renderer.style.width = '500px';
    renderer.style.height = '700px';
    await new Promise((resolve) => requestAnimationFrame(resolve));
    renderer.style.width = '760px';
    renderer.style.height = '680px';
    renderer.style.width = '900px';
    renderer.style.height = '640px';
    await new Promise((resolve) => setTimeout(resolve, 400));
    const doc = await waitForLayers();
    await renderer.goToSpread(6, 'center', 'page');
    const lastDoc = await waitForLayers();
    const layers = {
      canvas: lastDoc.querySelectorAll('#canvas canvas').length,
      text: lastDoc.querySelectorAll('.textLayer').length,
      annotation: lastDoc.querySelectorAll('.annotationLayer').length,
      endOfContent: lastDoc.querySelectorAll('.endOfContent').length,
    };
    for (let index = 1; index <= 3; index += 1) {
      await book.sections[index].load();
    }
    const firstPageReleaseCalls = renderDebug.destroys;
    const cancelledController = new AbortController();
    cancelledController.abort();
    let cancelledLoadError;
    try {
      await book.sections[5].load(cancelledController.signal);
    } catch (error) {
      cancelledLoadError = error?.name;
    }
    const result = {
      pageCount: book.sections.length,
      index: renderer.index,
      layers,
      pageZeroCanvasCount: doc.querySelectorAll('#canvas canvas').length,
      cancelledLoadError,
      firstPageReleaseCalls,
      highScaleCanvas: renderDebug.highScaleCanvas,
      previewAfter: renderDebug.previewAfter,
      previewBefore: renderDebug.previewBefore,
      previewFlags: renderDebug.previewFlags,
      previewGesture: renderDebug.previewGesture,
      errorsBeforeDestroy: [...window.__regressionErrors],
    };
    renderer.destroy();
    await book.destroy();

    const longBook = await makePDF(new File(
      [createPdf(105)],
      'long-regression.pdf',
      { type: 'application/pdf' },
    ));
    let longPdfCleanupCalls = 0;
    const trackedLongSources = new WeakSet();
    for (const section of longBook.sections) {
      const nativeLoad = section.load.bind(section);
      section.load = async (...args) => {
        const source = await nativeLoad(...args);
        if (!trackedLongSources.has(source)) {
          trackedLongSources.add(source);
          const nativeDestroy = source.onZoom.destroy;
          source.onZoom.destroy = (...destroyArgs) => {
            longPdfCleanupCalls += 1;
            return nativeDestroy(...destroyArgs);
          };
        }
        return source;
      };
    }
    const longRenderer = document.createElement('foliate-fxl');
    longRenderer.style.cssText = 'display:block;width:640px;height:800px';
    document.body.append(longRenderer);
    longRenderer.addEventListener('error', (event) => {
      window.__regressionErrors.push(String(
        event.detail?.error?.stack || event.detail?.error || 'Long PDF error',
      ));
    });
    longRenderer.open(longBook);
    let longPdfMaxCanvasCount = 0;
    const waitForLongCanvas = async () => {
      const deadline = performance.now() + 10_000;
      while (performance.now() < deadline) {
        const canvasCount = longRenderer.getContents()[0]?.doc
          ?.querySelectorAll('#canvas canvas').length ?? 0;
        longPdfMaxCanvasCount = Math.max(longPdfMaxCanvasCount, canvasCount);
        if (canvasCount === 1) return;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('Long PDF canvas render timed out');
    };
    for (let index = 0; index < longBook.sections.length; index += 1) {
      await longRenderer.goToSpread(index, 'center', 'page');
      await waitForLongCanvas();
    }
    await longRenderer.goToSpread(0, 'center', 'page');
    await waitForLongCanvas();
    longRenderer.destroy();
    await longBook.destroy();
    result.longPdf = {
      cleanupCalls: longPdfCleanupCalls,
      maxCanvasCount: longPdfMaxCanvasCount,
      pageCount: longBook.sections.length,
    };

    const deadline = performance.now() + 5_000;
    while (
      performance.now() < deadline
      && (activeUrls.size > 0 || workerStats.terminated < 1)
    ) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    result.activeBlobUrls = activeUrls.size;
    result.workerStats = workerStats;
    result.errorsAfterDestroy = [...window.__regressionErrors];
    URL.createObjectURL = nativeCreateObjectURL;
    URL.revokeObjectURL = nativeRevokeObjectURL;
    Worker.prototype.terminate = nativeWorkerTerminate;
    return result;
  })()`);
  assert.equal(pdfResult.pageCount, 7);
  assert.equal(pdfResult.index, 6);
  assert.deepEqual(pdfResult.layers, {
    canvas: 1,
    text: 1,
    annotation: 1,
    endOfContent: 1,
  });
  assert.ok(pdfResult.pageZeroCanvasCount <= 1);
  assert.equal(pdfResult.cancelledLoadError, 'AbortError');
  assert.ok(pdfResult.firstPageReleaseCalls >= 1);
  assert.ok(pdfResult.highScaleCanvas.width <= 8192);
  assert.ok(pdfResult.highScaleCanvas.height <= 8192);
  assert.ok(
    pdfResult.highScaleCanvas.width * pdfResult.highScaleCanvas.height
      <= 8_388_608,
  );
  assert.equal(pdfResult.previewAfter.width, pdfResult.previewBefore.width);
  assert.equal(pdfResult.previewAfter.height, pdfResult.previewBefore.height);
  assert.notEqual(pdfResult.previewAfter.transform, pdfResult.previewBefore.transform);
  assert.ok(pdfResult.previewFlags.includes(true));
  assert.ok(pdfResult.previewGesture.callsDuringPreview >= 2);
  assert.equal(pdfResult.previewGesture.duringWidth, pdfResult.previewGesture.initialWidth);
  assert.equal(pdfResult.previewGesture.duringHeight, pdfResult.previewGesture.initialHeight);
  assert.ok(pdfResult.previewGesture.finalWidth > pdfResult.previewGesture.initialWidth);
  assert.ok(pdfResult.previewGesture.finalHeight > pdfResult.previewGesture.initialHeight);
  assert.equal(pdfResult.longPdf.pageCount, 105);
  assert.equal(pdfResult.longPdf.maxCanvasCount, 1);
  assert.equal(pdfResult.longPdf.cleanupCalls, 106);
  assert.equal(pdfResult.activeBlobUrls, 0);
  assert.ok(pdfResult.workerStats.terminated >= 2);
  assert.deepEqual(pdfResult.errorsBeforeDestroy, []);
  assert.deepEqual(pdfResult.errorsAfterDestroy, []);

  await command('Network.setBypassServiceWorker', { bypass: false });
  const serviceWorkerResult = await evaluate(`(async () => {
    const cachePrefix = 'pc-reader-';
    const expectedCache = 'pc-reader-v1.8.2';
    const staleCache = 'pc-reader-v1.6.4';
    const preCacheUrls = [
      '/',
      '/manifest.json',
      '/favicon.ico',
      '/icon-192.png',
      '/icon-512.png',
      '/logo.png',
      '/fonts/PretendardVariable.woff2',
      '/fonts/RIDIBatang.woff2',
      '/fonts/RIDIBatang.otf',
    ];
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
    const existingCaches = await caches.keys();
    await Promise.all(
      existingCaches
        .filter((name) => name.startsWith(cachePrefix))
        .map((name) => caches.delete(name)),
    );
    const oldCache = await caches.open(staleCache);
    await oldCache.put('/stale-cache-proof', new Response('stale'));
    const existingReleaseCache = await caches.open(expectedCache);
    await existingReleaseCache.put('/fonts/SUIT-Variable.woff2', new Response('obsolete'));

    const registration = await navigator.serviceWorker.register(
      '/sw.js?browser-regression=1.8.2',
      { scope: '/' },
    );
    const worker = registration.installing
      ?? registration.waiting
      ?? registration.active;
    if (worker && worker.state !== 'activated') {
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(
          () => reject(new Error('Service worker activation timed out')),
          20_000,
        );
        worker.addEventListener('statechange', () => {
          if (worker.state !== 'activated') return;
          clearTimeout(timeout);
          resolve();
        });
      });
    }

    const deadline = performance.now() + 20_000;
    let cacheNames = [];
    while (performance.now() < deadline) {
      cacheNames = await caches.keys();
      if (cacheNames.includes(expectedCache) && !cacheNames.includes(staleCache)) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const releaseCache = await caches.open(expectedCache);
    const preCacheHits = await Promise.all(
      preCacheUrls.map(async (url) => ({
        url,
        cached: Boolean(await releaseCache.match(url)),
      })),
    );
    const result = {
      cacheNames: cacheNames.filter((name) => name.startsWith(cachePrefix)),
      oldCacheDeleted: !cacheNames.includes(staleCache),
      legacyFontDeleted: !await releaseCache.match('/fonts/SUIT-Variable.woff2'),
      preCacheHits,
      scriptUrl: registration.active?.scriptURL ?? worker?.scriptURL ?? '',
    };
    await registration.unregister();
    return result;
  })()`);
  assert.deepEqual(serviceWorkerResult.cacheNames, ['pc-reader-v1.8.2']);
  assert.equal(serviceWorkerResult.oldCacheDeleted, true);
  assert.equal(serviceWorkerResult.legacyFontDeleted, true);
  assert.ok(serviceWorkerResult.preCacheHits.every(({ cached }) => cached));
  assert.match(serviceWorkerResult.scriptUrl, /\/sw\.js\?browser-regression=1\.8\.2$/);

  console.log(JSON.stringify({
    shelf: {
      initialShelf,
      secondPageCount,
      previewTitles,
      searchDurationMs,
      sortDurationMs,
      metrics: shelfMetrics,
    },
    sizeLimitUi,
    modalScrollLock,
    modalScrollRestore,
    nestedModalLock,
    archiveLimit: archiveLimitResult,
    actualTextTap: { actualTextTapProbe, actualTextTapOpened, actualTextTapClosed },
    selectionActions,
    highlightReopen,
    highlightResolution,
    highlightDrift,
    highlightRepair,
    solidSevenZip: solidSevenZipResult,
    tapSettings,
    tapBoundary,
    fixedLayoutMouseZoomDrag,
    fixedLayout,
    pdf: pdfResult,
    serviceWorker: serviceWorkerResult,
  }, null, 2));
} finally {
  socket.close();
}
