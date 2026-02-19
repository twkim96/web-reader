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

    // [Modified] 최상단으로 스크롤바가 쏠리는 현상을 막기 위해 추정 높이 적용
    setPaddingTop(blockIdx * ESTIMATED_BLOCK_HEIGHT);
    blockHeights.current = {}; 
    setVisibleRange({ start: blockIdx, end: Math.min(blockIdx + 1, Math.floor(totalLen / BLOCK_SIZE)) });
    prevStart.current = blockIdx;

    setPendingJump({ blockIdx, internalOffset });
  }, [fullContentRef]);

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

      // 2. Scrolling Up (여백 처리 분리)
      if (scrolled - paddingTop < 800 && visibleRange.start > 0) {
        setVisibleRange(prev => {
          const newStart = prev.start - 1;
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

  // [Modified] Scroll Anchoring (이전 블록 로드 시 화면 떨림/튕김 완벽 제어)
  useLayoutEffect(() => {
    if (visibleRange.start < prevStart.current) {
      const addedBlockIdx = visibleRange.start;
      const addedBlock = blockRefs.current[addedBlockIdx];
      
      if (addedBlock) {
        const h = addedBlock.offsetHeight;
        blockHeights.current[addedBlockIdx] = h;
        
        // 새로 추가된 블록의 실제 높이만큼 paddingTop을 정확히 깎아냄 (Layout Shift 무효화)
        setPaddingTop(prev => {
          if (prev >= h) {
            return prev - h;
          } else {
            // paddingTop이 부족할 경우(가상 추정치 오차)에만 강제로 위치 재조정
            const diff = h - prev;
            const originalStyle = document.documentElement.style.scrollBehavior;
            document.documentElement.style.scrollBehavior = 'auto'; // 스무스 스크롤 임시 해제
            document.body.style.overflowAnchor = 'none'; // 브라우저 자동 앵커링 충돌 방지
            
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
    isJumping
  };
};