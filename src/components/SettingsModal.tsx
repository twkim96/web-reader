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
        
        {/* 폰트 선택 */}
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

        {/* 글자 크기 */}
        <div className="space-y-4">
          <label className="text-[10px] font-black uppercase opacity-50 tracking-widest block text-center">Font Size</label>
          <div className="flex items-center gap-3">
            <button onClick={() => onUpdateSettings({ fontSize: Math.max(12, settings.fontSize - 1) })} className={`flex-1 py-4 ${theme.secondary} rounded-2xl font-bold transition-transform active:scale-95`}>-</button>
            <span className="w-12 text-center font-black text-xl">{settings.fontSize}</span>
            <button onClick={() => onUpdateSettings({ fontSize: Math.min(40, settings.fontSize + 1) })} className={`flex-1 py-4 ${theme.secondary} rounded-2xl font-bold transition-transform active:scale-95`}>+</button>
          </div>
        </div>
        
        {/* 테마 설정 */}
        <div className="space-y-4">
          <label className="text-[10px] font-black uppercase opacity-50 tracking-widest block text-center">Theme</label>
          <div className="grid grid-cols-4 gap-3">
            {(Object.keys(THEMES) as Array<keyof typeof THEMES>).map(t => (
              <button 
                key={t} 
                onClick={() => onUpdateSettings({ theme: t })} 
                className={`h-12 rounded-2xl border-2 transition-all ${(THEMES as any)[t].bg} ${settings.theme === t ? 'border-indigo-600 scale-105 shadow-inner' : 'border-transparent opacity-60'}`} 
              />
            ))}
          </div>
        </div>

        <button onClick={onClose} className="w-full py-5 bg-slate-900 text-white font-black rounded-[1.5rem] tracking-[0.2em] uppercase text-xs shadow-xl active:scale-95 transition-transform">Done</button>
      </div>
    </div>
  );
};