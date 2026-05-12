// src/hooks/useEpubReader.ts
'use client';

import { useRef, useEffect, useCallback, useState } from 'react';

interface RelocateDetail {
  cfi: string;
  fraction: number;       // 현재 섹션 내 진행률 (0~1)
  location: {
    current: number;
    next: number;
    total: number;
  };
  tocItem?: {
    label: string;
    href: string;
  };
  range?: Range;
  index?: number;
}

interface UseEpubReaderOptions {
  onRelocate?: (detail: RelocateDetail) => void;
  onLoad?: () => void;
}

export const useEpubReader = (options?: UseEpubReaderOptions) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<any>(null);
  const [isReady, setIsReady] = useState(false);
  const [totalProgress, setTotalProgress] = useState(0);
  const [currentCfi, setCurrentCfi] = useState<string>('');
  const [currentChapter, setCurrentChapter] = useState<string>('');

  // Foliate-js 초기화 (view.js import 및 <foliate-view> 생성)
  const initView = useCallback(async () => {
    if (!containerRef.current || viewRef.current) return;

    // view.js를 <script type="module">로 로드 (public/ 디렉토리의 static 파일)
    // Next.js의 webpack이 import()를 가로채므로 script 태그 방식 사용
    if (!customElements.get('foliate-view')) {
      console.log('[EpubReader] Loading foliate-js view.js...');
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement('script');
        script.type = 'module';
        script.src = '/foliate-js/view.js';
        script.onload = () => {
          console.log('[EpubReader] view.js script loaded');
        };
        script.onerror = (e) => {
          console.error('[EpubReader] view.js load error:', e);
          reject(e);
        };
        document.head.appendChild(script);
        // module script는 비동기 실행이므로 customElements 등록 대기
        const check = setInterval(() => {
          if (customElements.get('foliate-view')) {
            console.log('[EpubReader] foliate-view custom element registered!');
            clearInterval(check);
            resolve();
          }
        }, 100);
        // 10초 타임아웃
        setTimeout(() => {
          clearInterval(check);
          console.warn('[EpubReader] Timeout waiting for foliate-view registration. Proceeding anyway.');
          resolve();
        }, 10000);
      });
    } else {
      console.log('[EpubReader] foliate-view already registered');
    }

    const view = document.createElement('foliate-view') as any;
    view.style.width = '100%';
    view.style.height = '100%';

    // relocate 이벤트: 위치가 변경될 때마다 호출
    view.addEventListener('relocate', (e: CustomEvent) => {
      const detail = e.detail;
      if (detail) {
        setCurrentCfi(detail.cfi || '');
        
        // 전체 진행률 계산
        if (detail.fraction !== undefined && detail.location) {
          const { current, total } = detail.location;
          if (total > 0) {
            const sectionProgress = detail.fraction;
            const overallProgress = ((current + sectionProgress) / total) * 100;
            setTotalProgress(Math.min(100, Math.max(0, overallProgress)));
          }
        }

        // 현재 챕터명
        if (detail.tocItem?.label) {
          setCurrentChapter(detail.tocItem.label);
        }

        options?.onRelocate?.(detail);
      }
    });

    // load 이벤트: 섹션이 로드될 때
    view.addEventListener('load', () => {
      options?.onLoad?.();
    });

    containerRef.current.appendChild(view);
    viewRef.current = view;
    setIsReady(true);
  }, [options]);

  // epub 파일 열기
  const openBook = useCallback(async (source: Blob | File | string) => {
    if (!viewRef.current) {
      await initView();
    }

    const view = viewRef.current;
    if (!view) return;

    try {
      // Blob → File 변환 (foliate-js의 makeBook은 file.name 속성에 접근)
      let fileSource = source;
      if (source instanceof Blob && !(source instanceof File)) {
        fileSource = new File([source], 'book.epub', { type: 'application/epub+zip' });
      }
      await view.open(fileSource);
    } catch (e) {
      console.error('Failed to open epub:', e);
      throw e;
    }
  }, [initView]);

  // 특정 CFI 위치로 이동
  const goTo = useCallback(async (cfi: string) => {
    const view = viewRef.current;
    if (!view) return;
    try {
      await view.goTo(cfi);
    } catch (e) {
      console.error('Failed to navigate to CFI:', e);
    }
  }, []);

  // fraction(0~1)으로 이동
  const goToFraction = useCallback(async (fraction: number) => {
    const view = viewRef.current;
    if (!view) return;
    try {
      await view.goToFraction(fraction);
    } catch (e) {
      console.error('Failed to navigate to fraction:', e);
    }
  }, []);

  // 이전/다음 페이지
  const prev = useCallback(() => {
    viewRef.current?.prev();
  }, []);

  const next = useCallback(() => {
    viewRef.current?.next();
  }, []);

  // 렌더러 스타일 설정
  const setStyle = useCallback((styles: {
    fontSize?: number;
    lineHeight?: number;
    fontFamily?: string;
    padding?: number;
    textAlign?: string;
  }) => {
    const view = viewRef.current;
    if (!view?.renderer) return;

    // epub 내부 CSS를 오버라이드하기 위한 스타일시트 주입
    const css = `
      body, p, div, span {
        ${styles.fontSize ? `font-size: ${styles.fontSize}px !important;` : ''}
        ${styles.lineHeight ? `line-height: ${styles.lineHeight} !important;` : ''}
        ${styles.fontFamily ? `font-family: ${styles.fontFamily} !important;` : ''}
        ${styles.textAlign ? `text-align: ${styles.textAlign} !important;` : ''}
      }
    `;

    // view.renderer에 setStyles 또는 CSS를 주입하는 방법은
    // foliate-js 버전에 따라 다를 수 있음 — 추후 Phase 2에서 정밀 조정
    try {
      if (view.renderer?.setStyles) {
        view.renderer.setStyles(css);
      }
    } catch (e) {
      console.warn('Style injection not yet supported:', e);
    }
  }, []);

  // 렌더러 레이아웃 설정 (페이지/스크롤 모드)
  const setLayout = useCallback((layout: {
    flow?: 'paginated' | 'scrolled';
    margin?: number;
    gap?: string;
    maxColumnCount?: number;
    animated?: boolean;
  }) => {
    const view = viewRef.current;
    if (!view?.renderer) return;

    if (layout.flow) view.renderer.setAttribute('flow', layout.flow);
    if (layout.margin) view.renderer.setAttribute('margin', `${layout.margin}px`);
    if (layout.gap) view.renderer.setAttribute('gap', layout.gap);
    if (layout.maxColumnCount) view.renderer.setAttribute('max-column-count', String(layout.maxColumnCount));
    if (layout.animated) view.renderer.setAttribute('animated', '');
  }, []);

  // 검색
  const search = useCallback(async (query: string): Promise<any[]> => {
    const view = viewRef.current;
    if (!view) return [];
    // foliate-js의 search 기능은 view 인스턴스를 통해 접근
    // 구체적인 API는 Phase 2에서 구현
    return [];
  }, []);

  // cleanup
  useEffect(() => {
    return () => {
      if (viewRef.current && containerRef.current) {
        try {
          containerRef.current.removeChild(viewRef.current);
        } catch { /* already removed */ }
        viewRef.current = null;
      }
    };
  }, []);

  return {
    containerRef,
    isReady,
    totalProgress,
    currentCfi,
    currentChapter,
    openBook,
    goTo,
    goToFraction,
    prev,
    next,
    setStyle,
    setLayout,
    search,
    viewRef,
  };
};
