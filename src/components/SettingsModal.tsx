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
  const labelStyle = "text-[10px] font-black uppercase tracking-[0.16em] block text-left mb-2 opacity-55";
  const optionBtnStyle = `h-9 px-4 rounded-xl text-[9px] font-bold uppercase transition-all active:scale-95`;
  const stepperBtnStyle = `w-9 h-9 ${theme.secondary} rounded-xl font-bold transition-transform active:scale-95 text-xs shadow-sm`;
  const stepperValueStyle = "w-12 h-9 flex items-center justify-center font-black text-base tabular-nums";
  const paragraphSpacing = settings.paragraphSpacing ?? 1;

  const navOptions = [
    { value: 'scroll', label: 'Scroll' },
    { value: 'page', label: 'T/B Tap' },
    { value: 'left-right', label: 'L/R Tap' },
    { value: 'all-dir', label: '4-Way' },
  ] as const;

  return (
    <ReaderModalFrame theme={theme} onClose={onClose} maxWidth="max-w-md" className="font-sans max-h-[85vh] overflow-y-auto p-6 sm:p-7">
      <div className="flex items-center justify-between mb-7">
        <h2 className="font-bold text-lg">리더 설정</h2>
        <button onClick={onClose} className="p-2 -mr-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-full transition-colors">
          <X size={20} />
        </button>
      </div>

      <div className="space-y-5">
        <div>
          <label className={labelStyle}>Navigation Mode</label>
          <div className="flex flex-wrap items-center justify-start gap-2">
            {navOptions.map(opt => (
              <button
                key={opt.value}
                onClick={() => onUpdateSettings({ navMode: opt.value })}
                className={`${optionBtnStyle} ${settings.navMode === opt.value ? 'bg-accent-600 text-white shadow-lg' : theme.secondary}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        <div>
          <label className={labelStyle}>Paragraph Gap</label>
          <div className="inline-flex items-center justify-start gap-0.5">
            <button aria-label="Decrease paragraph gap" onClick={() => onUpdateSettings({ paragraphSpacing: Math.max(0, parseFloat((paragraphSpacing - 0.1).toFixed(1))) })} className={stepperBtnStyle}>-</button>
            <span className={stepperValueStyle}>{paragraphSpacing.toFixed(1)}</span>
            <button aria-label="Increase paragraph gap" onClick={() => onUpdateSettings({ paragraphSpacing: Math.min(3, parseFloat((paragraphSpacing + 0.1).toFixed(1))) })} className={stepperBtnStyle}>+</button>
          </div>
        </div>

        <div>
          <label className={labelStyle}>Size</label>
          <div className="inline-flex items-center justify-start gap-0.5">
            <button aria-label="Decrease font size" onClick={() => onUpdateSettings({ fontSize: Math.max(12, settings.fontSize - 1) })} className={stepperBtnStyle}>-</button>
            <span className={stepperValueStyle}>{settings.fontSize}</span>
            <button aria-label="Increase font size" onClick={() => onUpdateSettings({ fontSize: Math.min(40, settings.fontSize + 1) })} className={stepperBtnStyle}>+</button>
          </div>
        </div>

        <div>
          <label className={labelStyle}>Line</label>
          <div className="inline-flex items-center justify-start gap-0.5">
            <button aria-label="Decrease line height" onClick={() => onUpdateSettings({ lineHeight: Math.max(1.0, parseFloat((settings.lineHeight - 0.1).toFixed(1))) })} className={stepperBtnStyle}>-</button>
            <span className={stepperValueStyle}>{settings.lineHeight.toFixed(1)}</span>
            <button aria-label="Increase line height" onClick={() => onUpdateSettings({ lineHeight: Math.min(3.0, parseFloat((settings.lineHeight + 0.1).toFixed(1))) })} className={stepperBtnStyle}>+</button>
          </div>
        </div>

        <div>
          <label className={labelStyle}>Font Family</label>
          <div className="flex flex-wrap items-center justify-start gap-2">
            {(['sans', 'serif', 'ridi'] as const).map(f => (
              <button 
                key={f}
                onClick={() => onUpdateSettings({ fontFamily: f })}
                className={`${optionBtnStyle} ${settings.fontFamily === f ? 'bg-accent-600 text-white shadow-lg' : theme.secondary}`}
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
