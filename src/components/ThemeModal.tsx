// src/components/ThemeModal.tsx
import React from 'react';
import { THEMES } from '../lib/constants';

interface ThemeModalProps {
  currentTheme: string;
  onSelectTheme: (theme: string) => void;
  onClose: () => void;
  theme: any; // 현재 적용된 테마 스타일 (모달 배경용)
}

// ⚠️ 이 부분(export const ThemeModal)이 정확히 있어야 합니다.
export const ThemeModal: React.FC<ThemeModalProps> = ({ 
  currentTheme, onSelectTheme, onClose, theme 
}) => {
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className={`w-full max-w-sm rounded-[2.5rem] p-8 space-y-8 ${theme.bg} ${theme.text} shadow-2xl font-sans`} onClick={e => e.stopPropagation()}>
        
        <div className="text-center space-y-1">
          <h3 className="text-lg font-black uppercase italic tracking-tighter">Select Theme</h3>
          <p className="text-[10px] font-bold text-gray-500 uppercase tracking-widest">Choose your reading atmosphere</p>
        </div>

        <div className="grid grid-cols-2 gap-4">
          {(Object.keys(THEMES) as Array<keyof typeof THEMES>).map(t => {
            const themeData = (THEMES as any)[t];
            const isSelected = currentTheme === t;
            
            return (
              <button 
                key={t} 
                onClick={() => { onSelectTheme(t); onClose(); }} 
                className={`relative h-24 rounded-2xl border-2 transition-all overflow-hidden group ${themeData.bg} ${isSelected ? 'border-indigo-600 scale-105 shadow-xl ring-2 ring-indigo-500/20' : 'border-black/5 hover:border-black/20'}`}
              >
                {/* 테마 미리보기용 텍스트 */}
                <div className={`absolute inset-0 flex flex-col items-center justify-center gap-2 ${themeData.text}`}>
                  <span className="text-xl font-black">Aa</span>
                  <span className="text-[10px] font-bold uppercase tracking-widest opacity-60">{t}</span>
                </div>
                
                {/* 선택 표시 */}
                {isSelected && (
                  <div className="absolute top-2 right-2 w-2 h-2 bg-indigo-600 rounded-full shadow-sm" />
                )}
              </button>
            );
          })}
        </div>

        <button onClick={onClose} className="w-full py-4 bg-indigo-600 text-white font-black rounded-[1.5rem] tracking-[0.2em] uppercase text-xs shadow-lg active:scale-95 transition-transform">
          Close
        </button>
      </div>
    </div>
  );
};