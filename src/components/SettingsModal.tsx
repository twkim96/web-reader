// src/components/SettingsModal.tsx
import React, { useState } from 'react';
import { ChevronDown, X } from 'lucide-react';
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
  const [showAdvancedSizing, setShowAdvancedSizing] = useState(false);
  const labelStyle = "text-[10px] font-black uppercase tracking-[0.16em] block text-left mb-1 opacity-55";
  const optionBtnStyle = `h-9 px-4 rounded-xl text-[9px] font-bold uppercase transition-all active:scale-95`;
  const stepperBtnStyle = `w-7 h-7 flex items-center justify-center ${theme.secondary} rounded-md font-bold transition-transform active:scale-95 text-xs shadow-sm leading-none`;
  const stepperGroupStyle = "flex items-center gap-1.5 mr-1.5";
  const valueStyle = "font-black text-lg tabular-nums leading-none w-10 text-left";
  const toggleAdvancedSizing = () => setShowAdvancedSizing((current) => !current);
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
  const renderStepperRow = ({
    label,
    value,
    decreaseLabel,
    increaseLabel,
    onDecrease,
    onIncrease,
  }: {
    label: string;
    value: React.ReactNode;
    decreaseLabel: string;
    increaseLabel: string;
    onDecrease: () => void;
    onIncrease: () => void;
  }) => (
    <div>
      <div className="flex items-end justify-between gap-4">
        <div>
          <label className={labelStyle}>{label}</label>
          <div className={valueStyle}>{value}</div>
        </div>
        <div className={stepperGroupStyle}>
          <button aria-label={decreaseLabel} onClick={onDecrease} className={stepperBtnStyle}>-</button>
          <button aria-label={increaseLabel} onClick={onIncrease} className={stepperBtnStyle}>+</button>
        </div>
      </div>
    </div>
  );

  const tapAreaControls = (
    <>
      {renderStepperRow({
        label: 'Top/Bottom',
        value: `${topBottomTapPercent}%`,
        decreaseLabel: 'Decrease top and bottom tap area',
        increaseLabel: 'Increase top and bottom tap area',
        onDecrease: () => onUpdateSettings({
          tapTopBottomPercent: clampTapZonePercent(
            topBottomTapPercent - 1,
            DEFAULT_TOP_BOTTOM_TAP_PERCENT,
          ),
        }),
        onIncrease: () => onUpdateSettings({
          tapTopBottomPercent: clampTapZonePercent(
            topBottomTapPercent + 1,
            DEFAULT_TOP_BOTTOM_TAP_PERCENT,
          ),
        }),
      })}

      {renderStepperRow({
        label: 'Left/Right',
        value: `${leftRightTapPercent}%`,
        decreaseLabel: 'Decrease left and right tap area',
        increaseLabel: 'Increase left and right tap area',
        onDecrease: () => onUpdateSettings({
          tapLeftRightPercent: clampTapZonePercent(
            leftRightTapPercent - 1,
            DEFAULT_LEFT_RIGHT_TAP_PERCENT,
          ),
        }),
        onIncrease: () => onUpdateSettings({
          tapLeftRightPercent: clampTapZonePercent(
            leftRightTapPercent + 1,
            DEFAULT_LEFT_RIGHT_TAP_PERCENT,
          ),
        }),
      })}
    </>
  );
  const renderSizeDisclosureToggle = () => (
    <button
      type="button"
      aria-expanded={showAdvancedSizing}
      aria-label={showAdvancedSizing ? 'Collapse size details' : 'Expand size details'}
      onClick={toggleAdvancedSizing}
      className="flex w-full items-center gap-2 py-1 text-current/45 transition-opacity active:opacity-70"
    >
      <span className="h-px flex-1 bg-current/15" />
      <ChevronDown
        size={14}
        className={`shrink-0 transition-transform ${showAdvancedSizing ? 'rotate-180' : 'rotate-0'}`}
      />
      <span className="h-px flex-1 bg-current/15" />
    </button>
  );

  return (
    <ReaderModalFrame
      noBlur
      placement="center"
      theme={theme}
      onClose={onClose}
      maxWidth="max-w-[21.25rem]"
      className="font-sans h-[34rem] max-h-[85vh] p-0 flex flex-col"
    >
      <div className="flex shrink-0 items-center justify-between px-5 pt-5 pb-3 sm:px-6 sm:pt-6">
          <h2 className="font-bold text-lg">리더 설정</h2>
          <button onClick={onClose} className="p-2 -mr-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-full transition-colors">
            <X size={20} />
          </button>
        </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 sm:px-6 sm:pb-6">
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
          )}

          <div className="w-full h-px bg-black/10 dark:bg-white/10" />

          {!isFixedLayout ? (
            <div className="space-y-4">
              <div className="flex items-end justify-between gap-3">
                <button
                  type="button"
                  aria-expanded={showAdvancedSizing}
                  aria-label="Toggle size details"
                  onClick={toggleAdvancedSizing}
                  className="min-w-0 flex-1 text-left transition-opacity active:opacity-70"
                >
                  <span className={labelStyle}>Size</span>
                  <span className={`block ${valueStyle}`}>{settings.fontSize}</span>
                </button>
                <div className={stepperGroupStyle}>
                  <button aria-label="Decrease font size" onClick={() => onUpdateSettings({ fontSize: Math.max(12, settings.fontSize - 1) })} className={stepperBtnStyle}>-</button>
                  <button aria-label="Increase font size" onClick={() => onUpdateSettings({ fontSize: Math.min(40, settings.fontSize + 1) })} className={stepperBtnStyle}>+</button>
                </div>
              </div>

              {showAdvancedSizing && (
                <div className="space-y-4">
                  {renderStepperRow({
                    label: 'Paragraph Gap',
                    value: paragraphSpacing.toFixed(1),
                    decreaseLabel: 'Decrease paragraph gap',
                    increaseLabel: 'Increase paragraph gap',
                    onDecrease: () => onUpdateSettings({
                      paragraphSpacing: Math.max(0, parseFloat((paragraphSpacing - 0.1).toFixed(1))),
                    }),
                    onIncrease: () => onUpdateSettings({
                      paragraphSpacing: Math.min(3, parseFloat((paragraphSpacing + 0.1).toFixed(1))),
                    }),
                  })}

                  {renderStepperRow({
                    label: 'Line',
                    value: settings.lineHeight.toFixed(1),
                    decreaseLabel: 'Decrease line height',
                    increaseLabel: 'Increase line height',
                    onDecrease: () => onUpdateSettings({
                      lineHeight: Math.max(1.0, parseFloat((settings.lineHeight - 0.1).toFixed(1))),
                    }),
                    onIncrease: () => onUpdateSettings({
                      lineHeight: Math.min(3.0, parseFloat((settings.lineHeight + 0.1).toFixed(1))),
                    }),
                  })}

                  {tapAreaControls}
                </div>
              )}

              {renderSizeDisclosureToggle()}
            </div>
          ) : (
            <div className="space-y-4">
              {tapAreaControls}
            </div>
          )}

          <div className="w-full h-px bg-black/10 dark:bg-white/10" />

          <label className="flex items-center justify-between gap-4 rounded-xl py-1 text-left">
            <span className="text-[11px] font-bold leading-snug">
              마지막으로 읽던 책 자동 열기
            </span>
            <input
              type="checkbox"
              checked={settings.autoOpenLastBook}
              onChange={(event) => onUpdateSettings({ autoOpenLastBook: event.target.checked })}
              className="h-4 w-4 shrink-0 accent-accent-600"
            />
          </label>
        </div>
      </div>
    </ReaderModalFrame>
  );
};
