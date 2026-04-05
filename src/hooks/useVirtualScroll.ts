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

  // [Added] 화면 최상단(y:80 부근)의 텍스트 노드 Index를 TreeWalker와 다중 블록 순회로 정밀하게 추출
  const getExactVisibleIndex = useCallback(() => {
    if (!fullContentRef.current) return null;
    
    // 렌더링된 모든 가시 블록을 순회
    const blocksToCheck = [];
    for (let i = visibleRange.start; i <= visibleRange.end; i++) {
      blocksToCheck.push(i);
    }

    for (const blockIdx of blocksToCheck) {
      const blockElem = blockRefs.current[blockIdx];
      if (!blockElem) continue;

      const targetViewportY = 80; // 상단 Nav 바 영역(약 64px) + 여백
      const blockRect = blockElem.getBoundingClientRect();
      
      // 블록이 완전히 화면 위로 지나갔다면 스킵
      if (blockRect.bottom < targetViewportY) continue;
      
      // 블록이 완전히 화면 아래에 있다면 더 이상 아래 블록은 탐색할 필요 없음
      if (blockRect.top > window.innerHeight) break;

      const walk = document.createTreeWalker(blockElem, NodeFilter.SHOW_TEXT, null);
      let node: Node | null;
      let offsetAcc = 0;
      let bestIdx = -1;

      while ((node = walk.nextNode())) {
        const len = node.nodeValue?.length || 0;
        if (len === 0) continue;

        const range = document.createRange();
        range.selectNodeContents(node);
        const nodeRect = range.getBoundingClientRect();

        // 텍스트 노드가 목표선 아래에 있거나 목표선에 걸쳐있을 경우만 내부 이진 탐색 진행
        if (nodeRect.bottom >= targetViewportY) {
          let low = 0;
          let high = len - 1;
          let localBest = -1;

          while (low <= high) {
            const mid = Math.floor((low + high) / 2);
            try {
              range.setStart(node, mid);
              // 부피를 가진 1글자 Range 생성하여 정확한 좌표 측정
              range.setEnd(node, Math.min(mid + 1, len)); 
              const rect = range.getBoundingClientRect();
              
              if (rect.top >= targetViewportY) {
                localBest = mid;
                high = mid - 1; // 목표점 아래에 있으므로 더 앞쪽 글자를 탐색
              } else {
                low = mid + 1; // 목표점보다 위에 가려져 있으므로 뒤쪽 글자를 탐색
              }
            } catch (e) {
              break;
            }
          }
          
          if (localBest !== -1) {
            bestIdx = offsetAcc + localBest;
            break; // 해당 블록에서 위치를 찾았으므로 더 이상 텍스트 노드를 순회하지 않음
          }
        }
        offsetAcc += len;
      }
      
      // 정밀 탐색으로 위치를 찾아냈다면 즉시 반환
      if (bestIdx !== -1) {
        return (blockIdx * BLOCK_SIZE) + bestIdx;
      }
    }
    return null;
  }, [visibleRange, fullContentRef]);

  const jumpToIdx = useCallback((targetIdx: number) => {
    if (!fullContentRef.current) return;
    
    const totalLen = fullContentRef.current.length || 1;
    const safeIdx = Math.max(0, Math.min(targetIdx, totalLen - 1));
    
    isJumping.current = true;
    const blockIdx = Math.floor(safeIdx / BLOCK_SIZE);
    const internalOffset = safeIdx % BLOCK_SIZE;

    setPaddingTop(blockIdx * ESTIMATED_BLOCK_HEIGHT);
    blockHeights.current = {}; 
    
    // [Fix] 점프 시 앞뒤로 여유 블록 1개씩 추가 로딩하여 텍스트 끊김 현상 방지
    const totalBlocks = Math.floor(totalLen / BLOCK_SIZE);
    setVisibleRange({ 
      start: Math.max(0, blockIdx - 1), 
      end: Math.min(blockIdx + 2, totalBlocks) 
    });
    
    prevStart.current = blockIdx;
    setPendingJump({ blockIdx, internalOffset });
  }, [fullContentRef]);

  // Execute Jump
  // [Fix] useLayoutEffect를 사용하여 DOM이 업데이트된 직후(화면이 그려지기 직전)에 스크롤 위치를 고정.
  // 여백(paddingTop) 변화와 스크롤 이동이 한 번에 일어나게 하여 공백 현상을 제거합니다.
  useLayoutEffect(() => {
    if (pendingJump) {
      const { blockIdx, internalOffset } = pendingJump;
      const blockElem = blockRefs.current[blockIdx];

      // 블록이 아직 렌더링되지 않았다면 다음 렌더링에서 재시도 (pendingJump를 유지)
      if (!blockElem) return;

      const executeJump = () => {
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
            range.setEnd(targetNode, Math.min((targetNode.nodeValue?.length || targetNodeOffset), targetNodeOffset + 1));
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
        
        requestAnimationFrame(() => {
          const exactIdx = getExactVisibleIndex();
          if (exactIdx !== null) {
            const totalSize = fullContentRef.current.length || 1;
            onScrollProgress(exactIdx, (exactIdx / totalSize) * 100);
          }
          setTimeout(() => { isJumping.current = false; }, 150);
        });
      };

      if (document.fonts && document.fonts.ready) {
        document.fonts.ready.then(() => requestAnimationFrame(executeJump));
      } else {
        requestAnimationFrame(executeJump);
      }
    }
  }, [pendingJump, visibleRange, getExactVisibleIndex, onScrollProgress, fullContentRef]);

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
    isJumping
  };
};