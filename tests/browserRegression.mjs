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
  clearTimeout(request.timeout);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

const command = (method, params = {}) => new Promise((resolve, reject) => {
  const id = nextId++;
  const commandContext = method === 'Runtime.evaluate' && typeof params.expression === 'string'
    ? `: ${params.expression.replace(/\s+/g, ' ').slice(0, 160)}`
    : '';
  const timeout = setTimeout(() => {
    pending.delete(id);
    reject(new Error(`Chrome DevTools command timed out: ${method}${commandContext}`));
  }, 60_000);
  pending.set(id, { resolve, reject, timeout });
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
  const diagnostics = await evaluate(`(() => {
    const view = document.querySelector('foliate-view');
    return {
      visibilityState: document.visibilityState,
      hasFocus: document.hasFocus(),
      appView: document.querySelector('[data-app-view]')?.getAttribute('data-app-view'),
      libraryBootstrapReady: document.querySelector('[data-app-view]')
        ?.getAttribute('data-library-bootstrap-ready'),
      lastReaderSession: localStorage.getItem('last_reader_session'),
      lastReaderAutoOpen: document.documentElement.dataset.lastReaderAutoOpen,
      viewerSettings: localStorage.getItem('viewer_settings'),
      regressionErrors: window.__regressionErrors ?? [],
      liveFoliateDocuments: view?.renderer?.getContents?.().map(({ doc }) => ({
        visibilityState: doc?.visibilityState,
        connected: Boolean(doc?.defaultView?.frameElement?.isConnected),
        textLength: doc?.body?.innerText?.length ?? 0,
      })) ?? [],
    };
  })()`).catch((error) => ({ diagnosticError: error.message }));
  throw new Error(
    `Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`
    + `\nDiagnostics: ${JSON.stringify(diagnostics)}\n${body}`,
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
  await command('Page.bringToFront');
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
        if (sessionStorage.getItem('browser_regression_skip_guest_bootstrap') !== 'true') {
          localStorage.setItem('isGuest', 'true');
        }
        localStorage.setItem('web_reader_guest_install_id', 'browser-regression');
        localStorage.setItem('neverShowInstallPrompt', 'true');
        localStorage.setItem('shelf_viewMode_v2', 'grid');
        localStorage.setItem('shelf_sortMode', 'recent');
        const storedSettings = JSON.parse(localStorage.getItem('viewer_settings') || '{}');
        localStorage.setItem('viewer_settings', JSON.stringify({
          ...storedSettings,
          theme: sessionStorage.getItem('browser_regression_theme_override') || 'dark',
          accentColor: 'emerald',
          shelfDockStyle: 'modern'
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
      window.__regressionNextFrame = async (frameCount = 1, timeoutMs = 100) => {
        for (let index = 0; index < frameCount; index += 1) {
          await new Promise((resolve) => {
            let settled = false;
            const finish = () => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              resolve();
            };
            const timer = setTimeout(finish, timeoutMs);
            requestAnimationFrame(finish);
          });
        }
      };
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
  assert.equal(themeBootstrapEarly.rootAccent, '#d4af37');
  assert.equal(themeBootstrapEarly.rootBackground, 'rgb(39, 39, 40)');

  await evaluate(`(() => {
    sessionStorage.setItem('browser_regression_skip_guest_bootstrap', 'true');
    localStorage.removeItem('isGuest');
    localStorage.setItem('web_reader_guest_install_id', 'browser-regression');
    localStorage.setItem('neverShowInstallPrompt', 'true');
    localStorage.setItem('shelf_viewMode_v2', 'grid');
    localStorage.setItem('shelf_sortMode', 'recent');
    localStorage.removeItem('viewer_settings');
    localStorage.removeItem('last_reader_session');
    localStorage.removeItem('reader_tts_cursor_v1');
    return true;
  })()`);

  await command('Page.reload', { ignoreCache: true });
  await waitFor(
    'document.querySelector("[data-shelf-library-label]")?.textContent?.trim() === "Guest Library"',
    'empty guest shelf',
  );

  const directGuestEntry = await evaluate(`(() => {
    sessionStorage.removeItem('browser_regression_skip_guest_bootstrap');
    return {
      appView: document.querySelector('[data-app-view]')?.getAttribute('data-app-view') ?? '',
      storedGuest: localStorage.getItem('isGuest'),
      hasLandingTitle: [...document.querySelectorAll('h1')]
        .some((node) => node.textContent?.trim() === 'TW READER'),
      hasGuestModeAction: document.body.textContent?.includes('Guest Mode (Offline)') ?? false,
    };
  })()`);
  assert.equal(directGuestEntry.appView, 'shelf', JSON.stringify(directGuestEntry));
  assert.equal(directGuestEntry.storedGuest, 'true', JSON.stringify(directGuestEntry));
  assert.equal(directGuestEntry.hasLandingTitle, false, JSON.stringify(directGuestEntry));
  assert.equal(directGuestEntry.hasGuestModeAction, false, JSON.stringify(directGuestEntry));

  const emptyShelfPresentation = await evaluate(`(() => {
    const panel = document.querySelector('[data-empty-shelf-panel="true"]');
    const google = panel?.querySelector('[data-empty-shelf-action="google"]');
    const sample = panel?.querySelector('[data-empty-shelf-action="sample"]');
    const accentProbe = document.createElement('span');
    accentProbe.className = 'text-accent-500';
    document.body.append(accentProbe);
    const accentColor = getComputedStyle(accentProbe).color;
    accentProbe.remove();
    return {
      text: panel?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
      heading: panel?.querySelector('[data-empty-shelf-heading="true"]')?.textContent?.trim() ?? '',
      iconCount: panel?.querySelectorAll('svg').length ?? 0,
      importExists: Boolean(panel?.querySelector('[data-empty-shelf-action="import"]')),
      visualButtonCount: panel?.querySelectorAll('.rounded-2xl, .rounded-full').length ?? 0,
      googleDecoration: google ? getComputedStyle(google).textDecorationLine : '',
      sampleDecoration: sample ? getComputedStyle(sample).textDecorationLine : '',
      googleColor: google ? getComputedStyle(google).color : '',
      sampleColor: sample ? getComputedStyle(sample).color : '',
      accentColor,
      panelBackground: panel ? getComputedStyle(panel).backgroundColor : '',
      panelBorderRadius: panel ? getComputedStyle(panel).borderRadius : '',
    };
  })()`);
  assert.equal(emptyShelfPresentation.heading, '보관함이 비어있음.', JSON.stringify(emptyShelfPresentation));
  assert.match(emptyShelfPresentation.text, /책을 보관함에 추가하려면 Google 계정을 연동하거나 샘플 도서를 추가해주세요\./);
  assert.equal(emptyShelfPresentation.iconCount, 0, JSON.stringify(emptyShelfPresentation));
  assert.equal(emptyShelfPresentation.importExists, false, JSON.stringify(emptyShelfPresentation));
  assert.equal(emptyShelfPresentation.visualButtonCount, 0, JSON.stringify(emptyShelfPresentation));
  assert.equal(emptyShelfPresentation.googleDecoration, 'underline', JSON.stringify(emptyShelfPresentation));
  assert.equal(emptyShelfPresentation.sampleDecoration, 'underline', JSON.stringify(emptyShelfPresentation));
  assert.equal(emptyShelfPresentation.googleColor, emptyShelfPresentation.accentColor, JSON.stringify(emptyShelfPresentation));
  assert.equal(emptyShelfPresentation.sampleColor, emptyShelfPresentation.accentColor, JSON.stringify(emptyShelfPresentation));
  assert.equal(emptyShelfPresentation.panelBackground, 'rgba(0, 0, 0, 0)', JSON.stringify(emptyShelfPresentation));
  assert.equal(emptyShelfPresentation.panelBorderRadius, '0px', JSON.stringify(emptyShelfPresentation));

  await evaluate(`document.querySelector('[data-empty-shelf-action="google"]')?.click()`);
  await waitFor(
    'Boolean(document.querySelector(\'[data-login-disclosure-modal="true"]\'))',
    'login privacy disclosure modal',
  );
  const loginDisclosure = await evaluate(`(() => {
    const modal = document.querySelector('[data-login-disclosure-modal="true"]');
    const confirm = modal?.querySelector('[data-login-disclosure-confirm="true"]');
    const notice = modal?.querySelector('[data-login-disclosure-notice="true"]');
    return {
      text: modal?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
      confirmLabel: confirm?.textContent?.trim() ?? '',
      confirmTop: confirm?.getBoundingClientRect().top ?? 0,
      confirmRect: confirm ? {
        width: confirm.getBoundingClientRect().width,
        height: confirm.getBoundingClientRect().height,
      } : null,
      noticeTop: notice?.getBoundingClientRect().top ?? 0,
      noticeFontSize: notice ? getComputedStyle(notice.querySelector('li')).fontSize : '',
      brandAsset: (() => {
        const asset = modal?.querySelector('[data-google-sign-in-brand-asset="true"]');
        return asset ? {
          width: asset.getBoundingClientRect().width,
          height: asset.getBoundingClientRect().height,
          naturalWidth: asset.naturalWidth,
          naturalHeight: asset.naturalHeight,
          variant: asset.dataset.googleSignInBrandVariant,
          fullyVisible: (() => {
            const assetRect = asset.getBoundingClientRect();
            const confirmRect = confirm?.getBoundingClientRect();
            return Boolean(confirmRect
              && assetRect.top >= confirmRect.top
              && assetRect.bottom <= confirmRect.bottom
              && assetRect.left >= confirmRect.left
              && assetRect.right <= confirmRect.right);
          })(),
        } : null;
      })(),
      appView: document.querySelector('[data-app-view]')?.getAttribute('data-app-view') ?? '',
      mode: modal?.getAttribute('data-login-disclosure-mode') ?? '',
      borderRadius: modal ? getComputedStyle(modal).borderRadius : '',
      cancelBorderRadius: modal?.querySelector('[data-login-disclosure-cancel="true"]')
        ? getComputedStyle(modal.querySelector('[data-login-disclosure-cancel="true"]')).borderRadius
        : '',
      headerIconBorderRadius: modal?.querySelector('header > div')
        ? getComputedStyle(modal.querySelector('header > div')).borderRadius
        : '',
      bodyPosition: document.body.style.position,
    };
  })()`);
  assert.match(loginDisclosure.text, /개인정보 처리방침/);
  assert.doesNotMatch(loginDisclosure.text, /Google 로그인과 Drive 연결은 서로 다른 권한입니다/);
  assert.match(loginDisclosure.text, /Firebase 계정 로그인/);
  assert.match(loginDisclosure.text, /고유 식별자/);
  assert.match(loginDisclosure.text, /독서 진행률·책갈피·주석·독서 통계/);
  assert.match(loginDisclosure.text, /Google Drive 연결 \(선택\)/);
  assert.match(loginDisclosure.text, /현재 탭의 세션 저장소와 메모리/);
  assert.equal(loginDisclosure.confirmLabel, 'Sign in with Google', JSON.stringify(loginDisclosure));
  assert.ok(loginDisclosure.confirmTop < loginDisclosure.noticeTop, JSON.stringify(loginDisclosure));
  assert.equal(loginDisclosure.noticeFontSize, '10px', JSON.stringify(loginDisclosure));
  assert.deepEqual(loginDisclosure.confirmRect, { width: 180, height: 40 }, JSON.stringify(loginDisclosure));
  assert.deepEqual(loginDisclosure.brandAsset, {
    width: 180,
    height: 40,
    naturalWidth: 180,
    naturalHeight: 40,
    variant: 'dark',
    fullyVisible: true,
  }, JSON.stringify(loginDisclosure));
  assert.equal(loginDisclosure.appView, 'shelf', JSON.stringify(loginDisclosure));
  assert.equal(loginDisclosure.mode, 'firebase', JSON.stringify(loginDisclosure));
  assert.equal(loginDisclosure.borderRadius, '14px', JSON.stringify(loginDisclosure));
  assert.equal(loginDisclosure.cancelBorderRadius, '10px', JSON.stringify(loginDisclosure));
  assert.equal(loginDisclosure.headerIconBorderRadius, '8px', JSON.stringify(loginDisclosure));
  assert.equal(loginDisclosure.bodyPosition, 'fixed', JSON.stringify(loginDisclosure));
  await evaluate(`document.querySelector('[data-login-disclosure-cancel="true"]')?.click()`);
  await waitFor(
    '!document.querySelector(\'[data-login-disclosure-modal="true"]\')',
    'login privacy disclosure cancel',
  );
  assert.equal(
    await evaluate(`document.querySelector('[data-app-view]')?.getAttribute('data-app-view')`),
    'shelf',
  );

  await evaluate(`(() => {
    const settings = JSON.parse(localStorage.getItem('viewer_settings') || '{}');
    settings.theme = 'light';
    localStorage.setItem('viewer_settings', JSON.stringify(settings));
    sessionStorage.setItem('browser_regression_theme_override', 'light');
  })()`);
  await command('Page.reload', { ignoreCache: true });
  await waitFor(
    'document.querySelector(\'[data-empty-shelf-heading="true"]\')?.textContent?.trim() === "보관함이 비어있음."',
    'light empty guest shelf',
  );
  await evaluate(`document.querySelector('[data-empty-shelf-action="google"]')?.click()`);
  await waitFor(
    'document.querySelector(\'[data-google-sign-in-brand-asset="true"]\')?.dataset.googleSignInBrandVariant === "light"',
    'light Google sign-in asset',
  );
  assert.deepEqual(
    await evaluate(`(() => {
      const asset = document.querySelector('[data-google-sign-in-brand-asset="true"]');
      return asset ? [asset.naturalWidth, asset.naturalHeight, asset.getBoundingClientRect().width, asset.getBoundingClientRect().height] : [];
    })()`),
    [180, 40, 180, 40],
  );
  await evaluate(`document.querySelector('[data-login-disclosure-cancel="true"]')?.click()`);
  await waitFor(
    '!document.querySelector(\'[data-login-disclosure-modal="true"]\')',
    'light login privacy disclosure cancel',
  );
  await evaluate(`(() => {
    const settings = JSON.parse(localStorage.getItem('viewer_settings') || '{}');
    settings.theme = 'midnight';
    localStorage.setItem('viewer_settings', JSON.stringify(settings));
    sessionStorage.setItem('browser_regression_theme_override', 'midnight');
  })()`);
  await command('Page.reload', { ignoreCache: true });
  await waitFor(
    'document.querySelector(\'[data-empty-shelf-heading="true"]\')?.textContent?.trim() === "보관함이 비어있음."',
    'restored Midnight empty guest shelf',
  );
  await evaluate(`sessionStorage.removeItem('browser_regression_theme_override')`);

  await evaluate(`document.querySelector('[data-empty-shelf-action="sample"]')?.click()`);
  await waitFor(
    'Boolean(document.querySelector(\'[data-shelf-book-id="sample-aesop-tortoise-hare-ko-v1"]\'))',
    'installed local sample book',
  );
  await waitFor(
    'Boolean(document.querySelector(\'[data-shelf-book-id="sample-aesop-tortoise-hare-ko-v1"] [data-shelf-book-cover="true"]\'))',
    'sample book cover',
  );
  const installedSample = await evaluate(`new Promise((resolve, reject) => {
    const request = indexedDB.open('web-reader-db');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(['metadata-v5', 'book-covers-v14'], 'readonly');
      const metadataRequest = tx.objectStore('metadata-v5').get([
        'guest:device-library|library:local',
        'sample-aesop-tortoise-hare-ko-v1',
      ]);
      const coverRequest = tx.objectStore('book-covers-v14').get([
        'guest:device-library|library:local',
        'sample-aesop-tortoise-hare-ko-v1',
      ]);
      tx.oncomplete = () => {
        db.close();
        resolve({
          title: metadataRequest.result?.name || '',
          source: metadataRequest.result?.source || '',
          format: metadataRequest.result?.sourceFormat || '',
          coverType: coverRequest.result?.image?.type || '',
          coverSize: coverRequest.result?.image?.size || 0,
        });
      };
      tx.onerror = () => reject(tx.error);
    };
  })`);
  assert.match(installedSample.title, /^토끼와 거북이/);
  assert.equal(installedSample.source, 'local');
  assert.equal(installedSample.format, 'epub');
  assert.equal(installedSample.coverType, 'image/svg+xml');
  assert.ok(installedSample.coverSize > 0);

  await evaluate(`document.querySelector(
    '[data-shelf-book-id="sample-aesop-tortoise-hare-ko-v1"]'
  )?.click()`);
  await waitFor(
    `Boolean(document.querySelector('foliate-view')?.renderer?.getContents?.()[0]?.doc?.body)`,
    'opened expanded sample book',
  );
  await waitFor(
    `!document.querySelector('nav')?.classList.contains('translate-y-0')`,
    'sample reader controls auto-hide',
    8_000,
  );
  const sampleReader = await evaluate(`(async () => {
    const view = document.querySelector('foliate-view');
    const renderer = view?.renderer;
    const doc = renderer?.getContents?.()[0]?.doc;
    const content = document.querySelector('[data-reader-content="true"]');
    if (!renderer || !doc || !content) return { missing: true };
    const paragraphCount = doc.querySelectorAll('p').length;
    const textLength = doc.body?.innerText?.length ?? 0;
    const fontSize = doc.defaultView?.getComputedStyle(doc.body).fontSize ?? '';
    const firstParagraphStyle = doc.defaultView?.getComputedStyle(doc.querySelector('p'));
    const hasRepeatedSpaces = [...doc.querySelectorAll('p')]
      .some((paragraph) => /[ \u00a0]{2,}/.test(paragraph.textContent ?? ''));
    const before = document.querySelector('nav')?.classList.contains('translate-y-0') ?? false;
    content.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: innerWidth / 2,
      clientY: innerHeight * 0.75,
    }));
    await window.__regressionNextFrame(2);
    const after = document.querySelector('nav')?.classList.contains('translate-y-0') ?? false;
    return {
      paragraphCount,
      textLength,
      fontSize,
      wordBreak: firstParagraphStyle?.wordBreak ?? '',
      hasRepeatedSpaces,
      flow: renderer.getAttribute('flow'),
      scrollable: renderer.viewSize > renderer.size,
      controlsBeforeOuterBlankTap: before,
      controlsAfterOuterBlankTap: after,
    };
  })()`);
  assert.equal(sampleReader.missing, undefined, JSON.stringify(sampleReader));
  assert.ok(sampleReader.paragraphCount >= 20, JSON.stringify(sampleReader));
  assert.ok(sampleReader.textLength >= 1_000, JSON.stringify(sampleReader));
  assert.equal(sampleReader.fontSize, '20px', JSON.stringify(sampleReader));
  assert.equal(sampleReader.wordBreak, 'normal', JSON.stringify(sampleReader));
  assert.equal(sampleReader.hasRepeatedSpaces, false, JSON.stringify(sampleReader));
  assert.equal(sampleReader.flow, 'scrolled', JSON.stringify(sampleReader));
  assert.equal(sampleReader.scrollable, true, JSON.stringify(sampleReader));
  assert.equal(sampleReader.controlsBeforeOuterBlankTap, false, JSON.stringify(sampleReader));
  assert.equal(sampleReader.controlsAfterOuterBlankTap, true, JSON.stringify(sampleReader));
  await evaluate(`document.querySelector('button[aria-label="Close reader"]')?.click()`);
  await waitFor(
    `Boolean(document.querySelector('[data-shelf-book-id="sample-aesop-tortoise-hare-ko-v1"]'))`,
    'returned from expanded sample book',
  );

  await evaluate(`new Promise((resolve, reject) => {
    const request = indexedDB.open('web-reader-db');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(
        ['metadata-v5', 'progress-v5', 'book-covers-v14'],
        'readwrite',
      );
      tx.objectStore('metadata-v5').clear();
      tx.objectStore('progress-v5').clear();
      tx.objectStore('book-covers-v14').clear();
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
      const coverBytes = Uint8Array.from(
        atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='),
        (character) => character.charCodeAt(0),
      );
      tx.objectStore('book-covers-v14').put({
        ownerKey: 'guest:device-library|library:local',
        bookId: 'book-0001',
        fingerprint: null,
        image: new Blob([coverBytes], { type: 'image/png' }),
        cachedAt: Date.now(),
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
    'document.querySelector("[data-shelf-library-label]")?.textContent?.trim() === "Guest Library"',
    'guest shelf',
  );
  await waitFor(
    'document.querySelectorAll("main h3").length === 50',
    'initial 50 shelf cards',
  );
  await waitFor(
    `Boolean(document.querySelector(
      '[data-shelf-book-id="book-0001"] [data-shelf-book-cover="true"]'
    ))`,
    'cached grid book cover',
  );

  const initialShelf = await evaluate(`(() => {
    const gridCard = document.querySelector('[data-shelf-book-id="book-0001"]');
    const coverFrame = document.querySelector(
      '[data-shelf-book-id="book-0001"] [data-shelf-book-cover-frame="true"]'
    );
    const coverRect = coverFrame?.getBoundingClientRect();
    const coverStyle = coverFrame ? getComputedStyle(coverFrame) : null;
    const fallbackProgress = document.querySelector(
      '[data-shelf-book-id="book-0000"] [data-shelf-grid-progress-block="true"]'
    )?.getBoundingClientRect();
    const coveredProgress = document.querySelector(
      '[data-shelf-book-id="book-0001"] [data-shelf-grid-progress-block="true"]'
    )?.getBoundingClientRect();
    const coveredDate = document.querySelector(
      '[data-shelf-book-id="book-0001"] [data-shelf-grid-progress-date="true"]'
    )?.getBoundingClientRect();
    const coveredPercent = document.querySelector(
      '[data-shelf-book-id="book-0001"] [data-shelf-grid-progress-percent="true"]'
    )?.getBoundingClientRect();
    const coveredFormat = document.querySelector(
      '[data-shelf-book-id="book-0001"] [data-shelf-grid-meta="true"]'
    )?.getBoundingClientRect();
    const gridTitle = gridCard?.querySelector('[data-shelf-grid-cover-title="true"]');
    const gridTitleRect = gridTitle?.getBoundingClientRect();
    const coveredTags = document.querySelector(
      '[data-shelf-book-id="book-0001"] [data-shelf-grid-cover-tag-slot="true"]'
    )?.getBoundingClientRect();
    const gridDeleteIcon = document.querySelector('[data-shelf-grid-progress-delete-icon="true"]');
    const gridDeleteIconRect = gridDeleteIcon?.getBoundingClientRect();
    return {
      cardCount: document.querySelectorAll('main h3').length,
      titles: [...document.querySelectorAll('main h3')]
        .slice(0, 4)
        .map((node) => node.textContent?.trim()),
      cachedCover: Boolean(document.querySelector(
        '[data-shelf-book-id="book-0001"] [data-shelf-book-cover="true"]'
      )),
      cachedCoverSrc: document.querySelector(
        '[data-shelf-book-id="book-0001"] [data-shelf-book-cover="true"]'
      )?.getAttribute('src') ?? '',
      placeholderCover: Boolean(document.querySelector(
        '[data-shelf-book-id="book-0000"] [data-generated-book-cover="true"]'
      )),
      fallbackIcon: Boolean(document.querySelector(
        '[data-shelf-book-id="book-0000"] [data-shelf-book-icon="true"]'
      )),
      coverLayout: coverRect && coverStyle ? {
        width: coverRect.width,
        height: coverRect.height,
        backgroundColor: coverStyle.backgroundColor,
        boxShadow: coverStyle.boxShadow,
        borderRadius: coverStyle.borderRadius,
      } : null,
      gridProgressAlignment: fallbackProgress && coveredProgress && coveredDate && coveredPercent ? {
        topDelta: Math.abs(fallbackProgress.top - coveredProgress.top),
        labelBottomDelta: Math.abs(coveredDate.bottom - coveredPercent.bottom),
      } : null,
      gridCoverProgressAlignment: coverRect && coveredProgress ? {
        bottomDelta: Math.abs(coverRect.bottom - coveredProgress.bottom),
      } : null,
      gridInfoOrder: coveredFormat && gridTitleRect && coveredTags && coveredProgress
        ? coveredFormat.top <= gridTitleRect.top
          && gridTitleRect.bottom <= coveredTags.top
          && coveredTags.bottom <= coveredProgress.top
        : false,
      gridColumnCount: gridCard?.parentElement
        ? getComputedStyle(gridCard.parentElement).gridTemplateColumns.split(' ').length
        : 0,
      gridCardBorderRadius: gridCard ? getComputedStyle(gridCard).borderRadius : '',
      gridTitleFontSize: gridTitle ? getComputedStyle(gridTitle).fontSize : '',
      gridDeleteIconSize: gridDeleteIconRect ? {
        width: gridDeleteIconRect.width,
        height: gridDeleteIconRect.height,
      } : null,
    };
  })()`);
  assert.equal(initialShelf.cardCount, 50);
  assert.deepEqual(initialShelf.titles.slice(0, 2), ['Book 0900', 'Book 0100']);
  assert.ok(!initialShelf.titles.slice(0, 2).includes('Book 0999'));
  assert.equal(initialShelf.cachedCover, true);
  assert.equal(initialShelf.placeholderCover, true);
  assert.equal(initialShelf.fallbackIcon, false);
  assert.equal(initialShelf.gridCardBorderRadius, '14px', JSON.stringify(initialShelf));
  assert.equal(initialShelf.gridTitleFontSize, '16px', JSON.stringify(initialShelf));
  assert.deepEqual(initialShelf.gridDeleteIconSize, { width: 14, height: 14 });
  assert.deepEqual(initialShelf.coverLayout, {
    width: 136,
    height: 208,
    backgroundColor: 'rgba(0, 0, 0, 0)',
    boxShadow: 'none',
    borderRadius: '0px',
  });
  assert.ok(initialShelf.gridProgressAlignment);
  assert.ok(initialShelf.gridProgressAlignment.topDelta <= 1, JSON.stringify(initialShelf.gridProgressAlignment));
  assert.ok(initialShelf.gridProgressAlignment.labelBottomDelta <= 1, JSON.stringify(initialShelf.gridProgressAlignment));
  assert.ok(initialShelf.gridCoverProgressAlignment);
  assert.ok(initialShelf.gridCoverProgressAlignment.bottomDelta <= 1, JSON.stringify(initialShelf.gridCoverProgressAlignment));
  assert.equal(initialShelf.gridInfoOrder, true, JSON.stringify(initialShelf));
  assert.equal(initialShelf.gridColumnCount, 2, JSON.stringify(initialShelf));

  await evaluate(`document.querySelector('button[title="Switch to List View"]')?.click()`);
  await waitFor(
    `localStorage.getItem('shelf_viewMode_v2') === 'list'
      && Boolean(document.querySelector(
        '[data-shelf-book-id="book-0001"] [data-shelf-book-cover="true"]'
      ))`,
    'cached list book cover',
  );
  const listCoverLayout = await evaluate(`(() => {
    const card = document.querySelector('[data-shelf-book-id="book-0001"]');
    const frame = card?.querySelector('[data-shelf-book-cover-frame="true"]');
    const titleContent = card?.querySelector('[data-shelf-title-tag-group="true"]')?.parentElement;
    const title = card?.querySelector('[data-shelf-title-tag-group="true"] h3');
    const localTag = card?.querySelector('[data-shelf-local-tag="true"]');
    const tagRow = card?.querySelector('[data-shelf-book-tags="true"]');
    const format = card?.querySelector('[data-shelf-list-format="true"]');
    const progress = card?.querySelector('[data-shelf-list-progress="true"]');
    const cardRect = card?.getBoundingClientRect();
    const frameRect = frame?.getBoundingClientRect();
    const titleRect = titleContent?.getBoundingClientRect();
    const formatRect = format?.getBoundingClientRect();
    const progressRect = progress?.getBoundingClientRect();
    const style = frame ? getComputedStyle(frame) : null;
    if (!cardRect || !frameRect || !titleRect || !localTag || !tagRow || !formatRect || !progressRect || !style) return null;
    return {
      width: frameRect.width,
      height: frameRect.height,
      backgroundColor: style.backgroundColor,
      boxShadow: style.boxShadow,
      borderRadius: style.borderRadius,
      contained: frameRect.top >= cardRect.top && frameRect.bottom <= cardRect.bottom,
      titleWidthRatio: titleRect.width / cardRect.width,
      localTagFirst: tagRow.firstElementChild === localTag,
      localTagText: localTag.textContent?.trim(),
      localTagBorderRadius: getComputedStyle(localTag).borderRadius,
      rightOrder: [formatRect.left, progressRect.left],
      formatWidth: formatRect.width,
      titleFontSize: title ? getComputedStyle(title).fontSize : '',
      coverSrc: card?.querySelector('[data-shelf-book-cover="true"]')?.getAttribute('src') ?? '',
    };
  })()`);
  assert.ok(listCoverLayout);
  assert.ok(listCoverLayout.width === 44 || listCoverLayout.width === 48);
  assert.equal(listCoverLayout.height, listCoverLayout.width === 48 ? 68 : 64);
  assert.equal(listCoverLayout.backgroundColor, 'rgba(0, 0, 0, 0)');
  assert.equal(listCoverLayout.boxShadow, 'none');
  assert.equal(listCoverLayout.borderRadius, '0px');
  assert.equal(listCoverLayout.contained, true);
  assert.ok(listCoverLayout.titleWidthRatio > 0.6, JSON.stringify(listCoverLayout));
  assert.equal(listCoverLayout.localTagFirst, true, JSON.stringify(listCoverLayout));
  assert.equal(listCoverLayout.localTagText, '로컬', JSON.stringify(listCoverLayout));
  assert.equal(listCoverLayout.localTagBorderRadius, '7px', JSON.stringify(listCoverLayout));
  assert.ok(
    listCoverLayout.rightOrder[0] < listCoverLayout.rightOrder[1],
    JSON.stringify(listCoverLayout),
  );
  assert.ok(listCoverLayout.formatWidth <= 64.5, JSON.stringify(listCoverLayout));
  assert.equal(listCoverLayout.titleFontSize, initialShelf.gridTitleFontSize, JSON.stringify({
    grid: initialShelf.gridTitleFontSize,
    list: listCoverLayout.titleFontSize,
  }));
  assert.equal(listCoverLayout.coverSrc, initialShelf.cachedCoverSrc);
  initialShelf.listCoverLayout = listCoverLayout;
  await evaluate(`document.querySelector('button[title="Switch to Simple View"]')?.click()`);
  await waitFor(
    `localStorage.getItem('shelf_viewMode_v2') === 'simple'`,
    'simple shelf view before restoring grid',
  );
  await evaluate(`document.querySelector('button[title="Switch to Grid View"]')?.click()`);
  await waitFor(
    `localStorage.getItem('shelf_viewMode_v2') === 'grid'
      && Boolean(document.querySelector(
        '[data-shelf-book-id="book-0001"] [data-shelf-book-cover="true"]'
      ))`,
    'restore cached grid book cover',
  );
  assert.equal(
    await evaluate(`document.querySelector(
      '[data-shelf-book-id="book-0001"] [data-shelf-book-cover="true"]'
    )?.getAttribute('src') ?? ''`),
    initialShelf.cachedCoverSrc,
    'view changes must reuse the existing cached-cover object URL',
  );

  await evaluate(`(() => {
    const sentinel = document.querySelector('main')?.nextElementSibling;
    sentinel?.scrollIntoView({ block: 'center' });
    window.dispatchEvent(new Event('scroll'));
    return Boolean(sentinel);
  })()`);
  await waitFor(
    `document.querySelectorAll("main h3").length >= 100
      || [...document.querySelectorAll('button')]
        .some((button) => button.textContent?.includes('더 보기'))`,
    'automatic shelf page or load-more fallback',
    5_000,
  );
  await evaluate(`(() => {
    if (document.querySelectorAll('main h3').length >= 100) return true;
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.textContent?.includes('더 보기'));
    button?.click();
    return Boolean(button);
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
    'Boolean(document.querySelector(\'[data-shelf-search-input="true"]\'))',
    'shelf search modal',
  );
  const desktopShelfSearchHeight = await evaluate(
    'document.querySelector(\'[data-shelf-search-input-row="true"]\')?.getBoundingClientRect().height',
  );
  const desktopShelfSearchRadius = await evaluate(
    'getComputedStyle(document.querySelector(\'[data-shelf-search-modal="true"]\')).borderRadius',
  );
  const desktopShelfSearchMaterial = await evaluate(`(() => {
    const modal = document.querySelector('[data-shelf-search-modal="true"]');
    const style = modal ? getComputedStyle(modal) : null;
    return {
      surfaceClass: modal?.classList.contains('app-search-surface') ?? false,
      menuStyle: document.documentElement.dataset.viewerMenuStyle,
      background: style?.backgroundColor ?? '',
      backdropFilter: style?.backdropFilter ?? '',
    };
  })()`);
  assert.equal(desktopShelfSearchRadius, '20px');
  assert.deepEqual(desktopShelfSearchMaterial, {
    surfaceClass: true,
    menuStyle: 'modern',
    background: 'rgba(39, 39, 40, 0.88)',
    backdropFilter: 'blur(24px)',
  });
  assert.ok(
    desktopShelfSearchHeight >= 64 && desktopShelfSearchHeight <= 69,
    `Unexpected desktop shelf search height: ${desktopShelfSearchHeight}`,
  );
  await command('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 640,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate('window.__regressionNextFrame(2)');
  await new Promise((resolve) => setTimeout(resolve, 260));
  const mobileShelfSearchHeight = await evaluate(
    'document.querySelector(\'[data-shelf-search-input-row="true"]\')?.getBoundingClientRect().height',
  );
  const mobileShelfSearchSheet = await evaluate(`(() => {
    const modal = document.querySelector('[data-shelf-search-modal="true"]');
    const rect = modal?.getBoundingClientRect();
    const backdropRect = modal?.parentElement?.getBoundingClientRect();
    const style = modal ? getComputedStyle(modal) : null;
    return {
      topGap: rect && backdropRect ? rect.top - backdropRect.top : -1,
      sideGap: rect && backdropRect ? rect.left - backdropRect.left : -1,
      topRadius: style?.borderTopLeftRadius ?? '',
      bottomRadius: style?.borderBottomLeftRadius ?? '',
    };
  })()`);
  assert.ok(
    mobileShelfSearchHeight >= 59 && mobileShelfSearchHeight <= 61,
    `Unexpected mobile shelf search height: ${mobileShelfSearchHeight}`,
  );
  assert.deepEqual(mobileShelfSearchSheet, {
    topGap: 96,
    sideGap: 16,
    topRadius: '20px',
    bottomRadius: '20px',
  });
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate('window.__regressionNextFrame(2)');
  assert.equal(
    await setInputValue('[data-shelf-search-input="true"]', 'Book 0'),
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
    await setInputValue('[data-shelf-search-input="true"]', 'Book 1099'),
    true,
  );
  const searchStarted = Date.now();
  await evaluate('document.querySelector(\'[data-shelf-search-input="true"]\')?.form?.requestSubmit()');
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
    const button = [...document.querySelectorAll('[data-shelf-filter-control="true"]')]
      .find((node) => node.getClientRects().length > 0);
    button?.click();
    return Boolean(button);
  })()`);
  await waitFor(
    'Boolean(document.querySelector(\'[data-shelf-filter-modal="true"]\'))',
    'unified shelf filter modal',
  );
  const desktopFilterModal = await evaluate(`(() => {
    const modal = document.querySelector('[data-shelf-filter-modal="true"]');
    const rect = modal?.getBoundingClientRect();
    const backdropRect = modal?.parentElement?.getBoundingClientRect();
    return {
      title: modal?.querySelector('h2')?.textContent?.trim() ?? '',
      width: rect?.width ?? 0,
      height: rect?.height ?? 0,
      alphaDisabled: modal?.querySelector('[data-shelf-filter-sort="alpha"]')?.disabled ?? true,
      headerClose: modal?.querySelector('[data-menu-sheet-close="true"]') !== null,
      headerDivider: modal?.querySelector('[data-modal-header="shelf-filter"]')
        ? getComputedStyle(modal.querySelector('[data-modal-header="shelf-filter"]')).borderBottomWidth
        : '0px',
    };
  })()`);
  assert.equal(desktopFilterModal.title, '책장 정렬·필터');
  assert.ok(desktopFilterModal.width <= 576, JSON.stringify(desktopFilterModal));
  assert.ok(desktopFilterModal.height <= 800 * 0.82 + 1, JSON.stringify(desktopFilterModal));
  assert.equal(desktopFilterModal.alphaDisabled, false);
  assert.equal(desktopFilterModal.headerClose, true, JSON.stringify(desktopFilterModal));
  assert.notEqual(desktopFilterModal.headerDivider, '0px', JSON.stringify(desktopFilterModal));
  await evaluate(`document.querySelector('[data-shelf-filter-sort="alpha"]')?.click()`);
  await evaluate('window.__regressionNextFrame(2)');
  await evaluate(`document.querySelector('[data-shelf-filter-apply="true"]')?.click()`);
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
    const card = document.querySelector('[data-shelf-book-card="true"]');
    card?.dispatchEvent(new MouseEvent('contextmenu', {
      bubbles: true,
      cancelable: true,
      button: 2,
      clientX: 200,
      clientY: 200,
    }));
    return Boolean(card);
  })()`);
  await waitFor(
    'Boolean(document.querySelector(\'[data-book-info-modal="true"]\'))',
    'shelf book information modal',
  );
  const bookInfoUi = await evaluate(`(() => {
    const modal = document.querySelector('[data-book-info-modal="true"]');
    const card = document.querySelector('[data-shelf-book-card="true"]');
    const rect = modal?.getBoundingClientRect();
    const infoCover = modal?.querySelector('[data-book-info-cover-frame="true"]')?.getBoundingClientRect();
    const infoTagRow = modal?.querySelector('[data-book-info-tag-row="true"]')?.getBoundingClientRect();
    const infoTagRadii = [...(modal?.querySelectorAll('[data-book-info-tag-row="true"] > span') ?? [])]
      .map((tag) => getComputedStyle(tag).borderRadius);
    const generatedCover = modal?.querySelector('[data-generated-book-cover="true"]')?.getBoundingClientRect();
    const generatedTitle = modal?.querySelector('[data-generated-book-cover-title="true"]')?.getBoundingClientRect();
    const cardStyle = card ? getComputedStyle(card) : null;
    const modalStyle = modal ? getComputedStyle(modal) : null;
    return {
      title: modal?.querySelector('h3')?.textContent?.trim() ?? '',
      text: modal?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
      width: rect?.width ?? 0,
      height: rect?.height ?? 0,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      deleteConfirmation: Boolean(modal?.querySelector('[data-book-info-delete-confirmation="true"]')),
      cardUserSelect: cardStyle?.userSelect ?? '',
      cardTouchCalloutDeclared: card?.classList.contains('[-webkit-touch-callout:none]') ?? false,
      modalUserSelect: modalStyle?.userSelect ?? '',
      modalOutlineStyle: modalStyle?.outlineStyle ?? '',
      modalOutlineWidth: modalStyle?.outlineWidth ?? '',
      captureRootContainsActions: Boolean(
        modal?.querySelector('[data-book-info-capture-root="true"] [data-book-info-actions="true"]'),
      ),
      hasCopyImageButton: Boolean(modal?.querySelector('[data-book-info-copy-image="true"]')),
      hasCaptureButton: Boolean(modal?.querySelector('[data-book-info-capture="true"]')),
      hasGeneratedCover: Boolean(modal?.querySelector('[data-generated-book-cover="true"]')),
      hasCachedCover: Boolean(modal?.querySelector('[data-book-info-cover="true"]')),
      headerClose: modal?.querySelector('[data-menu-sheet-close="true"]') !== null,
      headerDivider: modal?.querySelector('[data-modal-header="book-info"]')
        ? getComputedStyle(modal.querySelector('[data-modal-header="book-info"]')).borderBottomWidth
        : '0px',
      tagRowBottomDelta: infoCover && infoTagRow ? Math.abs(infoCover.bottom - infoTagRow.bottom) : null,
      infoTagRadii,
      generatedTitleTopRatio: generatedCover && generatedTitle
        ? (generatedTitle.top - generatedCover.top) / generatedCover.height
        : null,
    };
  })()`);
  assert.match(bookInfoUi.title, /Book/);
  assert.match(bookInfoUi.text, /파일 형식/);
  assert.match(bookInfoUi.text, /파일 크기/);
  assert.match(bookInfoUi.text, /읽은 시간/);
  assert.equal(bookInfoUi.headerClose, true, JSON.stringify(bookInfoUi));
  assert.notEqual(bookInfoUi.headerDivider, '0px', JSON.stringify(bookInfoUi));
  assert.equal(
    await evaluate(`document.querySelector('[data-book-info-value="reading-time"]')?.textContent?.trim()`),
    '',
  );
  assert.match(bookInfoUi.text, /최근 독서/);
  assert.ok(bookInfoUi.width <= Math.min(bookInfoUi.viewportWidth * 0.9, 576), JSON.stringify(bookInfoUi));
  assert.ok(bookInfoUi.height <= bookInfoUi.viewportHeight * 0.82, JSON.stringify(bookInfoUi));
  assert.equal(bookInfoUi.deleteConfirmation, false);
  assert.equal(bookInfoUi.hasGeneratedCover, true);
  assert.equal(bookInfoUi.hasCachedCover, false);
  assert.equal(bookInfoUi.cardUserSelect, 'none');
  assert.equal(bookInfoUi.cardTouchCalloutDeclared, true);
  assert.equal(bookInfoUi.modalUserSelect, 'text');
  assert.equal(bookInfoUi.modalOutlineStyle, 'none');
  assert.ok(bookInfoUi.modalOutlineWidth === '0px' || bookInfoUi.modalOutlineStyle === 'none');
  assert.equal(bookInfoUi.captureRootContainsActions, false);
  assert.equal(bookInfoUi.hasCopyImageButton, true);
  assert.equal(bookInfoUi.hasCaptureButton, true);
  assert.ok(bookInfoUi.tagRowBottomDelta !== null && bookInfoUi.tagRowBottomDelta <= 1, JSON.stringify(bookInfoUi));
  assert.ok(bookInfoUi.infoTagRadii.length > 0, JSON.stringify(bookInfoUi));
  assert.ok(bookInfoUi.infoTagRadii.every((radius) => radius === '7px'), JSON.stringify(bookInfoUi));
  assert.ok(
    bookInfoUi.generatedTitleTopRatio !== null
      && Math.abs(bookInfoUi.generatedTitleTopRatio - 0.15) <= 0.02,
    JSON.stringify(bookInfoUi),
  );
  const bookInfoActions = await evaluate(`(() => {
    const footer = document.querySelector('[data-book-info-actions="true"]');
    return [...(footer?.querySelectorAll('button') ?? [])].map((button) => ({
      label: button.getAttribute('aria-label') ?? '',
      width: button.getBoundingClientRect().width,
      height: button.getBoundingClientRect().height,
      text: button.textContent?.trim() ?? '',
    }));
  })()`);
  assert.deepEqual(bookInfoActions.map(({ label }) => label), [
    '읽기',
    '독서 인증 이미지 클립보드에 저장',
    '독서 인증 이미지 다운로드',
    'Book 0100 삭제',
  ]);
  assert.equal(bookInfoActions[1].text, '');
  assert.equal(bookInfoActions[2].text, '');
  assert.ok(Math.abs(bookInfoActions[1].width - bookInfoActions[3].width) <= 1);
  assert.ok(Math.abs(bookInfoActions[1].height - bookInfoActions[3].height) <= 1);
  assert.ok(Math.abs(bookInfoActions[2].width - bookInfoActions[3].width) <= 1);
  assert.ok(Math.abs(bookInfoActions[2].height - bookInfoActions[3].height) <= 1);
  await evaluate(`(() => {
    window.__bookInfoClipboardBlob = null;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        write: async (items) => {
          window.__bookInfoClipboardBlob = await items[0].getType('image/png');
        },
      },
    });
    document.querySelector('[data-book-info-copy-image="true"]')?.click();
  })()`);
  await waitFor(
    'Boolean(window.__bookInfoClipboardBlob)',
    'book information proof PNG clipboard copy',
    10_000,
  );
  const proofClipboard = await evaluate(`(async () => {
    const blob = window.__bookInfoClipboardBlob;
    const bitmap = await createImageBitmap(blob);
    const result = { type: blob.type, size: blob.size, width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return result;
  })()`);
  assert.equal(proofClipboard.type, 'image/png');
  assert.ok(proofClipboard.size > 1_000, JSON.stringify(proofClipboard));
  assert.ok(proofClipboard.width > 100 && proofClipboard.height > 100, JSON.stringify(proofClipboard));
  await evaluate(`(() => {
    window.__bookInfoProofDownload = null;
    window.__bookInfoProofBlob = null;
    window.__bookInfoOriginalAnchorClick = HTMLAnchorElement.prototype.click;
    window.__bookInfoOriginalCreateObjectURL = URL.createObjectURL;
    URL.createObjectURL = function (blob) {
      if (blob?.type === 'image/png' && blob.size > 1_000) window.__bookInfoProofBlob = blob;
      return window.__bookInfoOriginalCreateObjectURL.call(URL, blob);
    };
    HTMLAnchorElement.prototype.click = function () {
      if (this.download?.endsWith('.png')) {
        window.__bookInfoProofDownload = {
          fileName: this.download,
          hrefPrefix: this.href.slice(0, 5),
        };
        return;
      }
      return window.__bookInfoOriginalAnchorClick.call(this);
    };
    document.querySelector('[data-book-info-capture="true"]')?.click();
  })()`);
  await waitFor(
    'Boolean(window.__bookInfoProofDownload)',
    'book information proof PNG download',
    10_000,
  );
  const proofDownload = await evaluate('window.__bookInfoProofDownload');
  assert.match(proofDownload.fileName, /^독서인증_.*\.png$/);
  assert.equal(proofDownload.hrefPrefix, 'blob:');
  const proofImage = await evaluate(`(async () => {
    const blob = window.__bookInfoProofBlob;
    const bitmap = await createImageBitmap(blob);
    const canvas = document.createElement('canvas');
    canvas.width = 32;
    canvas.height = 32;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const width = bitmap.width;
    const height = bitmap.height;
    bitmap.close();
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let opaquePixels = 0;
    let minLuma = 255;
    let maxLuma = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] === 0) continue;
      opaquePixels += 1;
      const luma = (pixels[index] + pixels[index + 1] + pixels[index + 2]) / 3;
      minLuma = Math.min(minLuma, luma);
      maxLuma = Math.max(maxLuma, luma);
    }
    return {
      type: blob.type,
      size: blob.size,
      width,
      height,
      opaquePixels,
      lumaRange: maxLuma - minLuma,
    };
  })()`);
  assert.equal(proofImage.type, 'image/png');
  assert.ok(proofImage.size > 1_000, JSON.stringify(proofImage));
  assert.ok(proofImage.width > 100 && proofImage.height > 100, JSON.stringify(proofImage));
  assert.ok(proofImage.opaquePixels > 500, JSON.stringify(proofImage));
  assert.ok(proofImage.lumaRange > 5, JSON.stringify(proofImage));
  await evaluate(`(() => {
    HTMLAnchorElement.prototype.click = window.__bookInfoOriginalAnchorClick;
    URL.createObjectURL = window.__bookInfoOriginalCreateObjectURL;
    delete window.__bookInfoOriginalAnchorClick;
    delete window.__bookInfoOriginalCreateObjectURL;
  })()`);
  await evaluate(`document.querySelector('[data-book-info-request-delete="true"]')?.click()`);
  await waitFor(
    'Boolean(document.querySelector(\'[data-book-info-delete-confirmation="true"]\'))',
    'book information delete confirmation',
  );
  assert.equal(
    await evaluate(`document.querySelector('[data-book-info-delete-confirmation="true"] h3')?.textContent?.trim()`),
    '이 도서를 삭제하시겠습니까?',
  );
  assert.deepEqual(
    await evaluate(`[...document.querySelectorAll('[data-book-info-delete-confirmation="true"] button')]
      .map((button) => button.textContent?.trim())`),
    ['영구 삭제', '취소'],
  );
  await evaluate(`(() => {
    const confirmation = document.querySelector('[data-book-info-delete-confirmation="true"]');
    [...(confirmation?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent?.trim() === '취소')?.click();
    const modal = document.querySelector('[data-book-info-modal="true"]');
    modal?.querySelector('button[aria-label="도서 정보 닫기"]')?.click();
  })()`);
  await waitFor(
    '!document.querySelector(\'[data-book-info-modal="true"]\')',
    'book information modal close',
  );

  await command('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 640,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await evaluate('window.scrollTo(0, 0)');
  await evaluate('window.__regressionNextFrame(2)');
  await sleep(250);
  const mobileShelfControls = await evaluate(`(() => {
    const mobileControls = document.querySelector('[data-shelf-mobile-layout-controls="true"]');
    const filterButton = mobileControls?.querySelector('[data-shelf-filter-control="true"]');
    const viewButton = mobileControls?.querySelector('[data-shelf-view-control="true"]');
    const authButton = document.querySelector('header [data-shelf-auth-control="true"]');
    const topDock = document.querySelector('[data-shelf-top-dock="true"]');
    const bottomDock = document.querySelector('[data-shelf-bottom-dock="true"]');
    const rect = (node) => {
      const value = node?.getBoundingClientRect();
      return value ? { left: value.left, right: value.right } : null;
    };
    return {
      mobileControlCount: mobileControls?.querySelectorAll('button').length ?? 0,
      bottomUsesMuzioStyle: bottomDock?.classList.contains('shelf-muzio-dock') ?? false,
      bottomSurfaceColor: bottomDock ? getComputedStyle(bottomDock).backgroundColor : '',
      hasTopDock: Boolean(topDock),
      bottomBorderRadius: bottomDock ? Number.parseFloat(getComputedStyle(bottomDock).borderRadius) : 0,
      bottomBoxShadow: bottomDock ? getComputedStyle(bottomDock).boxShadow : 'none',
      bottomButtonOpacity: bottomDock?.querySelector('button')
        ? Number.parseFloat(getComputedStyle(bottomDock.querySelector('button')).opacity)
        : 0,
      bottomLayoutControlCount: [...(bottomDock?.querySelectorAll(
        '[data-shelf-filter-control="true"], [data-shelf-view-control="true"]',
      ) ?? [])].filter((button) => button.getClientRects().length > 0).length,
      bottomClientWidth: bottomDock?.clientWidth ?? 0,
      bottomScrollWidth: bottomDock?.scrollWidth ?? 0,
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      filterRect: rect(filterButton),
      viewRect: rect(viewButton),
      authRect: rect(authButton),
      viewportWidth: innerWidth,
    };
  })()`);
  assert.equal(mobileShelfControls.mobileControlCount, 3, JSON.stringify(mobileShelfControls));
  assert.equal(mobileShelfControls.bottomUsesMuzioStyle, true, JSON.stringify(mobileShelfControls));
  assert.equal(mobileShelfControls.bottomSurfaceColor, 'rgba(39, 39, 40, 0.88)', JSON.stringify(mobileShelfControls));
  assert.equal(mobileShelfControls.hasTopDock, false, JSON.stringify(mobileShelfControls));
  assert.equal(mobileShelfControls.bottomBorderRadius, 34, JSON.stringify(mobileShelfControls));
  assert.notEqual(mobileShelfControls.bottomBoxShadow, 'none', JSON.stringify(mobileShelfControls));
  assert.ok(mobileShelfControls.bottomButtonOpacity >= 0.8, JSON.stringify(mobileShelfControls));
  assert.equal(mobileShelfControls.bottomLayoutControlCount, 0, JSON.stringify(mobileShelfControls));
  assert.ok(
    mobileShelfControls.bottomScrollWidth <= mobileShelfControls.bottomClientWidth,
    JSON.stringify(mobileShelfControls),
  );
  assert.equal(mobileShelfControls.horizontalOverflow, 0, JSON.stringify(mobileShelfControls));
  assert.ok(
    mobileShelfControls.filterRect?.right <= mobileShelfControls.viewRect?.left
      && mobileShelfControls.viewRect?.right <= mobileShelfControls.viewportWidth
      && mobileShelfControls.authRect?.right <= mobileShelfControls.viewportWidth,
    JSON.stringify(mobileShelfControls),
  );
  await evaluate(`(() => {
    const settings = JSON.parse(localStorage.getItem('viewer_settings') || '{}');
    settings.customThemes = Array.from({ length: 8 }, (_, index) => ({
      id: 'custom-scroll-' + (index + 1),
      title: 'Custom Scroll ' + (index + 1),
      bgColor: index % 2 === 0 ? '#20252b' : '#31252d',
      textColor: '#d2d3d6',
      texture: 'none',
    }));
    localStorage.setItem('viewer_settings', JSON.stringify(settings));
    return true;
  })()`);
  await command('Page.reload', { ignoreCache: true });
  await waitFor(
    'Boolean(document.querySelector(\'[data-shelf-bottom-dock="true"] button[title="Change Theme"]\'))',
    'shelf after custom theme fixture reload',
  );
  await evaluate(`document.querySelector('[data-shelf-bottom-dock="true"] button[title="Change Theme"]')?.click()`);
  await waitFor(
    'Boolean(document.querySelector(\'[data-shelf-dock-style-option="glass"]\'))',
    'shelf dock style controls',
  );
  assert.equal(
    await evaluate('Boolean(document.querySelector(\'[data-shelf-dock-style-option="standard"]\'))'),
    true,
  );
  const themeModalHeader = await evaluate(`(() => {
    const header = document.querySelector('[data-modal-header="theme"]');
    const modal = header?.closest('[data-menu-sheet="true"]');
    const body = modal?.querySelector('[data-theme-modal-scroll-body="true"]');
    const overlay = modal?.parentElement;
    const beforeRect = modal?.getBoundingClientRect();
    const overlayRect = overlay?.getBoundingClientRect();
    if (overlay) overlay.scrollTop = 80;
    if (body) body.scrollTop = Math.min(80, Math.max(0, body.scrollHeight - body.clientHeight));
    const afterRect = modal?.getBoundingClientRect();
    return {
      close: Boolean(header?.querySelector('[data-menu-sheet-close="true"]')),
      divider: header ? getComputedStyle(header).borderBottomWidth : '0px',
      top: beforeRect?.top ?? -1,
      height: beforeRect?.height ?? -1,
      topAfterInnerScroll: afterRect?.top ?? -1,
      viewportHeight: innerHeight,
      overlayTop: overlayRect?.top ?? -1,
      overlayHeight: overlayRect?.height ?? -1,
      sideGap: beforeRect && overlayRect ? beforeRect.left - overlayRect.left : -1,
      overlayScrollable: Boolean(overlay && overlay.scrollHeight > overlay.clientHeight),
      overlayScrollTop: overlay?.scrollTop ?? -1,
      modalOverflowY: modal ? getComputedStyle(modal).overflowY : '',
      modalScrollable: Boolean(modal && modal.scrollHeight > modal.clientHeight),
      modalScrollTop: modal?.scrollTop ?? -1,
      bodyOverflowY: body ? getComputedStyle(body).overflowY : '',
      bodyScrollable: Boolean(body && body.scrollHeight > body.clientHeight),
      bodyScrollTop: body?.scrollTop ?? -1,
    };
  })()`);
  assert.equal(themeModalHeader.close, true, JSON.stringify(themeModalHeader));
  assert.equal(themeModalHeader.divider, '1px', JSON.stringify(themeModalHeader));
  assert.ok(Math.abs(
    themeModalHeader.top + themeModalHeader.height
      - (themeModalHeader.overlayTop + themeModalHeader.overlayHeight) + 12
  ) <= 1, JSON.stringify(themeModalHeader));
  assert.ok(themeModalHeader.sideGap >= 19 && themeModalHeader.sideGap <= 21, JSON.stringify(themeModalHeader));
  assert.equal(themeModalHeader.topAfterInnerScroll, themeModalHeader.top);
  assert.equal(themeModalHeader.overlayScrollable, false, JSON.stringify(themeModalHeader));
  assert.equal(themeModalHeader.overlayScrollTop, 0, JSON.stringify(themeModalHeader));
  assert.equal(themeModalHeader.modalOverflowY, 'hidden', JSON.stringify(themeModalHeader));
  assert.equal(themeModalHeader.modalScrollTop, 0, JSON.stringify(themeModalHeader));
  assert.equal(themeModalHeader.bodyOverflowY, 'auto', JSON.stringify(themeModalHeader));
  assert.equal(themeModalHeader.bodyScrollTop > 0, themeModalHeader.bodyScrollable, JSON.stringify(themeModalHeader));
  const themeCardLayout = await evaluate(`(() => {
    const builtInList = document.querySelector('[data-theme-list-scroll="true"]');
    const customList = document.querySelector('[data-custom-theme-list-scroll="true"]');
    const builtInCards = [...(builtInList?.querySelectorAll('[data-theme-option]') ?? [])];
    const customCards = [...(customList?.querySelectorAll('[data-custom-theme-option]') ?? [])];
    const cardRect = (card) => {
      const rect = card?.getBoundingClientRect();
      return rect ? { width: rect.width, height: rect.height } : null;
    };
    return {
      builtInKeys: builtInCards.map((card) => card.getAttribute('data-theme-option')),
      builtInLabels: builtInCards.map((card) => card.querySelector('span:nth-of-type(2)')?.textContent?.trim()),
      builtInColumns: builtInList ? getComputedStyle(builtInList).gridTemplateColumns.split(' ').length : 0,
      builtInRects: builtInCards.map(cardRect),
      customCount: customCards.length,
      customColumns: customList ? getComputedStyle(customList).gridTemplateColumns.split(' ').length : 0,
      customOverflowY: customList ? getComputedStyle(customList).overflowY : '',
      customRects: customCards.map(cardRect),
    };
  })()`);
  assert.deepEqual(themeCardLayout.builtInKeys, ['light', 'sepia', 'dark', 'midnight'], JSON.stringify(themeCardLayout));
  assert.deepEqual(themeCardLayout.builtInLabels, ['라이트', '세피아', '다크', '자정'], JSON.stringify(themeCardLayout));
  assert.equal(themeCardLayout.builtInColumns, 4, JSON.stringify(themeCardLayout));
  assert.ok(themeCardLayout.builtInRects.every((rect) => Math.abs(rect.width - rect.height) <= 1), JSON.stringify(themeCardLayout));
  assert.equal(themeCardLayout.customCount, 8, JSON.stringify(themeCardLayout));
  assert.equal(themeCardLayout.customColumns, 4, JSON.stringify(themeCardLayout));
  assert.equal(themeCardLayout.customOverflowY, 'auto', JSON.stringify(themeCardLayout));
  assert.ok(themeCardLayout.customRects.every((rect) => Math.abs(rect.width - rect.height) <= 1), JSON.stringify(themeCardLayout));
  assert.equal(await evaluate('Boolean(document.querySelector(\'[data-theme-option="blue"]\'))'), false);
  assert.equal(await evaluate('Boolean(document.querySelector(\'[data-theme-option="midnight"]\'))'), true);
  await evaluate(`document.querySelector('[data-theme-option="midnight"]')?.click()`);
  await waitFor(
    `getComputedStyle(document.documentElement).getPropertyValue('--viewer-theme-bg').trim() === '#141517'
      && getComputedStyle(document.documentElement).getPropertyValue('--viewer-theme-text').trim() === '#d2d3d6'`,
    'exact Midnight theme colors',
  );
  const midnightTheme = await evaluate(`(() => ({
    storedTheme: JSON.parse(localStorage.getItem('viewer_settings') || '{}').theme,
    background: getComputedStyle(document.documentElement).getPropertyValue('--viewer-theme-bg').trim(),
    text: getComputedStyle(document.documentElement).getPropertyValue('--viewer-theme-text').trim(),
  }))()`);
  assert.deepEqual(midnightTheme, { storedTheme: 'midnight', background: '#141517', text: '#d2d3d6' });
  await evaluate(`document.querySelector('[data-theme-option="dark"]')?.click()`);
  await waitFor(
    `getComputedStyle(document.documentElement).getPropertyValue('--viewer-theme-bg').trim() === '#272728'
      && getComputedStyle(document.documentElement).getPropertyValue('--accent-500').trim() === '#d4af37'`,
    'restored dark theme after Midnight check',
  );
  const shelfDockStyleLayout = await evaluate(`(() => {
    const values = ['standard', 'glass', 'modern'];
    const buttons = values.map((value) => document.querySelector(
      '[data-shelf-dock-style-option="' + value + '"]'
    ));
    return {
      values: buttons.map((button) => button?.dataset.shelfDockStyleOption || ''),
      tops: buttons.map((button) => Math.round(button?.getBoundingClientRect().top || -1)),
      labels: buttons.map((button) => button?.querySelector(':scope > span:last-of-type')?.textContent?.trim() || ''),
      texturePreviews: buttons.map((button) => Boolean(button?.querySelector('[data-menu-style-texture-preview="true"]'))),
      squareDeltas: buttons.map((button) => {
        const rect = button?.getBoundingClientRect();
        return rect ? Math.abs(rect.width - rect.height) : -1;
      }),
      previewClasses: buttons.map((button) => button?.className || ''),
      previewBlur: buttons.map((button) => button ? getComputedStyle(button).backdropFilter : ''),
      selectedBoxes: buttons.map((button) => Boolean(
        button?.querySelector('[data-shelf-dock-style-selected-box="true"]')
      )),
      storedStyle: JSON.parse(localStorage.getItem('viewer_settings') || '{}').shelfDockStyle,
      gridTemplateColumns: buttons[0]?.parentElement
        ? getComputedStyle(buttons[0].parentElement).gridTemplateColumns
        : '',
    };
  })()`);
  assert.deepEqual(shelfDockStyleLayout.values, ['standard', 'glass', 'modern']);
  assert.equal(new Set(shelfDockStyleLayout.tops).size, 1, JSON.stringify(shelfDockStyleLayout));
  assert.equal(shelfDockStyleLayout.gridTemplateColumns.split(' ').length, 3, JSON.stringify(shelfDockStyleLayout));
  assert.deepEqual(shelfDockStyleLayout.labels, ['표준', '글래스', '모던']);
  assert.deepEqual(shelfDockStyleLayout.texturePreviews, [true, true, true]);
  assert.ok(shelfDockStyleLayout.squareDeltas.every((delta) => delta <= 1), JSON.stringify(shelfDockStyleLayout));
  assert.match(shelfDockStyleLayout.previewClasses[0], /backdrop-blur-xl/);
  assert.match(shelfDockStyleLayout.previewClasses[1], /viewer-cime-glass/);
  assert.match(shelfDockStyleLayout.previewClasses[2], /shelf-muzio-dock/);
  assert.equal(
    shelfDockStyleLayout.previewBlur[1],
    'blur(4px) saturate(0.9) contrast(0.82)',
  );
  assert.equal(shelfDockStyleLayout.selectedBoxes.filter(Boolean).length, 1);
  assert.equal(
    shelfDockStyleLayout.values[shelfDockStyleLayout.selectedBoxes.indexOf(true)],
    shelfDockStyleLayout.storedStyle,
  );
  await evaluate(`document.querySelector('[data-shelf-dock-style-option="glass"]')?.click()`);
  await waitFor(
    'document.querySelector(\'[data-shelf-bottom-dock="true"]\')?.dataset.shelfDockStyle === "glass"',
    'glass shelf dock style',
  );
  await waitFor(
    `(() => {
      const dock = document.querySelector('[data-shelf-bottom-dock="true"]');
      if (!dock) return false;
      const style = getComputedStyle(dock);
      const radius = Number.parseFloat(style.borderRadius || '0');
      return style.backdropFilter === 'blur(4px) saturate(0.9) contrast(0.82)'
        && radius === 34;
    })()`,
    'settled glass shelf dock style',
  );
  const glassShelfDock = await evaluate(`(() => {
    const dock = document.querySelector('[data-shelf-bottom-dock="true"]');
    const style = dock ? getComputedStyle(dock) : null;
    return {
      storedStyle: JSON.parse(localStorage.getItem('viewer_settings') || '{}').shelfDockStyle,
      usesModernClass: dock?.classList.contains('shelf-muzio-dock') ?? true,
      usesCimeGlassClass: dock?.classList.contains('viewer-cime-glass') ?? false,
      backgroundColor: style?.backgroundColor ?? '',
      backdropFilter: style?.backdropFilter ?? '',
      rimBackground: dock ? getComputedStyle(dock, '::before').backgroundImage : '',
      borderRadius: Number.parseFloat(style?.borderRadius || '0'),
    };
  })()`);
  assert.equal(glassShelfDock.storedStyle, 'glass', JSON.stringify(glassShelfDock));
  assert.equal(glassShelfDock.usesModernClass, false, JSON.stringify(glassShelfDock));
  assert.equal(glassShelfDock.usesCimeGlassClass, true, JSON.stringify(glassShelfDock));
  assert.equal(glassShelfDock.backgroundColor, 'rgba(39, 39, 40, 0.24)', JSON.stringify(glassShelfDock));
  assert.equal(
    glassShelfDock.backdropFilter,
    'blur(4px) saturate(0.9) contrast(0.82)',
    JSON.stringify(glassShelfDock),
  );
  assert.match(glassShelfDock.rimBackground, /linear-gradient\(164deg/, JSON.stringify(glassShelfDock));
  assert.equal(glassShelfDock.borderRadius, 34, JSON.stringify(glassShelfDock));
  assert.equal(
    await evaluate(`Boolean(document.querySelector(
      '[data-shelf-dock-style-option="glass"] [data-shelf-dock-style-selected-box="true"]'
    ))`),
    true,
  );

  await evaluate(`document.querySelector('[data-shelf-dock-style-option="standard"]')?.click()`);
  await waitFor(
    'document.querySelector(\'[data-shelf-bottom-dock="true"]\')?.dataset.shelfDockStyle === "standard"',
    'standard shelf dock style',
  );
  await waitFor(
    `(() => {
      const dock = document.querySelector('[data-shelf-bottom-dock="true"]');
      if (!dock) return false;
      const style = getComputedStyle(dock);
      return style.backgroundColor === 'rgba(39, 39, 40, 0.68)'
        && style.backdropFilter.includes('blur(24px)');
    })()`,
    'settled standard shelf dock style',
  );
  const standardShelfDock = await evaluate(`(() => {
    const dock = document.querySelector('[data-shelf-bottom-dock="true"]');
    const style = dock ? getComputedStyle(dock) : null;
    return {
      storedStyle: JSON.parse(localStorage.getItem('viewer_settings') || '{}').shelfDockStyle,
      usesModernClass: dock?.classList.contains('shelf-muzio-dock') ?? true,
      usesCimeGlassClass: dock?.classList.contains('viewer-cime-glass') ?? true,
      backgroundColor: style?.backgroundColor ?? '',
      backdropFilter: style?.backdropFilter ?? '',
      borderRadius: Number.parseFloat(style?.borderRadius || '0'),
    };
  })()`);
  assert.equal(standardShelfDock.storedStyle, 'standard', JSON.stringify(standardShelfDock));
  assert.equal(standardShelfDock.usesModernClass, false, JSON.stringify(standardShelfDock));
  assert.equal(standardShelfDock.usesCimeGlassClass, false, JSON.stringify(standardShelfDock));
  assert.equal(standardShelfDock.backgroundColor, 'rgba(39, 39, 40, 0.68)', JSON.stringify(standardShelfDock));
  assert.match(standardShelfDock.backdropFilter, /blur\(24px\)/, JSON.stringify(standardShelfDock));
  assert.equal(standardShelfDock.borderRadius, 34, JSON.stringify(standardShelfDock));
  assert.equal(
    await evaluate(`Boolean(document.querySelector(
      '[data-shelf-dock-style-option="standard"] [data-shelf-dock-style-selected-box="true"]'
    ))`),
    true,
  );

  await evaluate(`document.querySelector('[data-shelf-dock-style-option="modern"]')?.click()`);
  await waitFor(
    'document.querySelector(\'[data-shelf-bottom-dock="true"]\')?.dataset.shelfDockStyle === "modern"',
    'modern shelf dock style',
  );
  assert.equal(
    await evaluate(`Boolean(document.querySelector(
      '[data-shelf-dock-style-option="modern"] [data-shelf-dock-style-selected-box="true"]'
    ))`),
    true,
  );
  await waitFor(
    `(() => {
      const dock = document.querySelector('[data-shelf-bottom-dock="true"]');
      if (!dock) return false;
      const style = getComputedStyle(dock);
      const radius = Number.parseFloat(style.borderRadius || '0');
      return style.backgroundColor === 'rgba(39, 39, 40, 0.88)'
        && radius === 34;
    })()`,
    'settled modern shelf dock style',
  );
  const modernShelfDock = await evaluate(`(() => {
    const dock = document.querySelector('[data-shelf-bottom-dock="true"]');
    const style = dock ? getComputedStyle(dock) : null;
    return {
      storedStyle: JSON.parse(localStorage.getItem('viewer_settings') || '{}').shelfDockStyle,
      usesModernClass: dock?.classList.contains('shelf-muzio-dock') ?? false,
      backgroundColor: style?.backgroundColor ?? '',
      borderRadius: Number.parseFloat(style?.borderRadius || '0'),
    };
  })()`);
  assert.equal(modernShelfDock.storedStyle, 'modern', JSON.stringify(modernShelfDock));
  assert.equal(modernShelfDock.usesModernClass, true, JSON.stringify(modernShelfDock));
  assert.equal(modernShelfDock.backgroundColor, 'rgba(39, 39, 40, 0.88)', JSON.stringify(modernShelfDock));
  assert.equal(modernShelfDock.borderRadius, 34, JSON.stringify(modernShelfDock));
  const backdropDismissPoint = await evaluate(`(() => {
    const probe = document.createElement('button');
    probe.type = 'button';
    probe.dataset.backdropClickProbe = 'true';
    probe.style.cssText = 'position:fixed;left:0;top:0;width:32px;height:32px;z-index:1';
    probe.addEventListener('click', () => { window.__themeBackdropClickThrough = true; });
    document.body.appendChild(probe);
    window.__themeBackdropClickThrough = false;
    return { x: 12, y: 12 };
  })()`);
  await command('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: backdropDismissPoint.x,
    y: backdropDismissPoint.y,
    button: 'left',
    clickCount: 1,
  });
  await command('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: backdropDismissPoint.x,
    y: backdropDismissPoint.y,
    button: 'left',
    clickCount: 1,
  });
  await waitFor(
    '!document.querySelector(\'[data-shelf-dock-style-option="glass"]\')',
    'theme modal backdrop close after shelf dock style switch',
  );
  assert.equal(await evaluate('window.__themeBackdropClickThrough'), false);
  await evaluate(`document.querySelector('[data-backdrop-click-probe="true"]')?.remove()`);
  await evaluate(`document.querySelector(
    '[data-shelf-mobile-layout-controls="true"] [data-shelf-filter-control="true"]',
  )?.click()`);
  await waitFor(
    'Boolean(document.querySelector(\'[data-shelf-filter-modal="true"]\'))',
    'mobile unified shelf filter modal',
  );
  await new Promise((resolve) => setTimeout(resolve, 260));
  const mobileFilterModal = await evaluate(`(() => {
    const modal = document.querySelector('[data-shelf-filter-modal="true"]');
    const rect = modal?.getBoundingClientRect();
    const backdropRect = modal?.parentElement?.getBoundingClientRect();
    return {
      left: rect?.left ?? -1,
      right: rect?.right ?? -1,
      top: rect?.top ?? -1,
      bottom: rect?.bottom ?? -1,
      backdropBottom: backdropRect?.bottom ?? -1,
      bottomGap: rect && backdropRect ? backdropRect.bottom - rect.bottom : -1,
      height: rect?.height ?? -1,
      borderBottomLeftRadius: modal
        ? Number.parseFloat(getComputedStyle(modal).borderBottomLeftRadius)
        : 0,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
    };
  })()`);
  assert.ok(mobileFilterModal.left >= 0, JSON.stringify(mobileFilterModal));
  assert.ok(mobileFilterModal.right <= mobileFilterModal.viewportWidth, JSON.stringify(mobileFilterModal));
  assert.ok(mobileFilterModal.top >= 0, JSON.stringify(mobileFilterModal));
  assert.ok(mobileFilterModal.bottom <= mobileFilterModal.backdropBottom, JSON.stringify(mobileFilterModal));
  assert.ok(mobileFilterModal.bottomGap >= 11 && mobileFilterModal.bottomGap <= 13, JSON.stringify(mobileFilterModal));
  assert.equal(mobileFilterModal.borderBottomLeftRadius, 22, JSON.stringify(mobileFilterModal));
  assert.ok(mobileFilterModal.height <= mobileFilterModal.viewportHeight * 0.60 + 1, JSON.stringify(mobileFilterModal));
  assert.equal(mobileFilterModal.horizontalOverflow, 0, JSON.stringify(mobileFilterModal));
  await evaluate(`document.querySelector(
    '[data-shelf-filter-modal="true"] [data-menu-sheet-close="true"]',
  )?.click()`);
  await waitFor(
    '!document.querySelector(\'[data-shelf-filter-modal="true"]\')',
    'mobile unified shelf filter modal close',
  );
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });

  await evaluate(`(() => {
    window.__archiveAlerts = [];
    window.__nativeArchiveAlert = window.alert;
    window.alert = (message) => window.__archiveAlerts.push(String(message));
    window.scrollTo(0, Math.min(
      320,
      Math.max(0, document.documentElement.scrollHeight - innerHeight),
    ));
    window.__modalScrollBefore = window.scrollY;
    window.__modalScrollToCalls = [];
    window.__nativeModalScrollTo = window.scrollTo.bind(window);
    window.scrollTo = (...args) => {
      const first = args[0];
      const requestedX = typeof first === 'object' && first !== null
        ? Number(first.left ?? window.scrollX)
        : Number(first ?? window.scrollX);
      const requestedY = typeof first === 'object' && first !== null
        ? Number(first.top ?? window.scrollY)
        : Number(args[1] ?? window.scrollY);
      window.__modalScrollToCalls.push({ x: requestedX, y: requestedY });
      return window.__nativeModalScrollTo(...args);
    };
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
  await evaluate(`(() => {
    document.elementFromPoint(10, 10)?.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 600,
    }));
    window.scrollBy(0, 600);
    return true;
  })()`);
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
      const getAll = tx.objectStore('metadata-v5').getAll();
      const values = await new Promise((resolve, reject) => {
        getAll.onsuccess = () => resolve(getAll.result);
        getAll.onerror = () => reject(getAll.error);
      });
      db.close();
      const value = values.find((candidate) => (
        candidate.ownerKey === ownerKey && candidate.name === 'oversized.cbz'
      ));
      if (value) window.__oversizedBookId = value.id;
      return Boolean(value);
    })()`,
    'oversized archive import',
  );
  await waitFor(
    `!document.querySelector('input[type="file"]')`,
    'archive import modal close',
  );
  const modalScrollRestore = await evaluate(`(() => {
    const result = {
      bodyPosition: document.body.style.position,
      bodyOverflow: document.body.style.overflow,
      htmlOverflow: document.documentElement.style.overflow,
      scrollY: window.scrollY,
      scrollBefore: window.__modalScrollBefore,
      scrollToCalls: [...(window.__modalScrollToCalls ?? [])],
    };
    if (window.__nativeModalScrollTo) window.scrollTo = window.__nativeModalScrollTo;
    delete window.__nativeModalScrollTo;
    delete window.__modalScrollToCalls;
    return result;
  })()`);
  assert.equal(modalScrollRestore.bodyPosition, '');
  assert.equal(modalScrollRestore.bodyOverflow, '');
  assert.equal(modalScrollRestore.htmlOverflow, '');
  assert.ok(
    modalScrollRestore.scrollToCalls.some(({ y }) => (
      Math.abs(y - modalScrollRestore.scrollBefore) <= 1
    )),
    JSON.stringify(modalScrollRestore),
  );
  await evaluate(`new Promise((resolve, reject) => {
    const request = indexedDB.open('web-reader-db');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const ownerKey = 'guest:device-library|library:local';
      const tx = db.transaction(['metadata-v5', 'book-covers-v14'], 'readwrite');
      const store = tx.objectStore('metadata-v5');
      tx.objectStore('book-covers-v14').clear();
      const cursorRequest = store.openCursor();
      cursorRequest.onerror = () => reject(cursorRequest.error);
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor) return;
        if (
          cursor.value.ownerKey === ownerKey
          && cursor.value.id !== window.__oversizedBookId
        ) {
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
  const offlineStorageTheme = await evaluate(`(() => {
    const header = document.querySelector('[data-modal-header="offline-storage"]');
    const heading = header?.querySelector('h2');
    const closeButton = header?.querySelector('button[aria-label="오프라인 저장소 닫기"]');
    const fileIcon = document.querySelector('[data-offline-book-icon="true"]');
    const row = fileIcon?.closest('.group');
    return {
      titleFontStyle: heading ? getComputedStyle(heading).fontStyle : '',
      headingColor: heading ? getComputedStyle(heading).color : '',
      closeColor: closeButton ? getComputedStyle(closeButton).color : '',
      fileIconColor: fileIcon ? getComputedStyle(fileIcon).color : '',
      rowColor: row ? getComputedStyle(row).color : '',
    };
  })()`);
  assert.equal(offlineStorageTheme.titleFontStyle, 'normal', JSON.stringify(offlineStorageTheme));
  assert.equal(offlineStorageTheme.closeColor, offlineStorageTheme.headingColor);
  assert.equal(offlineStorageTheme.fileIconColor, offlineStorageTheme.rowColor);
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
    'Boolean(document.querySelector(\'[data-shelf-search-input="true"]\'))',
    'archive search modal',
  );
  assert.equal(
    await setInputValue(
      '[data-shelf-search-input="true"]',
      'oversized',
    ),
    true,
  );
  await evaluate('document.querySelector(\'[data-shelf-search-input="true"]\')?.form?.requestSubmit()');
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
      const ownerKey = 'guest:device-library|library:local';
      const tx = db.transaction('metadata-v5', 'readonly');
      const getAll = tx.objectStore('metadata-v5').getAll();
      const values = await new Promise((resolve, reject) => {
        getAll.onsuccess = () => resolve(getAll.result);
        getAll.onerror = () => reject(getAll.error);
      });
      db.close();
      const value = values.find((candidate) => (
        candidate.ownerKey === ownerKey
        && candidate.name === 'selection-probe.epub'
        && candidate.sourceFormat === 'txt'
      ));
      if (value) {
        localStorage.setItem('__browserRegressionSelectionBookId', value.id);
      }
      return Boolean(value);
    })()`,
    'selection TXT import',
  );
  await evaluate(`(() => {
    const settings = JSON.parse(localStorage.getItem('viewer_settings') || '{}');
    localStorage.setItem('viewer_settings', JSON.stringify({
      ...settings,
      navMode: 'left-right',
      landscapeTwoPage: false,
    }));
    localStorage.removeItem('last_reader_session');
  })()`);
  await command('Page.reload', { ignoreCache: true });
  await waitFor(
    `document.querySelector("[data-shelf-library-label]")?.textContent?.trim() === "Guest Library"
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
      value: { writeText: async (text) => {
        if (text.startsWith('번역:')) window.__translationCopiedText = text;
        else window.__selectionCopiedText = text;
      } },
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async ({ text }) => { window.__selectionSharedText = text; },
    });
    window.__nativeLanguageToolOpen = window.open;
    window.__languageToolUrls = [];
    window.open = (url, target) => {
      window.__languageToolUrls.push({ url: String(url), target });
      return { opener: window };
    };
    window.__browserTranslatorStats = { availability: 0, create: 0, translate: 0, destroy: 0 };
    Object.defineProperty(globalThis, 'Translator', {
      configurable: true,
      value: {
        availability: async () => {
          window.__browserTranslatorStats.availability += 1;
          return 'downloadable';
        },
        create: async ({ monitor }) => {
          window.__browserTranslatorStats.create += 1;
          monitor?.({
            addEventListener: (_type, listener) => listener({ loaded: 0.6 }),
          });
          return {
            translate: async (text) => {
              window.__browserTranslatorStats.translate += 1;
              return '번역:' + text.trim();
            },
            destroy: () => { window.__browserTranslatorStats.destroy += 1; },
          };
        },
      },
    });
    class RegressionSpeechSynthesisUtterance {
      constructor(text) {
        this.text = text;
        this.lang = '';
        this.rate = 1;
        this.pitch = 1;
        this.volume = 1;
        this.voice = null;
        this.onstart = null;
        this.onend = null;
        this.onerror = null;
      }
    }
    const speechEvents = new EventTarget();
    let speechVoices = [
      { voiceURI: 'voice-en', name: 'Regression English', lang: 'en-US', default: true, localService: true },
      { voiceURI: 'voice-ko', name: 'Regression Korean', lang: 'ko-KR', default: false, localService: true },
    ];
    let currentUtterance = null;
    let delaySpeechStart = false;
    window.__browserSpeechStats = {
      speak: 0,
      cancel: 0,
      pause: 0,
      resume: 0,
      texts: [],
      languages: [],
      rates: [],
      voices: [],
    };
    const speechSynthesisMock = {
      speaking: false,
      paused: false,
      pending: false,
      getVoices: () => [...speechVoices],
      addEventListener: (...args) => speechEvents.addEventListener(...args),
      removeEventListener: (...args) => speechEvents.removeEventListener(...args),
      speak: (utterance) => {
        currentUtterance = utterance;
        speechSynthesisMock.speaking = true;
        speechSynthesisMock.paused = false;
        window.__browserSpeechStats.speak += 1;
        window.__browserSpeechStats.texts.push(utterance.text);
        window.__browserSpeechStats.languages.push(utterance.lang);
        window.__browserSpeechStats.rates.push(utterance.rate);
        window.__browserSpeechStats.voices.push(utterance.voice?.voiceURI ?? null);
        if (!delaySpeechStart) queueMicrotask(() => utterance.onstart?.({ utterance }));
      },
      cancel: () => {
        window.__browserSpeechStats.cancel += 1;
        speechSynthesisMock.speaking = false;
        speechSynthesisMock.paused = false;
        currentUtterance = null;
      },
      pause: () => {
        window.__browserSpeechStats.pause += 1;
        speechSynthesisMock.paused = true;
      },
      resume: () => {
        window.__browserSpeechStats.resume += 1;
        speechSynthesisMock.paused = false;
      },
    };
    Object.defineProperty(globalThis, 'SpeechSynthesisUtterance', {
      configurable: true,
      value: RegressionSpeechSynthesisUtterance,
    });
    Object.defineProperty(globalThis, 'speechSynthesis', {
      configurable: true,
      value: speechSynthesisMock,
    });
    window.__finishBrowserSpeech = () => {
      const utterance = currentUtterance;
      if (!utterance) return false;
      currentUtterance = null;
      speechSynthesisMock.speaking = false;
      utterance.onend?.({ utterance });
      return true;
    };
    window.__errorBrowserSpeech = (error = 'synthesis-failed') => {
      const utterance = currentUtterance;
      if (!utterance) return false;
      currentUtterance = null;
      speechSynthesisMock.speaking = false;
      speechSynthesisMock.pending = false;
      utterance.onerror?.({ utterance, error });
      return true;
    };
    window.__setBrowserSpeechRuntime = ({ speaking, paused, pending } = {}) => {
      if (typeof speaking === 'boolean') speechSynthesisMock.speaking = speaking;
      if (typeof paused === 'boolean') speechSynthesisMock.paused = paused;
      if (typeof pending === 'boolean') speechSynthesisMock.pending = pending;
    };
    window.__setBrowserSpeechStartDelayed = (value) => {
      delaySpeechStart = Boolean(value);
    };
    window.__startBrowserSpeech = () => {
      if (!currentUtterance) return false;
      currentUtterance.onstart?.({ utterance: currentUtterance });
      return true;
    };
    window.__setBrowserSpeechVoices = (voices) => {
      speechVoices = voices;
      speechEvents.dispatchEvent(new Event('voiceschanged'));
    };
  })()`);
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((node) => node.title === 'Search Books');
    button?.click();
    return Boolean(button);
  })()`);
  await waitFor(
    'Boolean(document.querySelector(\'[data-shelf-search-input="true"]\'))',
    'selection TXT search modal',
  );
  assert.equal(
    await setInputValue('[data-shelf-search-input="true"]', 'selection-probe'),
    true,
  );
  await evaluate('document.querySelector(\'[data-shelf-search-input="true"]\')?.form?.requestSubmit()');
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
  const readerBookTime = await evaluate(`(() => {
    const node = document.querySelector('[data-reader-book-reading-time="true"]');
    const main = document.querySelector('[data-reader-status-main="true"]');
    const title = document.querySelector('[data-reader-status-title="true"]');
    const progress = document.querySelector('[data-reader-status-progress="true"]');
    const jump = document.querySelector('[data-reader-status-jump="true"]');
    const rect = node?.getBoundingClientRect();
    const mainRect = main?.getBoundingClientRect();
    const progressRect = progress?.getBoundingClientRect();
    const jumpRect = jump?.getBoundingClientRect();
    return {
      text: node?.textContent?.trim() ?? '',
      opacity: node ? getComputedStyle(node).opacity : '',
      fontWeight: node ? getComputedStyle(node).fontWeight : '',
      fontFamily: node ? getComputedStyle(node).fontFamily : '',
      fontSize: node ? getComputedStyle(node).fontSize : '',
      mainFontSize: main ? getComputedStyle(main).fontSize : '',
      titleFontFamily: title ? getComputedStyle(title).fontFamily : '',
      titleFontWeight: title ? getComputedStyle(title).fontWeight : '',
      titleFontStyle: title ? getComputedStyle(title).fontStyle : '',
      centerDelta: rect && mainRect
        ? Math.abs((rect.top + rect.bottom) / 2 - (mainRect.top + mainRect.bottom) / 2)
        : null,
      mainText: main?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
      insideMain: Boolean(node && main?.contains(node)),
      progressToJumpGap: progressRect && jumpRect ? jumpRect.left - progressRect.right : null,
      jumpToTimeGap: jumpRect && rect ? rect.left - jumpRect.right : null,
      order: progress && jump && node
        ? Boolean(progress.compareDocumentPosition(jump) & Node.DOCUMENT_POSITION_FOLLOWING)
          && Boolean(jump.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)
        : false,
    };
  })()`);
  assert.match(readerBookTime.text, /^\d{2,}:\d{2}$/);
  assert.ok(Number(readerBookTime.opacity) < 0.5, JSON.stringify(readerBookTime));
  assert.equal(readerBookTime.fontWeight, '400', JSON.stringify(readerBookTime));
  assert.match(readerBookTime.fontFamily, /serif/i, JSON.stringify(readerBookTime));
  assert.equal(readerBookTime.fontSize, readerBookTime.mainFontSize, JSON.stringify(readerBookTime));
  assert.match(readerBookTime.titleFontFamily, /Pretendard/i, JSON.stringify(readerBookTime));
  assert.equal(readerBookTime.titleFontWeight, '400', JSON.stringify(readerBookTime));
  assert.equal(readerBookTime.titleFontStyle, 'normal', JSON.stringify(readerBookTime));
  assert.ok(readerBookTime.centerDelta !== null && readerBookTime.centerDelta <= 1, JSON.stringify(readerBookTime));
  assert.equal(readerBookTime.mainText.includes(readerBookTime.text), true, JSON.stringify(readerBookTime));
  assert.equal(readerBookTime.insideMain, true, JSON.stringify(readerBookTime));
  assert.equal(readerBookTime.order, true, JSON.stringify(readerBookTime));
  assert.ok(
    readerBookTime.progressToJumpGap !== null
      && readerBookTime.jumpToTimeGap !== null
      && Math.abs(readerBookTime.progressToJumpGap - readerBookTime.jumpToTimeGap) <= 1,
    JSON.stringify(readerBookTime),
  );
  await command('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 640,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await evaluate('window.__regressionNextFrame(2)');
  const mobileReaderBookTime = await evaluate(`(() => {
    const node = document.querySelector('[data-reader-book-reading-time="true"]');
    const main = document.querySelector('[data-reader-status-main="true"]');
    const rect = node?.getBoundingClientRect();
    const mainRect = main?.getBoundingClientRect();
    return {
      fontWeight: node ? getComputedStyle(node).fontWeight : '',
      fontFamily: node ? getComputedStyle(node).fontFamily : '',
      fontSize: node ? getComputedStyle(node).fontSize : '',
      mainFontSize: main ? getComputedStyle(main).fontSize : '',
      centerDelta: rect && mainRect
        ? Math.abs((rect.top + rect.bottom) / 2 - (mainRect.top + mainRect.bottom) / 2)
        : null,
    };
  })()`);
  assert.equal(mobileReaderBookTime.fontWeight, '400', JSON.stringify(mobileReaderBookTime));
  assert.match(mobileReaderBookTime.fontFamily, /serif/i, JSON.stringify(mobileReaderBookTime));
  assert.equal(
    mobileReaderBookTime.fontSize,
    mobileReaderBookTime.mainFontSize,
    JSON.stringify(mobileReaderBookTime),
  );
  assert.ok(
    mobileReaderBookTime.centerDelta !== null && mobileReaderBookTime.centerDelta <= 1,
    JSON.stringify(mobileReaderBookTime),
  );
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate('window.__regressionNextFrame(2)');
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
      script.src.endsWith('/foliate-js/view.js?v=1.8.34')
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
  await evaluate(`(() => {
    window.__doubleClickSelectionMenuMounts = 0;
    window.__doubleClickSelectionObserver = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (node.matches('[data-reader-selection-menu="true"]')
            || node.querySelector('[data-reader-selection-menu="true"]')) {
            window.__doubleClickSelectionMenuMounts += 1;
          }
        }
      }
    });
    window.__doubleClickSelectionObserver.observe(document.body, {
      childList: true,
      subtree: true,
    });
  })()`);
  for (const clickCount of [1, 2]) {
    await command('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: actualTextTapProbe.x,
      y: actualTextTapProbe.y,
      button: 'left',
      clickCount,
    });
    await command('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: actualTextTapProbe.x,
      y: actualTextTapProbe.y,
      button: 'left',
      clickCount,
    });
  }
  await sleep(300);
  const doubleClickSelectionUi = await evaluate(`(() => {
    window.__doubleClickSelectionObserver?.disconnect();
    const doc = document.querySelector('foliate-view')?.renderer?.getContents?.()[0]?.doc;
    return {
      menuVisible: Boolean(document.querySelector('[data-reader-selection-menu="true"]')),
      menuMounts: window.__doubleClickSelectionMenuMounts,
      selectedText: doc?.getSelection()?.toString() ?? '',
    };
  })()`);
  assert.deepEqual(doubleClickSelectionUi, {
    menuVisible: false,
    menuMounts: 0,
    selectedText: '',
  });
  if (await evaluate(`document.querySelector('nav')?.classList.contains('translate-y-0')`)) {
    await dispatchActualTextClick();
  }
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
    const dragRect = range.getBoundingClientRect();
    const dragTarget = textNode.parentElement ?? doc.body;
    dragTarget.dispatchEvent(new doc.defaultView.PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerId: 77,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: dragRect.left,
      clientY: dragRect.top + dragRect.height / 2,
    }));
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    doc.dispatchEvent(new doc.defaultView.Event('selectionchange'));
    dragTarget.dispatchEvent(new doc.defaultView.PointerEvent('pointermove', {
      bubbles: true,
      cancelable: true,
      pointerId: 77,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 1,
      clientX: dragRect.left + 24,
      clientY: dragRect.top + dragRect.height / 2,
    }));
    dragTarget.dispatchEvent(new doc.defaultView.PointerEvent('pointerup', {
      bubbles: true,
      cancelable: true,
      pointerId: 77,
      pointerType: 'mouse',
      isPrimary: true,
      button: 0,
      buttons: 0,
      clientX: dragRect.left + 24,
      clientY: dragRect.top + dragRect.height / 2,
    }));
    const menuDeadline = performance.now() + 2000;
    while (!document.querySelector('[data-reader-selection-menu="true"]')
      && performance.now() < menuDeadline) {
      await window.__regressionNextFrame();
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
    await window.__regressionNextFrame();
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
    const translateButtonFound = Boolean(document.querySelector(
      '[data-reader-selection-menu="true"] [data-reader-selection-translate="true"]',
    ));
    const dictionaryButtonFound = Boolean(document.querySelector(
      '[data-reader-selection-menu="true"] [data-reader-selection-dictionary="true"]',
    ));
    const speakButton = document.querySelector(
      '[data-reader-selection-menu="true"] [data-reader-selection-speak="true"]',
    );
    const speakButtonFound = Boolean(speakButton);
    const yellowHighlightButton = document.querySelector(
      '[data-reader-selection-menu="true"] button[aria-label="노랑 하이라이트 추가"]',
    );
    const beforeSelectionTts = renderer.start;
    speakButton?.click();
    const selectionTtsDeadline = performance.now() + 3000;
    while ((!document.querySelector('[data-reader-tts-controls="true"]')
      || window.__browserSpeechStats.speak < 1)
      && performance.now() < selectionTtsDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const selectionTtsControls = document.querySelector('[data-reader-tts-controls="true"]');
    const selectionTtsText = selectionTtsControls?.textContent ?? '';
    window.__setBrowserSpeechVoices?.([
      { voiceURI: 'voice-en', name: 'Regression English', lang: 'en-US', default: true, localService: true },
      { voiceURI: 'voice-ko', name: 'Regression Korean', lang: 'ko-KR', default: false, localService: true },
      { voiceURI: 'voice-ja', name: 'Regression Japanese', lang: 'ja-JP', default: false, localService: true },
    ]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const selectionTtsVoiceOptions = selectionTtsControls
      ?.querySelectorAll('select')[1]?.querySelectorAll('option').length ?? 0;
    const selectionTtsOverlayShown = renderer.getContents().some(({ overlayer }) => (
      overlayer?.element?.querySelector('[data-reader-tts-highlight="true"]')
    ));
    selectionTtsControls?.querySelector('button[aria-label="일시정지"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    selectionTtsControls?.querySelector('button[aria-label="재생"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    window.__finishBrowserSpeech?.();
    const selectionTtsFinishDeadline = performance.now() + 2000;
    while (!document.querySelector('[data-reader-tts-controls="true"]')
      ?.textContent?.includes('문장 완료')
      && performance.now() < selectionTtsFinishDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const selectionTtsOverlayCleared = !renderer.getContents().some(({ overlayer }) => (
      overlayer?.element?.querySelector('[data-reader-tts-highlight="true"]')
    ));
    document.querySelector('[data-reader-tts-controls="true"] button[aria-label="TTS 중지"]')
      ?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const selectionTtsStopped = !document.querySelector('[data-reader-tts-controls="true"]');
    const afterSelectionTts = renderer.start;
    selection.removeAllRanges();
    selection.addRange(range);
    doc.dispatchEvent(new doc.defaultView.Event('selectionchange'));
    const postTtsMenuDeadline = performance.now() + 2000;
    while (!document.querySelector('[data-reader-selection-menu="true"]')
      && performance.now() < postTtsMenuDeadline) {
      await window.__regressionNextFrame();
    }
    const beforeTranslation = renderer.start;
    document.querySelector(
      '[data-reader-selection-menu="true"] [data-reader-selection-translate="true"]',
    )?.click();
    const translationDeadline = performance.now() + 4000;
    while (!document.querySelector('[data-reader-translation-dialog="true"]')
      && performance.now() < translationDeadline) {
      await window.__regressionNextFrame();
    }
    const translationDialogShown = Boolean(
      document.querySelector('[data-reader-translation-dialog="true"]'),
    );
    history.back();
    const translationBackDeadline = performance.now() + 2000;
    while (document.querySelector('[data-reader-translation-dialog="true"]')
      && performance.now() < translationBackDeadline) {
      await window.__regressionNextFrame();
    }
    const translationClosedByBack = !document.querySelector(
      '[data-reader-translation-dialog="true"]',
    ) && Boolean(document.querySelector('foliate-view'));
    selection.removeAllRanges();
    selection.addRange(range);
    doc.dispatchEvent(new doc.defaultView.Event('selectionchange'));
    const translationRetryMenuDeadline = performance.now() + 2000;
    while (!document.querySelector('[data-reader-selection-menu="true"]')
      && performance.now() < translationRetryMenuDeadline) {
      await window.__regressionNextFrame();
    }
    document.querySelector(
      '[data-reader-selection-menu="true"] [data-reader-selection-translate="true"]',
    )?.click();
    const translationRetryDeadline = performance.now() + 4000;
    while (!document.querySelector('[data-reader-translation-dialog="true"]')
      ?.textContent?.includes('번역:probe paragraph')
      && performance.now() < translationRetryDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const translationResult = document.querySelector(
      '[data-reader-translation-dialog="true"]',
    )?.textContent ?? '';
    [...document.querySelectorAll('[data-reader-translation-dialog="true"] button')]
      .find((button) => button.textContent?.includes('결과 복사'))?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    [...document.querySelectorAll('[data-reader-translation-dialog="true"] button')]
      .find((button) => button.textContent?.includes('하이라이트 메모에 저장'))?.click();
    const translationSaveDeadline = performance.now() + 4000;
    while (document.querySelector('[data-reader-translation-dialog="true"]')
      && performance.now() < translationSaveDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const afterTranslation = renderer.start;
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
      return records.filter((record) => record.bookId === localStorage.getItem('__browserRegressionSelectionBookId'));
    };
    const hasHighlightOverlay = () => renderer.getContents().some(({ overlayer }) => (
      overlayer?.element?.querySelector('[data-reader-highlight="true"]')
    ));
    const createdAnnotations = await readAnnotations();
    const createdOverlay = hasHighlightOverlay();
    selection.removeAllRanges();
    selection.addRange(range);
    doc.dispatchEvent(new doc.defaultView.Event('selectionchange'));
    const dictionaryMenuDeadline = performance.now() + 2000;
    while (!document.querySelector('[data-reader-selection-menu="true"]')
      && performance.now() < dictionaryMenuDeadline) {
      await window.__regressionNextFrame();
    }
    document.querySelector(
      '[data-reader-selection-menu="true"] [data-reader-selection-dictionary="true"]',
    )?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const dictionaryUrl = window.__languageToolUrls[0]?.url ?? '';
    selection.removeAllRanges();
    doc.dispatchEvent(new doc.defaultView.Event('selectionchange'));
    await window.__regressionNextFrame();
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
      await window.__regressionNextFrame();
    }
    const highlightTouchMenuShown = Boolean(
      document.querySelector('[data-reader-highlight-menu="true"]'),
    );
    const afterHighlightTouch = renderer.start;
    document.querySelector(
      '[data-reader-highlight-menu="true"] button[aria-label="하이라이트 메뉴 닫기"]',
    )?.click();
    await window.__regressionNextFrame();
    textNode.parentElement?.dispatchEvent(new doc.defaultView.MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: selectedRect.left + selectedRect.width / 2,
      clientY: selectedRect.top + selectedRect.height / 2,
    }));
    const highlightMenuDeadline = performance.now() + 2000;
    while (!document.querySelector('[data-reader-highlight-menu="true"]')
      && performance.now() < highlightMenuDeadline) {
      await window.__regressionNextFrame();
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
      await window.__regressionNextFrame();
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
      await window.__regressionNextFrame();
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
      await window.__regressionNextFrame();
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
      await window.__regressionNextFrame();
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
    const scrollModeHorizontalOverflow = {
      rendererClientWidth: renderer.clientWidth,
      rendererScrollWidth: renderer.scrollWidth,
      contentClientWidth: renderer.getContents()[0]?.doc?.documentElement?.clientWidth ?? 0,
      contentScrollWidth: renderer.getContents()[0]?.doc?.documentElement?.scrollWidth ?? 0,
    };
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
    await window.__regressionNextFrame();
    const controlsOpened = document.querySelector('nav')?.classList.contains('translate-y-0');
    const beforeControlsCloseTap = renderer.start;
    dispatchDocumentClick(toFramePoint(innerWidth * 0.95, innerHeight / 2));
    await window.__regressionNextFrame();
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
    await window.__regressionNextFrame();
    const nativeSelectionBeforeRapidSecondTap = selection.toString();
    dispatchPointerTap(402);
    await new Promise((resolve) => setTimeout(resolve, 130));
    const afterRapidTaps = renderer.start;
    const rapidTapSelectionCleared = !selection.toString()
      && !document.querySelector('[data-reader-selection-menu="true"]');
    const countVisibleReaderTextRects = () => {
      const currentFrame = doc.defaultView.frameElement;
      const currentFrameRect = currentFrame?.getBoundingClientRect();
      if (!currentFrame || !currentFrameRect) return 0;
      const scaleX = currentFrameRect.width / currentFrame.clientWidth;
      const scaleY = currentFrameRect.height / currentFrame.clientHeight;
      let count = 0;
      const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        if (!node.nodeValue?.trim()) continue;
        const textRange = doc.createRange();
        textRange.selectNodeContents(node);
        for (const rect of textRange.getClientRects()) {
          const left = currentFrameRect.left + rect.left * scaleX;
          const right = currentFrameRect.left + rect.right * scaleX;
          const top = currentFrameRect.top + rect.top * scaleY;
          const bottom = currentFrameRect.top + rect.bottom * scaleY;
          if (right > 0 && left < innerWidth && bottom > 0 && top < innerHeight) count += 1;
        }
      }
      return count;
    };
    const visibleTextBeforeModeSwitch = countVisibleReaderTextRects();
    document.querySelector('button[aria-label="설정"]')?.click();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const settingsHeading = [...document.querySelectorAll('h2')]
      .find((heading) => heading.textContent?.trim() === '리더 설정');
    const settingsFrame = settingsHeading?.parentElement?.parentElement?.parentElement;
    const scrollModeButton = [...(settingsFrame?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent?.trim() === 'Scroll');
    scrollModeButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const visibleTextAfterScrollMode = countVisibleReaderTextRects();
    const flowAfterScrollMode = renderer.getAttribute('flow');
    const tapModeButton = [...(settingsFrame?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent?.trim() === 'L/R Tap');
    tapModeButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 250));
    const visibleTextAfterTapMode = countVisibleReaderTextRects();
    const flowAfterTapMode = renderer.getAttribute('flow');
    settingsFrame?.querySelector('button[aria-label="리더 설정 닫기"]')?.click();
    await window.__regressionNextFrame();
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
      translateButtonFound,
      dictionaryButtonFound,
      speakButtonFound,
      selectionTtsText,
      selectionTtsVoiceOptions,
      selectionTtsOverlayShown,
      selectionTtsOverlayCleared,
      selectionTtsStopped,
      beforeSelectionTts,
      afterSelectionTts,
      browserSpeechStats: window.__browserSpeechStats,
      translationDialogShown,
      translationClosedByBack,
      translationResult,
      translationCopiedText: window.__translationCopiedText,
      translationSavedNote: createdAnnotations[0]?.note ?? null,
      browserTranslatorStats: window.__browserTranslatorStats,
      dictionaryUrl,
      beforeTranslation,
      afterTranslation,
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
      scrollModeHorizontalOverflow,
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
      visibleTextAfterScrollMode,
      visibleTextAfterTapMode,
      visibleTextBeforeModeSwitch,
      flowAfterScrollMode,
      flowAfterTapMode,
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
  assert.equal(selectionActions.translateButtonFound, true, JSON.stringify(selectionActions));
  assert.equal(selectionActions.dictionaryButtonFound, true, JSON.stringify(selectionActions));
  assert.equal(selectionActions.speakButtonFound, true, JSON.stringify(selectionActions));
  assert.match(selectionActions.selectionTtsText, /선택 영역 읽는 중/);
  assert.match(selectionActions.selectionTtsText, /probe paragraph/);
  assert.ok(selectionActions.selectionTtsVoiceOptions >= 4);
  assert.equal(selectionActions.selectionTtsOverlayShown, true, JSON.stringify(selectionActions));
  assert.equal(selectionActions.selectionTtsOverlayCleared, true, JSON.stringify(selectionActions));
  assert.equal(selectionActions.selectionTtsStopped, true, JSON.stringify(selectionActions));
  assert.equal(selectionActions.afterSelectionTts, selectionActions.beforeSelectionTts);
  assert.equal(selectionActions.browserSpeechStats.speak, 1);
  assert.equal(selectionActions.browserSpeechStats.pause, 1);
  assert.equal(selectionActions.browserSpeechStats.resume, 1);
  assert.match(selectionActions.browserSpeechStats.texts[0], /probe paragraph/);
  assert.equal(selectionActions.browserSpeechStats.languages[0], 'en-US');
  assert.equal(selectionActions.browserSpeechStats.voices[0], 'voice-en');
  assert.equal(selectionActions.translationDialogShown, true, JSON.stringify(selectionActions));
  assert.equal(selectionActions.translationClosedByBack, true, JSON.stringify(selectionActions));
  assert.match(selectionActions.translationResult, /번역:probe paragraph/);
  assert.equal(selectionActions.translationCopiedText, '번역:probe paragraph');
  assert.match(selectionActions.translationSavedNote, /\[번역 en→ko\]\n번역:probe paragraph/);
  assert.deepEqual(selectionActions.browserTranslatorStats, {
    availability: 2,
    create: 2,
    translate: 2,
    destroy: 2,
  });
  assert.match(selectionActions.dictionaryUrl, /^https:\/\/en\.dict\.naver\.com\/#\/search\?query=/);
  assert.equal(selectionActions.afterTranslation, selectionActions.beforeTranslation);
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
  assert.ok(
    selectionActions.scrollModeHorizontalOverflow.rendererScrollWidth
      <= selectionActions.scrollModeHorizontalOverflow.rendererClientWidth + 1,
    JSON.stringify(selectionActions.scrollModeHorizontalOverflow),
  );
  assert.ok(
    selectionActions.scrollModeHorizontalOverflow.contentScrollWidth
      <= selectionActions.scrollModeHorizontalOverflow.contentClientWidth + 1,
    JSON.stringify(selectionActions.scrollModeHorizontalOverflow),
  );
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
  assert.equal(selectionActions.flowAfterScrollMode, 'scrolled', JSON.stringify(selectionActions));
  assert.ok(selectionActions.visibleTextBeforeModeSwitch > 0, JSON.stringify(selectionActions));
  assert.ok(selectionActions.visibleTextAfterScrollMode > 0, JSON.stringify(selectionActions));
  assert.equal(selectionActions.flowAfterTapMode, 'paginated', JSON.stringify(selectionActions));
  assert.ok(selectionActions.visibleTextAfterTapMode > 0, JSON.stringify(selectionActions));
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1366,
    height: 768,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const landscapeReaderLayout = await evaluate(`(async () => {
    await window.__regressionNextFrame(2);
    const view = document.querySelector('foliate-view');
    const renderer = view?.renderer;
    const content = document.querySelector('[data-reader-content="true"]');
    const publicationDoc = renderer?.getContents?.()[0]?.doc;
    if (!view || !renderer || !content || !publicationDoc) return { missing: true };

    renderer.setAttribute('max-column-count', '1');
    await new Promise((resolve) => setTimeout(resolve, 150));
    const textColumnRight = innerWidth / 2 + 500;
    const marginTapX = innerWidth - 24;
    const marginTapY = innerHeight / 2;
    const beforeMarginTap = renderer.start;
    const target = document.elementFromPoint(marginTapX, marginTapY);
    target?.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: marginTapX,
      clientY: marginTapY,
    }));
    await new Promise((resolve) => setTimeout(resolve, 350));
    const afterMarginTap = renderer.start;

    const openControls = () => {
      if (document.querySelector('nav')?.classList.contains('translate-y-0')) return;
      const centerTarget = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      centerTarget?.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: innerWidth / 2,
        clientY: innerHeight / 2,
      }));
    };
    openControls();
    await window.__regressionNextFrame();
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === '설정')?.click();
    await window.__regressionNextFrame();
    const checkbox = document.querySelector('input[aria-label="가로 모드 2페이지 보기"]');
    const initiallyChecked = checkbox?.checked ?? null;
    checkbox?.click();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const landscapeColumnCount = renderer.getAttribute('max-column-count');
    const landscapePageSlots = renderer.heads?.length ?? 0;
    const toolbarMenuRect = document.querySelector('[data-reader-toolbar-menu="true"]')
      ?.getBoundingClientRect();
    const storedEnabled = JSON.parse(localStorage.getItem('viewer_settings') || '{}')
      .landscapeTwoPage;
    return {
      beforeMarginTap,
      afterMarginTap,
      textColumnRight,
      marginTapX,
      targetIsContent: target === content || content.contains(target),
      initiallyChecked,
      landscapeColumnCount,
      landscapePageSlots,
      viewportWidth: innerWidth,
      toolbarMenuRightInset: toolbarMenuRect ? innerWidth - toolbarMenuRect.right : -1,
      storedEnabled,
    };
  })()`);
  assert.equal(landscapeReaderLayout.missing, undefined, JSON.stringify(landscapeReaderLayout));
  assert.ok(
    landscapeReaderLayout.marginTapX > landscapeReaderLayout.textColumnRight,
    JSON.stringify(landscapeReaderLayout),
  );
  assert.equal(landscapeReaderLayout.targetIsContent, true, JSON.stringify(landscapeReaderLayout));
  assert.notEqual(
    landscapeReaderLayout.afterMarginTap,
    landscapeReaderLayout.beforeMarginTap,
    JSON.stringify(landscapeReaderLayout),
  );
  assert.equal(landscapeReaderLayout.initiallyChecked, false, JSON.stringify(landscapeReaderLayout));
  assert.equal(landscapeReaderLayout.landscapeColumnCount, '2', JSON.stringify(landscapeReaderLayout));
  assert.equal(landscapeReaderLayout.landscapePageSlots, 2, JSON.stringify(landscapeReaderLayout));
  assert.ok(
    Math.abs(
      landscapeReaderLayout.toolbarMenuRightInset
        - landscapeReaderLayout.viewportWidth * 0.05,
    ) <= 1,
    JSON.stringify(landscapeReaderLayout),
  );
  assert.equal(landscapeReaderLayout.storedEnabled, true, JSON.stringify(landscapeReaderLayout));

  await command('Emulation.setDeviceMetricsOverride', {
    width: 768,
    height: 1024,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate('window.__regressionNextFrame(2)');
  const portraitTwoPageLayout = await evaluate(`(() => {
    const renderer = document.querySelector('foliate-view')?.renderer;
    return {
      configuredColumnCount: renderer?.getAttribute('max-column-count') ?? null,
      pageSlots: renderer?.heads?.length ?? 0,
    };
  })()`);
  assert.equal(portraitTwoPageLayout.configuredColumnCount, '2');
  assert.equal(portraitTwoPageLayout.pageSlots, 1, JSON.stringify(portraitTwoPageLayout));
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const restoredSinglePageLayout = await evaluate(`(async () => {
    await window.__regressionNextFrame(2);
    const checkbox = document.querySelector('input[aria-label="가로 모드 2페이지 보기"]');
    checkbox?.click();
    await new Promise((resolve) => setTimeout(resolve, 200));
    const renderer = document.querySelector('foliate-view')?.renderer;
    const result = {
      checked: checkbox?.checked ?? null,
      configuredColumnCount: renderer?.getAttribute('max-column-count') ?? null,
      storedEnabled: JSON.parse(localStorage.getItem('viewer_settings') || '{}')
        .landscapeTwoPage,
    };
    [...document.querySelectorAll('h2')]
      .find((node) => node.textContent?.trim() === '리더 설정')
      ?.parentElement?.querySelector('button')?.click();
    return result;
  })()`);
  assert.equal(restoredSinglePageLayout.checked, false, JSON.stringify(restoredSinglePageLayout));
  assert.equal(restoredSinglePageLayout.configuredColumnCount, '1', JSON.stringify(restoredSinglePageLayout));
  assert.equal(restoredSinglePageLayout.storedEnabled, false, JSON.stringify(restoredSinglePageLayout));
  const progressPointerControls = await evaluate(`(async () => {
    const openControls = () => {
      if (document.querySelector('nav')?.classList.contains('translate-y-0')) return;
      const centerTarget = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      centerTarget?.dispatchEvent(new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
        clientX: innerWidth / 2,
        clientY: innerHeight / 2,
      }));
    };
    openControls();
    await window.__regressionNextFrame(2);
    const track = document.querySelector('[data-reader-progress-pointer-track="true"]');
    const input = document.querySelector('input[aria-label="진행률"]');
    if (!track || !input) return { missing: true };
    const rect = track.getBoundingClientRect();
    const current = Number(input.value || 0);
    const tapTarget = current < 50 ? 72 : 28;
    const dragTarget = current < 50 ? 86 : 14;
    const dragStart = current < 50 ? 18 : 82;
    const xFor = (percent) => rect.left + rect.width * percent / 100;
    const dispatchPointer = (type, percent, buttons) => track.dispatchEvent(new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 41,
      pointerType: 'touch',
      button: type === 'pointerdown' ? 0 : -1,
      buttons,
      clientX: xFor(percent),
      clientY: rect.top + rect.height / 2,
    }));

    dispatchPointer('pointerdown', tapTarget, 1);
    dispatchPointer('pointerup', tapTarget, 0);
    await window.__regressionNextFrame(2);
    const tapTitle = document.querySelector('#progress-jump-confirm-title')?.textContent ?? '';
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === '취소')?.click();
    await window.__regressionNextFrame(2);

    dispatchPointer('pointerdown', dragStart, 1);
    dispatchPointer('pointermove', dragTarget, 1);
    dispatchPointer('pointerup', dragTarget, 0);
    await window.__regressionNextFrame(2);
    const dragTitle = document.querySelector('#progress-jump-confirm-title')?.textContent ?? '';
    [...document.querySelectorAll('button')]
      .find((button) => button.textContent?.trim() === '취소')?.click();

    return {
      current,
      tapTarget,
      dragStart,
      dragTarget,
      tapTitle,
      dragTitle,
      inputPointerEvents: getComputedStyle(input).pointerEvents,
      trackTouchAction: getComputedStyle(track).touchAction,
    };
  })()`);
  assert.equal(progressPointerControls.missing, undefined, JSON.stringify(progressPointerControls));
  assert.match(
    progressPointerControls.tapTitle,
    new RegExp(`^${progressPointerControls.tapTarget.toFixed(1)}%로 이동할까요\\?$`),
    JSON.stringify(progressPointerControls),
  );
  assert.match(
    progressPointerControls.dragTitle,
    new RegExp(`^${progressPointerControls.dragTarget.toFixed(1)}%로 이동할까요\\?$`),
    JSON.stringify(progressPointerControls),
  );
  assert.notEqual(progressPointerControls.dragStart, progressPointerControls.current);
  assert.equal(progressPointerControls.inputPointerEvents, 'none');
  assert.equal(progressPointerControls.trackTouchAction, 'none');
  const ttsLifecycleGuards = await evaluate(`(async () => {
    const view = document.querySelector('foliate-view');
    const renderer = view?.renderer;
    const button = document.querySelector('button[aria-label="현재 위치부터 듣기"]');
    if (!view || !renderer || !button) return { missing: true };

    const nativeGetContents = renderer.getContents.bind(renderer);
    renderer.getContents = () => [];
    button.click();
    const feedbackDeadline = performance.now() + 2000;
    while (!document.querySelector('[data-reader-tts-feedback="true"]')
      && performance.now() < feedbackDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const failureFeedback = document.querySelector(
      '[data-reader-tts-feedback="true"]',
    )?.textContent ?? '';
    renderer.getContents = nativeGetContents;

    const nativeAddTransientOverlay = view.addTransientOverlay.bind(view);
    view.addTransientOverlay = () => { throw new Error('transient-overlay-probe'); };
    const speakBeforeOverlayFailure = window.__browserSpeechStats.speak;
    button.click();
    const overlayFailureDeadline = performance.now() + 2000;
    while ((window.__browserSpeechStats.speak <= speakBeforeOverlayFailure
      || !document.querySelector('[data-reader-tts-controls="true"]'))
      && performance.now() < overlayFailureDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const overlayFailureSpoke = window.__browserSpeechStats.speak
      === speakBeforeOverlayFailure + 1;
    const overlayFailureControls = Boolean(
      document.querySelector('[data-reader-tts-controls="true"]'),
    );
    window.__finishBrowserSpeech?.();
    document.querySelector('[data-reader-tts-controls="true"] button[aria-label="TTS 중지"]')
      ?.click();
    view.addTransientOverlay = nativeAddTransientOverlay;

    window.__setBrowserSpeechStartDelayed?.(true);
    const activeTtsIdsBeforeDelayed = Object.keys(localStorage)
      .filter((key) => key.startsWith('reading_stats_draft_v1:'))
      .map((key) => {
        try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
      })
      .filter((draft) => draft?.state === 'active' && draft?.mode === 'tts')
      .map((draft) => draft.sessionId);
    const pauseBefore = window.__browserSpeechStats.pause;
    const speakBeforeDelayedStart = window.__browserSpeechStats.speak;
    button.click();
    const delayedStartDeadline = performance.now() + 2000;
    while ((!document.querySelector('[data-reader-tts-controls="true"]')
      || window.__browserSpeechStats.speak <= speakBeforeDelayedStart)
      && performance.now() < delayedStartDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const delayedStartNewTtsDrafts = Object.keys(localStorage)
      .filter((key) => key.startsWith('reading_stats_draft_v1:'))
      .map((key) => {
        try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
      })
      .filter((draft) => (
        draft?.state === 'active'
        && draft?.mode === 'tts'
        && !activeTtsIdsBeforeDelayed.includes(draft.sessionId)
      ))
      .length;
    document.querySelector('[data-reader-tts-controls="true"] button[aria-label="일시정지"]')
      ?.click();
    window.__startBrowserSpeech?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    const delayedStartStayedPaused = Boolean(document.querySelector(
      '[data-reader-tts-controls="true"] button[aria-label="재생"]',
    ));
    const pauseCalls = window.__browserSpeechStats.pause - pauseBefore;
    document.querySelector('[data-reader-tts-controls="true"] button[aria-label="TTS 중지"]')
      ?.click();
    window.__setBrowserSpeechStartDelayed?.(false);
    return {
      failureFeedback,
      overlayFailureControls,
      overlayFailureSpoke,
      delayedStartStayedPaused,
      delayedStartNewTtsDrafts,
      pauseCalls,
    };
  })()`);
  assert.equal(ttsLifecycleGuards.missing, undefined, JSON.stringify(ttsLifecycleGuards));
  assert.match(ttsLifecycleGuards.failureFeedback, /현재 장을 불러오지 못했습니다/);
  assert.equal(ttsLifecycleGuards.overlayFailureSpoke, true, JSON.stringify(ttsLifecycleGuards));
  assert.equal(ttsLifecycleGuards.overlayFailureControls, true, JSON.stringify(ttsLifecycleGuards));
  assert.equal(ttsLifecycleGuards.delayedStartStayedPaused, true, JSON.stringify(ttsLifecycleGuards));
  assert.equal(ttsLifecycleGuards.delayedStartNewTtsDrafts, 0, JSON.stringify(ttsLifecycleGuards));
  assert.ok(ttsLifecycleGuards.pauseCalls >= 2, JSON.stringify(ttsLifecycleGuards));
  const currentPositionTts = await evaluate(`(async () => {
    const view = document.querySelector('foliate-view');
    const renderer = view?.renderer;
    const before = renderer?.start;
    const speakBefore = window.__browserSpeechStats.speak;
    const button = document.querySelector('button[aria-label="현재 위치부터 듣기"]');
    button?.click();
    const startDeadline = performance.now() + 3000;
    while ((!document.querySelector('[data-reader-tts-controls="true"]')
      || window.__browserSpeechStats.speak <= speakBefore)
      && performance.now() < startDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const controls = document.querySelector('[data-reader-tts-controls="true"]');
    const controlsTextAtStart = controls?.textContent ?? '';
    const firstText = window.__browserSpeechStats.texts.at(-1) ?? '';
    const overlayShown = renderer?.getContents().some(({ overlayer }) => (
      overlayer?.element?.querySelector('[data-reader-tts-highlight="true"]')
    ));
    const speakAfterStart = window.__browserSpeechStats.speak;
    window.__finishBrowserSpeech?.();
    const finishDeadline = performance.now() + 2000;
    while (window.__browserSpeechStats.speak <= speakAfterStart
      && performance.now() < finishDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const speakAfterNaturalEnd = window.__browserSpeechStats.speak;
    document.querySelector('[data-reader-tts-controls="true"] button[aria-label="다음 문장"]')
      ?.click();
    const nextDeadline = performance.now() + 2000;
    while (window.__browserSpeechStats.speak <= speakAfterNaturalEnd
      && performance.now() < nextDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const nextText = window.__browserSpeechStats.texts.at(-1) ?? '';
    const after = renderer?.start;
    document.querySelector('[data-reader-tts-controls="true"] button[aria-label="TTS 중지"]')
      ?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));
    return {
      buttonFound: Boolean(button),
      controlsTextAtStart,
      firstText,
      nextText,
      overlayShown: Boolean(overlayShown),
      stopped: !document.querySelector('[data-reader-tts-controls="true"]'),
      overlayCleared: !renderer?.getContents().some(({ overlayer }) => (
        overlayer?.element?.querySelector('[data-reader-tts-highlight="true"]')
      )),
      speakBefore,
      speakAfterStart,
      speakAfterNaturalEnd,
      speakAfterNext: window.__browserSpeechStats.speak,
      before,
      after,
    };
  })()`);
  assert.equal(currentPositionTts.buttonFound, true, JSON.stringify(currentPositionTts));
  assert.match(currentPositionTts.controlsTextAtStart, /현재 장 연속 읽는 중/);
  assert.ok(currentPositionTts.firstText.length > 0, JSON.stringify(currentPositionTts));
  assert.equal(currentPositionTts.overlayShown, true, JSON.stringify(currentPositionTts));
  assert.equal(currentPositionTts.speakAfterStart, currentPositionTts.speakBefore + 1);
  assert.equal(currentPositionTts.speakAfterNaturalEnd, currentPositionTts.speakAfterStart + 1);
  assert.equal(currentPositionTts.speakAfterNext, currentPositionTts.speakAfterStart + 2);
  assert.notEqual(currentPositionTts.nextText, currentPositionTts.firstText);
  assert.equal(currentPositionTts.after, currentPositionTts.before);
  assert.equal(currentPositionTts.stopped, true);
  assert.equal(currentPositionTts.overlayCleared, true);
  const largeSelectionTts = await evaluate(`(async () => {
    const view = document.querySelector('foliate-view');
    const renderer = view?.renderer;
    const content = renderer?.getContents().find(({ doc }) => (
      doc.body?.innerText?.includes('Selection probe paragraph')
    ));
    const doc = content?.doc;
    if (!renderer || !doc) return { missing: true };
    const waitUntil = async (predicate, timeout = 3000) => {
      const deadline = performance.now() + timeout;
      while (!predicate() && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return predicate();
    };
    const range = doc.createRange();
    range.selectNodeContents(doc.body);
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
    doc.dispatchEvent(new doc.defaultView.Event('selectionchange'));
    await waitUntil(() => document.querySelector('[data-reader-selection-menu="true"]'));
    const speakBefore = window.__browserSpeechStats.speak;
    document.querySelector(
      '[data-reader-selection-menu="true"] [data-reader-selection-speak="true"]',
    )?.click();
    await waitUntil(() => (
      window.__browserSpeechStats.speak > speakBefore
      && document.querySelector('[data-reader-tts-controls="true"]')
    ));
    const initialControls = document.querySelector('[data-reader-tts-controls="true"]');
    const total = Number(initialControls?.dataset.readerTtsTotal ?? 0);
    const initialWindowSize = Number(initialControls?.dataset.readerTtsWindowSize ?? 0);
    const textsStart = window.__browserSpeechStats.texts.length - 1;
    let advanced = 0;
    for (let index = 0; index < 55; index += 1) {
      const previousSpeak = window.__browserSpeechStats.speak;
      if (!window.__finishBrowserSpeech?.()) break;
      if (!await waitUntil(() => window.__browserSpeechStats.speak > previousSpeak, 2000)) break;
      advanced += 1;
    }
    await waitUntil(() => Number(document.querySelector(
      '[data-reader-tts-controls="true"]',
    )?.dataset.readerTtsIndex ?? -1) === 55, 2000);
    const finalControls = document.querySelector('[data-reader-tts-controls="true"]');
    const finalIndex = Number(finalControls?.dataset.readerTtsIndex ?? -1);
    const finalWindowSize = Number(finalControls?.dataset.readerTtsWindowSize ?? 0);
    const indexes = window.__browserSpeechStats.texts.slice(textsStart).map((text) => Number(
      /Selection probe paragraph (\\d+)/.exec(text)?.[1] ?? -1,
    ));
    finalControls?.querySelector('button[aria-label="TTS 중지"]')?.click();
    return { advanced, finalIndex, finalWindowSize, indexes, initialWindowSize, total };
  })()`);
  assert.equal(largeSelectionTts.missing, undefined, JSON.stringify(largeSelectionTts));
  assert.equal(largeSelectionTts.total, 180, JSON.stringify(largeSelectionTts));
  assert.ok(largeSelectionTts.initialWindowSize <= 51, JSON.stringify(largeSelectionTts));
  assert.ok(largeSelectionTts.finalWindowSize <= 51, JSON.stringify(largeSelectionTts));
  assert.equal(largeSelectionTts.advanced, 55, JSON.stringify(largeSelectionTts));
  assert.equal(largeSelectionTts.finalIndex, 55, JSON.stringify(largeSelectionTts));
  assert.deepEqual(largeSelectionTts.indexes.slice(0, 56), Array.from({ length: 56 }, (_, index) => index));
  const chapterTts = await evaluate(`(async () => {
    const view = document.querySelector('foliate-view');
    const renderer = view?.renderer;
    const toolbarButton = document.querySelector('button[aria-label="현재 위치부터 듣기"]');
    const content = renderer?.getContents().find(({ doc }) => (
      doc.body?.innerText?.includes('Selection probe paragraph')
    ));
    const doc = content?.doc;
    if (!view || !renderer || !toolbarButton || !doc) return { missing: true };

    const waitUntil = async (predicate, timeout = 3000) => {
      const deadline = performance.now() + timeout;
      while (!predicate() && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return predicate();
    };
    const readProgress = async () => {
      const request = indexedDB.open('web-reader-db');
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const all = db.transaction('progress-v5', 'readonly')
        .objectStore('progress-v5').getAll();
      const records = await new Promise((resolve, reject) => {
        all.onsuccess = () => resolve(all.result);
        all.onerror = () => reject(all.error);
      });
      db.close();
      const bookId = localStorage.getItem('__browserRegressionSelectionBookId');
      return records.find((record) => record.bookId === bookId) ?? null;
    };
    const comparableProgress = (progress) => progress ? {
      cfi: progress.cfi ?? null,
      progressPercent: progress.progressPercent ?? null,
      revision: progress.revision ?? null,
      updatedAtClient: progress.updatedAtClient ?? null,
      autoBookmarkCfi: progress.autoBookmark?.cfi ?? null,
      manualBookmarkCfi: progress.manualBookmark?.cfi ?? null,
    } : null;
    const readActiveTtsDraft = () => {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key?.startsWith('reading_stats_draft_v1:')) continue;
        try {
          const draft = JSON.parse(localStorage.getItem(key));
          if (draft?.mode === 'tts' && draft?.state === 'active') return {
            sessionId: draft.sessionId ?? null,
            intervalCount: Array.isArray(draft.activeIntervals)
              ? draft.activeIntervals.length
              : -1,
            hasOpenInterval: Number.isSafeInteger(draft.activeIntervalStartedAtClient),
            lastHeartbeatAt: draft.lastHeartbeatAt ?? null,
            lastClosedIntervalEnd: Array.isArray(draft.activeIntervals)
              ? draft.activeIntervals.at(-1)?.endedAtClient ?? null
              : null,
          };
        } catch {}
      }
      return null;
    };
    const seedProgressSentinel = async () => {
      const request = indexedDB.open('web-reader-db');
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const tx = db.transaction('progress-v5', 'readwrite');
      tx.objectStore('progress-v5').put({
        ownerKey: 'guest:browser-regression|library:local',
        bookId: localStorage.getItem('__browserRegressionSelectionBookId'),
        cfi: 'epubcfi(/tts-regression-sentinel)',
        progressPercent: 12.34,
        revision: 77,
        updatedAtClient: 1_787_000_000_000,
        lastRead: 1_787_000_000_000,
      });
      await new Promise((resolve, reject) => {
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
      db.close();
    };
    const originalLocationRange = view.lastLocation?.range;
    const startRange = doc.createRange();
    startRange.selectNodeContents(doc.body);
    startRange.collapse(true);
    view.lastLocation.range = startRange;
    const relocateReasons = [];
    const handleRelocate = (event) => relocateReasons.push(event.detail?.reason ?? null);
    view.addEventListener('relocate', handleRelocate);
    let progressPhase = 'preflush';
    window.__readerProgressRegressionTrace = [];
    window.__readerProgressRegressionPhase = progressPhase;
    const setProgressPhase = (value) => {
      progressPhase = value;
      window.__readerProgressRegressionPhase = value;
    };
    await window.__flushReaderProgressForRegression?.();
    await seedProgressSentinel();
    setProgressPhase('chapter-start');
    const progressWrites = [];
    const originalProgressPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args) {
      const value = args[0];
      if (
        this.name === 'progress-v5'
        && value?.bookId === localStorage.getItem('__browserRegressionSelectionBookId')
      ) {
        progressWrites.push({
          phase: progressPhase,
          cfi: value.cfi ?? null,
          progressPercent: value.progressPercent ?? null,
          stack: new Error('progress-v5-put').stack?.split('\\n').slice(0, 8) ?? [],
        });
      }
      return Reflect.apply(originalProgressPut, this, args);
    };

    const speakBefore = window.__browserSpeechStats.speak;
    toolbarButton.click();
    await waitUntil(() => (
      window.__browserSpeechStats.speak > speakBefore
      && document.querySelector('[data-reader-tts-controls="true"]')
    ));
    await waitUntil(() => (
      document.querySelector('[data-reader-tts-controls="true"]')
        ?.textContent?.includes('현재 장 연속 읽는 중')
    ));
    const controlsAtStart = document.querySelector('[data-reader-tts-controls="true"]');
    const total = Number(controlsAtStart?.dataset.readerTtsTotal ?? 0);
    const initialIndex = Number(controlsAtStart?.dataset.readerTtsIndex ?? -1);
    const ttsDraftAtStart = readActiveTtsDraft();
    const chapterTextStart = window.__browserSpeechStats.texts.length - 1;
    const progressBefore = comparableProgress(await readProgress());

    let advanced = 0;
    for (let iteration = 0; iteration < 55; iteration += 1) {
      const previousSpeak = window.__browserSpeechStats.speak;
      if (!window.__finishBrowserSpeech?.()) break;
      const moved = await waitUntil(
        () => window.__browserSpeechStats.speak > previousSpeak,
        2000,
      );
      if (!moved) break;
      advanced += 1;
    }
    await waitUntil(() => Number(document.querySelector(
      '[data-reader-tts-controls="true"]',
    )?.dataset.readerTtsIndex ?? -1) === 55, 2000);
    const controlsAfterWindow = document.querySelector('[data-reader-tts-controls="true"]');
    const afterWindowIndex = Number(controlsAfterWindow?.dataset.readerTtsIndex ?? -1);
    const afterWindowSize = Number(controlsAfterWindow?.dataset.readerTtsWindowSize ?? -1);
    const chapterTexts = window.__browserSpeechStats.texts.slice(chapterTextStart);
    const paragraphIndexes = chapterTexts.map((text) => Number(
      /Selection probe paragraph (\\d+)/.exec(text)?.[1] ?? -1,
    ));
    const sequential = paragraphIndexes.every((value, index) => (
      index === 0 || value === paragraphIndexes[index - 1] + 1
    ));
    await new Promise((resolve) => setTimeout(resolve, 150));
    setProgressPhase('after-window');
    const progressAfterWindow = comparableProgress(await readProgress());
    const ttsDraftAfterWindow = readActiveTtsDraft();
    const cursorsAfterWindow = JSON.parse(
      localStorage.getItem('reader_tts_cursor_v1') || '[]',
    );
    const cursorAfterWindow = cursorsAfterWindow.find((cursor) => (
      cursor.bookId === localStorage.getItem('__browserRegressionSelectionBookId')
    ));

    const retryIndex = Number(controlsAfterWindow?.dataset.readerTtsIndex ?? -1);
    setProgressPhase('retry');
    const retryText = window.__browserSpeechStats.texts.at(-1) ?? '';
    const retrySpeakBefore = window.__browserSpeechStats.speak;
    window.__errorBrowserSpeech?.('network');
    await waitUntil(() => window.__browserSpeechStats.speak > retrySpeakBefore, 2000);
    const retryTextAfter = window.__browserSpeechStats.texts.at(-1) ?? '';
    const skipSpeakBefore = window.__browserSpeechStats.speak;
    window.__errorBrowserSpeech?.('network');
    await waitUntil(() => window.__browserSpeechStats.speak > skipSpeakBefore, 2000);
    const controlsAfterSkip = document.querySelector('[data-reader-tts-controls="true"]');
    const skippedToIndex = Number(controlsAfterSkip?.dataset.readerTtsIndex ?? -1);
    const skippedToText = window.__browserSpeechStats.texts.at(-1) ?? '';

    const nativeVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
    setProgressPhase('visibility');
    let visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    window.__setBrowserSpeechRuntime?.({ speaking: false, paused: false, pending: false });
    const visibilitySpeakBefore = window.__browserSpeechStats.speak;
    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    await waitUntil(() => window.__browserSpeechStats.speak > visibilitySpeakBefore, 2000);
    const visibilityRecoveredText = window.__browserSpeechStats.texts.at(-1) ?? '';

    const timerButton = [...document.querySelectorAll(
      '[data-reader-tts-controls="true"] button',
    )].find((button) => button.textContent?.trim() === '10분');
    timerButton?.click();
    setProgressPhase('sleep-timer');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const timerArmed = Boolean(document.querySelector(
      '[data-reader-tts-controls="true"] [data-reader-tts-sleep-active="true"]',
    ));
    const nativeNow = Date.now;
    Date.now = () => nativeNow() + 11 * 60_000;
    document.dispatchEvent(new Event('visibilitychange'));
    await waitUntil(() => !document.querySelector('[data-reader-tts-controls="true"]'), 2000);
    Date.now = nativeNow;
    if (nativeVisibility) Object.defineProperty(document, 'visibilityState', nativeVisibility);
    else delete document.visibilityState;
    const sleepStopped = !document.querySelector('[data-reader-tts-controls="true"]');
    const sleepFeedback = document.querySelector('[data-reader-tts-feedback="true"]')
      ?.textContent ?? '';

    const resumeSpeakBefore = window.__browserSpeechStats.speak;
    setProgressPhase('resume');
    toolbarButton.click();
    await waitUntil(() => (
      window.__browserSpeechStats.speak > resumeSpeakBefore
      && document.querySelector('[data-reader-tts-controls="true"]')
    ));
    await waitUntil(() => (
      document.querySelector('[data-reader-tts-controls="true"]')
        ?.textContent?.includes('현재 장 연속 읽는 중')
    ), 4000);
    const resumedControls = document.querySelector('[data-reader-tts-controls="true"]');
    const resumedIndex = Number(resumedControls?.dataset.readerTtsIndex ?? -1);
    const resumedText = window.__browserSpeechStats.texts.at(-1) ?? '';
    resumedControls?.querySelector('button[aria-label="TTS 중지"]')?.click();
    setProgressPhase('stopped');
    IDBObjectStore.prototype.put = originalProgressPut;
    view.removeEventListener('relocate', handleRelocate);
    if (originalLocationRange) view.lastLocation.range = originalLocationRange;
    return {
      advanced,
      afterWindowIndex,
      afterWindowSize,
      cursorSourceIndex: cursorAfterWindow?.sourceIndex ?? -1,
      initialIndex,
      paragraphIndexes,
      progressAfterWindow,
      progressBefore,
      progressTrace: window.__readerProgressRegressionTrace,
      progressWrites,
      relocateReasons,
      restartStarted: window.__browserSpeechStats.speak > resumeSpeakBefore,
      resumedIndex,
      resumedText,
      retryIndex,
      retryText,
      retryTextAfter,
      sequential,
      skippedToIndex,
      skippedToText,
      sleepFeedback,
      sleepStopped,
      timerArmed,
      total,
      ttsDraftAfterWindow,
      ttsDraftAtStart,
      visibilityRecoveredText,
    };
  })()`);
  assert.equal(chapterTts.missing, undefined, JSON.stringify(chapterTts));
  assert.ok(chapterTts.total >= 180, JSON.stringify(chapterTts));
  assert.equal(chapterTts.initialIndex, 0, JSON.stringify(chapterTts));
  assert.equal(chapterTts.advanced, 55, JSON.stringify(chapterTts));
  assert.equal(chapterTts.afterWindowIndex, 55, JSON.stringify(chapterTts));
  assert.ok(chapterTts.afterWindowSize > 0 && chapterTts.afterWindowSize <= 51, JSON.stringify(chapterTts));
  assert.equal(chapterTts.sequential, true, JSON.stringify(chapterTts));
  assert.ok(chapterTts.ttsDraftAtStart?.sessionId, JSON.stringify(chapterTts));
  assert.ok(chapterTts.ttsDraftAtStart?.intervalCount >= 0, JSON.stringify(chapterTts));
  assert.equal(chapterTts.ttsDraftAtStart?.hasOpenInterval, true, JSON.stringify(chapterTts));
  assert.ok(
    chapterTts.ttsDraftAtStart?.lastHeartbeatAt
      >= (chapterTts.ttsDraftAtStart?.lastClosedIntervalEnd ?? 0),
    JSON.stringify(chapterTts),
  );
  assert.equal(
    chapterTts.ttsDraftAfterWindow?.sessionId,
    chapterTts.ttsDraftAtStart?.sessionId,
    JSON.stringify(chapterTts),
  );
  assert.ok(
    chapterTts.ttsDraftAfterWindow?.intervalCount
      >= chapterTts.ttsDraftAtStart?.intervalCount,
    JSON.stringify(chapterTts),
  );
  assert.equal(chapterTts.ttsDraftAfterWindow?.hasOpenInterval, true, JSON.stringify(chapterTts));
  assert.ok(
    chapterTts.ttsDraftAfterWindow?.lastHeartbeatAt
      >= (chapterTts.ttsDraftAfterWindow?.lastClosedIntervalEnd ?? 0),
    JSON.stringify(chapterTts),
  );
  assert.deepEqual(chapterTts.paragraphIndexes.slice(0, 56), Array.from({ length: 56 }, (_, index) => index));
  assert.ok(chapterTts.relocateReasons.includes('tts-navigation'), JSON.stringify(chapterTts));
  assert.deepEqual(chapterTts.progressAfterWindow, chapterTts.progressBefore);
  assert.deepEqual(chapterTts.progressWrites, [], JSON.stringify(chapterTts));
  assert.equal(chapterTts.cursorSourceIndex, 55, JSON.stringify(chapterTts));
  assert.equal(chapterTts.retryTextAfter, chapterTts.retryText, JSON.stringify(chapterTts));
  assert.equal(chapterTts.skippedToIndex, chapterTts.retryIndex + 1, JSON.stringify(chapterTts));
  assert.notEqual(chapterTts.skippedToText, chapterTts.retryText, JSON.stringify(chapterTts));
  assert.equal(chapterTts.visibilityRecoveredText, chapterTts.skippedToText, JSON.stringify(chapterTts));
  assert.equal(chapterTts.timerArmed, true, JSON.stringify(chapterTts));
  assert.equal(chapterTts.sleepStopped, true, JSON.stringify(chapterTts));
  assert.match(chapterTts.sleepFeedback, /취침 타이머/);
  assert.equal(chapterTts.restartStarted, true, JSON.stringify(chapterTts));
  assert.ok(chapterTts.resumedIndex >= chapterTts.cursorSourceIndex, JSON.stringify(chapterTts));
  assert.ok(chapterTts.resumedText.length > 0, JSON.stringify(chapterTts));
  const ttsStopGuards = await evaluate(`(async () => {
    const view = document.querySelector('foliate-view');
    const toolbarButton = document.querySelector('button[aria-label="현재 위치부터 듣기"]');
    if (!view || !toolbarButton) return { missing: true };
    const waitUntil = async (predicate, timeout = 3000) => {
      const deadline = performance.now() + timeout;
      while (!predicate() && performance.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      return predicate();
    };
    const findResumeButton = () => [...document.querySelectorAll(
      '[data-reader-tts-controls="true"] button',
    )].find((button) => button.textContent?.includes('저장 위치 이어 듣기'));
    const nativeResolveNavigation = view.resolveNavigation.bind(view);
    const nativeNavigateTransient = view.navigateTransient.bind(view);

    let releasePendingNavigation = () => undefined;
    view.resolveNavigation = () => ({ index: 999 });
    view.navigateTransient = () => new Promise((resolve) => {
      releasePendingNavigation = resolve;
    });
    const loadingSpeakBefore = window.__browserSpeechStats.speak;
    toolbarButton.click();
    await waitUntil(() => Boolean(findResumeButton()));
    findResumeButton()?.click();
    await waitUntil(() => document.querySelector('[data-reader-tts-controls="true"]')
      ?.textContent?.includes('저장 위치를 준비하고 있습니다'));
    document.querySelector('[data-reader-tts-controls="true"] button[aria-label="TTS 중지"]')
      ?.click();
    const loadingStopped = await waitUntil(
      () => !document.querySelector('[data-reader-tts-controls="true"]'),
      2000,
    );
    releasePendingNavigation();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const loadingStayedStopped = !document.querySelector('[data-reader-tts-controls="true"]')
      && window.__browserSpeechStats.speak === loadingSpeakBefore + 1;

    view.navigateTransient = () => Promise.reject(new Error('cursor-navigation-probe'));
    toolbarButton.click();
    await waitUntil(() => Boolean(findResumeButton()));
    findResumeButton()?.click();
    await waitUntil(() => document.querySelector('[data-reader-tts-controls="true"]')
      ?.textContent?.includes('저장한 TTS 위치를 복원하지 못했습니다'));
    const errorVisible = Boolean(document.querySelector('[data-reader-tts-controls="true"]'));
    document.querySelector('[data-reader-tts-controls="true"] button[aria-label="TTS 중지"]')
      ?.click();
    const errorStopped = await waitUntil(
      () => !document.querySelector('[data-reader-tts-controls="true"]'),
      2000,
    );
    view.resolveNavigation = nativeResolveNavigation;
    view.navigateTransient = nativeNavigateTransient;
    return { errorStopped, errorVisible, loadingStayedStopped, loadingStopped };
  })()`);
  assert.equal(ttsStopGuards.missing, undefined, JSON.stringify(ttsStopGuards));
  assert.equal(ttsStopGuards.loadingStopped, true, JSON.stringify(ttsStopGuards));
  assert.equal(ttsStopGuards.loadingStayedStopped, true, JSON.stringify(ttsStopGuards));
  assert.equal(ttsStopGuards.errorVisible, true, JSON.stringify(ttsStopGuards));
  assert.equal(ttsStopGuards.errorStopped, true, JSON.stringify(ttsStopGuards));
  const ttsRangeSemantics = await evaluate(`(async () => {
    const view = document.querySelector('foliate-view');
    const renderer = view?.renderer;
    const button = document.querySelector('button[aria-label="현재 위치부터 듣기"]');
    const content = renderer?.getContents().find(({ doc }) => (
      doc.body?.innerText?.includes('Selection probe paragraph')
    ));
    const doc = content?.doc;
    if (!view || !renderer || !button || !doc || !view.lastLocation) return { missing: true };

    const originalLocationRange = view.lastLocation.range;
    const endRange = doc.createRange();
    endRange.selectNodeContents(doc.body);
    endRange.collapse(false);
    view.lastLocation.range = endRange;
    const speakBeforeEnd = window.__browserSpeechStats.speak;
    button.click();
    const endDeadline = performance.now() + 2500;
    while ((window.__browserSpeechStats.speak <= speakBeforeEnd
      || !document.querySelector('[data-reader-tts-controls="true"]'))
      && performance.now() < endDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const endText = window.__browserSpeechStats.texts.at(-1) ?? '';
    const endTotal = Number(document.querySelector(
      '[data-reader-tts-controls="true"]',
    )?.dataset.readerTtsTotal ?? 0);
    document.querySelector('[data-reader-tts-controls="true"] button[aria-label="TTS 중지"]')
      ?.click();

    const chapterProbeSpeakBefore = window.__browserSpeechStats.speak;
    button.click();
    const chapterProbeControlsDeadline = performance.now() + 2000;
    while ((!document.querySelector('[data-reader-tts-controls="true"]')
      || window.__browserSpeechStats.speak <= chapterProbeSpeakBefore)
      && performance.now() < chapterProbeControlsDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const chapterModeDeadline = performance.now() + 2000;
    while (!document.querySelector('[data-reader-tts-controls="true"]')
      ?.textContent?.includes('현재 장 연속 읽는 중')
      && performance.now() < chapterModeDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const chapterControls = document.querySelector('[data-reader-tts-controls="true"]');
    const lastChapterIndex = Number(chapterControls?.dataset.readerTtsIndex ?? -1);
    const endActionSelect = [...(chapterControls?.querySelectorAll('label') ?? [])]
      .find((label) => label.textContent?.includes('장 끝 동작'))?.querySelector('select');
    if (endActionSelect) {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(endActionSelect, 'next');
      endActionSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const cancelBeforeLastSkip = window.__browserSpeechStats.cancel;
    document.querySelector('[data-reader-tts-controls="true"] button[aria-label="다음 문장"]')
      ?.click();
    const lastSkipDeadline = performance.now() + 2000;
    while (!document.querySelector('[data-reader-tts-controls="true"]')
      ?.textContent?.includes('현재 장 완료')
      && performance.now() < lastSkipDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const lastSkipCancelDelta = window.__browserSpeechStats.cancel - cancelBeforeLastSkip;
    const lastSkipSpeechContinued = window.speechSynthesis.speaking === true;
    if (endActionSelect) {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
      setter.call(endActionSelect, 'stop');
      endActionSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    document.querySelector('[data-reader-tts-controls="true"] button[aria-label="TTS 중지"]')
      ?.click();
    view.lastLocation.range = originalLocationRange;

    let target = null;
    for (const candidate of doc.querySelectorAll('p')) {
      const probe = doc.createRange();
      probe.selectNodeContents(candidate);
      const rect = probe.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0 && rect.bottom > 0
        && rect.top < doc.defaultView.innerHeight) {
        target = candidate;
        break;
      }
    }
    if (!target) return { missingTarget: true, endText, endTotal };
    const originalMarkup = target.innerHTML;
    target.innerHTML = [
      '<span>Hello</span> <span>world</span><br/>',
      '<span hidden="">secret</span>',
      '<span style="display:none">gone</span>',
      '<span style="visibility:hidden">invisible</span>',
      '<span style="content-visibility:hidden">skipped</span>',
      '<ruby>漢<rt>かん</rt><rp>(</rp></ruby><span>字.</span>',
      '<table><tbody><tr><td>A</td><td>B.</td></tr></tbody></table>',
    ].join('');
    await new Promise((resolve) => setTimeout(resolve, 400));
    const semanticRange = doc.createRange();
    semanticRange.selectNodeContents(target);
    const selection = doc.getSelection();
    selection.removeAllRanges();
    selection.addRange(semanticRange);
    doc.dispatchEvent(new doc.defaultView.Event('selectionchange'));
    const menuDeadline = performance.now() + 2000;
    while (!document.querySelector('[data-reader-selection-menu="true"]')
      && performance.now() < menuDeadline) {
      await window.__regressionNextFrame();
    }
    const semanticMenuFound = Boolean(
      document.querySelector('[data-reader-selection-menu="true"]'),
    );
    const semanticSelectedText = selection.toString();
    const semanticStart = window.__browserSpeechStats.texts.length;
    document.querySelector(
      '[data-reader-selection-menu="true"] [data-reader-selection-speak="true"]',
    )?.click();
    const semanticStartDeadline = performance.now() + 2000;
    while ((window.__browserSpeechStats.texts.length <= semanticStart
      || !document.querySelector('[data-reader-tts-controls="true"]'))
      && performance.now() < semanticStartDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const controls = document.querySelector('[data-reader-tts-controls="true"]');
      if (!controls || controls.textContent?.includes('문장 완료')) break;
      window.__finishBrowserSpeech?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const semanticTexts = window.__browserSpeechStats.texts.slice(semanticStart);
    document.querySelector('[data-reader-tts-controls="true"] button[aria-label="TTS 중지"]')
      ?.click();
    selection.removeAllRanges();
    doc.dispatchEvent(new doc.defaultView.Event('selectionchange'));
    target.innerHTML = originalMarkup;
    return {
      endText,
      endTotal,
      lastChapterIndex,
      lastSkipCancelDelta,
      lastSkipSpeechContinued,
      semanticMenuFound,
      semanticSelectedText,
      semanticTexts,
    };
  })()`);
  assert.equal(ttsRangeSemantics.missing, undefined, JSON.stringify(ttsRangeSemantics));
  assert.equal(ttsRangeSemantics.missingTarget, undefined, JSON.stringify(ttsRangeSemantics));
  assert.match(ttsRangeSemantics.endText, /Selection probe paragraph 179/);
  assert.equal(ttsRangeSemantics.lastChapterIndex, 179, JSON.stringify(ttsRangeSemantics));
  assert.equal(
    ttsRangeSemantics.endTotal,
    ttsRangeSemantics.lastChapterIndex + 1,
    JSON.stringify(ttsRangeSemantics),
  );
  assert.ok(ttsRangeSemantics.lastSkipCancelDelta >= 1, JSON.stringify(ttsRangeSemantics));
  assert.equal(
    ttsRangeSemantics.lastSkipSpeechContinued,
    true,
    JSON.stringify(ttsRangeSemantics),
  );
  const semanticSpeech = ttsRangeSemantics.semanticTexts.join('\n');
  assert.match(semanticSpeech, /Hello world/, JSON.stringify(ttsRangeSemantics));
  assert.match(semanticSpeech, /漢字\./);
  assert.match(semanticSpeech, /A\s+B\./);
  assert.doesNotMatch(semanticSpeech, /Helloworld/);
  assert.doesNotMatch(semanticSpeech, /secret|gone|invisible|skipped|かん/);
  let narrowSelectionMenu;
  try {
    await command('Emulation.setDeviceMetricsOverride', {
      width: 320,
      height: 480,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await evaluate(`(() => {
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent?.trim() === '책 검색')?.click();
    })()`);
    await waitFor(
      'Boolean(document.querySelector(\'[data-epub-search-input-row="true"]\'))',
      'mobile EPUB search modal',
    );
    await new Promise((resolve) => setTimeout(resolve, 260));
    const mobileEpubSearchHeight = await evaluate(
      'document.querySelector(\'[data-epub-search-input-row="true"]\')?.getBoundingClientRect().height',
    );
    const mobileEpubSearchSheet = await evaluate(`(() => {
      const modal = document.querySelector('[data-epub-search-modal="true"]');
      const rect = modal?.getBoundingClientRect();
      const backdropRect = modal?.parentElement?.getBoundingClientRect();
      const style = modal ? getComputedStyle(modal) : null;
      return {
        topGap: rect && backdropRect ? rect.top - backdropRect.top : -1,
        sideGap: rect && backdropRect ? rect.left - backdropRect.left : -1,
        topRadius: style?.borderTopLeftRadius ?? '',
        bottomRadius: style?.borderBottomLeftRadius ?? '',
        surfaceClass: modal?.classList.contains('app-search-surface') ?? false,
        backdropFilter: style?.backdropFilter ?? '',
      };
    })()`);
    assert.deepEqual(mobileEpubSearchSheet, {
      topGap: 72,
      sideGap: 16,
      topRadius: '20px',
      bottomRadius: '20px',
      surfaceClass: true,
      backdropFilter: 'blur(24px)',
    });
    assert.ok(
      mobileEpubSearchHeight >= 59 && mobileEpubSearchHeight <= 61,
      `Unexpected mobile EPUB search height: ${mobileEpubSearchHeight}`,
    );
    await evaluate(
      `document.querySelector('[data-epub-search-modal="true"]')?.parentElement?.click()`,
    );
    await waitFor(
      '!document.querySelector(\'[data-epub-search-modal="true"]\')',
      'mobile EPUB search modal close',
    );
    await command('Network.emulateNetworkConditions', {
      offline: true,
      latency: 0,
      downloadThroughput: 0,
      uploadThroughput: 0,
    });
    narrowSelectionMenu = await evaluate(`(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400));
      const toolbarTtsButton = document.querySelector('button[aria-label="현재 위치부터 듣기"]');
      const toolbarStatisticsButton = document.querySelector('button[aria-label="독서 통계"]');
      const toolbarRecordsButton = document.querySelector('button[aria-label="책갈피와 주석"]');
      const toolbarTtsRect = toolbarTtsButton?.getBoundingClientRect();
      const toolbarStatisticsRect = toolbarStatisticsButton?.getBoundingClientRect();
      const toolbarRecordsRect = toolbarRecordsButton?.getBoundingClientRect();
      const toolbarMenuRect = document.querySelector('[data-reader-toolbar-menu="true"]')
        ?.getBoundingClientRect();
      const toolbarActionOrder = [...(document.querySelector(
        '[data-reader-toolbar-actions="true"]',
      )?.children ?? [])].map((button) => (
        button.getAttribute('aria-label') ?? button.textContent?.trim() ?? ''
      ));
      const toolbarProbe = {
        actionOrder: toolbarActionOrder,
        utilityOrder: [...(document.querySelector(
          '[data-reader-toolbar-utilities="true"]',
        )?.children ?? [])].map((button) => button.getAttribute('aria-label') ?? ''),
        menuWidth: document.querySelector('[data-reader-toolbar-actions="true"]')
          ?.parentElement?.offsetWidth ?? 0,
        menuRightInset: toolbarMenuRect ? innerWidth - toolbarMenuRect.right : -1,
        recordsClientWidth: toolbarRecordsButton?.clientWidth ?? 0,
        recordsScrollWidth: toolbarRecordsButton?.scrollWidth ?? 0,
        recordsWidth: toolbarRecordsRect?.width ?? 0,
        themeWidth: document.querySelector('button[aria-label="테마"]')
          ?.getBoundingClientRect().width ?? 0,
        settingsWidth: document.querySelector('button[aria-label="설정"]')
          ?.getBoundingClientRect().width ?? 0,
        recordsWhiteSpace: toolbarRecordsButton
          ? getComputedStyle(toolbarRecordsButton).whiteSpace
          : '',
        ttsText: toolbarTtsButton?.textContent?.trim() ?? '',
        ttsWidth: toolbarTtsRect?.width ?? 0,
        ttsRight: toolbarTtsRect?.right ?? 0,
        statisticsRight: toolbarStatisticsRect?.right ?? 0,
        statisticsWidth: toolbarStatisticsButton?.offsetWidth ?? 0,
        recordsRight: toolbarRecordsRect?.right ?? 0,
        actionHeight: toolbarRecordsButton?.offsetHeight ?? 0,
        actionFontWeight: toolbarRecordsButton
          ? getComputedStyle(toolbarRecordsButton).fontWeight
          : '',
      };
      const ttsSpeakBefore = window.__browserSpeechStats.speak;
      toolbarTtsButton?.click();
      const ttsDeadline = performance.now() + 2000;
      while ((!document.querySelector('[data-reader-tts-controls="true"]')
        || window.__browserSpeechStats.speak <= ttsSpeakBefore)
        && performance.now() < ttsDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const ttsPanel = document.querySelector('[data-reader-tts-controls="true"]');
      const ttsDetails = ttsPanel?.querySelector('details');
      if (ttsDetails) ttsDetails.open = true;
      await window.__regressionNextFrame(2);
      const ttsPanelRect = ttsPanel?.getBoundingClientRect();
      const ttsStopRect = ttsPanel?.querySelector('button[aria-label="TTS 중지"]')
        ?.getBoundingClientRect();
      const ttsPanelProbe = {
        clientHeight: ttsPanel?.clientHeight ?? 0,
        scrollHeight: ttsPanel?.scrollHeight ?? 0,
        panelTop: ttsPanelRect?.top ?? -1,
        panelBottom: ttsPanelRect?.bottom ?? -1,
        stopTop: ttsStopRect?.top ?? -1,
        stopBottom: ttsStopRect?.bottom ?? -1,
        viewportHeight: innerHeight,
      };
      ttsPanel?.querySelector('button[aria-label="TTS 중지"]')?.click();
      const view = document.querySelector('foliate-view');
      const contents = view?.renderer?.getContents?.() ?? [];
      let targetDoc = null;
      let textNode = null;
      for (const { doc } of contents) {
        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
        while (walker.nextNode()) {
          if (!walker.currentNode.textContent?.trim()) continue;
          const probe = doc.createRange();
          probe.selectNodeContents(walker.currentNode);
          const rect = probe.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < doc.defaultView.innerHeight) {
            targetDoc = doc;
            textNode = walker.currentNode;
            break;
          }
        }
        if (textNode) break;
      }
      if (!targetDoc || !textNode) return { missingText: true };
      const range = targetDoc.createRange();
      const end = Math.min(textNode.textContent.length, 12);
      range.setStart(textNode, 0);
      range.setEnd(textNode, end);
      const selection = targetDoc.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      targetDoc.dispatchEvent(new targetDoc.defaultView.Event('selectionchange'));
      const deadline = performance.now() + 2000;
      while (!document.querySelector('[data-reader-selection-menu="true"]')
        && performance.now() < deadline) {
        await window.__regressionNextFrame();
      }
      document.querySelector(
        '[data-reader-selection-menu="true"] [data-reader-selection-dictionary="true"]',
      )?.click();
      await new Promise((resolve) => setTimeout(resolve, 100));
      const menu = document.querySelector('[data-reader-selection-menu="true"]');
      const menuRect = menu?.getBoundingClientRect();
      const buttonRects = [...(menu?.querySelectorAll('button') ?? [])].map((button) => {
        const rect = button.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
      });
      const feedback = menu?.querySelector('[role="status"]');
      const feedbackRect = feedback?.getBoundingClientRect();
      const result = {
        innerWidth,
        menuBorderRadius: menu ? getComputedStyle(menu).borderRadius : '',
        menuRect: menuRect ? {
          left: menuRect.left,
          right: menuRect.right,
          top: menuRect.top,
          bottom: menuRect.bottom,
          width: menuRect.width,
        } : null,
        buttonRects,
        feedbackText: feedback?.textContent ?? '',
        feedbackWidth: feedbackRect?.width ?? 0,
        feedbackWhiteSpace: feedback ? getComputedStyle(feedback).whiteSpace : '',
        ttsPanelProbe,
        toolbarProbe,
      };
      selection.removeAllRanges();
      targetDoc.dispatchEvent(new targetDoc.defaultView.Event('selectionchange'));
      return result;
    })()`);
  } finally {
    await command('Network.emulateNetworkConditions', {
      offline: false,
      latency: 0,
      downloadThroughput: -1,
      uploadThroughput: -1,
    });
    await command('Emulation.setDeviceMetricsOverride', {
      width: 1280,
      height: 800,
      deviceScaleFactor: 1,
      mobile: false,
    });
  }
  assert.equal(narrowSelectionMenu.missingText, undefined, JSON.stringify(narrowSelectionMenu));
  assert.ok(narrowSelectionMenu.ttsPanelProbe.panelTop >= 0, JSON.stringify(narrowSelectionMenu));
  assert.ok(
    narrowSelectionMenu.ttsPanelProbe.panelBottom <= narrowSelectionMenu.ttsPanelProbe.viewportHeight,
    JSON.stringify(narrowSelectionMenu),
  );
  assert.ok(narrowSelectionMenu.ttsPanelProbe.scrollHeight > narrowSelectionMenu.ttsPanelProbe.clientHeight);
  assert.ok(narrowSelectionMenu.ttsPanelProbe.stopTop >= narrowSelectionMenu.ttsPanelProbe.panelTop);
  assert.ok(narrowSelectionMenu.ttsPanelProbe.stopBottom <= narrowSelectionMenu.ttsPanelProbe.panelBottom);
  assert.equal(narrowSelectionMenu.toolbarProbe.ttsText, '', JSON.stringify(narrowSelectionMenu));
  assert.ok(narrowSelectionMenu.toolbarProbe.ttsWidth >= 43 && narrowSelectionMenu.toolbarProbe.ttsWidth <= 45, JSON.stringify(narrowSelectionMenu));
  assert.deepEqual(narrowSelectionMenu.toolbarProbe.actionOrder, [
    '책갈피와 주석',
    '테마',
    '설정',
  ]);
  assert.deepEqual(narrowSelectionMenu.toolbarProbe.utilityOrder, [
    '현재 위치부터 듣기',
    '독서 통계',
    '도서 정보',
  ]);
  assert.ok(
    narrowSelectionMenu.toolbarProbe.menuWidth >= 274
      && narrowSelectionMenu.toolbarProbe.menuWidth <= 276,
    JSON.stringify(narrowSelectionMenu.toolbarProbe),
  );
  assert.ok(
    narrowSelectionMenu.toolbarProbe.menuRightInset >= 15
      && narrowSelectionMenu.toolbarProbe.menuRightInset <= 17,
    JSON.stringify(narrowSelectionMenu.toolbarProbe),
  );
  assert.ok(
    narrowSelectionMenu.toolbarProbe.statisticsWidth >= 43
      && narrowSelectionMenu.toolbarProbe.statisticsWidth <= 45,
    JSON.stringify(narrowSelectionMenu),
  );
  assert.ok(
    narrowSelectionMenu.toolbarProbe.actionHeight >= 46
      && narrowSelectionMenu.toolbarProbe.actionHeight <= 47,
    JSON.stringify(narrowSelectionMenu.toolbarProbe),
  );
  assert.equal(narrowSelectionMenu.toolbarProbe.actionFontWeight, '500');
  assert.ok(
    narrowSelectionMenu.toolbarProbe.ttsRight < narrowSelectionMenu.toolbarProbe.statisticsRight,
    JSON.stringify(narrowSelectionMenu),
  );
  assert.equal(narrowSelectionMenu.toolbarProbe.recordsWhiteSpace, 'nowrap');
  assert.ok(Math.abs(
    narrowSelectionMenu.toolbarProbe.recordsWidth / narrowSelectionMenu.toolbarProbe.themeWidth - 1.35
  ) < 0.03, JSON.stringify(narrowSelectionMenu.toolbarProbe));
  assert.ok(Math.abs(
    narrowSelectionMenu.toolbarProbe.themeWidth - narrowSelectionMenu.toolbarProbe.settingsWidth
  ) <= 1, JSON.stringify(narrowSelectionMenu.toolbarProbe));
  assert.ok(
    narrowSelectionMenu.toolbarProbe.recordsScrollWidth
      <= narrowSelectionMenu.toolbarProbe.recordsClientWidth,
    JSON.stringify(narrowSelectionMenu),
  );
  assert.ok(narrowSelectionMenu.menuRect, JSON.stringify(narrowSelectionMenu));
  assert.equal(narrowSelectionMenu.menuBorderRadius, '16px', JSON.stringify(narrowSelectionMenu));
  assert.ok(narrowSelectionMenu.menuRect.left >= 0, JSON.stringify(narrowSelectionMenu));
  assert.ok(
    narrowSelectionMenu.menuRect.right <= narrowSelectionMenu.innerWidth,
    JSON.stringify(narrowSelectionMenu),
  );
  assert.ok(narrowSelectionMenu.buttonRects.every(({ left, right }) => (
    left >= 0 && right <= narrowSelectionMenu.innerWidth
  )), JSON.stringify(narrowSelectionMenu));
  assert.match(narrowSelectionMenu.feedbackText, /오프라인/);
  const desktopToolbarProbe = await evaluate(`(() => {
    const actions = document.querySelector('[data-reader-toolbar-actions="true"]');
    const records = document.querySelector('button[aria-label="책갈피와 주석"]');
    const utilities = document.querySelector('[data-reader-toolbar-utilities="true"]');
    const titleRect = document.querySelector('[data-reader-title-surface="true"]')
      ?.getBoundingClientRect();
    const closeRect = document.querySelector('[data-reader-close-button="true"]')
      ?.getBoundingClientRect();
    const titleRightLimitRect = document.querySelector('[data-reader-title-right-limit="true"]')
      ?.getBoundingClientRect();
    const menuRect = document.querySelector('[data-reader-toolbar-menu="true"]')
      ?.getBoundingClientRect();
    return {
      menuWidth: actions?.parentElement?.offsetWidth ?? 0,
      menuRightInset: menuRect ? innerWidth - menuRect.right : -1,
      actionHeight: records?.offsetHeight ?? 0,
      utilityWidth: utilities?.firstElementChild?.offsetWidth ?? 0,
      topControlsCenterGap: titleRect && closeRect
        ? Math.abs(
          (titleRect.top + titleRect.height / 2)
          - (closeRect.top + closeRect.height / 2)
        )
        : -1,
      topCloseMenuRightGap: closeRect && menuRect
        ? Math.abs(closeRect.right - menuRect.right)
        : -1,
      titleRightLimitInset: titleRightLimitRect
        ? innerWidth - titleRightLimitRect.right
        : -1,
      titleBorderRadius: document.querySelector('[data-reader-title-surface="true"]')
        ? getComputedStyle(document.querySelector('[data-reader-title-surface="true"]')).borderRadius
        : '',
    };
  })()`);
  assert.ok(desktopToolbarProbe.menuWidth >= 302 && desktopToolbarProbe.menuWidth <= 303);
  assert.ok(
    desktopToolbarProbe.menuRightInset >= 165
      && desktopToolbarProbe.menuRightInset <= 167,
    JSON.stringify(desktopToolbarProbe),
  );
  assert.ok(desktopToolbarProbe.actionHeight >= 50 && desktopToolbarProbe.actionHeight <= 51);
  assert.ok(desktopToolbarProbe.utilityWidth >= 48 && desktopToolbarProbe.utilityWidth <= 49);
  assert.equal(desktopToolbarProbe.titleBorderRadius, '16px', JSON.stringify(desktopToolbarProbe));
  assert.ok(
    desktopToolbarProbe.topControlsCenterGap >= 0
      && desktopToolbarProbe.topControlsCenterGap <= 1,
    JSON.stringify(desktopToolbarProbe),
  );
  assert.ok(
    desktopToolbarProbe.topCloseMenuRightGap >= 0
      && desktopToolbarProbe.topCloseMenuRightGap <= 1,
    JSON.stringify(desktopToolbarProbe),
  );
  assert.ok(
    Math.abs(
      desktopToolbarProbe.titleRightLimitInset - desktopToolbarProbe.menuRightInset
    ) <= 1,
    JSON.stringify(desktopToolbarProbe),
  );
  assert.ok(Math.abs(
    desktopToolbarProbe.menuWidth / narrowSelectionMenu.toolbarProbe.menuWidth - 1.10
  ) < 0.01, JSON.stringify({ desktopToolbarProbe, narrowSelectionMenu }));
  assert.ok(Math.abs(
    desktopToolbarProbe.actionHeight / narrowSelectionMenu.toolbarProbe.actionHeight - 1.10
  ) < 0.02, JSON.stringify({ desktopToolbarProbe, narrowSelectionMenu }));
  assert.ok(Math.abs(
    desktopToolbarProbe.utilityWidth / narrowSelectionMenu.toolbarProbe.ttsWidth - 1.10
  ) < 0.02, JSON.stringify({ desktopToolbarProbe, narrowSelectionMenu }));
  await evaluate(`document.querySelector('button[aria-label="설정"]')?.click()`);
  await waitFor(
    'Boolean(document.querySelector(\'[data-modal-header="settings"]\'))',
    'reader settings modal header',
  );
  const settingsModalHeader = await evaluate(`(() => {
    const header = document.querySelector('[data-modal-header="settings"]');
    const navigation = document.querySelector('[data-reader-settings-navigation="true"]');
    const landscapeRow = document.querySelector(
      '[data-reader-settings-landscape-two-page="true"]',
    );
    const autoOpenRow = document.querySelector('[data-reader-settings-auto-open="true"]');
    const headerRect = header?.getBoundingClientRect();
    const navigationRect = navigation?.getBoundingClientRect();
    const landscapeRect = landscapeRow?.getBoundingClientRect();
    const autoOpenRect = autoOpenRow?.getBoundingClientRect();
    return {
      close: Boolean(header?.querySelector('[data-menu-sheet-close="true"]')),
      divider: header ? getComputedStyle(header).borderBottomWidth : '0px',
      navigationGap: headerRect && navigationRect
        ? navigationRect.top - headerRect.bottom
        : -1,
      toggleGap: landscapeRect && autoOpenRect
        ? autoOpenRect.top - landscapeRect.bottom
        : -1,
    };
  })()`);
  assert.equal(settingsModalHeader.close, true, JSON.stringify(settingsModalHeader));
  assert.equal(settingsModalHeader.divider, '1px', JSON.stringify(settingsModalHeader));
  assert.ok(
    settingsModalHeader.navigationGap >= 19 && settingsModalHeader.navigationGap <= 21,
    JSON.stringify(settingsModalHeader),
  );
  assert.ok(
    settingsModalHeader.toggleGap >= 11 && settingsModalHeader.toggleGap <= 13,
    JSON.stringify(settingsModalHeader),
  );
  await evaluate(`document.querySelector('button[aria-label="리더 설정 닫기"]')?.click()`);
  await waitFor(
    '!document.querySelector(\'[data-modal-header="settings"]\')',
    'reader settings modal close after header check',
  );
  await evaluate(`document.querySelector('button[aria-label="독서 통계"]')?.click()`);
  await waitFor(
    'Boolean(document.querySelector(\'[data-reading-statistics-modal="true"]\'))',
    'reader statistics modal',
  );
  assert.equal(await evaluate(`document.querySelector('[data-reading-statistics-modal="true"]')?.offsetParent !== null`), true);
  const statisticsBlockedPosition = await evaluate(`(() => {
    const view = document.querySelector('foliate-view');
    return {
      start: view?.renderer?.start ?? null,
      scrollTop: view?.renderer?.scrollTop ?? null,
      scrollLeft: view?.renderer?.scrollLeft ?? null,
    };
  })()`);
  await evaluate(`(() => {
    for (const key of ['ArrowDown', ' ']) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true, cancelable: true }));
    }
  })()`);
  await new Promise((resolve) => setTimeout(resolve, 120));
  assert.deepEqual(await evaluate(`(() => {
    const view = document.querySelector('foliate-view');
    return {
      start: view?.renderer?.start ?? null,
      scrollTop: view?.renderer?.scrollTop ?? null,
      scrollLeft: view?.renderer?.scrollLeft ?? null,
    };
  })()`), statisticsBlockedPosition, 'reader position must not change behind the statistics modal');
  assert.deepEqual(await evaluate(`(() => {
    const header = document.querySelector('[data-modal-header="statistics"]');
    return {
      close: Boolean(header?.querySelector('[data-menu-sheet-close="true"]')),
      divider: header ? getComputedStyle(header).borderBottomWidth : '0px',
    };
  })()`), { close: true, divider: '1px' });
  await evaluate(`document.querySelector('button[aria-label="독서 통계 닫기"]')?.click()`);
  await waitFor(
    '!document.querySelector(\'[data-reading-statistics-modal="true"]\')',
    'reader statistics modal close',
  );
  await evaluate(`document.querySelector('button[aria-label="도서 정보"]')?.click()`);
  await waitFor(
    'Boolean(document.querySelector(\'[data-book-info-modal="true"]\'))',
    'reader book information modal',
  );
  const readerBookInfo = await evaluate(`(() => {
    const modal = document.querySelector('[data-book-info-modal="true"]');
    return {
      hasReadButton: [...(modal?.querySelectorAll('button') ?? [])]
        .some((button) => button.textContent?.trim() === '읽기'),
      hasDeleteButton: Boolean(modal?.querySelector('[data-book-info-request-delete="true"]')),
      hasCopyImageButton: Boolean(modal?.querySelector('[data-book-info-copy-image="true"]')),
      hasCaptureButton: Boolean(modal?.querySelector('[data-book-info-capture="true"]')),
    };
  })()`);
  assert.deepEqual(readerBookInfo, {
    hasReadButton: false,
    hasDeleteButton: false,
    hasCopyImageButton: true,
    hasCaptureButton: true,
  });
  await evaluate(`document.querySelector('[data-book-info-modal="true"] button[aria-label="도서 정보 닫기"]')?.click()`);
  await waitFor(
    '!document.querySelector(\'[data-book-info-modal="true"]\')',
    'reader book information modal close',
  );
  assert.notEqual(narrowSelectionMenu.feedbackWhiteSpace, 'nowrap');
  assert.ok(
    narrowSelectionMenu.feedbackWidth <= narrowSelectionMenu.menuRect.width,
    JSON.stringify(narrowSelectionMenu),
  );
  await evaluate(`(() => {
    delete navigator.clipboard;
    delete navigator.share;
    window.open = window.__nativeLanguageToolOpen;
    delete globalThis.Translator;
    document.querySelector('button[aria-label="Close reader"]')?.click();
  })()`);
  await waitFor(
    `document.querySelector("[data-shelf-library-label]")?.textContent?.trim() === "Guest Library"`,
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
    const saved = records.find((record) => record.bookId === localStorage.getItem('__browserRegressionSelectionBookId'));
    return {
      overlayVisible: Boolean(hasOverlay),
      savedCount: records.filter((record) => record.bookId === localStorage.getItem('__browserRegressionSelectionBookId')).length,
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
  const remoteOverlayDelete = await evaluate(`(async () => {
    const request = indexedDB.open('web-reader-db');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const read = db.transaction('annotations-v8', 'readonly')
      .objectStore('annotations-v8').getAll();
    const records = await new Promise((resolve, reject) => {
      read.onsuccess = () => resolve(read.result);
      read.onerror = () => reject(read.error);
    });
    const saved = records.find((record) => record.bookId === localStorage.getItem('__browserRegressionSelectionBookId'));
    const tx = db.transaction('annotations-v8', 'readwrite');
    tx.objectStore('annotations-v8').delete([saved.ownerKey, saved.bookId, saved.id]);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    window.__remoteAnnotationFixture = saved;
    window.dispatchEvent(new CustomEvent('twreader:annotation-sync-change', {
      detail: { ownerKey: saved.ownerKey, bookId: saved.bookId },
    }));
    return Boolean(saved);
  })()`);
  assert.equal(remoteOverlayDelete, true);
  await waitFor(
    `(() => {
      const view = document.querySelector('foliate-view');
      return !view?.renderer?.getContents?.().some(({ overlayer }) => (
        overlayer?.element?.querySelector('[data-reader-highlight="true"]')
      ));
    })()`,
    'remote annotation tombstone removes the live overlay',
  );
  await evaluate(`(async () => {
    const saved = window.__remoteAnnotationFixture;
    const request = indexedDB.open('web-reader-db');
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const tx = db.transaction('annotations-v8', 'readwrite');
    tx.objectStore('annotations-v8').put(saved);
    await new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    window.dispatchEvent(new CustomEvent('twreader:annotation-sync-change', {
      detail: { ownerKey: saved.ownerKey, bookId: saved.bookId },
    }));
  })()`);
  await waitFor(
    `(() => {
      const view = document.querySelector('foliate-view');
      return Boolean(view?.renderer?.getContents?.().some(({ overlayer }) => (
        overlayer?.element?.querySelector('[data-reader-highlight="true"]')
      )));
    })()`,
    'remote annotation upsert restores the live overlay',
  );
  const annotationEntry = await evaluate(`(() => {
    const separateAnnotationButton = document.querySelector('button[aria-label="하이라이트와 메모"]');
    const recordsButton = document.querySelector('button[aria-label="책갈피와 주석"]');
    recordsButton?.click();
    return {
      separateAnnotationButton: Boolean(separateAnnotationButton),
      recordsButtonTitle: recordsButton?.getAttribute('title') ?? '',
      annotationIndicator: Boolean(recordsButton?.querySelector('[data-reader-annotation-indicator="true"]')),
      recordCounts: document.querySelector('#reader-record-counts')?.textContent ?? '',
    };
  })()`);
  assert.equal(annotationEntry.separateAnnotationButton, false, JSON.stringify(annotationEntry));
  assert.match(annotationEntry.recordsButtonTitle, /주석 1개/);
  assert.equal(annotationEntry.annotationIndicator, true, JSON.stringify(annotationEntry));
  assert.match(annotationEntry.recordCounts, /책갈피 \d+개, 주석 1개/);
  await waitFor(
    `Boolean(document.querySelector('[data-reader-bookmark-panel="true"]'))`,
    'combined records modal after reader reopen',
  );
  const bookmarkDirtyProbe = await evaluate(`(async () => {
    window.__readerProgressRegressionTrace = [];
    const panel = document.querySelector('[data-reader-bookmark-panel="true"]');
    const addButton = [...(panel?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent?.includes('현재 위치 추가하기'));
    const addDisabled = Boolean(addButton?.disabled);
    addButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const addEvents = (window.__readerProgressRegressionTrace ?? []).map(({ event }) => event);
    window.__readerProgressRegressionTrace = [];
    const deleteButton = panel?.querySelector('button[aria-label="책갈피 삭제"]');
    deleteButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const deleteEvents = (window.__readerProgressRegressionTrace ?? []).map(({ event }) => event);
    return {
      addDisabled,
      addEvents,
      deleteButtonFound: Boolean(deleteButton),
      deleteEvents,
    };
  })()`);
  assert.equal(bookmarkDirtyProbe.addDisabled, false, JSON.stringify(bookmarkDirtyProbe));
  assert.equal(bookmarkDirtyProbe.deleteButtonFound, true, JSON.stringify(bookmarkDirtyProbe));
  assert.ok(bookmarkDirtyProbe.addEvents.includes('user-interaction'), JSON.stringify(bookmarkDirtyProbe));
  assert.equal(bookmarkDirtyProbe.addEvents.includes('user-change'), false, JSON.stringify(bookmarkDirtyProbe));
  assert.ok(bookmarkDirtyProbe.deleteEvents.includes('user-interaction'), JSON.stringify(bookmarkDirtyProbe));
  assert.equal(bookmarkDirtyProbe.deleteEvents.includes('user-change'), false, JSON.stringify(bookmarkDirtyProbe));
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
    const search = document.querySelector('[data-reader-annotation-search="true"]');
    const inputSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    inputSetter?.call(search, 'probe paragraph');
    search?.dispatchEvent(new Event('input', { bubbles: true }));
    await window.__regressionNextFrame();
    const initialSearchItemCount = document.querySelectorAll('[data-reader-annotation-item]').length;
    const initialSearchExpanded = greenGroup?.getAttribute('aria-expanded') === 'true';
    inputSetter?.call(search, '');
    search?.dispatchEvent(new Event('input', { bubbles: true }));
    await window.__regressionNextFrame();
    const collapsedStateRestoredAfterSearch = greenGroup?.getAttribute('aria-expanded') === 'false';
    greenGroup?.click();
    await window.__regressionNextFrame();
    const expandedItemCount = document.querySelectorAll('[data-reader-annotation-item]').length;
    document.querySelector('[data-reader-annotation-item] button[aria-label="메모 편집"]')?.click();
    const noteDeadline = performance.now() + 2000;
    while (!document.querySelector('[data-reader-annotation-note-dialog="true"]')
      && performance.now() < noteDeadline) {
      await window.__regressionNextFrame();
    }
    history.back();
    const backDeadline = performance.now() + 2000;
    while (document.querySelector('[data-reader-annotation-note-dialog="true"]')
      && performance.now() < backDeadline) {
      await window.__regressionNextFrame();
    }
    const managerStayedOpenAfterBack = Boolean(
      document.querySelector('[data-reader-annotation-modal="true"]'),
    );
    document.querySelector('[data-reader-annotation-item] button[aria-label="메모 편집"]')?.click();
    const reopenDeadline = performance.now() + 2000;
    while (!document.querySelector('[data-reader-annotation-note-dialog="true"]')
      && performance.now() < reopenDeadline) {
      await window.__regressionNextFrame();
    }
    const textarea = document.querySelector('[data-reader-annotation-note-dialog="true"] textarea');
    const noteDraft = \`회귀 메모 \${Date.now()}\`;
    const valueSetter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      'value',
    )?.set;
    valueSetter?.call(textarea, noteDraft);
    textarea?.dispatchEvent(new Event('input', { bubbles: true }));
    await window.__regressionNextFrame();
    document.querySelector('[data-reader-annotation-note-dialog="true"]')?.requestSubmit();
    const saveDeadline = performance.now() + 3000;
    while (document.querySelector('[data-reader-annotation-note-dialog="true"]')
      && performance.now() < saveDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const feedbackDeadline = performance.now() + 2000;
    while (!document.querySelector('[data-reader-annotation-modal-feedback="true"]')
      && performance.now() < feedbackDeadline) {
      await window.__regressionNextFrame();
    }
    const modalFeedback = document.querySelector(
      '[data-reader-annotation-modal-feedback="true"]',
    )?.textContent ?? '';

    greenGroup?.click();
    await window.__regressionNextFrame();
    const noteFilter = document.querySelector('[data-reader-annotation-note-filter="true"]');
    noteFilter?.click();
    await window.__regressionNextFrame();
    const noteFilterItemCount = document.querySelectorAll('[data-reader-annotation-item]').length;
    const noteFilterExpanded = greenGroup?.getAttribute('aria-expanded') === 'true';
    noteFilter?.click();
    await window.__regressionNextFrame();
    const noteFilterCollapsedStateRestored = greenGroup?.getAttribute('aria-expanded') === 'false';
    greenGroup?.click();
    await window.__regressionNextFrame();

    inputSetter?.call(search, '회귀 메모');
    search?.dispatchEvent(new Event('input', { bubbles: true }));
    await window.__regressionNextFrame();
    const searchedItemCount = document.querySelectorAll('[data-reader-annotation-item]').length;
    inputSetter?.call(search, '');
    search?.dispatchEvent(new Event('input', { bubbles: true }));
    await window.__regressionNextFrame();
    const manualExpandedItemCount = document.querySelectorAll('[data-reader-annotation-item]').length;
    greenGroup?.click();
    await window.__regressionNextFrame();
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
      initialSearchItemCount,
      initialSearchExpanded,
      collapsedStateRestoredAfterSearch,
      expandedItemCount,
      noteFilterItemCount,
      noteFilterExpanded,
      noteFilterCollapsedStateRestored,
      searchedItemCount,
      manualExpandedItemCount,
      collapsedItemCount,
      note: records.find((record) => record.bookId === localStorage.getItem('__browserRegressionSelectionBookId'))?.note ?? null,
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
  assert.equal(annotationManager.initialSearchItemCount, 1, JSON.stringify(annotationManager));
  assert.equal(annotationManager.initialSearchExpanded, true, JSON.stringify(annotationManager));
  assert.equal(annotationManager.collapsedStateRestoredAfterSearch, true, JSON.stringify(annotationManager));
  assert.equal(annotationManager.expandedItemCount, 1, JSON.stringify(annotationManager));
  assert.equal(annotationManager.noteFilterItemCount, 1, JSON.stringify(annotationManager));
  assert.equal(annotationManager.noteFilterExpanded, true, JSON.stringify(annotationManager));
  assert.equal(annotationManager.noteFilterCollapsedStateRestored, true, JSON.stringify(annotationManager));
  assert.equal(annotationManager.searchedItemCount, 1, JSON.stringify(annotationManager));
  assert.equal(annotationManager.manualExpandedItemCount, 1, JSON.stringify(annotationManager));
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
  await evaluate(`document.querySelector('button[aria-label="책갈피와 주석"]')?.click()`);
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
    `document.querySelector("[data-shelf-library-label]")?.textContent?.trim() === "Guest Library"`,
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
    const annotation = records.find((record) => record.bookId === localStorage.getItem('__browserRegressionSelectionBookId'));
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
        && records.find((record) => record.bookId === localStorage.getItem('__browserRegressionSelectionBookId'))?.sectionIndex === 0;
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
    const saved = records.find((record) => record.bookId === localStorage.getItem('__browserRegressionSelectionBookId'));
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
    `document.querySelector("[data-shelf-library-label]")?.textContent?.trim() === "Guest Library"`,
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
    const annotation = records.find((record) => record.bookId === localStorage.getItem('__browserRegressionSelectionBookId'));
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
        record.bookId === localStorage.getItem('__browserRegressionSelectionBookId') && record.id !== 'invalid-cfi-probe'
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
      record.bookId === localStorage.getItem('__browserRegressionSelectionBookId') && record.id !== 'invalid-cfi-probe'
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
    `document.querySelector("[data-shelf-library-label]")?.textContent?.trim() === "Guest Library"`,
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
      record.bookId === localStorage.getItem('__browserRegressionSelectionBookId') && record.id !== 'invalid-cfi-probe'
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
      return records.find((record) => record.bookId === localStorage.getItem('__browserRegressionSelectionBookId'))
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
      await window.__regressionNextFrame();
    }
    document.querySelector(
      '[data-reader-selection-menu="true"] button[aria-label="초록 하이라이트 추가"]',
    )?.click();
    const overlayDeadline = performance.now() + 3000;
    const hasOverlay = () => renderer.getContents().some(({ overlayer }) => (
      overlayer?.element?.querySelector('[data-reader-highlight="true"]')
    ));
    while (!hasOverlay() && performance.now() < overlayDeadline) {
      await window.__regressionNextFrame();
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
    const saved = records.find((record) => record.bookId === localStorage.getItem('__browserRegressionSelectionBookId'));
    return {
      overlayVisible: Boolean(hasOverlay()),
      savedCount: records.filter((record) => record.bookId === localStorage.getItem('__browserRegressionSelectionBookId')).length,
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
    `document.querySelector("[data-shelf-library-label]")?.textContent?.trim() === "Guest Library"`,
    'shelf after unresolved highlight check',
  );
  await evaluate(`(() => {
    window.__libraryAnnotationExport = {
      blobs: [],
      downloads: [],
      shares: [],
      nativeCreateObjectURL: URL.createObjectURL.bind(URL),
      nativeRevokeObjectURL: URL.revokeObjectURL.bind(URL),
      nativeAnchorClick: HTMLAnchorElement.prototype.click,
    };
    URL.createObjectURL = (blob) => {
      window.__libraryAnnotationExport.blobs.push(blob);
      return 'blob:library-annotation-' + window.__libraryAnnotationExport.blobs.length;
    };
    URL.revokeObjectURL = () => undefined;
    HTMLAnchorElement.prototype.click = function annotationExportClick() {
      window.__libraryAnnotationExport.downloads.push({
        download: this.download,
        href: this.href,
      });
    };
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: ({ files }) => Array.isArray(files) && files.length === 1,
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async ({ files, title }) => {
        window.__libraryAnnotationExport.shares.push({
          title,
          name: files[0].name,
          text: await files[0].text(),
        });
      },
    });
    document.querySelector('button[aria-label="라이브러리 전체 주석"]')?.click();
  })()`);
  await waitFor(
    'Boolean(document.querySelector(\'[data-library-annotation-modal="true"]\'))',
    'library annotation modal',
  );
  await command('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 640,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await evaluate('window.__regressionNextFrame(2)');
  const libraryAnnotationUi = await evaluate(`(() => {
    const modal = document.querySelector('[data-library-annotation-modal="true"]');
    const body = modal?.querySelector('[data-library-annotation-body="true"]');
    const closeButton = modal?.querySelector('button[aria-label="라이브러리 주석 닫기"]');
    const rect = modal?.getBoundingClientRect();
    const closeRect = closeButton?.getBoundingClientRect();
    return {
      modalWidth: rect?.width ?? 0,
      modalHeight: rect?.height ?? 0,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      bodyHorizontalOverflow: body ? Math.max(0, body.scrollWidth - body.clientWidth) : -1,
      closeWidth: closeRect?.width ?? 0,
      closeHeight: closeRect?.height ?? 0,
      headerClose: Boolean(modal?.querySelector('[data-menu-sheet-close="true"]')),
      headerDivider: modal?.querySelector('[data-modal-header="annotations"]')
        ? getComputedStyle(modal.querySelector('[data-modal-header="annotations"]')).borderBottomWidth
        : '0px',
    };
  })()`);
  assert.ok(
    libraryAnnotationUi.modalWidth <= libraryAnnotationUi.viewportWidth * 0.92,
    JSON.stringify(libraryAnnotationUi),
  );
  assert.ok(
    libraryAnnotationUi.modalHeight <= libraryAnnotationUi.viewportHeight * 0.89,
    JSON.stringify(libraryAnnotationUi),
  );
  assert.equal(libraryAnnotationUi.headerClose, true, JSON.stringify(libraryAnnotationUi));
  assert.notEqual(libraryAnnotationUi.headerDivider, '0px', JSON.stringify(libraryAnnotationUi));
  assert.equal(libraryAnnotationUi.horizontalOverflow, 0, JSON.stringify(libraryAnnotationUi));
  assert.equal(libraryAnnotationUi.bodyHorizontalOverflow, 0, JSON.stringify(libraryAnnotationUi));
  assert.ok(
    libraryAnnotationUi.closeWidth >= 44 && libraryAnnotationUi.closeHeight >= 44,
    JSON.stringify(libraryAnnotationUi),
  );
  const libraryAnnotationBackdropClose = await evaluate(`(async () => {
    document.querySelector('[data-library-annotation-modal="true"]')?.click();
    await window.__regressionNextFrame(2);
    const stayedOpenAfterInnerClick = Boolean(
      document.querySelector('[data-library-annotation-modal="true"]'),
    );
    document.querySelector('[data-library-annotation-backdrop="true"]')?.click();
    return { stayedOpenAfterInnerClick };
  })()`);
  assert.equal(
    libraryAnnotationBackdropClose.stayedOpenAfterInnerClick,
    true,
    JSON.stringify(libraryAnnotationBackdropClose),
  );
  await waitFor(
    '!document.querySelector(\'[data-library-annotation-modal="true"]\')',
    'library annotation backdrop close',
  );
  await evaluate(`document.querySelector('button[aria-label="라이브러리 전체 주석"]')?.click()`);
  await waitFor(
    'Boolean(document.querySelector(\'[data-library-annotation-modal="true"]\'))',
    'library annotation modal reopen after backdrop close',
  );
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await evaluate('window.__regressionNextFrame(2)');
  await evaluate(`(() => {
    const input = document.querySelector('[data-library-annotation-search="true"]');
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value',
    ).set;
    setter.call(input, 'probe paragraph');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`);
  await waitFor(
    'document.querySelectorAll("[data-library-annotation-item]").length === 1',
    'library annotation search result',
  );
  await evaluate(`(() => {
    const select = document.querySelector('[data-library-annotation-export-format="true"]');
    select.value = 'json-library';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await evaluate(`window.__regressionNextFrame(2)`);
  await evaluate(`document.querySelector('[data-library-annotation-download="true"]')?.click()`);
  await waitFor(
    'window.__libraryAnnotationExport.downloads.length === 1',
    'library annotation JSON download',
  );
  const libraryAnnotationJson = await evaluate(`(async () => {
    const state = window.__libraryAnnotationExport;
    const text = await state.blobs[0].text();
    const parsed = JSON.parse(text);
    return {
      filename: state.downloads[0].download,
      format: parsed.format,
      version: parsed.version,
      count: parsed.annotations.length,
      quote: parsed.annotations[0]?.quote ?? null,
    };
  })()`);
  assert.equal(libraryAnnotationJson.filename, 'library-annotations.json');
  assert.equal(libraryAnnotationJson.format, 'web-reader-annotations');
  assert.equal(libraryAnnotationJson.version, 1);
  assert.equal(libraryAnnotationJson.count, 1);
  assert.equal(libraryAnnotationJson.quote, selectionActions.selectedText);
  await evaluate(`(() => {
    const select = document.querySelector('[data-library-annotation-export-format="true"]');
    select.value = 'markdown-library';
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await evaluate(`window.__regressionNextFrame(2)`);
  await evaluate(`document.querySelector('[data-library-annotation-share="true"]')?.click()`);
  await waitFor(
    'window.__libraryAnnotationExport.shares.length === 1',
    'library annotation Markdown share',
  );
  const libraryAnnotationShare = await evaluate(`window.__libraryAnnotationExport.shares[0]`);
  assert.equal(libraryAnnotationShare.name, 'library-annotations.md');
  assert.ok(libraryAnnotationShare.text.includes(selectionActions.selectedText));
  await waitFor(
    '!document.querySelector(\'[data-library-annotation-share="true"]\').disabled',
    'library annotation share completion',
  );
  await evaluate(`(() => {
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: async () => {
        throw new DOMException('unsupported file share', 'NotSupportedError');
      },
    });
    document.querySelector('[data-library-annotation-share="true"]')?.click();
  })()`);
  await waitFor(
    'window.__libraryAnnotationExport.downloads.length === 2',
    'library annotation runtime share rejection fallback',
  );
  await waitFor(
    '!document.querySelector(\'[data-library-annotation-share="true"]\').disabled',
    'library annotation runtime fallback completion',
  );
  await evaluate(`(() => {
    Object.defineProperty(navigator, 'canShare', {
      configurable: true,
      value: undefined,
    });
    Object.defineProperty(navigator, 'share', {
      configurable: true,
      value: undefined,
    });
    document.querySelector('[data-library-annotation-share="true"]')?.click();
  })()`);
  await waitFor(
    'window.__libraryAnnotationExport.downloads.length === 3',
    'library annotation share download fallback',
  );
  const libraryAnnotationFallback = await evaluate(`(() => ({
    filename: window.__libraryAnnotationExport.downloads[2].download,
    feedback: document.querySelector('[data-library-annotation-modal="true"] [role="status"]')
      ?.textContent ?? '',
  }))()`);
  assert.equal(libraryAnnotationFallback.filename, 'library-annotations.md');
  assert.match(libraryAnnotationFallback.feedback, /다운로드로 저장/);
  await evaluate(`(() => {
    const state = window.__libraryAnnotationExport;
    URL.createObjectURL = state.nativeCreateObjectURL;
    URL.revokeObjectURL = state.nativeRevokeObjectURL;
    HTMLAnchorElement.prototype.click = state.nativeAnchorClick;
    delete navigator.canShare;
    delete navigator.share;
  })()`);
  await evaluate(`document.querySelector('[data-library-annotation-item] button')?.click()`);
  await waitFor(
    'Boolean(document.querySelector("foliate-view"))',
    'reader from library annotation result',
  );
  await waitFor(
    `(() => {
      const view = document.querySelector('foliate-view');
      return Boolean(view?.renderer?.getContents?.().some(({ overlayer }) => (
        overlayer?.element?.querySelector('[data-reader-highlight="true"]')
      )));
    })()`,
    'library annotation jump target overlay',
    60_000,
  );
  await evaluate(`document.querySelector('button[aria-label="Close reader"]')?.click()`);
  await waitFor(
    'Boolean(document.querySelector(\'[data-library-annotation-modal="true"]\'))',
    'library annotation modal restored after reader',
  );
  await waitFor(
    'document.querySelectorAll(\'[data-library-annotation-item]\').length === 1',
    'library annotation result restored after reader',
  );
  const libraryAnnotationRestore = await evaluate(`(() => ({
    query: document.querySelector('[data-library-annotation-search="true"]')?.value,
    resultCount: document.querySelectorAll('[data-library-annotation-item]').length,
  }))()`);
  assert.equal(libraryAnnotationRestore.query, 'probe paragraph');
  assert.equal(libraryAnnotationRestore.resultCount, 1);
  await evaluate(`document.querySelector('button[aria-label="라이브러리 주석 닫기"]')?.click()`);
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
      const getAll = tx.objectStore('metadata-v5').getAll();
      const values = await new Promise((resolve, reject) => {
        getAll.onsuccess = () => resolve(getAll.result);
        getAll.onerror = () => reject(getAll.error);
      });
      db.close();
      const value = values.find((candidate) => (
        candidate.ownerKey === ownerKey && candidate.name === 'solid-pages.7z'
      ));
      if (value) localStorage.setItem('__browserRegressionSolidBookId', value.id);
      return Boolean(value);
    })()`,
    'solid 7z import',
  );
  await evaluate(`(() => {
    localStorage.setItem('last_reader_session', JSON.stringify({
      version: 2,
      bookId: localStorage.getItem('__browserRegressionSolidBookId'),
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
  assert.equal(
    autoOpenSession.storedSession,
    await evaluate(`localStorage.getItem('__browserRegressionSolidBookId')`),
  );
  await evaluate(`document.querySelector('button[aria-label="Close reader"]')?.click()`);
  await waitFor(
    'document.querySelector("[data-shelf-library-label]")?.textContent?.trim() === "Guest Library"',
    'shelf after auto-open close',
  );
  await waitFor(
    `localStorage.getItem('last_reader_session') === null`,
    'last reader intent cleared after reader close',
  );
  await command('Page.reload', { ignoreCache: true });
  await waitFor(
    `document.querySelector("[data-shelf-library-label]")?.textContent?.trim() === "Guest Library"
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
    'Boolean(document.querySelector(\'[data-shelf-search-input="true"]\'))',
    'solid 7z search modal',
  );
  assert.equal(
    await setInputValue(
      '[data-shelf-search-input="true"]',
      'solid-pages',
    ),
    true,
  );
  await evaluate('document.querySelector(\'[data-shelf-search-input="true"]\')?.form?.requestSubmit()');
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
    await window.__regressionNextFrame();
    const storedDisabled = JSON.parse(localStorage.getItem('viewer_settings') || '{}');
    autoOpenCheckbox?.click();
    await window.__regressionNextFrame();
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
    await window.__regressionNextFrame();
    topIncrease?.click();
    await window.__regressionNextFrame();
    leftDecrease?.click();
    await window.__regressionNextFrame();
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
    await window.__regressionNextFrame();
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
      await window.__regressionNextFrame();
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
    await window.__regressionNextFrame();
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
    await window.__regressionNextFrame();
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
    await window.__regressionNextFrame();
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
    await window.__regressionNextFrame();

    const darkTheme = document.querySelector('[data-theme-option="dark"]');
    darkTheme?.click();
    await window.__regressionNextFrame();

    const globalAccentPicker = document.querySelector('button[title="emerald"]');
    await new Promise((resolve, reject) => {
      const deadline = performance.now() + 3000;
      const waitForPaint = () => {
        const readerRoot = document.querySelector('foliate-view')?.closest('.h-screen.w-screen');
        const rootStyle = getComputedStyle(document.documentElement);
        const readerRootStyle = readerRoot ? getComputedStyle(readerRoot) : null;
        const hasThemePaint = rootStyle.getPropertyValue('--accent-500').trim() === '#d4af37'
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
      globalAccentAvailable: Boolean(globalAccentPicker),
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
  assert.equal(themeSettings.globalAccentAvailable, false);
  assert.equal(themeSettings.storedTheme, 'dark');
  assert.equal(themeSettings.storedAccent, 'emerald');
  assert.equal(themeSettings.rootAccent, '#d4af37');
  assert.equal(themeSettings.rootReaderSurface, 'rgba(39, 39, 40, 0.68)');
  assert.equal(themeSettings.bodyBackground, 'rgb(39, 39, 40)');
  assert.equal(themeSettings.readerRootBackground, 'rgb(39, 39, 40)');
  assert.equal(themeSettings.themeModalBackground, 'rgb(39, 39, 40)');
  assert.equal(themeSettings.toolbarSurface, 'rgba(39, 39, 40, 0.68)');

  await evaluate(`(async () => {
    document.querySelector('[data-reader-controls-overlay="true"]')?.click();
    await window.__regressionNextFrame();
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
    await window.__regressionNextFrame();
    const controlsAtTwentyNinePointFive = controlsAreOpen();

    document.querySelector('div.fixed.inset-0.z-40.touch-none')?.click();
    await window.__regressionNextFrame();
    dispatchTap(0.28);
    await window.__regressionNextFrame();
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
    await window.__regressionNextFrame();
    renderer.resetUserScale();
    await window.__regressionNextFrame();

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
    await window.__regressionNextFrame();
    await window.__regressionNextFrame();
    dispatchPointer('pointerup', clientY - 110, 0);
    await window.__regressionNextFrame();

    const scaleAfterDrag = renderer.userScale;
    const indexBeforeSuppressedClick = renderer.index;
    overlay.dispatchEvent(new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      clientX: Math.round(innerWidth * 0.9),
      clientY,
      ...modifier,
    }));
    await window.__regressionNextFrame();
    const indexAfterSuppressedClick = renderer.index;

    renderer.resetUserScale();
    await window.__regressionNextFrame();
    dispatchPointer('pointerdown', clientY, 1);
    dispatchPointer('pointermove', clientY - 90, 1);
    await window.__regressionNextFrame();
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
    await window.__regressionNextFrame();
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
    'document.querySelector("[data-shelf-library-label]")?.textContent?.trim() === "Guest Library"',
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
  assert.equal(shelfThemeAfterReaderClose.rootAccent, '#d4af37');
  assert.equal(shelfThemeAfterReaderClose.rootThemeBg, '#272728');
  assert.equal(shelfThemeAfterReaderClose.shelfBackground, 'rgb(39, 39, 40)');
  assert.equal(shelfThemeAfterReaderClose.shelfColor, 'rgb(184, 184, 184)');

  const readingSessionCount = await waitFor(`new Promise((resolve) => {
    const request = indexedDB.open('web-reader-db');
    request.onerror = () => resolve(0);
    request.onsuccess = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('reading-sessions-v11')) {
        db.close();
        resolve(0);
        return;
      }
      const count = db.transaction('reading-sessions-v11')
        .objectStore('reading-sessions-v11').count();
      count.onsuccess = () => {
        db.close();
        resolve(count.result);
      };
      count.onerror = () => {
        db.close();
        resolve(0);
      };
    };
  })`, 'persisted reading statistics session');
  assert.ok(readingSessionCount >= 1);
  await evaluate(`new Promise((resolve, reject) => {
    const request = indexedDB.open('web-reader-db');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const ownerKey = 'guest:browser-regression|library:local';
      const bookId = localStorage.getItem('__browserRegressionSelectionBookId');
      const transaction = db.transaction('reading-sessions-v11', 'readwrite');
      const store = transaction.objectStore('reading-sessions-v11');
      const existingKeys = store.index('by-owner-book').getAllKeys([ownerKey, bookId]);
      existingKeys.onerror = () => reject(existingKeys.error);
      existingKeys.onsuccess = () => {
        // The real reader session was already asserted above. Remove it before
        // the round fixture so the round-order contract never depends on the
        // wall clock or on whether this regression happens to cross midnight.
        for (const key of existingKeys.result) store.delete(key);

        const now = new Date();
        const base = new Date(
          now.getFullYear(),
          now.getMonth(),
          now.getDate(),
          0,
          10,
          0,
          0,
        ).getTime();
        const put = (
          sessionId,
          startOffset,
          startProgress,
          endProgress,
          completed,
          completionConfirmedAtClient,
        ) => {
          const startedAtClient = base + startOffset;
          const timezoneOffsetMinutes = new Date(startedAtClient).getTimezoneOffset();
          return store.put({
            schemaVersion: 1,
            ownerKey,
            sessionId,
            bookId,
            bookTitle: 'selection-probe.epub',
            deviceId: 'round-fixture',
            mode: 'screen',
            startedAtClient,
            endedAtClient: startedAtClient + 60_000,
            durationMs: 60_000,
            startProgressPercent: startProgress,
            endProgressPercent: endProgress,
            timezoneOffsetMinutes,
            localDate: new Date(
              startedAtClient - timezoneOffsetMinutes * 60_000,
            ).toISOString().slice(0, 10),
            completed,
            ...(completionConfirmedAtClient === undefined
              ? {}
              : { completionConfirmedAtClient }),
            clockOffsetMs: 0,
            clockUncertaintyMs: 25,
            clockMeasuredAtClient: startedAtClient,
            syncState: 'synced',
            retryCount: 0,
            nextAttemptAt: 0,
            lastErrorCode: null,
          });
        };
        put('round-fixture-first-start', 0, 0, 50, false);
        put('round-fixture-first-finish', 61_000, 50, 100, true, base + 121_000);
        put('round-fixture-second-start', 122_000, 0, 99, false);
      };
      transaction.oncomplete = () => { db.close(); resolve(true); };
      transaction.onerror = () => reject(transaction.error);
    };
  })`);
  await command('Emulation.setDeviceMetricsOverride', {
    width: 320,
    height: 640,
    deviceScaleFactor: 1,
    mobile: true,
  });
  await evaluate(`document.querySelector('button[aria-label="독서 통계"]')?.click()`);
  await waitFor(
    'Boolean(document.querySelector(\'[data-reading-statistics-modal="true"]\'))',
    'reading statistics modal',
  );
  const readingStatisticsUi = await evaluate(`(() => {
    const modal = document.querySelector('[data-reading-statistics-modal="true"]');
    const body = modal?.querySelector('[data-reading-statistics-body="true"]');
    const rect = modal?.getBoundingClientRect();
    const markdownButton = modal?.querySelector('[data-reading-statistics-export="markdown"]');
    const shareButton = modal?.querySelector('[data-reading-statistics-share="true"]');
    const modalTextColor = modal ? getComputedStyle(modal).color : '';
    const headlineValueColors = [...(modal?.querySelectorAll('[data-reading-statistics-headline]') ?? [])]
      .map((headline) => getComputedStyle(headline.lastElementChild).color);
    const modeValueColors = [...(modal?.querySelectorAll('[data-reading-statistics-mode-total]') ?? [])]
      .map((value) => getComputedStyle(value).color);
    const unexpectedAccentElements = [...(modal?.querySelectorAll('[class*="accent-"]') ?? [])]
      .filter((element) => !(
        element.closest('[data-reading-statistics-refresh="true"]')
        || element.matches('[data-reading-statistics-range][aria-pressed="true"]')
        || element.matches('[data-reading-statistics-book-filter="true"] button[aria-pressed="true"]')
        || element.matches('[data-reading-statistics-book-duration="true"]')
      ));
    const buttons = [...modal.querySelectorAll('button')].map((button) => {
      const buttonRect = button.getBoundingClientRect();
      return {
        label: button.getAttribute('aria-label') || button.textContent?.trim() || '',
        width: buttonRect.width,
        height: buttonRect.height,
        range: button.getAttribute('data-reading-statistics-range'),
        compact: Boolean(
          button.closest('[data-reading-statistics-book-filter="true"]')
          || button.hasAttribute('data-reading-statistics-complete')
          || button.hasAttribute('data-reading-statistics-confirm-complete')
        ),
      };
    });
    return {
      text: modal?.textContent ?? '',
      bookCount: modal?.querySelectorAll('[data-reading-statistics-book="true"]').length ?? 0,
      modalWidth: rect?.width ?? 0,
      modalHeight: rect?.height ?? 0,
      viewportWidth: innerWidth,
      viewportHeight: innerHeight,
      horizontalOverflow: Math.max(0, document.documentElement.scrollWidth - innerWidth),
      bodyHorizontalOverflow: body ? Math.max(0, body.scrollWidth - body.clientWidth) : -1,
      actionButtonsReachable: buttons
        .filter(({ range, compact }) => !range && !compact)
        .every(({ width, height }) => width >= 44 && height >= 44),
      rangeButtonsCompact: buttons
        .filter(({ range }) => Boolean(range))
        .every(({ height }) => height >= 40 && height <= 41),
      refreshButtonFound: Boolean(modal?.querySelector('[data-reading-statistics-refresh="true"]')),
      jsonEnabled: !modal?.querySelector('[data-reading-statistics-export="json"]')?.disabled,
      accentName: modal?.getAttribute('data-reading-statistics-accent'),
      accentValue: modal?.style.getPropertyValue('--accent-500').trim(),
      headerClose: Boolean(modal?.querySelector('[data-menu-sheet-close="true"]')),
      headerDivider: modal?.querySelector('[data-modal-header="statistics"]')
        ? getComputedStyle(modal.querySelector('[data-modal-header="statistics"]')).borderBottomWidth
        : '0px',
      modalTextColor,
      headlineValueColors,
      modeValueColors,
      unexpectedAccentCount: unexpectedAccentElements.length,
      markdownBorderColor: markdownButton ? getComputedStyle(markdownButton).borderColor : '',
      markdownTextColor: markdownButton ? getComputedStyle(markdownButton).color : '',
      markdownBackground: markdownButton ? getComputedStyle(markdownButton).backgroundColor : '',
      shareTextColor: shareButton ? getComputedStyle(shareButton).color : '',
      shareBackground: shareButton ? getComputedStyle(shareButton).backgroundColor : '',
    };
  })()`);
  assert.match(readingStatisticsUi.text, /오늘/);
  assert.match(readingStatisticsUi.text, /화면 독서/);
  assert.match(readingStatisticsUi.text, /TTS 듣기/);
  assert.ok(readingStatisticsUi.bookCount >= 1, JSON.stringify(readingStatisticsUi));
  assert.ok(readingStatisticsUi.modalWidth <= readingStatisticsUi.viewportWidth, JSON.stringify(readingStatisticsUi));
  assert.ok(readingStatisticsUi.modalWidth <= readingStatisticsUi.viewportWidth * 0.92, JSON.stringify(readingStatisticsUi));
  assert.ok(readingStatisticsUi.modalHeight <= readingStatisticsUi.viewportHeight, JSON.stringify(readingStatisticsUi));
  assert.ok(readingStatisticsUi.modalHeight <= readingStatisticsUi.viewportHeight * 0.89, JSON.stringify(readingStatisticsUi));
  assert.equal(readingStatisticsUi.horizontalOverflow, 0, JSON.stringify(readingStatisticsUi));
  assert.equal(readingStatisticsUi.bodyHorizontalOverflow, 0, JSON.stringify(readingStatisticsUi));
  assert.equal(readingStatisticsUi.actionButtonsReachable, true, JSON.stringify(readingStatisticsUi));
  assert.equal(readingStatisticsUi.rangeButtonsCompact, true, JSON.stringify(readingStatisticsUi));
  assert.equal(readingStatisticsUi.refreshButtonFound, true, JSON.stringify(readingStatisticsUi));
  assert.equal(readingStatisticsUi.jsonEnabled, true, JSON.stringify(readingStatisticsUi));
  assert.equal(readingStatisticsUi.accentName, 'yellow', JSON.stringify(readingStatisticsUi));
  assert.equal(readingStatisticsUi.accentValue, '#d4af37', JSON.stringify(readingStatisticsUi));
  assert.equal(readingStatisticsUi.headerClose, true, JSON.stringify(readingStatisticsUi));
  assert.notEqual(readingStatisticsUi.headerDivider, '0px', JSON.stringify(readingStatisticsUi));
  assert.equal(readingStatisticsUi.unexpectedAccentCount, 0, JSON.stringify(readingStatisticsUi));
  assert.ok(
    readingStatisticsUi.headlineValueColors.every((color) => color === readingStatisticsUi.modalTextColor),
    JSON.stringify(readingStatisticsUi),
  );
  assert.ok(
    readingStatisticsUi.modeValueColors.every((color) => color === readingStatisticsUi.modalTextColor),
    JSON.stringify(readingStatisticsUi),
  );
  assert.equal(readingStatisticsUi.markdownTextColor, readingStatisticsUi.modalTextColor, JSON.stringify(readingStatisticsUi));
  assert.equal(readingStatisticsUi.shareTextColor, readingStatisticsUi.markdownTextColor, JSON.stringify(readingStatisticsUi));
  assert.equal(readingStatisticsUi.shareBackground, readingStatisticsUi.markdownBackground, JSON.stringify(readingStatisticsUi));
  assert.notEqual(readingStatisticsUi.markdownBorderColor, readingStatisticsUi.markdownTextColor, JSON.stringify(readingStatisticsUi));
  const bookRoundUi = await evaluate(`(() => {
    const modal = document.querySelector('[data-reading-statistics-modal="true"]');
    const filters = modal?.querySelector('[data-reading-statistics-book-filter="true"]');
    const rows = [...(modal?.querySelectorAll('[data-reading-statistics-book="true"]') ?? [])];
    return {
      filterText: filters?.textContent?.replace(/\\s+/g, '') ?? '',
      summaryText: modal?.querySelector('[data-reading-statistics-book-summary="true"]')
        ?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
      filterPressed: [...(filters?.querySelectorAll('button') ?? [])]
        .map((button) => [button.textContent?.trim(), button.getAttribute('aria-pressed')]),
      fixtureBookId: localStorage.getItem('__browserRegressionSelectionBookId'),
      rounds: rows.map((row) => row.getAttribute('data-reading-statistics-round')),
      rowTexts: rows.map((row) => row.textContent?.replace(/\\s+/g, ' ').trim()),
      confirmableRounds: rows
        .filter((row) => row.querySelector('[data-reading-statistics-confirm-complete="true"]'))
        .map((row) => row.getAttribute('data-reading-statistics-round')),
      completedLabels: rows
        .map((row) => row.querySelector('[data-reading-statistics-complete="true"]')?.textContent?.trim())
        .filter(Boolean),
      confirmableLabels: rows
        .map((row) => row.querySelector('[data-reading-statistics-confirm-complete="true"]')?.textContent?.trim())
        .filter(Boolean),
    };
  })()`);
  assert.equal(bookRoundUi.filterText, '전체|현재|완료');
  assert.match(bookRoundUi.summaryText, /^\d+권 읽는 중 · 완료 \d+권$/);
  assert.doesNotMatch(bookRoundUi.summaryText, /회차/);
  assert.deepEqual(bookRoundUi.filterPressed, [
    ['전체', 'true'], ['현재', 'false'], ['완료', 'false'],
  ]);
  const fixtureRoundSelector = `[data-reading-statistics-book-id="${bookRoundUi.fixtureBookId}"]`;
  const fixtureRounds = await evaluate(`[
    ...document.querySelectorAll(${JSON.stringify(fixtureRoundSelector)})
  ].map((row) => row.getAttribute('data-reading-statistics-round'))`);
  assert.deepEqual(fixtureRounds, ['2', '1'], JSON.stringify({ bookRoundUi, fixtureRounds }));
  assert.ok(bookRoundUi.rowTexts.every((text) => /\d+회차/.test(text)), JSON.stringify(bookRoundUi));
  assert.ok(bookRoundUi.rowTexts.some((text) => text.includes('1회차')), JSON.stringify(bookRoundUi));
  assert.ok(bookRoundUi.rowTexts.some((text) => text.includes('2회차')), JSON.stringify(bookRoundUi));
  assert.deepEqual(bookRoundUi.confirmableRounds, ['2'], JSON.stringify(bookRoundUi));
  assert.ok(bookRoundUi.completedLabels.every((label) => label === '완료됨'), JSON.stringify(bookRoundUi));
  assert.deepEqual(bookRoundUi.confirmableLabels, ['완료하기'], JSON.stringify(bookRoundUi));
  assert.ok(bookRoundUi.rowTexts.every((text) => text.includes('시작')), JSON.stringify(bookRoundUi));
  await evaluate(`document.querySelector('[data-reading-statistics-complete="true"]')?.click()`);
  await evaluate('window.__regressionNextFrame(2)');
  const completionUi = await evaluate(`(() => {
    const complete = document.querySelector('[data-reading-statistics-complete="true"]');
    return {
      expanded: complete?.getAttribute('aria-expanded'),
      dates: document.querySelector('[data-reading-statistics-completion-dates="true"]')
        ?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
    };
  })()`);
  assert.equal(completionUi.expanded, 'true');
  assert.match(completionUi.dates, /시작 .* 종료/);
  await evaluate(`(() => {
    const filters = document.querySelector('[data-reading-statistics-book-filter="true"]');
    [...(filters?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent?.trim() === '현재')?.click();
  })()`);
  await evaluate('window.__regressionNextFrame(2)');
  const currentRoundUi = await evaluate(`(() => ({
    count: document.querySelectorAll('[data-reading-statistics-book="true"]').length,
    rounds: [...document.querySelectorAll(${JSON.stringify(fixtureRoundSelector)})]
      .map((row) => row.getAttribute('data-reading-statistics-round')),
  }))()`);
  assert.ok(currentRoundUi.rounds.includes('2'), JSON.stringify(currentRoundUi));
  assert.ok(!currentRoundUi.rounds.includes('1'), JSON.stringify(currentRoundUi));
  await evaluate(`(() => {
    const filters = document.querySelector('[data-reading-statistics-book-filter="true"]');
    [...(filters?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent?.trim() === '완료')?.click();
  })()`);
  await evaluate('window.__regressionNextFrame(2)');
  const completedRoundUi = await evaluate(`[
    ...document.querySelectorAll(${JSON.stringify(fixtureRoundSelector)})
  ].map((row) => row.getAttribute('data-reading-statistics-round'))`);
  assert.ok(completedRoundUi.includes('1'), JSON.stringify(completedRoundUi));
  assert.ok(!completedRoundUi.includes('2'), JSON.stringify(completedRoundUi));
  await evaluate(`(() => {
    const filters = document.querySelector('[data-reading-statistics-book-filter="true"]');
    [...(filters?.querySelectorAll('button') ?? [])]
      .find((button) => button.textContent?.trim() === '전체')?.click();
  })()`);
  await evaluate('window.__regressionNextFrame(2)');
  await evaluate(`document.querySelector(
    ${JSON.stringify(`${fixtureRoundSelector}[data-reading-statistics-round="2"] [data-reading-statistics-confirm-complete="true"]`)}
  )?.click()`);
  await waitFor(
    `!document.querySelector(${JSON.stringify(
      `${fixtureRoundSelector}[data-reading-statistics-round="2"] [data-reading-statistics-confirm-complete="true"]`,
    )})`,
    'explicit reading round completion',
  );
  const confirmedRoundUi = await evaluate(`(() => {
    const modal = document.querySelector('[data-reading-statistics-modal="true"]');
    const rows = [...document.querySelectorAll(${JSON.stringify(fixtureRoundSelector)})];
    return {
      summary: modal?.querySelector('[data-reading-statistics-book-summary="true"]')
        ?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
      completedRounds: rows
        .filter((row) => row.querySelector('[data-reading-statistics-complete="true"]'))
        .map((row) => row.getAttribute('data-reading-statistics-round')),
      feedback: modal?.querySelector('footer [role="status"]')?.textContent?.trim() ?? '',
    };
  })()`);
  assert.equal(confirmedRoundUi.summary, '0권 읽는 중 · 완료 1권');
  assert.deepEqual(confirmedRoundUi.completedRounds, ['2', '1']);
  assert.match(confirmedRoundUi.feedback, /2회차를 완료/);
  const totalsBeforeBookListDeletion = await evaluate(`(() => ({
    headlines: [...document.querySelectorAll('[data-reading-statistics-headline]')]
      .map((element) => element.textContent?.replace(/\\s+/g, ' ').trim()),
    modes: [...document.querySelectorAll('[data-reading-statistics-mode-total]')]
      .map((element) => element.textContent?.trim()),
  }))()`);
  await evaluate(`(async () => {
    const row = document.querySelector(${JSON.stringify(
      `${fixtureRoundSelector}[data-reading-statistics-round="1"]`,
    )});
    if (!row) return false;
    const rect = row.getBoundingClientRect();
    row.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerId: 91,
      pointerType: 'touch',
      clientX: rect.left + 12,
      clientY: rect.top + 12,
    }));
    await new Promise((resolve) => setTimeout(resolve, 700));
    row.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true,
      pointerId: 91,
      pointerType: 'touch',
      clientX: rect.left + 12,
      clientY: rect.top + 12,
    }));
    return true;
  })()`);
  await waitFor(
    `[...document.querySelectorAll('button')]
      .some((button) => button.textContent?.trim() === '목록에서 삭제')`,
    'reading statistics long-press delete confirmation',
  );
  const bookListDeletionMessage = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((candidate) => candidate.textContent?.trim() === '목록에서 삭제');
    return button?.closest('.fixed')?.textContent?.replace(/\\s+/g, ' ').trim() ?? '';
  })()`);
  assert.match(bookListDeletionMessage, /1회차/);
  assert.match(bookListDeletionMessage, /선택한 회차의 세션만/);
  assert.match(bookListDeletionMessage, /다른 회차/);
  assert.match(bookListDeletionMessage, /표시되는 독서 합계.*제외/);
  await evaluate(`[
    ...document.querySelectorAll('button')
  ].find((button) => button.textContent?.trim() === '목록에서 삭제')?.click()`);
  await waitFor(
    `document.querySelectorAll(${JSON.stringify(fixtureRoundSelector)}).length === 1
      && document.querySelector(${JSON.stringify(`${fixtureRoundSelector}[data-reading-statistics-round="2"]`)}) !== null`,
    'reading statistics single-round list deletion',
  );
  const bookListDeletionUi = await evaluate(`(() => ({
    headlines: [...document.querySelectorAll('[data-reading-statistics-headline]')]
      .map((element) => element.textContent?.replace(/\\s+/g, ' ').trim()),
    modes: [...document.querySelectorAll('[data-reading-statistics-mode-total]')]
      .map((element) => element.textContent?.trim()),
    summary: document.querySelector('[data-reading-statistics-book-summary="true"]')
      ?.textContent?.replace(/\\s+/g, ' ').trim() ?? '',
    feedback: document.querySelector('[data-reading-statistics-modal="true"] footer [role="status"]')
      ?.textContent?.trim() ?? '',
    remainingRounds: [...document.querySelectorAll(${JSON.stringify(fixtureRoundSelector)})]
      .map((row) => row.getAttribute('data-reading-statistics-round')),
    jsonEnabled: !document.querySelector('[data-reading-statistics-export="json"]')?.disabled,
  }))()`);
  assert.notDeepEqual(bookListDeletionUi.headlines, totalsBeforeBookListDeletion.headlines);
  assert.notDeepEqual(bookListDeletionUi.modes, totalsBeforeBookListDeletion.modes);
  assert.deepEqual(bookListDeletionUi.headlines, ['오늘1분', '이번 주1분', '이번 달1분']);
  assert.deepEqual(bookListDeletionUi.modes, ['1분', '0분']);
  assert.equal(bookListDeletionUi.summary, '0권 읽는 중 · 완료 1권');
  assert.deepEqual(bookListDeletionUi.remainingRounds, ['2']);
  assert.match(bookListDeletionUi.feedback, /1회차.*표시 합계에서 제외/);
  assert.equal(bookListDeletionUi.jsonEnabled, true);
  await evaluate(`document.querySelector('button[aria-label="독서 통계 닫기"]')?.click()`);
  await evaluate(`localStorage.removeItem('reading_statistics_hidden_sessions_v1')`);
  await command('Emulation.setDeviceMetricsOverride', {
    width: 1280,
    height: 800,
    deviceScaleFactor: 1,
    mobile: false,
  });

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
    await window.__regressionNextFrame();
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
    const cover = await book.getCover();
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
      cover: { size: cover?.size ?? 0, type: cover?.type ?? '' },
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
  assert.ok(pdfResult.cover.size > 0);
  assert.match(pdfResult.cover.type, /^image\//);
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
    const expectedCache = 'pc-reader-v1.8.34';
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
      '/sw.js?browser-regression=1.8.34',
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
  assert.deepEqual(serviceWorkerResult.cacheNames, ['pc-reader-v1.8.34']);
  assert.equal(serviceWorkerResult.oldCacheDeleted, true);
  assert.equal(serviceWorkerResult.legacyFontDeleted, true);
  assert.ok(serviceWorkerResult.preCacheHits.every(({ cached }) => cached));
  assert.match(serviceWorkerResult.scriptUrl, /\/sw\.js\?browser-regression=1\.8\.34$/);

  console.log(JSON.stringify({
    shelf: {
      initialShelf,
      secondPageCount,
      previewTitles,
      searchDurationMs,
      sortDurationMs,
      mobileFilterModal,
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
    libraryAnnotation: libraryAnnotationUi,
    solidSevenZip: solidSevenZipResult,
    tapSettings,
    readingStatistics: readingStatisticsUi,
    tapBoundary,
    fixedLayoutMouseZoomDrag,
    fixedLayout,
    pdf: pdfResult,
    serviceWorker: serviceWorkerResult,
  }, null, 2));
} finally {
  socket.close();
}
