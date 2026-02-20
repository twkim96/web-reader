// src/hooks/useVirtualScroll.ts
import { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';

const BLOCK_SIZE = 15000; 
const MAX_VISIBLE_BLOCKS = 4;
const ESTIMATED_BLOCK_HEIGHT = 15000; 
const TOP_NAV_HEIGHT = 64; // 고정된 오프셋

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
              
              const scrollTop = window.scrollY + rect.top - TOP_NAV_HEIGHT; 
              window.scrollTo({ top: scrollTop, behavior: 'instant' });
            } else {
               window.scrollTo({ top: blockElem.offsetTop - TOP_NAV_HEIGHT, behavior: 'instant' });
            }
          } catch (e) {
            console.error("Jump Error", e);
            window.scrollTo({ top: blockElem.offsetTop - TOP_NAV_HEIGHT, behavior: 'instant' });
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

  const getExactVisibleIndex = useCallback(() => {
    if (!fullContentRef.current) return null;
    
    const blocksToCheck = [visibleRange.start, visibleRange.start + 1];

    for (const blockIdx of blocksToCheck) {
      const blockElem = blockRefs.current[blockIdx];
      if (!blockElem) continue;

      // [Fix] 화면 최상단의 기준점을 변형 없는 고정 픽셀(64px)로 설정
      const targetViewportY = TOP_NAV_HEIGHT; 
      const textNode = blockElem.firstChild;
      
      if (!textNode || textNode.nodeType !== Node.TEXT_NODE) continue;

      const blockRect = blockElem.getBoundingClientRect();
      if (blockRect.bottom < targetViewportY) {
        continue; 
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
            high = mid - 1; 
          } else {
            low = mid + 1; 
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

      if (scrolled - paddingTop < 800 && visibleRange.start > 0) {
        setVisibleRange(prev => {
          const newStart = prev.start - 1;
          const newEnd = (prev.end - newStart + 1 > MAX_VISIBLE_BLOCKS) ? prev.end - 1 : prev.end;
          return { start: newStart, end: newEnd };
        });
      }

      if (scrollTimeout.current) clearTimeout(scrollTimeout.current);
      scrollTimeout.current = setTimeout(() => {
        const totalSize = fullContentRef.current.length || 1;
        const exactIdx = getExactVisibleIndex();

        if (exactIdx !== null) {
          onScrollProgress(Math.min(exactIdx, totalSize), (exactIdx / totalSize) * 100);
        } else {
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

  // Scroll Anchoring
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
    isJumping
  };
};