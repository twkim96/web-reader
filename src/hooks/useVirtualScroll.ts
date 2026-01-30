// src/hooks/useVirtualScroll.ts
import { useState, useRef, useEffect, useCallback } from 'react';
import { Bookmark } from '../types';

const BLOCK_SIZE = 15000; 
const MAX_VISIBLE_BLOCKS = 4;

interface UseVirtualScrollProps {
  fullContentRef: React.MutableRefObject<string>;
  isLoaded: boolean;
  hasRestored: boolean; // 초기 복원이 끝났는지 여부
  // 스크롤 시 상위 상태(progress)를 업데이트하기 위한 콜백
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

  // Logic: Jump To Index
  const jumpToIdx = useCallback((targetIdx: number) => {
    if (!fullContentRef.current) return;
    
    const totalLen = fullContentRef.current.length || 1;
    const safeIdx = Math.max(0, Math.min(targetIdx, totalLen - 1));
    
    // 1. 가상화 및 스크롤 처리
    isJumping.current = true;
    const blockIdx = Math.floor(safeIdx / BLOCK_SIZE);
    const internalOffset = safeIdx % BLOCK_SIZE;

    setPaddingTop(0);
    blockHeights.current = {};
    setVisibleRange({ start: blockIdx, end: Math.min(blockIdx + 1, Math.floor(totalLen / BLOCK_SIZE)) });

    setPendingJump({ blockIdx, internalOffset });
  }, [fullContentRef]);

  // Logic: Handle Pending Jump (DOM Scroll)
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

  // Logic: Scroll Handler (Virtualization)
  useEffect(() => {
    const handleScroll = () => {
      if (isJumping.current || !isLoaded || !hasRestored || !fullContentRef.current) return;
      
      const scrolled = window.scrollY;
      const vh = window.innerHeight;
      const totalH = document.documentElement.scrollHeight;

      // 무한 스크롤 (아래로)
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
                window.scrollBy(0, -h); // Jank 방지
                return { start: prev.start + 1, end: newEnd };
              }
            }
            return { ...prev, end: newEnd };
          });
        }
      }

      // 무한 스크롤 (위로)
      if (scrolled - paddingTop < 800 && visibleRange.start > 0) {
        setVisibleRange(prev => {
          const newStart = prev.start - 1;
          const h = blockHeights.current[newStart] || 0;
          if (h > 0) {
            setPaddingTop(pt => Math.max(0, pt - h));
            window.scrollBy(0, h); // Jank 방지
            return { 
                start: newStart, 
                end: (prev.end - newStart + 1 > MAX_VISIBLE_BLOCKS) ? prev.end - 1 : prev.end 
            };
          }
          return prev; // 높이 정보 없으면 그냥 유지 (안전장치)
        });
      }

      // 진행률 계산 및 상위 컴포넌트 업데이트
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

  return {
    visibleRange,
    paddingTop,
    blockRefs,
    getVisibleBlocks,
    jumpToIdx,
    isJumping // 외부에서 스크롤 여부 확인 필요시 사용
  };
};