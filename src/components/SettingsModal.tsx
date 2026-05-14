// src/components/SettingsModal.tsx
import React from 'react';
import { X } from 'lucide-react';
import { ThemeClasses, ViewerSettings } from '../types';
import { ReaderModalFrame } from './reader/ReaderModalFrame';

interface SettingsModalProps {
  settings: ViewerSettings;
  onUpdateSettings: (s: Partial<ViewerSettings>) => void;
  onClose: () => void;
  theme: ThemeClasses;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ 
  settings, onUpdateSettings, onClose, theme 
}) => {
  const labelStyle = "text-sm font-black uppercase tracking-widest block text-center mb-3";
  const controlBtnStyle = `flex-1 py-1.5 ${theme.secondary} rounded-lg font-bold transition-transform active:scale-95 text-sm shadow-sm`;
  const paragraphSpacing = settings.paragraphSpacing ?? 1;

  const navOptions = [
    { value: 'scroll', label: 'Scroll' },
    { value: 'page', label: 'T/B Tap' },
    { value: 'left-right', label: 'L/R Tap' },
    { value: 'all-dir', label: '4-Way' },
  ] as const;

  return (
    <ReaderModalFrame theme={theme} onClose={onClose} maxWidth="max-w-md" className="font-sans max-h-[85vh] overflow-y-auto p-6 sm:p-8">
      <div className="flex items-center justify-between mb-8">
        <h2 className="font-bold text-lg">리더 설정</h2>
        <button onClick={onClose} className="p-2 -mr-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-full transition-colors">
          <X size={20} />
        </button>
      </div>

      <div className="space-y-9">
        {/* 1. 화면 이동 방식 및 문단 간격 */}
        <div className="grid grid-cols-1 sm:grid-cols-[1.4fr_1fr] gap-6">
          <div>
            <label className={labelStyle}>Navigation Mode</label>
            <div className="grid grid-cols-2 gap-2">
              {navOptions.map(opt => (
                <button
                  key={opt.value}
                  onClick={() => onUpdateSettings({ navMode: opt.value })}
                  className={`py-3 rounded-xl text-[10px] font-bold uppercase transition-all ${settings.navMode === opt.value ? 'bg-accent-600 text-white shadow-lg' : theme.secondary}`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className={labelStyle}>Paragraph Gap</label>
            <div className="flex items-center gap-2">
              <button onClick={() => onUpdateSettings({ paragraphSpacing: Math.max(0, parseFloat((paragraphSpacing - 0.1).toFixed(1))) })} className={controlBtnStyle}>-</button>
              <span className="w-14 text-center font-black text-xl">{paragraphSpacing.toFixed(1)}em</span>
              <button onClick={() => onUpdateSettings({ paragraphSpacing: Math.min(3, parseFloat((paragraphSpacing + 0.1).toFixed(1))) })} className={controlBtnStyle}>+</button>
            </div>
          </div>
        </div>


        {/* 2. 글자 크기 및 줄 간격 */}
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
                className={`flex-1 py-3 rounded-xl text-[10px] font-bold uppercase transition-all ${settings.fontFamily === f ? 'bg-accent-600 text-white shadow-lg' : theme.secondary}`}
              >
                {f === 'ridi' ? 'Ridi Batang' : f}
              </button>
            ))}
          </div>
        </div>
        
        {/* 테마 섹션 삭제됨 */}
      </div>
    </ReaderModalFrame>
  );
};
