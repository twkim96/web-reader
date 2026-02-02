// src/hooks/useVirtualScroll.ts
import { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';

const BLOCK_SIZE = 15000; 
const MAX_VISIBLE_BLOCKS = 4;

interface UseVirtualScrollProps {
  fullContentRef: React.MutableRefObject<string>;
  isLoaded: boolean;
  hasRestored: boolean; 
  currentIdx: number; 
  onScrollProgress: (idx: number, percent: number) => void;
  layoutDeps?: any[]; // [Added] 레이아웃 변경을 유발하는 의존성 배열
}

export const useVirtualScroll = ({ 
  fullContentRef, 
  isLoaded, 
  hasRestored,
  currentIdx,
  onScrollProgress,
  layoutDeps = [] // [Added] 기본값 빈 배열
}: UseVirtualScrollProps) => {
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 0 });
  const [paddingTop, setPaddingTop] = useState(0);
  
  const blockHeights = useRef<Record<number, number>>({});
  const blockRefs = useRef<Record<number, HTMLDivElement | null>>({});
  
  const isJumping = useRef(false);
  const isResizing = useRef(false);
  const [pendingJump, setPendingJump] = useState<{ blockIdx: number, internalOffset: number } | null>(null);

  const prevStart = useRef(0);

  // Helper: Get Visible Blocks
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

    setPaddingTop(0);
    blockHeights.current = {}; 
    setVisibleRange({ start: blockIdx, end: Math.min(blockIdx + 1, Math.floor(totalLen / BLOCK_SIZE)) });
    prevStart.current = blockIdx;

    setPendingJump({ blockIdx, internalOffset });
  }, [fullContentRef]);

  // [Added] Layout Change Handler (Settings Change)
  // 폰트 크기, 줄 간격 등이 바뀌면 즉시 현재 위치로 재정렬합니다.
  useLayoutEffect(() => {
    if (!isLoaded || !hasRestored) return;

    // 1. 레이아웃 변경 중 스크롤 이벤트 차단
    isResizing.current = true;
    
    // 2. 높이 캐시 초기화
    blockHeights.current = {};

    // 3. 현재 위치로 강제 이동 (Re-anchor)
    jumpToIdx(currentIdx);

    // 4. 짧은 지연 후 차단 해제 (jumpToIdx의 비동기 처리 고려)
    const timer = setTimeout(() => {
      isResizing.current = false;
    }, 100);

    return () => clearTimeout(timer);
  }, layoutDeps); // 의존성 배열(settings 값들)이 변할 때 실행

  // Resize Event Handler
  useEffect(() => {
    let timeoutId: NodeJS.Timeout;

    const handleResize = () => {
      if (!isLoaded || !hasRestored) return;

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

  // Jump Logic
  useEffect(() => {
    if (pendingJump) {
      const { blockIdx, internalOffset } = pendingJump;
      const blockElem = blockRefs.current[blockIdx];

      if (blockElem && blockElem.firstChild) {
        const textNode = blockElem.firstChild;
        try {
          if (textNode.nodeType === Node.TEXT_NODE) {
            const range = document.createRange();
            const offset = Math.min(internalOffset, textNode.textContent?.length || 0);
            range.setStart(textNode, offset);
            range.setEnd(textNode, offset);
            const rect = range.getBoundingClientRect();
            
            const scrollTop = window.scrollY + rect.top - 80; 
            window.scrollTo({ top: scrollTop, behavior: 'instant' });
          } else {
             window.scrollTo({ top: blockElem.offsetTop - 80, behavior: 'instant' });
          }
        } catch (e) {
          console.error("Jump Error", e);
        }
        setPendingJump(null);
        setTimeout(() => { isJumping.current = false; }, 100);
      }
    }
  }, [pendingJump, visibleRange]);

  // Scroll Handler
  useEffect(() => {
    const handleScroll = () => {
      if (isJumping.current || isResizing.current || !isLoaded || !hasRestored || !fullContentRef.current) return;
      
      const scrolled = window.scrollY;
      const vh = window.innerHeight;
      const totalH = document.documentElement.scrollHeight;

      // 1. Scrolling Down
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

      // 2. Scrolling Up
      if (scrolled - paddingTop < 800 && visibleRange.start > 0) {
        setVisibleRange(prev => {
          const newStart = prev.start - 1;
          const h = blockHeights.current[newStart];

          if (h && paddingTop >= h) {
            setPaddingTop(pt => pt - h);
            const newEnd = (prev.end - newStart + 1 > MAX_VISIBLE_BLOCKS) ? prev.end - 1 : prev.end;
            return { start: newStart, end: newEnd };
          } 
          
          const newEnd = (prev.end - newStart + 1 > MAX_VISIBLE_BLOCKS) ? prev.end - 1 : prev.end;
          return { start: newStart, end: newEnd };
        });
      }

      // Progress Calculation
      const firstVisibleBlock = blockRefs.current[visibleRange.start];
      if (firstVisibleBlock) {
        const blockProgress = Math.max(0, (scrolled - paddingTop) / (firstVisibleBlock.offsetHeight || 1));
        const absoluteIdx = Math.floor((visibleRange.start + blockProgress) * BLOCK_SIZE);
        const totalSize = fullContentRef.current.length || 1;
        
        onScrollProgress(Math.min(absoluteIdx, totalSize), (absoluteIdx / totalSize) * 100);
      }
    };
    
    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, [isLoaded, visibleRange, paddingTop, onScrollProgress, hasRestored, fullContentRef]);

  // Scroll Anchoring
  useLayoutEffect(() => {
    if (visibleRange.start < prevStart.current) {
      const addedBlockIdx = visibleRange.start;
      const addedBlock = blockRefs.current[addedBlockIdx];
      
      if (addedBlock) {
        const storedH = blockHeights.current[addedBlockIdx];
        if (!storedH) {
           window.scrollBy(0, addedBlock.offsetHeight);
        }
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
    isJumping
  };
};