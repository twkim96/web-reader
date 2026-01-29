import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Book, UserProgress, ViewerSettings } from '../types';
import { THEMES } from '../lib/constants';
import { fetchFileChunk } from '../lib/googleDrive'; // 도구함에서 함수 임포트
import { 
  ChevronLeft, Settings, Moon, Sun, 
  ChevronUp, ChevronDown 
} from 'lucide-react';

interface ReaderProps {
  book: Book;
  googleToken: string;
  initialProgress?: UserProgress;
  settings: ViewerSettings;
  setSettings: (s: any) => void;
  onBack: () => void;
  onSaveProgress: (absoluteCharIndex: number, progressPercent: number) => void;
}

export const Reader: React.FC<ReaderProps> = ({ 
  book, googleToken, initialProgress, settings, setSettings, onBack, onSaveProgress 
}) => {
  // --- 상태 관리 ---
  const [content, setContent] = useState("");
  const [loadedRange, setLoadedRange] = useState({ start: 0, end: 0 });
  const [totalSize, setTotalSize] = useState(0);
  const [isFetching, setIsFetching] = useState(false);
  
  const [showControls, setShowControls] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  
  const contentRef = useRef<HTMLDivElement>(null);
  const hasRestored = useRef<string | null>(null); // 현재 책 ID 저장으로 중복 복구 방지
  const theme = THEMES[settings.theme as keyof typeof THEMES] || THEMES.sepia;

  /**
   * [데이터 로드] googleDrive.ts의 fetchFileChunk 함수를 사용하여 데이터를 가져옵니다.
   */
  const loadData = useCallback(async (start: number, isInitial = false) => {
    if (isFetching || (totalSize > 0 && start >= totalSize)) return;
    
    setIsFetching(true);
    try {
      const chunkSize = 1024 * 256; // 256KB 단위 로드
      const result = await fetchFileChunk(book.id, googleToken, start, chunkSize);
      
      if (isInitial) {
        setContent(result.text);
        setLoadedRange({ start, end: result.endByte });
      } else {
        // 기존 컨텐츠 뒤에 새 데이터를 정확히 병합
        setContent(prev => prev + result.text);
        setLoadedRange(prev => ({ ...prev, end: result.endByte }));
      }
      setTotalSize(result.totalSize);
    } catch (err) {
      console.error("Reader 데이터 로드 오류:", err);
    } finally {
      setIsFetching(false);
    }
  }, [book.id, googleToken, isFetching, totalSize]);

  // 1. 초기 로드: 저장된 위치 근처부터 시작하여 문맥 확보
  useEffect(() => {
    // 도서가 변경될 때마다 초기화
    setContent("");
    setLoadedRange({ start: 0, end: 0 });
    setTotalSize(0);
    hasRestored.current = null;

    const startByte = initialProgress ? Math.max(0, initialProgress.charIndex - 4000) : 0;
    loadData(startByte, true);
  }, [book.id]);

  // 2. 위치 복구: 컨텐츠가 로드된 후 최초 1회만 스크롤 위치를 복원합니다.
  useEffect(() => {
    if (hasRestored.current !== book.id && content && initialProgress) {
      const relativeIndex = Math.max(0, initialProgress.charIndex - loadedRange.start);
      const relativePercent = relativeIndex / content.length;
      
      const timer = setTimeout(() => {
        const totalHeight = document.documentElement.scrollHeight;
        window.scrollTo({ 
          top: totalHeight * relativePercent, 
          behavior: 'instant' 
        });
        hasRestored.current = book.id; // 복구 완료 표시
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [content, book.id, initialProgress, loadedRange.start]);

  // 3. 스크롤 감지: 진행도 저장 및 자동 추가 로드
  useEffect(() => {
    const handleScroll = () => {
      const scrolled = window.scrollY;
      const vh = window.innerHeight;
      const totalH = document.documentElement.scrollHeight;
      const scrollable = totalH - vh;

      // 로딩 중이거나 위치 복구 전이면 무시
      if (isFetching || hasRestored.current !== book.id || scrollable <= 0) return;

      const currentPercent = scrolled / scrollable;
      const charOffset = Math.floor(content.length * currentPercent);
      const absoluteIdx = loadedRange.start + charOffset;
      const totalPercent = (absoluteIdx / totalSize) * 100;

      // 부모에게 진행도 전달 (쓰로틀링은 부모에서 권장)
      onSaveProgress(absoluteIdx, Math.min(totalPercent, 100));

      // 하단 4500px 도달 시 선제적으로 다음 내용 갱신 (네트워크 지연 대비 넉넉하게 설정)
      if (totalH - (scrolled + vh) < 4500 && loadedRange.end < totalSize - 1) {
        loadData(loadedRange.end + 1);
      }
    };

    window.addEventListener('scroll', handleScroll);
    return () => window.removeEventListener('scroll', handleScroll);
  }, [content, loadedRange, totalSize, isFetching, loadData, onSaveProgress]);

  /**
   * 상/하단 클릭 시 페이지 이동 및 중앙 클릭 시 설정 제어
   */
  const handleInteraction = (e: React.MouseEvent) => {
    const { clientY } = e;
    const h = window.innerHeight;

    if (settings.navMode === 'page') {
      if (clientY < h * 0.3) {
        window.scrollBy({ top: -(h - 60), behavior: 'smooth' });
      } else if (clientY > h * 0.7) {
        // 마지막 지점 클릭 시 데이터 로딩 트리거 보조
        const totalH = document.documentElement.scrollHeight;
        const scrolled = window.scrollY;
        if (totalH - (scrolled + h) < 800 && loadedRange.end < totalSize - 1) {
          loadData(loadedRange.end + 1);
        }
        window.scrollBy({ top: (h - 60), behavior: 'smooth' });
      } else {
        setShowControls(!showControls);
      }
    } else if (clientY >= h * 0.3 && clientY <= h * 0.7) {
      setShowControls(!showControls);
    }
  };

  return (
    <div className={`min-h-screen ${theme.bg} ${theme.text} transition-colors duration-300 font-sans select-none`}>
      {/* 상단 네비게이션 */}
      <nav className={`fixed top-0 inset-x-0 h-16 ${theme.bg} border-b ${theme.border} z-50 flex items-center justify-between px-4 transition-transform duration-300 ${showControls ? 'translate-y-0 shadow-lg' : '-translate-y-full'}`}>
        <button onClick={onBack} className="p-2 rounded-full hover:bg-black/5 transition-colors">
          <ChevronLeft />
        </button>
        <h2 className="font-bold text-sm truncate px-4">{book.name.replace('.txt', '')}</h2>
        <div className="w-10" />
      </nav>

      {/* 본문 텍스트 영역 */}
      <main onClick={handleInteraction} className="min-h-screen pt-12 pb-48 relative" style={{ paddingLeft: `${settings.padding}px`, paddingRight: `${settings.padding}px`, textAlign: settings.textAlign }}>
        <div ref={contentRef} className="max-w-3xl mx-auto whitespace-pre-wrap break-words" style={{ fontSize: `${settings.fontSize}px`, lineHeight: settings.lineHeight }}>
          {content}
        </div>
        
        {/* 로딩 인디케이터 */}
        {isFetching && (
          <div className="py-20 text-center animate-pulse flex flex-col items-center gap-3">
            <div className="w-8 h-8 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin" />
            <span className="text-[10px] font-black tracking-widest uppercase opacity-40">Loading next contents...</span>
          </div>
        )}
      </main>

      {/* 하단 컨트롤 바 */}
      <div className={`fixed bottom-0 inset-x-0 ${theme.bg} border-t ${theme.border} z-50 transition-transform duration-300 ${showControls ? 'translate-y-0 shadow-2xl' : 'translate-y-full'}`}>
        <div className="flex justify-around p-5 max-w-lg mx-auto">
          <button onClick={() => setShowSettings(true)} className="flex flex-col items-center gap-1.5 opacity-60 hover:opacity-100 transition-opacity">
            <Settings size={22} />
            <span className="text-[9px] font-bold uppercase tracking-tighter">Config</span>
          </button>
          <button 
            onClick={() => setSettings({...settings, theme: settings.theme === 'dark' ? 'sepia' : 'dark'})} 
            className="flex flex-col items-center gap-1.5 opacity-60 hover:opacity-100 transition-opacity"
          >
            {settings.theme === 'dark' ? <Sun size={22} /> : <Moon size={22} />}
            <span className="text-[9px] font-bold uppercase tracking-tighter">Mode</span>
          </button>
        </div>
      </div>

      {/* 설정 모달 */}
      {showSettings && (
        <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={() => setShowSettings(false)}>
          <div className={`w-full max-w-md rounded-t-[2.5rem] p-8 space-y-8 ${theme.bg} ${theme.text} shadow-2xl`} onClick={e => e.stopPropagation()}>
            <div className="space-y-4">
              <label className="text-[10px] font-black uppercase opacity-50 tracking-widest">Font Size</label>
              <div className="flex items-center gap-3">
                <button onClick={() => setSettings({...settings, fontSize: Math.max(12, settings.fontSize - 1)})} className={`flex-1 py-4 ${theme.secondary} rounded-2xl font-bold transition-transform active:scale-95`}>-</button>
                <span className="w-12 text-center font-black text-xl">{settings.fontSize}</span>
                <button onClick={() => setSettings({...settings, fontSize: Math.min(40, settings.fontSize + 1)})} className={`flex-1 py-4 ${theme.secondary} rounded-2xl font-bold transition-transform active:scale-95`}>+</button>
              </div>
            </div>
            
            <div className="space-y-4">
              <label className="text-[10px] font-black uppercase opacity-50 tracking-widest">Theme</label>
              <div className="grid grid-cols-4 gap-3">
                {(Object.keys(THEMES) as Array<keyof typeof THEMES>).map(t => (
                  <button 
                    key={t} 
                    onClick={() => setSettings({...settings, theme: t})} 
                    className={`h-12 rounded-2xl border-2 transition-all ${(THEMES as any)[t].bg} ${settings.theme === t ? 'border-indigo-600 scale-105 shadow-inner' : 'border-transparent opacity-60'}`} 
                  />
                ))}
              </div>
            </div>

            <button onClick={() => setShowSettings(false)} className="w-full py-5 bg-slate-900 text-white font-black rounded-[1.5rem] tracking-[0.2em] uppercase text-xs shadow-xl active:scale-95 transition-transform">Done</button>
          </div>
        </div>
      )}
    </div>
  );
};