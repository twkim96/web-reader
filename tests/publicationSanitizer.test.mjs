import test from 'node:test';
import assert from 'node:assert/strict';
import { DOMParser } from 'linkedom';

globalThis.DOMParser = DOMParser;

const {
  PUBLICATION_CSP,
  hasUnsafeCSS,
  isSafePublicationURL,
  sanitizePublicationDocument,
} = await import('../public/foliate-js/publication-sanitizer.js');

const parse = markup => new DOMParser().parseFromString(markup, 'text/html');

test('removes executable and nested-document publication content', () => {
  const doc = parse(`<html><head><meta http-equiv="refresh" content="0;url=https://evil.test"></head><body>
    <script>top.pwned = true</script><iframe srcdoc="<script></script>"></iframe>
    <object data="https://evil.test/a"></object><svg><foreignObject>bad</foreignObject></svg>
    <button onclick="fetch('https://evil.test')">x</button></body></html>`);
  sanitizePublicationDocument(doc);
  assert.equal(doc.querySelector('script,iframe,object,foreignObject,meta[http-equiv="refresh"]'), null);
  assert.equal(doc.querySelector('button').hasAttribute('onclick'), false);
  assert.match(doc.querySelector('meta[http-equiv="Content-Security-Policy"]').content, /script-src 'none'/);
  assert.match(PUBLICATION_CSP, /connect-src 'none'/);
});

test('blocks dangerous URLs while preserving package and safe external anchors', () => {
  const doc = parse(`<html><body>
    <img id="remote" src="https://evil.test/a.png"><img id="package" src="blob:test">
    <img id="svg" src="data:image/svg+xml,<svg/>">
    <a id="js" href="javascript:alert(1)">bad</a>
    <a id="web" href="https://example.com">web</a><a id="internal" href="chapter.xhtml#x">next</a>
  </body></html>`);
  sanitizePublicationDocument(doc);
  assert.equal(doc.querySelector('#remote').hasAttribute('src'), false);
  assert.equal(doc.querySelector('#package').getAttribute('src'), 'blob:test');
  assert.equal(doc.querySelector('#svg').hasAttribute('src'), false);
  assert.equal(doc.querySelector('#js').hasAttribute('href'), false);
  assert.equal(doc.querySelector('#web').getAttribute('rel'), 'noopener noreferrer');
  assert.equal(doc.querySelector('#internal').getAttribute('href'), 'chapter.xhtml#x');
});

test('CSS token gate rejects remote/import URLs without confusing comments or strings', () => {
  assert.equal(hasUnsafeCSS(`background: url(https://evil.test/a.png)`), true);
  assert.equal(hasUnsafeCSS(`@import "https://evil.test/a.css";`), true);
  assert.equal(hasUnsafeCSS(`background: url("blob:safe")`), false);
  assert.equal(hasUnsafeCSS(`content: "url(https://not-a-token.test)"`), false);
  assert.equal(hasUnsafeCSS(`/* url(https://comment.test) */ color: red`), false);
  assert.equal(hasUnsafeCSS('body{background:u/**/rl(https://bad.test/a.png)}'), true);
  assert.equal(hasUnsafeCSS('body{background:u\\72l(https://bad.test/a.png)}'), true);
  assert.equal(hasUnsafeCSS('@im\\70ort "https://bad.test/a.css"'), true);
  assert.equal(hasUnsafeCSS('body{background-image:image-set("https://bad.test/a.png" 1x)}'), true);
  assert.equal(hasUnsafeCSS('body{background:url(images/background.png)}'), false);
  assert.equal(isSafePublicationURL('data:image/svg+xml,<svg/>'), false);
  assert.equal(isSafePublicationURL('data:image/png;base64,AA=='), true);
});
