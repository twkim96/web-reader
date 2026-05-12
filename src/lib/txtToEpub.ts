// src/lib/txtToEpub.ts
import JSZip from 'jszip';

const CHAPTER_TARGET_SIZE = 30000; // 목표 챕터 크기 (글자 수)
const CHAPTER_MIN_SIZE = 5000;     // 최소 챕터 크기 (너무 짧은 챕터 방지)

/**
 * 텍스트를 자연스러운 구분점(빈 줄)에서 챕터로 분할합니다.
 * 30000자 근처의 빈 줄(줄바꿈 2개 이상)에서 끊습니다.
 */
function splitIntoChapters(text: string): string[] {
  if (text.length <= CHAPTER_TARGET_SIZE) {
    return [text];
  }

  const chapters: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= CHAPTER_TARGET_SIZE * 1.3) {
      // 남은 텍스트가 목표의 130% 이하면 마지막 챕터로 통합
      chapters.push(remaining);
      break;
    }

    // 목표 지점 전후에서 빈 줄(줄바꿈 2개 이상) 탐색
    let splitIdx = -1;
    const searchStart = Math.max(CHAPTER_MIN_SIZE, CHAPTER_TARGET_SIZE - 5000);
    const searchEnd = Math.min(remaining.length, CHAPTER_TARGET_SIZE + 5000);

    // 목표 지점에서 가장 가까운 빈 줄을 찾음 (목표 지점부터 앞뒤로 탐색)
    const target = CHAPTER_TARGET_SIZE;
    let bestDist = Infinity;

    for (let i = searchStart; i < searchEnd - 1; i++) {
      // 빈 줄 패턴: \n\n 또는 \r\n\r\n
      if (remaining[i] === '\n' && remaining[i + 1] === '\n') {
        const dist = Math.abs(i - target);
        if (dist < bestDist) {
          bestDist = dist;
          splitIdx = i + 2; // 빈 줄 다음부터 새 챕터
        }
      } else if (i + 3 < searchEnd &&
        remaining[i] === '\r' && remaining[i + 1] === '\n' &&
        remaining[i + 2] === '\r' && remaining[i + 3] === '\n') {
        const dist = Math.abs(i - target);
        if (dist < bestDist) {
          bestDist = dist;
          splitIdx = i + 4;
        }
      }
    }

    // 빈 줄을 찾지 못했으면 목표 지점에서 기계적으로 자름
    if (splitIdx === -1) {
      splitIdx = CHAPTER_TARGET_SIZE;
    }

    chapters.push(remaining.substring(0, splitIdx));
    remaining = remaining.substring(splitIdx);
  }

  return chapters;
}

/**
 * 텍스트를 HTML로 이스케이프하고 줄바꿈을 <br/> 또는 <p>로 변환합니다.
 */
function textToHtml(text: string): string {
  // HTML 특수문자 이스케이프
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  // 문단 분리: 빈 줄로 구분된 블록을 <p>로 감쌈
  const paragraphs = escaped.split(/\n\s*\n/);
  return paragraphs
    .map(p => {
      const trimmed = p.trim();
      if (!trimmed) return '';
      // 문단 내 단일 줄바꿈은 <br/>로 변환
      const withBr = trimmed.replace(/\n/g, '<br/>');
      return `<p>${withBr}</p>`;
    })
    .filter(p => p.length > 0)
    .join('\n');
}

/**
 * 챕터 XHTML 파일 내용을 생성합니다.
 */
