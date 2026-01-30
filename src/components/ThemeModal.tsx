// src/components/ThemeModal.tsx
import React from 'react';
import { ViewerSettings } from '../types';
import { X, Check } from 'lucide-react';
import { THEMES } from '../lib/constants';

interface ThemeModalProps {
  // [Fix] settings와 onUpdateSettings 추가 (Reader.tsx에서 전달하므로 필수)
  settings: ViewerSettings;
  onUpdateSettings: (s: Partial<ViewerSettings>) => void;
  onClose: () => void;
  theme: { bg: string; text: string; border: string; secondary?: string };
  // [Check] 기존에 Reader.tsx에서 추가했던 prop도 유지
  onSelectTheme?: (themeName: string) => void;
}

export const ThemeModal: React.FC<ThemeModalProps> = ({ 
  settings, onUpdateSettings, onClose, theme, onSelectTheme 
}) => {
  
  const handleThemeClick = (themeKey: string) => {
    // 1. onSelectTheme이 있으면 호출 (Reader에서 전달한 핸들러)
    if (onSelectTheme) {
      onSelectTheme(themeKey);
    } 
    // 2. 혹시 몰라 직접 설정 업데이트도 수행 (안전장치)
    else {
      onUpdateSettings({ theme: themeKey });
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-6 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={onClose}>
      <div 
        onClick={(e) => e.stopPropagation()}
        className={`w-full max-w-sm ${theme.bg} ${theme.text} rounded-3xl shadow-2xl border ${theme.border} p-6 animate-in zoom-in-95 duration-200`}
      >
        <div className="flex items-center justify-between mb-6">
          <h2 className="font-bold text-lg">테마 설정</h2>
          <button onClick={onClose} className="p-2 hover:bg-black/5 rounded-full transition-colors"><X size={20} /></button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {Object.entries(THEMES).map(([key, t]) => (
            <button
              key={key}
              onClick={() => handleThemeClick(key)}
              className={`
                relative p-4 rounded-2xl border-2 text-left transition-all active:scale-95
                ${t.bg} ${t.text}
                ${settings.theme === key ? 'border-indigo-500 ring-2 ring-indigo-500/20' : `border-transparent ${theme.border}`}
              `}
            >
              <div className="font-bold capitalize mb-1">{key}</div>
              <div className="text-[10px] opacity-60">Comfortable reading</div>
              {settings.theme === key && (
                <div className="absolute top-3 right-3 text-indigo-500">
                  <Check size={16} strokeWidth={3} />
                </div>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
};