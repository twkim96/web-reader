// src/components/SettingsModal.tsx
import React from 'react';
import { X } from 'lucide-react';
import { ThemeClasses, ViewerSettings } from '../types';
import {
  clampTapZonePercent,
  DEFAULT_LEFT_RIGHT_TAP_PERCENT,
  DEFAULT_TOP_BOTTOM_TAP_PERCENT,
  getEffectiveNavigationMode,
  getNavigationOptions,
} from '../lib/readerNavigation';
import { ReaderModalFrame } from './reader/ReaderModalFrame';

interface SettingsModalProps {
  settings: ViewerSettings;
  onUpdateSettings: (s: Partial<ViewerSettings>) => void;
  onClose: () => void;
  theme: ThemeClasses;
  isFixedLayout?: boolean;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ 
  settings, onUpdateSettings, onClose, theme, isFixedLayout = false,
}) => {
  const labelStyle = "text-[10px] font-black uppercase tracking-[0.16em] block text-left mb-1 opacity-55";
  const optionBtnStyle = `h-9 px-4 rounded-xl text-[9px] font-bold uppercase transition-all active:scale-95`;
  const stepperBtnStyle = `w-7 h-7 flex items-center justify-center ${theme.secondary} rounded-md font-bold transition-transform active:scale-95 text-xs shadow-sm leading-none`;
  const stepperGroupStyle = "flex items-center gap-1.5 mr-1.5";
  const valueStyle = "font-black text-lg tabular-nums leading-none w-10 text-left";
  const paragraphSpacing = settings.paragraphSpacing ?? 1;
  const topBottomTapPercent = clampTapZonePercent(
    settings.tapTopBottomPercent,
    DEFAULT_TOP_BOTTOM_TAP_PERCENT,
  );
  const leftRightTapPercent = clampTapZonePercent(
    settings.tapLeftRightPercent,
    DEFAULT_LEFT_RIGHT_TAP_PERCENT,
  );

  const navOptions = getNavigationOptions(isFixedLayout);
  const selectedNavMode = getEffectiveNavigationMode(settings.navMode, isFixedLayout);

  return (
    <ReaderModalFrame noBlur theme={theme} onClose={onClose} maxWidth="max-w-[21.25rem]" className="font-sans max-h-[85vh] overflow-y-auto p-5 sm:p-6 flex flex-col justify-center">
      <div className="w-fit mx-auto">
        <div className="flex items-center justify-between mb-3">
          <h2 className="font-bold text-lg">리더 설정</h2>
          <button onClick={onClose} className="p-2 -mr-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-full transition-colors">
            <X size={20} />
          </button>
        </div>

        <div className="space-y-5">
          <div>
            <label className={labelStyle}>Navigation Mode</label>
          <div className="flex flex-wrap items-center justify-start gap-2 pt-1.5">
            {navOptions.map(opt => (
              <button
                key={opt.value}
                onClick={() => onUpdateSettings({ navMode: opt.value })}
                className={`${optionBtnStyle} ${selectedNavMode === opt.value ? 'bg-accent-600 text-white shadow-lg' : theme.secondary}`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>

        {!isFixedLayout && (
          <>
            <div>
              <label className={labelStyle}>Font Family</label>
              <div className="flex flex-wrap items-center justify-start gap-2 pt-1.5">
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

            <div className="w-full h-px bg-black/10 dark:bg-white/10" />

            <div>
              <div className="flex items-end justify-between">
                <div>
                  <label className={labelStyle}>Paragraph Gap</label>
                  <div className={valueStyle}>{paragraphSpacing.toFixed(1)}</div>
                </div>
                <div className={stepperGroupStyle}>
                  <button aria-label="Decrease paragraph gap" onClick={() => onUpdateSettings({ paragraphSpacing: Math.max(0, parseFloat((paragraphSpacing - 0.1).toFixed(1))) })} className={stepperBtnStyle}>-</button>
                  <button aria-label="Increase paragraph gap" onClick={() => onUpdateSettings({ paragraphSpacing: Math.min(3, parseFloat((paragraphSpacing + 0.1).toFixed(1))) })} className={stepperBtnStyle}>+</button>
                </div>
              </div>
            </div>

            <div>
              <div className="flex items-end justify-between">
                <div>
                  <label className={labelStyle}>Size</label>
                  <div className={valueStyle}>{settings.fontSize}</div>
                </div>
                <div className={stepperGroupStyle}>
                  <button aria-label="Decrease font size" onClick={() => onUpdateSettings({ fontSize: Math.max(12, settings.fontSize - 1) })} className={stepperBtnStyle}>-</button>
                  <button aria-label="Increase font size" onClick={() => onUpdateSettings({ fontSize: Math.min(40, settings.fontSize + 1) })} className={stepperBtnStyle}>+</button>
                </div>
              </div>
            </div>

            <div>
              <div className="flex items-end justify-between">
                <div>
                  <label className={labelStyle}>Line</label>
                  <div className={valueStyle}>{settings.lineHeight.toFixed(1)}</div>
                </div>
                <div className={stepperGroupStyle}>
                  <button aria-label="Decrease line height" onClick={() => onUpdateSettings({ lineHeight: Math.max(1.0, parseFloat((settings.lineHeight - 0.1).toFixed(1))) })} className={stepperBtnStyle}>-</button>
                  <button aria-label="Increase line height" onClick={() => onUpdateSettings({ lineHeight: Math.min(3.0, parseFloat((settings.lineHeight + 0.1).toFixed(1))) })} className={stepperBtnStyle}>+</button>
                </div>
              </div>
            </div>
          </>
        )}

        <div>
          <div className="flex items-end justify-between">
            <div>
              <label className={labelStyle}>Top/Bottom</label>
              <div className={valueStyle}>{topBottomTapPercent}%</div>
            </div>
            <div className={stepperGroupStyle}>
              <button aria-label="Decrease top and bottom tap area" onClick={() => onUpdateSettings({ tapTopBottomPercent: clampTapZonePercent(topBottomTapPercent - 1, DEFAULT_TOP_BOTTOM_TAP_PERCENT) })} className={stepperBtnStyle}>-</button>
              <button aria-label="Increase top and bottom tap area" onClick={() => onUpdateSettings({ tapTopBottomPercent: clampTapZonePercent(topBottomTapPercent + 1, DEFAULT_TOP_BOTTOM_TAP_PERCENT) })} className={stepperBtnStyle}>+</button>
            </div>
          </div>
        </div>

        <div>
          <div className="flex items-end justify-between">
            <div>
              <label className={labelStyle}>Left/Right</label>
              <div className={valueStyle}>{leftRightTapPercent}%</div>
            </div>
            <div className={stepperGroupStyle}>
              <button aria-label="Decrease left and right tap area" onClick={() => onUpdateSettings({ tapLeftRightPercent: clampTapZonePercent(leftRightTapPercent - 1, DEFAULT_LEFT_RIGHT_TAP_PERCENT) })} className={stepperBtnStyle}>-</button>
              <button aria-label="Increase left and right tap area" onClick={() => onUpdateSettings({ tapLeftRightPercent: clampTapZonePercent(leftRightTapPercent + 1, DEFAULT_LEFT_RIGHT_TAP_PERCENT) })} className={stepperBtnStyle}>+</button>
            </div>
          </div>
        </div>
        </div>
      </div>
    </ReaderModalFrame>
  );
};
