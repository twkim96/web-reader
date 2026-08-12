import test from 'node:test';
import assert from 'node:assert/strict';
import JSZip from 'jszip';
import {
  buildTxtChapterLabel,
  convertTxtToEpub,
  TXT_CHAPTER_EXCERPT_LENGTH,
} from '../src/lib/txtToEpub.ts';

const encode = (text) => new TextEncoder().encode(text).buffer;

test('builds a numbered chapter label from a normalized 12-grapheme excerpt', () => {
  const content = `\n\n  첫 문장은   여러 공백과\n줄바꿈을 포함하지만 목차에서는 한 줄로 보입니다. ${'가'.repeat(40)}`;
  const label = buildTxtChapterLabel(content, 2);

  assert.equal(label, '3. 첫 문장은 여러 공백과…');
  assert.equal(label.endsWith('…'), true);
  const excerpt = label.slice('3. '.length, -1);
  assert.equal(Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(excerpt)).length, TXT_CHAPTER_EXCERPT_LENGTH);
});

test('keeps an empty generated chapter on the existing Chapter N fallback', () => {
  assert.equal(buildTxtChapterLabel('\n\t ', 4), 'Chapter 5');
});

test('writes numbered excerpts into new TXT EPUB navigation and escapes XML', async () => {
  const first = '첫 장의 시작 & <비밀>은 목차에도 안전하게 표시됩니다.';
  const second = '둘째 장은 전혀 다른 구절로 시작해서 위치를 기억하기 쉽습니다.';
  const source = `${first}\n\n${'가'.repeat(30_000)}\n\n${second}\n\n${'나'.repeat(30_000)}`;
  const blob = await convertTxtToEpub(encode(source), '제목 & <테스트>.txt');
  const zip = await JSZip.loadAsync(await blob.arrayBuffer());
  const nav = await zip.file('OEBPS/nav.xhtml').async('string');
  const firstChapter = await zip.file('OEBPS/ch001.xhtml').async('string');

  assert.match(nav, /<a href="ch001\.xhtml">1\. 첫 장의 시작 &amp; &lt;비…<\/a>/);
  assert.match(nav, /<a href="ch002\.xhtml">2\. 둘째 장은 전혀 다른 …<\/a>/);
  assert.match(firstChapter, /<title>제목 &amp; &lt;테스트&gt; - 1\. 첫 장의 시작 &amp; &lt;비…<\/title>/);
});