function createChapterXhtml(chapterContent: string, chapterIndex: number, title: string): string {
  const htmlContent = textToHtml(chapterContent);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="ko" lang="ko">
<head>
  <meta charset="UTF-8"/>
  <title>${title} - Chapter ${chapterIndex + 1}</title>
  <link rel="stylesheet" type="text/css" href="style.css"/>
</head>
<body>
${htmlContent}
</body>
</html>`;
}

/**
 * ArrayBuffer(txt 파일)를 epub Blob으로 변환합니다.
 * 
 * @param buffer - txt 파일의 ArrayBuffer
 * @param fileName - 원본 파일명 (예: "example.txt")
 * @param encoding - 인코딩 모드 ('auto' | 'utf-8' | 'euc-kr' | 'utf-16le')
 * @returns epub Blob
 */
export async function convertTxtToEpub(
  buffer: ArrayBuffer,
  fileName: string,
  encoding: 'auto' | 'utf-8' | 'euc-kr' | 'utf-16le' = 'auto'
): Promise<Blob> {
  // 1. 텍스트 디코딩
  const text = decodeBuffer(buffer, encoding);
  const title = fileName.replace(/\.txt$/i, '');
  const bookId = `urn:uuid:${crypto.randomUUID()}`;

  // 2. 챕터 분할
  const chapters = splitIntoChapters(text);

  // 3. epub 구조 생성
  const zip = new JSZip();

  // mimetype (비압축, 반드시 첫 번째 파일)
  zip.file('mimetype', 'application/epub+zip', { compression: 'STORE' });

  // META-INF/container.xml
  zip.file('META-INF/container.xml', `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`);

  // OEBPS/style.css
  zip.file('OEBPS/style.css', `body {
  margin: 0;
  padding: 1em;
  font-family: sans-serif;
  line-height: 1.8;
  word-break: break-all;
  overflow-wrap: break-word;
}
p {
  margin: 0.5em 0;
  text-indent: 0;
  text-align: justify;
}`);

  // 챕터 파일들 생성
  const manifestItems: string[] = [];
  const spineItems: string[] = [];
  const tocItems: string[] = [];

  for (let i = 0; i < chapters.length; i++) {
    const chId = `ch${String(i + 1).padStart(3, '0')}`;
    const chFile = `${chId}.xhtml`;

    zip.file(`OEBPS/${chFile}`, createChapterXhtml(chapters[i], i, title));

    manifestItems.push(`    <item id="${chId}" href="${chFile}" media-type="application/xhtml+xml"/>`);
    spineItems.push(`    <itemref idref="${chId}"/>`);
    tocItems.push(`      <li><a href="${chFile}">Chapter ${i + 1}</a></li>`);
  }

  // OEBPS/content.opf
  zip.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">${bookId}</dc:identifier>
    <dc:title>${escapeXml(title)}</dc:title>
    <dc:language>ko</dc:language>
    <meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+Z$/, 'Z')}</meta>
  </metadata>
  <manifest>
    <item id="style" href="style.css" media-type="text/css"/>
    <item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>
${manifestItems.join('\n')}
  </manifest>
  <spine>
${spineItems.join('\n')}
  </spine>
</package>`);

  // OEBPS/nav.xhtml (EPUB3 네비게이션)
  zip.file('OEBPS/nav.xhtml', `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="ko" lang="ko">
<head>
  <meta charset="UTF-8"/>
  <title>Table of Contents</title>
</head>
<body>
  <nav epub:type="toc" id="toc">
    <h1>목차</h1>
    <ol>
${tocItems.join('\n')}
    </ol>
  </nav>
</body>
</html>`);

  // 4. Blob 생성
  const epubBlob = await zip.generateAsync({
    type: 'blob',
    mimeType: 'application/epub+zip',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 }
  });

  return epubBlob;
}

/**
 * ArrayBuffer를 텍스트로 디코딩합니다.
 */
function decodeBuffer(buffer: ArrayBuffer, mode: string): string {
  const view = new Uint8Array(buffer);
  const isUTF16LE = view[0] === 0xFF && view[1] === 0xFE;
  const isUTF16BE = view[0] === 0xFE && view[1] === 0xFF;

  if (mode === 'auto') {
    try {
      const encoding = (isUTF16LE || isUTF16BE)
        ? (isUTF16LE ? 'utf-16le' : 'utf-16be')
        : 'utf-8';
      return new TextDecoder(encoding, { fatal: true }).decode(buffer);
    } catch {
      // UTF-8 실패 시 EUC-KR fallback
      return new TextDecoder('euc-kr').decode(buffer);
    }
  }

  return new TextDecoder(mode).decode(buffer);
}

/**
 * XML 특수문자를 이스케이프합니다.
 */
function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}
