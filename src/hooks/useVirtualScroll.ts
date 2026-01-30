// src/hooks/useVirtualScroll.ts
import { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';

const BLOCK_SIZE = 15000; 
const MAX_VISIBLE_BLOCKS = 4;

interface UseVirtualScrollProps {
  fullContentRef: React.MutableRefObject<string>;
  isLoaded: boolean;
  hasRestored: boolean; 
  onScrollProgress: (idx: number, percent: number) => void; 
}

export const useVirtualScroll = ({ 
  fullContentRef, 
  isLoaded, 
  hasRestored,
  onScrollProgress
}: UseVirtualScrollProps) => {
  const [visibleRange, setVisibleRange] = useState({ start: 0, end: 0 });
  const [paddingTop, setPaddingTop] = useState(0);
  
  const blockHeights = useRef<Record<number, number>>({});
  const blockRefs = useRef<Record<number, HTMLDivElement | null>>({});
  
  const isJumping = useRef(false);
  const [pendingJump, setPendingJump] = useState<{ blockIdx: number, internalOffset: number } | null>(null);

  // [Fix 2] Scroll Anchoring을 위한 이전 시작 인덱스 추적
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
    prevStart.current = blockIdx; // 점프 시 prevStart 초기화

    setPendingJump({ blockIdx, internalOffset });
  }, [fullContentRef]);

  // Jump 처리 로직
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
            window.scrollTo({ top: window.scrollY + rect.top - 20, behavior: 'instant' });
          } else {
             window.scrollTo({ top: blockElem.offsetTop, behavior: 'instant' });
          }
        } catch (e) {
          console.error("Jump Error", e);
        }
        setPendingJump(null);
        setTimeout(() => { isJumping.current = false; }, 100);
      }
    }
  }, [pendingJump, visibleRange]);

  // [Fix 2 & 3] 무한 스크롤 및 텍스트 정리 로직 개선
  useEffect(() => {
    const handleScroll = () => {
      if (isJumping.current || !isLoaded || !hasRestored || !fullContentRef.current) return;
      
      const scrolled = window.scrollY;
      const vh = window.innerHeight;
      const totalH = document.documentElement.scrollHeight;

      // 1. 하단 무한 스크롤 (Scrolling Down)
      if (totalH - (scrolled + vh) < 1500) {
        if ((visibleRange.end + 1) * BLOCK_SIZE < fullContentRef.current.length) {
          setVisibleRange(prev => {
            const newEnd = prev.end + 1;
            // 상단 블록 제거 (Cleanup Top)
            if (newEnd - prev.start + 1 > MAX_VISIBLE_BLOCKS) {
              const startBlock = blockRefs.current[prev.start];
              // [Fix 3] 높이를 구할 수 있으면 paddingTop에 더하고 start 증가
              if (startBlock) {
                const h = startBlock.offsetHeight;
                blockHeights.current[prev.start] = h;
                setPaddingTop(pt => pt + h);
                // Note: paddingTop을 추가하면 요소가 제거된 만큼 빈 공간이 생기므로 
                // 브라우저가 자동으로 스크롤 위치를 유지합니다. scrollBy 불필요.
                return { start: prev.start + 1, end: newEnd };
              }
              // 높이를 못 구해도 메모리 관리를 위해 강제로 start 증가 고려 가능하나, 
              // 스크롤 튐 방지를 위해 안전하게 유지하거나 추정치 사용. 여기서는 유지.
            }
            return { ...prev, end: newEnd };
          });
        }
      }

      // 2. 상단 무한 스크롤 (Scrolling Up)
      // [Fix 2] 높이 정보가 없어도(Jump 직후) 상단 블록을 로드할 수 있도록 조건 완화
      if (scrolled - paddingTop < 800 && visibleRange.start > 0) {
        setVisibleRange(prev => {
          const newStart = prev.start - 1;
          const h = blockHeights.current[newStart];

          // 이전에 저장된 높이 정보가 있고, paddingTop이 그보다 크다면 (일반적인 스크롤 업)
          if (h && paddingTop >= h) {
            setPaddingTop(pt => pt - h);
            // 하단 블록 제거 (Cleanup Bottom)
            const newEnd = (prev.end - newStart + 1 > MAX_VISIBLE_BLOCKS) ? prev.end - 1 : prev.end;
            return { start: newStart, end: newEnd };
          } 
          
          // [Fix 2] 높이 정보가 없거나 paddingTop이 0인 경우 (점프 후 상단 로드)
          // paddingTop을 건드리지 않고 start만 줄여서 렌더링을 유도함.
          // 위치 보정은 useLayoutEffect에서 수행.
          const newEnd = (prev.end - newStart + 1 > MAX_VISIBLE_BLOCKS) ? prev.end - 1 : prev.end;
          return { start: newStart, end: newEnd };
        });
      }

      // 진행률 계산
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

  // [Fix 2] 상단에 새 블록이 추가되었을 때 스크롤 위치 보정 (Scroll Anchoring)
  useLayoutEffect(() => {
    // start 인덱스가 줄어들었다면 (상단 블록 추가됨)
    if (visibleRange.start < prevStart.current) {
      const addedBlockIdx = visibleRange.start;
      const addedBlock = blockRefs.current[addedBlockIdx];
      
      if (addedBlock) {
        // paddingTop으로 보정되지 않은 경우 (높이 정보가 없었거나 Jump 직후)
        // 브라우저는 새 요소를 상단에 끼워넣어 전체 높이를 늘리지만 스크롤 위치는 그대로 둡니다.
        // 사용자는 내용이 아래로 밀리는 것을 보게 되므로, 추가된 높이만큼 스크롤을 내려야 합니다.
        
        // 만약 paddingTop을 줄여서 보정했다면 이 로직이 필요 없을 수 있으나,
        // 위 handleScroll에서 paddingTop을 줄이지 못한 경우(else 분기)를 커버합니다.
        
        // 간단한 판단 기준: 현재의 paddingTop이 보정하려는 높이보다 현저히 작다면 보정이 안 된 것임.
        // 하지만 더 확실한 것은, handleScroll에서 보정하지 '않은' 경우에만 동작하도록 하는 것이지만,
        // 여기서는 안전하게 "이전에 높이를 몰랐던 블록"인 경우에만 스크롤을 이동시킵니다.
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