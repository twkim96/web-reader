// src/components/SettingsModal.tsx
import React from 'react';
import { ViewerSettings } from '../types';

interface SettingsModalProps {
  settings: ViewerSettings;
  onUpdateSettings: (s: Partial<ViewerSettings>) => void;
  onClose: () => void;
  theme: any;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ 
  settings, onUpdateSettings, onClose, theme 
}) => {
  const labelStyle = "text-sm font-black uppercase tracking-widest block text-center mb-3";
  const controlBtnStyle = `flex-1 py-1.5 ${theme.secondary} rounded-lg font-bold transition-transform active:scale-95 text-sm shadow-sm`;

  const navOptions = [
    { value: 'scroll', label: 'Scroll' },
    { value: 'page', label: 'T/B Tap' },
    { value: 'left-right', label: 'L/R Tap' },
    { value: 'all-dir', label: '4-Way' },
  ] as const;

  return (
    <div className="fixed inset-0 z-[60] flex items-end justify-center bg-black/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div className={`w-full max-w-md rounded-t-[2.5rem] p-8 space-y-10 ${theme.bg} ${theme.text} shadow-2xl font-sans overflow-y-auto max-h-[90vh]`} onClick={e => e.stopPropagation()}>
        
        {/* 1. 화면 이동 방식 */}
        <div>
          <label className={labelStyle}>Navigation Mode</label>
          <div className="grid grid-cols-4 gap-2">
            {navOptions.map(opt => (
              <button 
                key={opt.value}
                onClick={() => onUpdateSettings({ navMode: opt.value })}
                className={`py-3 rounded-xl text-[10px] font-bold uppercase transition-all ${settings.navMode === opt.value ? 'bg-indigo-600 text-white shadow-lg' : theme.secondary}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {/* 2. 인코딩 */}
        <div>
          <label className={labelStyle}>Encoding</label>
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
        </div>

        {/* 3. 글자 크기 및 줄 간격 */}
        <div className="flex gap-6">
          <div className="flex-1">
            <label className={labelStyle}>Size</label>
            <div className="flex items-center gap-2">
              <button onClick={() => onUpdateSettings({ fontSize: Math.max(12, settings.fontSize - 1) })} className={controlBtnStyle}>-</button>
              <span className="w-8 text-center font-black text-xl">{settings.fontSize}</span>
              <button onClick={() => onUpdateSettings({ fontSize: Math.min(40, settings.fontSize + 1) })} className={controlBtnStyle}>+</button>
            </div>
          </div>

          <div className="flex-1">
            <label className={labelStyle}>Line</label>
            <div className="flex items-center gap-2">
              <button onClick={() => onUpdateSettings({ lineHeight: Math.max(1.0, parseFloat((settings.lineHeight - 0.1).toFixed(1))) })} className={controlBtnStyle}>-</button>
              <span className="w-10 text-center font-black text-xl">{settings.lineHeight.toFixed(1)}</span>
              <button onClick={() => onUpdateSettings({ lineHeight: Math.min(3.0, parseFloat((settings.lineHeight + 0.1).toFixed(1))) })} className={controlBtnStyle}>+</button>
            </div>
          </div>
        </div>

        {/* 4. 글꼴 선택 */}
        <div>
          <label className={labelStyle}>Font Family</label>
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
        
        {/* 테마 섹션 삭제됨 */}

        <button onClick={onClose} className="w-full py-5 bg-slate-900 text-white font-black rounded-[1.5rem] tracking-[0.2em] uppercase text-sm shadow-xl active:scale-95 transition-transform">Done</button>
      </div>
    </div>
  );
};