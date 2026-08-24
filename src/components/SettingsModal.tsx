// src/components/SettingsModal.tsx
import React, { useState } from 'react';
import { ChevronDown, Languages, RotateCcw, Settings, X } from 'lucide-react';
import type {
  AnnotationPaletteItem,
  HighlightColorId,
  ThemeClasses,
  ViewerSettings,
} from '../types';
import {
  clampTapZonePercent,
  DEFAULT_LEFT_RIGHT_TAP_PERCENT,
  DEFAULT_TOP_BOTTOM_TAP_PERCENT,
  getEffectiveNavigationMode,
  getNavigationOptions,
} from '../lib/readerNavigation';
import { ReaderModalFrame } from './reader/ReaderModalFrame';
import { getHighlightColor } from '../lib/annotationPolicy';
import {
  ANNOTATION_PALETTE_LABEL_MAX_LENGTH,
  ANNOTATION_PALETTE_MEANING_MAX_LENGTH,
} from '../lib/annotationPalette';
import {
  READER_DICTIONARY_PROVIDERS,
  READER_LANGUAGE_OPTIONS,
  READER_TRANSLATION_PROVIDERS,
} from '../lib/readerLanguageTools';
import { isBrowserTranslatorExposed } from '../lib/browserTranslator';

interface SettingsModalProps {
  settings: ViewerSettings;
  onUpdateSettings: (s: Partial<ViewerSettings>) => void;
  onClose: () => void;
  theme: ThemeClasses;
  isFixedLayout?: boolean;
  annotationPalette: AnnotationPaletteItem[];
  onUpdatePaletteItem: (
    colorId: HighlightColorId,
    patch: Partial<Pick<AnnotationPaletteItem, 'label' | 'meaning'>>,
  ) => void;
  onResetPalette: () => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({ 
  settings,
  onUpdateSettings,
  onClose,
  theme,
  isFixedLayout = false,
  annotationPalette,
  onUpdatePaletteItem,
  onResetPalette,
}) => {
  const [showAdvancedSizing, setShowAdvancedSizing] = useState(false);
  const [showAnnotationPalette, setShowAnnotationPalette] = useState(false);
  const [showLanguageTools, setShowLanguageTools] = useState(false);
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
  const browserTranslatorAvailable = isBrowserTranslatorExposed();
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
      ariaLabel="리더 설정"
      noBlur
      placement="center"
      theme={theme}
      onClose={onClose}
      maxWidth="max-w-[21.25rem]"
      className="font-sans h-[34rem] max-h-[85vh] p-0 flex flex-col"
    >
      <div data-modal-header="settings" className={`flex shrink-0 items-center gap-2.5 border-b ${theme.border} px-5 py-3 sm:px-6`}>
          <div data-modal-header-icon="settings" className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl ${theme.secondary}`}>
            <Settings size={19} aria-hidden="true" />
          </div>
          <h2 className="min-w-0 flex-1 font-bold text-lg">리더 설정</h2>
          <button aria-label="리더 설정 닫기" onClick={onClose} className="p-2 -mr-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-full transition-colors">
            <X size={20} />
          </button>
      </div>

      <div
        data-reader-settings-content="true"
        className="min-h-0 flex-1 overflow-y-auto px-5 pb-5 pt-5 sm:px-6 sm:pb-6"
      >
        <div className="space-y-5">
          <div data-reader-settings-navigation="true">
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

          <div data-reader-settings-toggle-group="true" className="space-y-3">
            {!isFixedLayout && (
              <label
                data-reader-settings-landscape-two-page="true"
                className="flex items-center justify-between gap-4 rounded-xl py-1 text-left"
              >
                <span className="min-w-0">
                  <span className="block text-[11px] font-bold leading-snug">
                    가로 모드 2페이지 보기
                  </span>
                  <span className="mt-0.5 block text-[9px] font-bold leading-snug opacity-45">
                    탭 이동 모드의 가로 화면에서만 왼쪽·오른쪽 두 페이지로 표시합니다
                  </span>
                </span>
                <input
                  type="checkbox"
                  aria-label="가로 모드 2페이지 보기"
                  checked={settings.landscapeTwoPage === true}
                  onChange={(event) => onUpdateSettings({
                    landscapeTwoPage: event.target.checked,
                  })}
                  className="h-4 w-4 shrink-0 accent-accent-600"
                />
              </label>
            )}

            <label
              data-reader-settings-auto-open="true"
              className="flex items-center justify-between gap-4 rounded-xl py-1 text-left"
            >
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

          {!isFixedLayout && (
            <div className={`overflow-hidden rounded-2xl border ${theme.border}`}>
              <button
                type="button"
                aria-expanded={showLanguageTools}
                onClick={() => setShowLanguageTools((current) => !current)}
                className="flex min-h-12 w-full items-center gap-3 px-3 text-left hover:bg-black/5 dark:hover:bg-white/5"
              >
                <Languages size={17} className="shrink-0 opacity-55" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[11px] font-black">번역·사전 설정</span>
                  <span className="block text-[9px] font-bold opacity-45">
                    내장 번역과 외부 검색 경로를 정합니다
                  </span>
                </span>
                <ChevronDown size={16} className={`transition-transform ${showLanguageTools ? 'rotate-180' : ''}`} />
              </button>

              {showLanguageTools && (
                <div className={`space-y-3 border-t ${theme.border} p-3`}>
                  <label className="block">
                    <span className={labelStyle}>Translation path</span>
                    <select
                      aria-label="기본 번역 경로"
                      value={settings.translationProvider}
                      onChange={(event) => onUpdateSettings({
                        translationProvider: event.target.value as ViewerSettings['translationProvider'],
                      })}
                      className={`min-h-10 w-full rounded-xl border ${theme.border} bg-transparent px-3 text-xs font-bold outline-none`}
                    >
                      {READER_TRANSLATION_PROVIDERS.map((provider) => (
                        <option
                          key={provider.value}
                          value={provider.value}
                          disabled={provider.value === 'browser' && !browserTranslatorAvailable}
                        >
                          {provider.label}
                          {provider.value === 'auto' ? ' (내장 우선, Google fallback)' : ''}
                          {provider.value === 'browser' && !browserTranslatorAvailable ? ' (현재 미지원)' : ''}
                        </option>
                      ))}
                    </select>
                  </label>

                  <div className="grid grid-cols-2 gap-2">
                    <label className="block min-w-0">
                      <span className={labelStyle}>Source</span>
                      <select
                        aria-label="번역 원문 언어"
                        value={settings.translationSourceLanguage}
                        onChange={(event) => onUpdateSettings({
                          translationSourceLanguage: event.target.value as ViewerSettings['translationSourceLanguage'],
                        })}
                        className={`min-h-10 w-full rounded-xl border ${theme.border} bg-transparent px-2 text-xs font-bold outline-none`}
                      >
                        <option value="auto">자동 추정</option>
                        {READER_LANGUAGE_OPTIONS.map((language) => (
                          <option key={language.value} value={language.value}>{language.label}</option>
                        ))}
                      </select>
                    </label>
                    <label className="block min-w-0">
                      <span className={labelStyle}>Target</span>
                      <select
                        aria-label="번역 대상 언어"
                        value={settings.translationTargetLanguage}
                        onChange={(event) => onUpdateSettings({
                          translationTargetLanguage: event.target.value as ViewerSettings['translationTargetLanguage'],
                        })}
                        className={`min-h-10 w-full rounded-xl border ${theme.border} bg-transparent px-2 text-xs font-bold outline-none`}
                      >
                        {READER_LANGUAGE_OPTIONS.map((language) => (
                          <option key={language.value} value={language.value}>{language.label}</option>
                        ))}
                      </select>
                    </label>
                  </div>

                  <label className="block">
                    <span className={labelStyle}>Dictionary</span>
                    <select
                      aria-label="기본 사전 경로"
                      value={settings.dictionaryProvider}
                      onChange={(event) => onUpdateSettings({
                        dictionaryProvider: event.target.value as ViewerSettings['dictionaryProvider'],
                      })}
                      className={`min-h-10 w-full rounded-xl border ${theme.border} bg-transparent px-3 text-xs font-bold outline-none`}
                    >
                      {READER_DICTIONARY_PROVIDERS.map((provider) => (
                        <option key={provider.value} value={provider.value}>{provider.label}</option>
                      ))}
                    </select>
                  </label>

                  <p className="text-[9px] font-bold leading-relaxed opacity-45">
                    내장 Translator API는 지원되는 데스크톱 브라우저에서만 표시됩니다. 외부 경로는 실행할 때 선택 원문을 새 탭으로 전달합니다.
                  </p>
                </div>
              )}
            </div>
          )}

          {!isFixedLayout && (
            <div className={`overflow-hidden rounded-2xl border ${theme.border}`}>
              <button
                type="button"
                aria-expanded={showAnnotationPalette}
                onClick={() => setShowAnnotationPalette((current) => !current)}
                className="flex min-h-12 w-full items-center gap-3 px-3 text-left hover:bg-black/5 dark:hover:bg-white/5"
              >
                <span className="min-w-0 flex-1">
                  <span className="block text-[11px] font-black">형광펜 의미 설정</span>
                  <span className="block text-[9px] font-bold opacity-45">표시명과 색상별 용도를 정합니다</span>
                </span>
                <ChevronDown size={16} className={`transition-transform ${showAnnotationPalette ? 'rotate-180' : ''}`} />
              </button>

              {showAnnotationPalette && (
                <div className={`space-y-3 border-t ${theme.border} p-3`}>
                  {annotationPalette.map((item) => (
                    <div key={item.id} className="grid grid-cols-[auto_minmax(0,0.8fr)_minmax(0,1.2fr)] items-center gap-2">
                      <span className="size-4 rounded-full" style={{ backgroundColor: getHighlightColor(item.id).color }} />
                      <input
                        key={`${item.id}:${item.label}`}
                        defaultValue={item.label}
                        maxLength={ANNOTATION_PALETTE_LABEL_MAX_LENGTH}
                        aria-label={`${getHighlightColor(item.id).label} 표시명`}
                        onBlur={(event) => onUpdatePaletteItem(item.id, { label: event.target.value })}
                        className={`min-w-0 rounded-lg border ${theme.border} bg-black/5 px-2 py-2 text-xs font-bold outline-none focus:border-accent-500 dark:bg-white/5`}
                      />
                      <input
                        value={item.meaning}
                        maxLength={ANNOTATION_PALETTE_MEANING_MAX_LENGTH}
                        aria-label={`${getHighlightColor(item.id).label} 의미`}
                        placeholder="의미"
                        onChange={(event) => onUpdatePaletteItem(item.id, { meaning: event.target.value })}
                        className={`min-w-0 rounded-lg border ${theme.border} bg-black/5 px-2 py-2 text-xs outline-none focus:border-accent-500 dark:bg-white/5`}
                      />
                    </div>
                  ))}
                  <button
                    type="button"
                    onClick={onResetPalette}
                    className="flex min-h-10 items-center gap-1.5 rounded-xl px-3 text-[10px] font-bold opacity-55 hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/5"
                  >
                    <RotateCcw size={13} /> 기본값으로 되돌리기
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </ReaderModalFrame>
  );
};
