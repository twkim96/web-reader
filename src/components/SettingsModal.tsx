// src/components/SettingsModal.tsx
import React from 'react';
import { ViewerSettings } from '../types';
import { THEMES } from '../lib/constants';

interface SettingsModalProps {
  settings: ViewerSettings;
  onUpdateSettings: (s: Partial<ViewerSettings>) => void;
  onClose: () => void;
  theme: any;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ 
  settings, onUpdateSettings, onClose, theme 
}) => {
  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className={`w-full max-w-md rounded-t-[2.5rem] p-8 space-y-8 ${theme.bg} ${theme.text} shadow-2xl font-sans`} onClick={e => e.stopPropagation()}>
        
        {/* 인코딩 설정 (utf-16le 옵션 추가) */}
        <div className="space-y-4">
          <label className="text-[10px] font-black uppercase opacity-50 tracking-widest block text-center">Encoding</label>
          <div className="flex flex-wrap gap-2">
            {(['auto', 'utf-8', 'euc-kr', 'utf-16le'] as const).map(enc => (
              <button 
                key={enc}
                onClick={() => onUpdateSettings({ encoding: enc })}
                className={`flex-1 min-w-[70px] py-3 rounded-xl text-[10px] font-bold uppercase transition-all ${settings.encoding === enc ? 'bg-indigo-600 text-white shadow-lg' : theme.secondary}`}
              >
                {enc === 'auto' ? 'Auto' : enc === 'utf-16le' ? 'UTF-16' : enc}
              </button>
            ))}
          </div>
          {settings.encoding === 'auto' && (
            <p className="text-[9px] text-center text-slate-500 font-bold opacity-60">* 한글이 깨져 보인다면 수동으로 인코딩을 선택해 주세요.</p>
          )}
        </div>

        {/* 글꼴 선택 */}
        <div className="space-y-4">
          <label className="text-[10px] font-black uppercase opacity-50 tracking-widest block text-center">Font Family</label>
          <div className="flex gap-2">
            {(['sans', 'serif', 'ridi'] as const).map(f => (
              <button 
                key={f}
                onClick={() => onUpdateSettings({ fontFamily: f })}
                className={`flex-1 py-3 rounded-xl text-[10px] font-bold uppercase transition-all ${settings.fontFamily === f ? 'bg-indigo-600 text-white shadow-lg' : theme.secondary}`}
              >
                {f === 'ridi' ? 'Ridi Batang' : f}
              </button>
            ))}
          </div>
        </div>

        {/* 글자 크기, 테마 등 나머지 코드는 동일하게 유지 */}
        <button onClick={onClose} className="w-full py-5 bg-slate-900 text-white font-black rounded-[1.5rem] tracking-[0.2em] uppercase text-xs shadow-xl active:scale-95 transition-transform">Done</button>
      </div>
    </div>
  );
};