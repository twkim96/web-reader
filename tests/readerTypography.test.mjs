import test from 'node:test';
import assert from 'node:assert/strict';
import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { useFoliateLayout } from '../src/hooks/foliate/useFoliateLayout.ts';

test('loads only the selected bundled font and ignores stale font loads', async () => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  Object.assign(globalThis, { window, document: window.document, HTMLElement: window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true });
  const originalFetch = globalThis.fetch;
  const originalFileReader = globalThis.FileReader;
  const requests = [];
  let finishChosun;
  globalThis.fetch = (url) => {
    requests.push(url);
    if (url.includes('Chosunilbo_myungjo')) return new Promise(resolve => { finishChosun = resolve; });
    return Promise.resolve({ ok: true, blob: async () => new Blob(['ridi']) });
  };
  globalThis.FileReader = class {
    readAsDataURL() { this.result = 'data:font/test;base64,Zm9udA=='; this.onload(); }
  };
  const applied = [];
  const renderer = { setStyles: styles => applied.push(styles) };
  let setStyle;
  function Harness() {
    const layout = useFoliateLayout({ viewRef: { current: { renderer } } });
    useEffect(() => { setStyle = layout.setStyle; }, [layout.setStyle]);
    return null;
  }
  const root = createRoot(window.document.querySelector('#root'));
  try {
    await act(async () => root.render(React.createElement(Harness)));
    await setStyle({ fontFamily: 'ridi' });
    assert.deepEqual(requests, ['/fonts/RIDIBatang.woff2']);
    assert.match(applied.at(-1)[0], /data:font\/test/);
    const pending = setStyle({ fontFamily: 'chosunIlboMyungjo' });
    await setStyle({ fontFamily: 'sans' });
    assert.doesNotMatch(applied.at(-1)[0], /@import|fonts\.googleapis\.com/);
    assert.doesNotMatch(applied.at(-1)[0], /data:font|ChosunilboNM|RIDIBatang/);
    finishChosun({ ok: true, blob: async () => new Blob(['chosun']) });
    await pending;
    assert.equal(applied.length, 2);
    await setStyle({ fontFamily: 'chosunIlboMyungjo' });
    assert.match(applied.at(-1)[0], /ChosunilboNM[\s\S]*data:font\/test/);
    assert.doesNotMatch(applied.at(-1)[0], /@import|fonts\.googleapis\.com/);
    assert.doesNotMatch(applied.at(-1)[0], /RIDIBatang/);
    assert.deepEqual(requests, ['/fonts/RIDIBatang.woff2', '/fonts/Chosunilbo_myungjo.woff']);
    await setStyle({ fontFamily: 'chosunGu' });
    assert.match(applied.at(-1)[0], /ChosunGu[\s\S]*data:font\/test/);
    assert.doesNotMatch(applied.at(-1)[0], /RIDIBatang|ChosunilboNM/);
    assert.deepEqual(requests, ['/fonts/RIDIBatang.woff2', '/fonts/Chosunilbo_myungjo.woff', '/fonts/ChosunGu.woff']);
    for (const [fontFamily, family, file] of [
      ['gowunBatang', 'GowunBatang', '/fonts/GowunBatang-Regular.woff'],
      ['gowunDodum', 'GowunDodum', '/fonts/GowunDodum-Regular.woff'],
    ]) {
      const before = requests.length;
      await setStyle({ fontFamily });
      assert.deepEqual(requests.slice(before), [file]);
      assert.ok(applied.at(-1)[0].includes(`font-family: '${family}'`));
      assert.match(applied.at(-1)[0], /data:font\/test/);
      await setStyle({ fontFamily });
      assert.equal(requests.length, before + 1);
    }
    const requestCount = requests.length;
    await setStyle({ fontFamily: 'serif', fontSize: 22 });
    assert.equal(applied.at(-1)[0], '');
    assert.match(applied.at(-1)[1], /Georgia, serif/);
    await setStyle({ fontFamily: 'sans', fontSize: 23 });
    assert.equal(applied.at(-1)[0], '');
    assert.match(applied.at(-1)[1], /Roboto, sans-serif/);
    assert.equal(requests.length, requestCount);
    assert.ok(applied.every(styles => !styles.join('').includes('fonts.googleapis.com')));
  } finally {
    await act(async () => root.unmount());
    globalThis.fetch = originalFetch;
    globalThis.FileReader = originalFileReader;
  }
});
