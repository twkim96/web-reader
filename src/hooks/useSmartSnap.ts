import { useState, useEffect, useRef, useCallback } from 'react';
import { ViewerSettings } from '../types';

interface UseSmartSnapProps {
  settings: ViewerSettings;
  blockRefs: React.MutableRefObject<Record<number, HTMLDivElement | null>>;
  getVisibleBlocks: () => { index: number; text: string }[];
  isJumping: React.MutableRefObject<boolean>;
}

export const useSmartSnap = ({
  settings,
  blockRefs,
  getVisibleBlocks,
  isJumping
}: UseSmartSnapProps) => {
  const [maskHeight, setMaskHeight] = useState(0);
  const measureRef = useRef<HTMLDivElement>(null);
  const [actualLineHeight, setActualLineHeight] = useState(settings.fontSize * settings.lineHeight);
  const skipNextSnap = useRef(false);

  useEffect(() => {
    if (measureRef.current) {
      const h = measureRef.current.getBoundingClientRect().height;
      if (h > 0) setActualLineHeight(h);
    }
  }, [settings.fontSize, settings.lineHeight, settings.fontFamily]);

  const getGridSnapY = useCallback((targetY: number) => {
    const lh = actualLineHeight;
    let baseTop = lh;
    
    const topPadding = lh;
    
    const blocks = getVisibleBlocks();
    if (blocks.length === 0) return 0;
    
    const firstElem = blockRefs.current[blocks[0].index];
    if (firstElem) {
      baseTop = window.scrollY + firstElem.getBoundingClientRect().top;
    }
    
    if (targetY < lh) return 0;

    // 1. 그리드 스냅을 먼저 계산 (현재 targetY가 뷰포트 기준이므로 topPadding을 더해 텍스트 기준 좌표로 변환 후 반올림)
    const gridY = Math.round((targetY + topPadding - baseTop) / lh) * lh + baseTop;
    let finalGridY = gridY;
    
    for (const block of blocks) {
      const blockElem = blockRefs.current[block.index];
      if (!blockElem) continue;
      
      const blockDocBottom = window.scrollY + blockElem.getBoundingClientRect().bottom;
      if (blockDocBottom < gridY - 2) continue;
      
      const walk = document.createTreeWalker(blockElem, NodeFilter.SHOW_TEXT, null);
      let node: Node | null;
      let found = false;

      while ((node = walk.nextNode())) {
        const text = node.nodeValue || "";
        if (text.trim() === "") continue;

        const range = document.createRange();
        range.selectNodeContents(node);
        const nodeDocBottom = window.scrollY + range.getBoundingClientRect().bottom;
        if (nodeDocBottom < gridY - 2) continue;

        let low = 0, high = text.length - 1, firstIdx = -1;
        while (low <= high) {
          const mid = Math.floor((low + high) / 2);
          try {
            range.setStart(node, mid);
            range.setEnd(node, mid + 1);
            const charCenterY = window.scrollY + range.getBoundingClientRect().top + range.getBoundingClientRect().height / 2;
            if (charCenterY >= gridY) { firstIdx = mid; high = mid - 1; }
            else { low = mid + 1; }
          } catch { break; }
        }

        if (firstIdx !== -1) {
          for (let i = firstIdx; i < text.length; i++) {
            if (text[i].trim() === "") continue;
            try {
              range.setStart(node, i);
              range.setEnd(node, i + 1);
              const rect = range.getBoundingClientRect();
              const charCenterY = window.scrollY + rect.top + rect.height / 2;
              finalGridY = Math.floor((charCenterY - baseTop) / lh) * lh + baseTop;
              found = true;
              break;
            } catch { break; }
          }
        }
        if (found) break;
      }
      if (found) break;
    }

    return Math.max(0, finalGridY - topPadding);
  }, [actualLineHeight, getVisibleBlocks, blockRefs]);

  const snapTimerRef = useRef<NodeJS.Timeout | undefined>(undefined);
  const snapFuncRef = useRef(getGridSnapY);
  useEffect(() => { snapFuncRef.current = getGridSnapY; }, [getGridSnapY]);

  useEffect(() => {
    const updateMaskAndSnap = () => {
      const lh = actualLineHeight;
      const h = document.documentElement.clientHeight || window.innerHeight;
      const topPadding = lh; 
      const lines = Math.floor((h - topPadding) / lh);
      setMaskHeight(Math.max(0, h - (lines * lh) - topPadding));
    };

    const handleScroll = () => {
      clearTimeout(snapTimerRef.current);
      snapTimerRef.current = setTimeout(() => {
        if (skipNextSnap.current) { skipNextSnap.current = false; return; }
        if (isJumping.current) return;
        
        const currentY = window.scrollY;
        const snapY = snapFuncRef.current(currentY);
        
        if (Math.abs(snapY - currentY) > 2) { 
          window.scrollTo({ top: snapY, behavior: 'smooth' });
        }
      }, 300);
    };

    updateMaskAndSnap();
    window.addEventListener('resize', updateMaskAndSnap);
    window.addEventListener('scroll', handleScroll, { passive: true });
    
    return () => {
      window.removeEventListener('resize', updateMaskAndSnap);
      window.removeEventListener('scroll', handleScroll);
      clearTimeout(snapTimerRef.current);
    };
  }, [actualLineHeight, isJumping]);

  return {
    maskHeight,
    measureRef,
    actualLineHeight,
    getGridSnapY,
    skipNextSnap
  };
};
