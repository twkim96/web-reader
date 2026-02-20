// src/hooks/useVirtualScroll.ts
import { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';

const BLOCK_SIZE = 15000; 
const MAX_VISIBLE_BLOCKS = 4;
// [Added] 블록당 가상 높이 추정치 (스크롤바 위치를 정상적으로 잡기 위함)
const ESTIMATED_BLOCK_HEIGHT = 15000; 

interface UseVirtualScrollProps {
  fullContentRef: React.MutableRefObject<string>;
  isLoaded: boolean;
  hasRestored: boolean; 
  currentIdx: number; 
  onScrollProgress: (idx: number, percent: number) => void;
  layoutDeps?: any[];
}

export const useVirtualScroll = ({ 
  fullContentRef, 
  isLoaded, 
  hasRestored,
  currentIdx,
  onScrollProgress,
  layoutDeps = []
}: UseVirtualScrollProps) => {
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 0 });
  const [paddingTop, setPaddingTop] = useState(0);
  
  const blockHeights = useRef<Record<number, number>>({});
  const blockRefs = useRef<Record<number, HTMLDivElement | null>>({});
  
  const isJumping = useRef(false);
  const isResizing = useRef(false);
  const [pendingJump, setPendingJump] = useState<{ blockIdx: number, internalOffset: number } | null>(null);

  const prevStart = useRef(0);
  const scrollTimeout = useRef<NodeJS.Timeout | null>(null);

  // [Added] 탭 이동 히스토리 스택 (이전 페이지 복귀용)
  const pageHistory = useRef<number[]>([]);

  const getVisibleBlocks = () => {
    const blocks = [];
    if (!fullContentRef.current) return [];
    
    for (let i = visibleRange.start; i <= visibleRange.end; i++) {
      const start = i * BLOCK_SIZE;
      const end = Math.min(start + BLOCK_SIZE, fullContentRef.current.length);
      if (start < fullContentRef.current.length) {
        blocks.push({ index: i, text: fullContentRef.current.substring(start, end) });
      }
    }
    return blocks;
  };

  const jumpToIdx = useCallback((targetIdx: number) => {
    if (!fullContentRef.current) return;
    
    const totalLen = fullContentRef.current.length || 1;
    const safeIdx = Math.max(0, Math.min(targetIdx, totalLen - 1));
    
    isJumping.current = true;
    const blockIdx = Math.floor(safeIdx / BLOCK_SIZE);
    const internalOffset = safeIdx % BLOCK_SIZE;

    setPaddingTop(blockIdx * ESTIMATED_BLOCK_HEIGHT);
    blockHeights.current = {}; 
    setVisibleRange({ start: blockIdx, end: Math.min(blockIdx + 1, Math.floor(totalLen / BLOCK_SIZE)) });
    prevStart.current = blockIdx;

    setPendingJump({ blockIdx, internalOffset });
  }, [fullContentRef]);

  // [Added] 다음 페이지 이동:
  // 현재 뷰포트에서 완전히 보이는 마지막 줄의 바로 다음 줄 top으로 이동.
  // 잘리는 줄은 다음 페이지 첫 줄이 되어 글자가 잘리지 않는다.
  const goNextPage = useCallback(() => {
    const NAV_HEIGHT = 64; // 상단 네비게이션 높이 (px)

    let nextPageTop: number | null = null;

    // 현재 렌더링된 블록 인덱스를 순서대로 순회
    const blockIndices = Object.keys(blockRefs.current)
      .map(Number)
      .sort((a, b) => a - b);

    outer:
    for (const idx of blockIndices) {
      const blockElem = blockRefs.current[idx];
      if (!blockElem) continue;

      // Range.getClientRects()로 실제 렌더링된 줄별 rect 수집
      // (whitespace-pre-wrap, 폰트, 패딩 등 모두 반영된 실측값)
      const range = document.createRange();
      range.selectNodeContents(blockElem);
      const rects = Array.from(range.getClientRects());

      for (const rect of rects) {
        // rect.bottom이 뷰포트 하단(window.innerHeight)을 벗어난 첫 번째 줄
        // = 현재 화면에서 잘리는 줄 = 다음 페이지 첫 줄
        if (rect.top < window.innerHeight && rect.bottom > window.innerHeight - 1) {
          // 이 줄이 뷰포트 하단에 걸쳐 있음 (잘림 발생)
          // → 이 줄의 절대 top을 다음 페이지 시작점으로 사용
          nextPageTop = window.scrollY + rect.top - NAV_HEIGHT;
          break outer;
        }
        if (rect.top >= window.innerHeight) {
          // 이미 완전히 화면 밖인 줄이 나타났으면 바로 직전 줄이 경계
          nextPageTop = window.scrollY + rect.top - NAV_HEIGHT;
          break outer;
        }
      }
    }

    // 찾지 못한 경우 기존 방식 fallback
    const targetScrollTop = nextPageTop ?? (window.scrollY + window.innerHeight - NAV_HEIGHT);

    // 현재 위치를 히스토리 스택에 저장 (이전 페이지 복귀용)
    pageHistory.current.push(window.scrollY);

    window.scrollTo({ top: targetScrollTop, behavior: 'instant' });
  }, [blockRefs]);

  // [Added] 이전 페이지 복귀:
  // pageHistory 스택에서 이전 scrollY를 꺼내 복원.
  // 중복/건너뜀 없이 정확한 이전 페이지 시작점으로 돌아간다.
  const goPrevPage = useCallback(() => {
    const prevTop = pageHistory.current.pop();
    if (prevTop !== undefined) {
      window.scrollTo({ top: prevTop, behavior: 'instant' });
    }
  }, []);

  // Layout Change
  useLayoutEffect(() => {
    if (!isLoaded || !hasRestored) return;

    isResizing.current = true;
    blockHeights.current = {};
    jumpToIdx(currentIdx);

    const timer = setTimeout(() => {
      isResizing.current = false;
    }, 100);

    return () => clearTimeout(timer);
  }, layoutDeps); 

  // Resize
  useEffect(() => {
    let timeoutId: NodeJS.Timeout;
    let lastWidth = window.innerWidth;

    const handleResize = () => {
      if (!isLoaded || !hasRestored) return;

      if (window.innerWidth === lastWidth) {
        return;
      }
      lastWidth = window.innerWidth;

      isResizing.current = true;

      clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        blockHeights.current = {};
        jumpToIdx(currentIdx);
        isResizing.current = false;
      }, 150);
    };

    window.addEventListener('resize', handleResize);
    return () => {
      window.removeEventListener('resize', handleResize);
      clearTimeout(timeoutId);
    };
  }, [isLoaded, hasRestored, currentIdx, jumpToIdx]);

  // Execute Jump
  useEffect(() => {
    if (pendingJump) {
      const executeJump = () => {
        const { blockIdx, internalOffset } = pendingJump;
        const blockElem = blockRefs.current[blockIdx];

        if (blockElem) {
          try {
            let targetNode: Node | null = null;
            let targetNodeOffset = 0;
            let currentOffset = 0;
            
            const walk = document.createTreeWalker(blockElem, NodeFilter.SHOW_TEXT, null);
            let node = walk.nextNode();
            
            while (node) {
              const len = node.nodeValue?.length || 0;
              if (currentOffset + len >= internalOffset) {
                targetNode = node;
                targetNodeOffset = internalOffset - currentOffset;
                break;
              }
              currentOffset += len;
              node = walk.nextNode();
            }

            if (targetNode) {
              const range = document.createRange();
              range.setStart(targetNode, targetNodeOffset);
              range.setEnd(targetNode, targetNodeOffset);
              const rect = range.getBoundingClientRect();
              
              const scrollTop = window.scrollY + rect.top - 80; 
              window.scrollTo({ top: scrollTop, behavior: 'instant' });
            } else {
               window.scrollTo({ top: blockElem.offsetTop - 80, behavior: 'instant' });
            }
          } catch (e) {
            console.error("Jump Error", e);
            window.scrollTo({ top: blockElem.offsetTop - 80, behavior: 'instant' });
          }
          setPendingJump(null);
          setTimeout(() => { isJumping.current = false; }, 100);
        }
      };

      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => {
          requestAnimationFrame(executeJump);
        });
      } else {
        requestAnimationFrame(executeJump);
      }
    }
  }, [pendingJump, visibleRange]);

  // 화면 최상단(y:80 부근)의 텍스트 노드 Index를 이진 탐색으로 추출
  const getExactVisibleIndex = useCallback(() => {
    if (!fullContentRef.current) return null;
    
    // 블록 걸침 현상을 대비해 최상단 2개 블록 탐색
    const blocksToCheck = [visibleRange.start, visibleRange.start + 1];

    for (const blockIdx of blocksToCheck) {
      const blockElem = blockRefs.current[blockIdx];
      if (!blockElem) continue;

      const targetViewportY = 80; // 상단 Nav 바 영역(약 64px) + 여백
      const textNode = blockElem.firstChild;
      
      if (!textNode || textNode.nodeType !== Node.TEXT_NODE) continue;

      const blockRect = blockElem.getBoundingClientRect();
      if (blockRect.bottom < targetViewportY) {
        continue; // 이 블록은 이미 스크롤로 지나쳐 화면 밖에 있음
      }

      let low = 0;
      let high = textNode.nodeValue?.length || 0;
      let bestOffset = -1;
      const range = document.createRange();

      while (low <= high) {
        const mid = Math.floor((low + high) / 2);
        try {
          range.setStart(textNode, mid);
          range.setEnd(textNode, mid);
          const rect = range.getBoundingClientRect();
          
          if (rect.top >= targetViewportY) {
            bestOffset = mid;
            high = mid - 1; // 목표점 아래에 있으므로 더 앞쪽 글자를 탐색
          } else {
            low = mid + 1; // 목표점보다 위에 가려져 있으므로 뒤쪽 글자를 탐색
          }
        } catch (e) {
          break;
        }
      }
      
      if (bestOffset !== -1) {
        return (blockIdx * BLOCK_SIZE) + bestOffset;
      }
    }
    return null;
  }, [visibleRange.start, fullContentRef]);

  // Scroll Handler
  useEffect(() => {
    const handleScroll = () => {
      if (isJumping.current || isResizing.current || !isLoaded || !hasRestored || !fullContentRef.current) return;
      
      const scrolled = window.scrollY;
      const vh = window.innerHeight;
      const totalH = document.documentElement.scrollHeight;

      // 1. Scrolling Down (블록 렌더링 즉시 처리)
      if (totalH - (scrolled + vh) < 1500) {
        if ((visibleRange.end + 1) * BLOCK_SIZE < fullContentRef.current.length) {
          setVisibleRange(prev => {
            const newEnd = prev.end + 1;
            if (newEnd - prev.start + 1 > MAX_VISIBLE_BLOCKS) {
              const startBlock = blockRefs.current[prev.start];
              if (startBlock) {
                const h = startBlock.offsetHeight;
                blockHeights.current[prev.start] = h;
                setPaddingTop(pt => pt + h);
                return { start: prev.start + 1, end: newEnd };
              }
            }
            return { ...prev, end: newEnd };
          });
        }
      }

      // 2. Scrolling Up (블록 해제 즉시 처리)
      if (scrolled - paddingTop < 800 && visibleRange.start > 0) {
        setVisibleRange(prev => {
          const newStart = prev.start - 1;
          const newEnd = (prev.end - newStart + 1 > MAX_VISIBLE_BLOCKS) ? prev.end - 1 : prev.end;
          return { start: newStart, end: newEnd };
        });
      }

      // 3. Progress Calculation (성능을 위해 150ms 디바운스 처리 후 정확한 DOM 측정)
      if (scrollTimeout.current) clearTimeout(scrollTimeout.current);
      scrollTimeout.current = setTimeout(() => {
        const totalSize = fullContentRef.current.length || 1;
        const exactIdx = getExactVisibleIndex();

        if (exactIdx !== null) {
          onScrollProgress(Math.min(exactIdx, totalSize), (exactIdx / totalSize) * 100);
        } else {
          // 예외적으로 스캔 실패 시 기존의 비율 추정식으로 Fallback
          const firstVisibleBlock = blockRefs.current[visibleRange.start];
          if (firstVisibleBlock) {
            const blockProgress = Math.max(0, (scrolled - paddingTop) / (firstVisibleBlock.offsetHeight || 1));
            const absoluteIdx = Math.floor((visibleRange.start + blockProgress) * BLOCK_SIZE);
            onScrollProgress(Math.min(absoluteIdx, totalSize), (absoluteIdx / totalSize) * 100);
          }
        }
      }, 150);
    };
    
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', handleScroll);
      if (scrollTimeout.current) clearTimeout(scrollTimeout.current);
    };
  }, [isLoaded, visibleRange, paddingTop, onScrollProgress, hasRestored, fullContentRef, getExactVisibleIndex]);

  // Scroll Anchoring (이전 블록 로드 시 화면 떨림/튕김 완벽 제어)
  useLayoutEffect(() => {
    if (visibleRange.start < prevStart.current) {
      const addedBlockIdx = visibleRange.start;
      const addedBlock = blockRefs.current[addedBlockIdx];
      
      if (addedBlock) {
        const h = addedBlock.offsetHeight;
        blockHeights.current[addedBlockIdx] = h;
        
        setPaddingTop(prev => {
          if (prev >= h) {
            return prev - h;
          } else {
            const diff = h - prev;
            const originalStyle = document.documentElement.style.scrollBehavior;
            document.documentElement.style.scrollBehavior = 'auto'; 
            document.body.style.overflowAnchor = 'none'; 
            
            window.scrollBy({ top: diff, behavior: 'instant' });
            
            setTimeout(() => {
              document.documentElement.style.scrollBehavior = originalStyle || '';
              document.body.style.overflowAnchor = '';
            }, 50);
            return 0;
          }
        });
      }
    }
    prevStart.current = visibleRange.start;
  }, [visibleRange.start]);

  return {
    visibleRange,
    paddingTop,
    blockRefs,
    getVisibleBlocks,
    jumpToIdx,
    isJumping,
    goNextPage,   // [Added]
    goPrevPage,   // [Added]
  };
};