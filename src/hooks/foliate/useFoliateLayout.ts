'use client';

import { MutableRefObject, useCallback, useEffect, useState } from 'react';
import { FoliateViewElement, ReaderLayout, ReaderStyle } from './types';

interface UseFoliateLayoutOptions {
  viewRef: MutableRefObject<FoliateViewElement | null>;
}

const FONT_MAP: Record<string, string> = {
  sans: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  serif: '"Noto Serif KR", "Noto Serif", Georgia, serif',
  ridi: '"RIDIBatang", "Noto Serif KR", serif',
};

const RIDI_FONT_URL = '/fonts/RIDIBatang.woff2';

const buildBeforeStyle = (ridiFontSource: string) => `
  @import url('https://fonts.googleapis.com/css2?family=Noto+Serif+KR:wght@400;700&display=swap');
  @font-face {
    font-family: 'RIDIBatang';
    src:
      ${ridiFontSource},
      url('/fonts/RIDIBatang.otf') format('opentype');
    font-weight: normal;
    font-style: normal;
    font-display: block;
  }
`;

const URL_RIDI_FONT_FACE = buildBeforeStyle(`url('${RIDI_FONT_URL}') format('woff2')`);
let ridiFontFacePromise: Promise<string> | null = null;

const blobToDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result));
  reader.onerror = () => reject(reader.error);
  reader.readAsDataURL(blob);
});

const loadEmbeddedRidiFontFace = () => {
  if (ridiFontFacePromise) return ridiFontFacePromise;

  ridiFontFacePromise = fetch(RIDI_FONT_URL, { cache: 'force-cache' })
    .then((response) => {
      if (!response.ok) throw new Error(`Failed to load ${RIDI_FONT_URL}: ${response.status}`);
      return response.blob();
    })
    .then(blobToDataUrl)
    .then((dataUrl) => buildBeforeStyle(`url('${dataUrl}') format('woff2')`))
    .catch((error) => {
      console.warn('[EpubReader] Failed to embed RIDIBatang font:', error);
      return URL_RIDI_FONT_FACE;
    });

  return ridiFontFacePromise;
};

const buildReaderStyle = (styles: ReaderStyle) => {
  const fontStack = styles.fontFamily ? FONT_MAP[styles.fontFamily] || styles.fontFamily : '';
  const paragraphSpacing = styles.paragraphSpacing ?? 1;

  return `
    html, body {
      ${styles.bgColor ? `background-color: ${styles.bgColor} !important;` : ''}
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
  const [beforeStyle, setBeforeStyle] = useState(URL_RIDI_FONT_FACE);

  useEffect(() => {
    let cancelled = false;

    loadEmbeddedRidiFontFace().then((fontFaceCss) => {
      if (!cancelled) setBeforeStyle(fontFaceCss);
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const setStyle = useCallback((styles: ReaderStyle) => {
    const view = viewRef.current;
    if (!view?.renderer) return;

    try {
      view.renderer.setStyles([beforeStyle, buildReaderStyle(styles)]);
    } catch (error) {
      console.warn('[EpubReader] Style injection failed:', error);
    }
  }, [beforeStyle, viewRef]);

  const setLayout = useCallback((layout: ReaderLayout) => {
    const view = viewRef.current;
    if (!view?.renderer) return;

    if (layout.flow) view.renderer.setAttribute('flow', layout.flow);
    if (layout.margin !== undefined) view.renderer.setAttribute('margin', `${layout.margin}px`);
    if (layout.gap) view.renderer.setAttribute('gap', layout.gap);
    if (layout.maxColumnCount) view.renderer.setAttribute('max-column-count', String(layout.maxColumnCount));
    if (layout.maxInlineSize) view.renderer.setAttribute('max-inline-size', layout.maxInlineSize);
    if (layout.animated) view.renderer.setAttribute('animated', '');
  }, [viewRef]);

  return {
    setStyle,
    setLayout,
  };
};
