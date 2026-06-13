import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';

import { isEpubBuffer } from '../src/lib/epubValidation.ts';

const makeZip = async (files) => {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(files)) {
    zip.file(name, content);
  }
  return zip.generateAsync({ type: 'arraybuffer' });
};

test('accepts an EPUB container with the required mimetype and container file', async () => {
  const buffer = await makeZip({
    mimetype: 'application/epub+zip',
    'META-INF/container.xml': '<container/>',
  });
  assert.equal(await isEpubBuffer(buffer), true);
});

test('does not treat a generic ZIP as EPUB', async () => {
  const buffer = await makeZip({
    'images/001.jpg': 'not-an-image',
  });
  assert.equal(await isEpubBuffer(buffer), false);
});

test('rejects an EPUB-like ZIP with an invalid mimetype', async () => {
  const buffer = await makeZip({
    mimetype: 'application/zip',
    'META-INF/container.xml': '<container/>',
  });
  assert.equal(await isEpubBuffer(buffer), false);
});
