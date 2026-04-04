import React from 'react';
import { ViewerSettings } from '../types';
import { X, Check } from 'lucide-react';
import { THEMES, ACCENT_COLORS, ACCENT_PALETTE } from '../lib/constants';

interface ThemeModalProps {
  settings: ViewerSettings;
  onUpdateSettings: (s: Partial<ViewerSettings>) => void;
  onClose: () => void;
  theme: { bg: string; text: string; border: string; secondary?: string };
  onSelectTheme?: (themeName: string) => void;
}

export const ThemeModal: React.FC<ThemeModalProps> = ({ 
  settings, onUpdateSettings, onClose, theme, onSelectTheme 
}) => {
  
  const handleThemeClick = (themeKey: string) => {
    if (onSelectTheme) {
      onSelectTheme(themeKey);
    } 
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
          <h2 className="font-bold text-lg whitespace-nowrap">테마 설정</h2>
          
          <div className="flex flex-1 items-center justify-end px-4 gap-2">
            {ACCENT_COLORS.map(color => (
              <button
                key={color}
                onClick={() => onUpdateSettings({ accentColor: color })}
                className={`w-6 h-6 rounded-full shrink-0 transition-all outline-none ${settings.accentColor === color ? 'ring-2 ring-offset-2 ring-accent-500 ring-offset-transparent scale-110 shadow-md' : 'opacity-50 hover:opacity-100 hover:scale-110'}`}
                style={{ backgroundColor: ACCENT_PALETTE[color]?.[500] || ACCENT_PALETTE.indigo[500] }}
                title={`${color}`}
              />
            ))}
          </div>

          <button onClick={onClose} className="p-2 -mr-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-full transition-colors shrink-0"><X size={20} /></button>
        </div>

        <div className="grid grid-cols-2 gap-3">
          {Object.entries(THEMES).map(([key, t]) => (
            <button
              key={key}
              onClick={() => handleThemeClick(key)}
              className={`
                relative p-4 rounded-2xl border-2 text-left transition-all active:scale-95
                ${t.bg} ${t.text}
                ${settings.theme === key ? 'border-accent-500 ring-2 ring-accent-500/20' : `border-transparent ${theme.border}`}
              `}
            >
              <div className="font-bold capitalize mb-1">{key}</div>
              <div className="text-[10px] opacity-60">Comfortable reading</div>
              {settings.theme === key && (
                <div className="absolute top-3 right-3 text-accent-500">
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