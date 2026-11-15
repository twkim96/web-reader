'use client';

import { MutableRefObject, useCallback, useRef } from 'react';
import { FoliateRenderer, FoliateViewElement, ReaderLayout, ReaderStyle } from './types';
import { traceReaderBootstrap, traceReaderOpenPerformance } from '../../lib/readerBootstrapTrace';
import { READER_FONT_FAMILIES } from '../../lib/readerTypography';

interface UseFoliateLayoutOptions {
  viewRef: MutableRefObject<FoliateViewElement | null>;
}

const LOCAL_FONTS: Record<string, { family: string; url: string; format: string; fallback?: string }> = {
  ridi: { family: 'RIDIBatang', url: '/fonts/RIDIBatang.woff2', format: 'woff2', fallback: ", url('/fonts/RIDIBatang.otf') format('opentype')" },
  chosunIlboMyungjo: { family: 'ChosunilboNM', url: '/fonts/Chosunilbo_myungjo.woff', format: 'woff' },
  chosunGu: { family: 'ChosunGu', url: '/fonts/ChosunGu.woff', format: 'woff' },
  gowunBatang: { family: 'GowunBatang', url: '/fonts/GowunBatang-Regular.woff', format: 'woff' },
  gowunDodum: { family: 'GowunDodum', url: '/fonts/GowunDodum-Regular.woff', format: 'woff' },
};

const buildFontFace = (family: string, source: string, fallback = '') => `
  @font-face {
    font-family: '${family}';
    src: ${source}${fallback};
    font-weight: normal;
    font-style: normal;
    font-display: block;
  }
`;

const fontFacePromises = new Map<string, Promise<string>>();

const blobToDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

const loadSelectedFontFace = (fontKey: string | undefined) => {
  const key = fontKey ?? 'ridi';
  const font = LOCAL_FONTS[key];
  if (!font) return Promise.resolve('');
  const existing = fontFacePromises.get(key);
  if (existing) return existing;

  const promise = fetch(font.url, { cache: 'force-cache' })
    .then((response) => {
      if (!response.ok) throw new Error(`Failed to load ${font.url}: ${response.status}`);
      return response.blob();
    })
    .then(blobToDataUrl)
    .then((dataUrl) => buildFontFace(font.family, `url('${dataUrl}') format('${font.format}')`))
    .catch((error) => {
      fontFacePromises.delete(key);
      console.warn(`[EpubReader] Failed to embed ${font.family} font:`, error);
      return buildFontFace(font.family, `url('${font.url}') format('${font.format}')`, font.fallback);
    });
  fontFacePromises.set(key, promise);
  return promise;
};

const buildReaderStyle = (styles: ReaderStyle) => {
  const fontStack = styles.fontFamily ? READER_FONT_FAMILIES[styles.fontFamily] || styles.fontFamily : '';
  const paragraphSpacing = styles.paragraphSpacing ?? 1;

  return `
    html, body {
      ${styles.bgColor ? `background-color: ${styles.bgColor} !important;` : ''}
      ${styles.bgImage ? `background-image: ${styles.bgImage} !important;` : ''}
      ${styles.bgSize ? `background-size: ${styles.bgSize} !important;` : ''}
      ${styles.textColor ? `color: ${styles.textColor} !important;` : ''}
      margin: 0 !important;
      padding: 10px 2px !important;
      width: 100% !important;
      max-width: none !important;
    }
    body, p, div, span, li, td, th, dd, dt, blockquote, cite, pre, code, h1, h2, h3, h4, h5, h6 {
      ${styles.fontSize ? `font-size: ${styles.fontSize}px !important;` : ''}
      ${styles.lineHeight ? `line-height: ${styles.lineHeight} !important;` : ''}
      ${fontStack ? `font-family: ${fontStack} !important;` : ''}
      ${styles.textAlign ? `text-align: ${styles.textAlign} !important;` : ''}
      ${styles.textColor ? `color: ${styles.textColor} !important;` : ''}
    }
    p, div {
      margin-top: 0 !important;
      margin-bottom: ${paragraphSpacing}em !important;
    }
    p:last-child, div:last-child {
      margin-bottom: 0 !important;
    }
    img, svg, video {
      max-width: 100% !important;
      max-height: 95vh !important;
      height: auto !important;
      object-fit: contain !important;
    }
    p:has(> img:only-child),
    div:has(> img:only-child) {
      text-indent: 0 !important;
      text-align: center !important;
      line-height: normal !important;
      break-inside: avoid !important;
      page-break-inside: avoid !important;
    }
    p:has(> img:only-child) > img,
    div:has(> img:only-child) > img {
      display: block !important;
      width: auto !important;
      height: auto !important;
      max-width: 100% !important;
      max-height: calc(100vh - 20px) !important;
      margin: 0 auto !important;
      object-fit: contain !important;
    }
    a { color: inherit !important; }
  `;
};

export const useFoliateLayout = ({ viewRef }: UseFoliateLayoutOptions) => {
  const styleRequestRef = useRef(0);
  const setStyle = useCallback(async (
    styles: ReaderStyle,
    targetRenderer?: FoliateRenderer,
  ) => {
    const requestId = ++styleRequestRef.current;
    const fontStartedAt = performance.now();
    const fontFace = await loadSelectedFontFace(styles.fontFamily);
    if (requestId !== styleRequestRef.current) return;
    traceReaderOpenPerformance({
      phase: 'reader-font-source-ready',
      durationMs: performance.now() - fontStartedAt,
      status: styles.fontFamily ?? 'default',
    });
    traceReaderBootstrap({ event: 'font-ready' });
    const renderer = targetRenderer ?? viewRef.current?.renderer;
    if (!renderer) return;

    try {
      if (styles.bgColor) {
        // The reader shell owns the theme color and texture. Let it show through
        // the publication canvas as well as the paginator's outer margins.
        renderer.setBackground?.({
          color: 'transparent',
        });
      }
      renderer.setStyles([fontFace, buildReaderStyle(styles)]);
      traceReaderBootstrap({ event: 'style-applied' });
    } catch (error) {
      console.warn('[EpubReader] Style injection failed:', error);
    }
  }, [viewRef]);

  const setLayout = useCallback((layout: ReaderLayout, targetRenderer?: FoliateRenderer) => {
    const renderer = targetRenderer ?? viewRef.current?.renderer;
    if (!renderer) return;

    let changed = false;
    const setAttributeIfChanged = (name: string, value: string) => {
      if (renderer.getAttribute(name) === value) return;
      renderer.setAttribute(name, value);
      changed = true;
    };

    if (layout.flow) setAttributeIfChanged('flow', layout.flow);
    if (layout.swipeNavigation !== undefined) {
      setAttributeIfChanged('swipe-navigation', String(layout.swipeNavigation));
    }
    if (layout.margin !== undefined) setAttributeIfChanged('margin', `${layout.margin}px`);
    if (layout.gap) setAttributeIfChanged('gap', layout.gap);
    if (layout.outsideMargin) setAttributeIfChanged('outside-margin', layout.outsideMargin);
    if (layout.maxColumnCount) {
      setAttributeIfChanged('max-column-count', String(layout.maxColumnCount));
    }
    if (layout.maxInlineSize) setAttributeIfChanged('max-inline-size', layout.maxInlineSize);
    if (layout.animated) setAttributeIfChanged('animated', '');
    if (changed) {
      traceReaderBootstrap({
        event: 'layout-applied',
        viewportWidth: window.innerWidth,
        viewportHeight: window.innerHeight,
      });
    }
  }, [viewRef]);

  return {
    setStyle,
    setLayout,
  };
};
