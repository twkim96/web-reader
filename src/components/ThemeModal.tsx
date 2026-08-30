import React, { useMemo, useState } from 'react';
import { CustomTheme, CustomThemeTexture, ViewerSettings } from '../types';
import { Check, Plus, Pencil, Trash2 } from 'lucide-react';
import { THEMES, ACCENT_COLORS, ACCENT_PALETTE } from '../lib/constants';
import { ReaderModalFrame } from './reader/ReaderModalFrame';
import { MenuSheetHeader } from './MenuSheetHeader';
import { createCustomThemeId, getTexturePreviewStyle, normalizeHexColor } from '../lib/themeUtils';

interface ThemeModalProps {
  settings: ViewerSettings;
  onUpdateSettings: (s: Partial<ViewerSettings>) => void;
  onClose: () => void;
  theme: { bg: string; text: string; border: string; secondary?: string };
}

const TEXTURE_OPTIONS: Array<[CustomThemeTexture, string]> = [
  ['none', '없음'],
  ['paper', '종이'],
  ['linen', '섬유'],
  ['canvas', '캔버스'],
  ['grid', '격자'],
  ['grain', '입자'],
];

const BUILT_IN_THEME_OPTIONS = [
  ['light', '라이트'],
  ['sepia', '세피아'],
  ['dark', '다크'],
  ['midnight', '자정'],
] as const;

export const ThemeModal: React.FC<ThemeModalProps> = ({
  settings, onUpdateSettings, onClose, theme
}) => {
  const modalFrameClass = 'flex max-h-[82dvh] flex-col overflow-hidden';
  const customThemes = useMemo(() => settings.customThemes || [], [settings.customThemes]);
  const [mode, setMode] = useState<'list' | 'create' | 'edit-select' | 'edit'>('list');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({
    title: '',
    bgColor: '#272728',
    textColor: '#b8b8b8',
    texture: 'none' as CustomThemeTexture,
    accentColor: 'rose',
  });

  const editingTheme = useMemo(
    () => customThemes.find((customTheme) => customTheme.id === editingId),
    [customThemes, editingId]
  );
  
  const handleThemeClick = (themeKey: string) => {
    onUpdateSettings({ theme: themeKey });
  };

  const openCreate = () => {
    setForm({
      title: `커스텀 ${customThemes.length + 1}`,
      bgColor: '#272728',
      textColor: '#b8b8b8',
      texture: 'none',
      accentColor: 'rose',
    });
    setEditingId(null);
    setMode('create');
  };

  const openEdit = (customTheme: CustomTheme) => {
    setForm({
      title: customTheme.title,
      bgColor: normalizeHexColor(customTheme.bgColor, '#272728'),
      textColor: normalizeHexColor(customTheme.textColor, '#b8b8b8'),
      texture: customTheme.texture || 'none',
      accentColor: customTheme.accentColor && ACCENT_PALETTE[customTheme.accentColor]
        ? customTheme.accentColor
        : (ACCENT_PALETTE[settings.accentColor] ? settings.accentColor : 'rose'),
    });
    setEditingId(customTheme.id);
    setMode('edit');
  };

  const saveCustomTheme = () => {
    const title = form.title.trim() || '커스텀 테마';
    const nextTheme: CustomTheme = {
      id: editingTheme?.id || createCustomThemeId(),
      title,
      bgColor: normalizeHexColor(form.bgColor, '#272728'),
      textColor: normalizeHexColor(form.textColor, '#b8b8b8'),
      texture: form.texture,
      accentColor: form.accentColor,
    };

    const nextThemes = editingTheme
      ? customThemes.map((customTheme) => customTheme.id === editingTheme.id ? nextTheme : customTheme)
      : [...customThemes, nextTheme];

    onUpdateSettings({
      customThemes: nextThemes,
      theme: nextTheme.id,
    });
    setMode('list');
    setEditingId(null);
  };

  const deleteCustomTheme = () => {
    if (!editingTheme) return;
    const nextThemes = customThemes.filter((customTheme) => customTheme.id !== editingTheme.id);
    onUpdateSettings({
      customThemes: nextThemes,
      theme: settings.theme === editingTheme.id ? 'sepia' : settings.theme,
    });
    setMode('list');
    setEditingId(null);
  };

  const renderModalHeader = (
    title: string,
    onDismiss: () => void,
    actions?: React.ReactNode,
  ) => <MenuSheetHeader kind="theme" title={title} onClose={onDismiss} borderClass={theme.border} secondaryClass={theme.secondary} trailing={actions} />;

  const renderThemeCard = (key: string, t: { bg: string; text: string }, label: string) => (
    <button
      key={key}
      type="button"
      data-theme-option={key}
      aria-label={`${label} 테마`}
      aria-pressed={settings.theme === key}
      onClick={() => handleThemeClick(key)}
      className={`
        relative flex aspect-square min-w-0 flex-col items-center justify-center rounded-[14px] border border-current/15 text-center transition-all active:scale-95
        ${t.bg} ${t.text}
        ${settings.theme === key ? 'outline outline-2 outline-offset-2 outline-current' : ''}
      `}
    >
      <span className="font-serif text-[1.65rem] font-medium leading-none">Aa</span>
      <span className="mt-1.5 max-w-full truncate px-1 text-[9px] font-medium sm:text-[10px]">{label}</span>
      {settings.theme === key && (
        <div className="absolute right-1.5 top-1.5 text-current">
          <Check size={13} strokeWidth={3} />
        </div>
      )}
    </button>
  );

  if (mode === 'create' || mode === 'edit') {
    const previewBg = normalizeHexColor(form.bgColor, '#272728');
    const previewText = normalizeHexColor(form.textColor, '#b8b8b8');

    return (
      <ReaderModalFrame
        ariaLabel={mode === 'create' ? '커스텀 테마 추가' : '커스텀 테마 편집'}
        menuSheet
        noBlur
        placement="center"
        theme={theme}
        onClose={() => setMode('list')}
        maxWidth="max-w-sm"
        className={modalFrameClass}
      >
        {renderModalHeader(mode === 'create' ? '커스텀 테마 추가' : '커스텀 테마 편집', () => setMode('list'))}

        <div data-theme-modal-scroll-body="true" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-6">
          <div className="space-y-4">
            <label className="block">
              <span className="text-[10px] font-bold opacity-40 uppercase tracking-widest">테마 이름</span>
              <input
                value={form.title}
                onChange={(e) => setForm((prev) => ({ ...prev, title: e.target.value }))}
                className={`mt-1.5 w-full rounded-xl border ${theme.border} ${theme.secondary || ''} px-4 py-2.5 text-sm font-bold outline-none focus:ring-2 focus:ring-accent-500`}
                placeholder="내 테마"
              />
            </label>

          <div className="grid grid-cols-2 gap-3">
            {[
              ['배경색', 'bgColor'],
              ['글자색', 'textColor'],
            ].map(([label, key]) => (
              <label key={key} className="block min-w-0">
                <span className="text-[10px] font-bold opacity-40 uppercase tracking-widest">{label}</span>
                <div className="mt-1.5 flex items-center gap-2">
                  <input
                    type="color"
                    value={normalizeHexColor(form[key as 'bgColor' | 'textColor'], key === 'bgColor' ? '#272728' : '#b8b8b8')}
                    onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
                    className="h-10 w-10 shrink-0 rounded-xl border-0 bg-transparent p-0"
                    aria-label={label}
                  />
                  <input
                    value={form[key as 'bgColor' | 'textColor']}
                    onChange={(e) => setForm((prev) => ({ ...prev, [key]: e.target.value }))}
                    className={`min-w-0 flex-1 rounded-xl border ${theme.border} ${theme.secondary || ''} px-3 py-2.5 text-xs font-bold outline-none focus:ring-2 focus:ring-accent-500`}
                    placeholder="#ededed"
                  />
                </div>
              </label>
            ))}
          </div>

          <div data-custom-theme-accent-picker="true">
            <p className="mb-2 text-[10px] font-bold uppercase tracking-widest opacity-40">포인트 색상</p>
            <div className="grid grid-cols-6 gap-2">
              {ACCENT_COLORS.map((color) => {
                const selected = form.accentColor === color;
                return (
                  <button
                    key={color}
                    type="button"
                    aria-label={`${color} 포인트 색상`}
                    aria-pressed={selected}
                    onClick={() => setForm((prev) => ({ ...prev, accentColor: color }))}
                    className={`aspect-square rounded-full border-2 border-transparent transition-transform active:scale-90 ${selected ? 'outline outline-2 outline-offset-2 outline-current' : 'opacity-55 hover:opacity-100'}`}
                    style={{ backgroundColor: ACCENT_PALETTE[color]?.[500] || ACCENT_PALETTE.rose[500] }}
                  />
                );
              })}
            </div>
          </div>

          <div>
            <p className="text-[10px] font-bold opacity-40 uppercase tracking-widest mb-1.5">질감</p>
            <div className="grid grid-cols-3 gap-2">
              {TEXTURE_OPTIONS.map(([value, label]) => (
                <button
                  key={value}
                  onClick={() => setForm((prev) => ({ ...prev, texture: value as CustomThemeTexture }))}
                  className={`h-9 rounded-xl text-xs font-bold transition-all active:scale-95 ${form.texture === value ? 'bg-accent-600 text-white' : `${theme.secondary || ''} opacity-70 hover:opacity-100`}`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          <div
            className="rounded-[14px] border border-current/10 p-3"
            style={{
              backgroundColor: previewBg,
              color: previewText,
              ...getTexturePreviewStyle(form.texture, previewText),
            }}
          >
            <p className="text-sm font-bold">미리보기 문장입니다.</p>
            <p className="mt-1.5 text-xs opacity-65">배경색, 글자색, 질감 설정을 확인하세요.</p>
            <span
              className="mt-3 block h-1.5 w-20 rounded-full"
              style={{ backgroundColor: ACCENT_PALETTE[form.accentColor]?.[500] || ACCENT_PALETTE.rose[500] }}
            />
          </div>

            <div className="flex gap-2 pt-1">
              {mode === 'edit' && (
                <button onClick={deleteCustomTheme} className="flex h-11 w-11 items-center justify-center rounded-xl text-red-400 hover:bg-red-500/10">
                  <Trash2 size={18} />
                </button>
              )}
              <button onClick={() => setMode('list')} className={`h-11 flex-1 rounded-xl ${theme.secondary || ''} text-sm font-bold opacity-70 hover:opacity-100`}>
                취소
              </button>
              <button onClick={saveCustomTheme} className="h-11 flex-1 rounded-xl bg-accent-600 text-sm font-bold text-white shadow-lg shadow-accent-500/20">
                확인
              </button>
            </div>
          </div>
        </div>
      </ReaderModalFrame>
    );
  }

  if (mode === 'edit-select') {
    return (
      <ReaderModalFrame
        ariaLabel="편집할 테마 선택"
        menuSheet
        noBlur
        placement="center"
        theme={theme}
        onClose={() => setMode('list')}
        maxWidth="max-w-sm"
        className={modalFrameClass}
      >
        {renderModalHeader('편집할 테마 선택', () => setMode('list'))}

        <div data-theme-modal-scroll-body="true" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-6">
          <div className="space-y-2">
            {customThemes.length === 0 ? (
              <div className={`rounded-2xl ${theme.secondary || ''} p-8 text-center text-xs font-bold opacity-50`}>
                아직 커스텀 테마가 없습니다.
              </div>
            ) : (
              customThemes.map((customTheme) => (
                <button
                  key={customTheme.id}
                  onClick={() => openEdit(customTheme)}
                  className={`flex w-full items-center justify-between rounded-2xl border ${theme.border} ${theme.secondary || ''} p-4 text-left transition-all active:scale-95`}
                >
                  <span className="font-bold">{customTheme.title}</span>
                  <span className="flex items-center gap-2">
                    <span className="h-5 w-5 rounded-full border border-current/10" style={{ backgroundColor: customTheme.bgColor }} />
                    <span className="h-5 w-5 rounded-full border border-current/10" style={{ backgroundColor: customTheme.textColor }} />
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      </ReaderModalFrame>
    );
  }

  return (
    <ReaderModalFrame
      ariaLabel="테마 설정"
      menuSheet
      noBlur
      placement="center"
      theme={theme}
      onClose={onClose}
      maxWidth="max-w-sm"
      className={modalFrameClass}
    >
      {renderModalHeader('테마 설정', onClose, (
        <>
          <button onClick={openCreate} className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-full transition-colors" aria-label="커스텀 테마 추가"><Plus size={19} /></button>
          <button onClick={() => setMode('edit-select')} className="p-2 hover:bg-black/5 dark:hover:bg-white/5 rounded-full transition-colors" aria-label="커스텀 테마 편집"><Pencil size={18} /></button>
        </>
      ))}

      <div data-theme-modal-scroll-body="true" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-5 sm:p-6">
        <section className="mb-6">
          <p className="mb-3 text-[10px] font-bold uppercase tracking-widest opacity-40">읽기 테마</p>
          <div data-theme-list-scroll="true" className="grid grid-cols-4 gap-2">
            {BUILT_IN_THEME_OPTIONS.map(([key, label]) => renderThemeCard(key, THEMES[key], label))}
          </div>
        </section>

        {customThemes.length > 0 && (
          <section className="mb-6">
            <p className="mb-3 text-[10px] font-bold uppercase tracking-widest opacity-40">커스텀 테마</p>
            <div data-custom-theme-list-scroll="true" className="grid max-h-[9.75rem] grid-cols-4 gap-2 overflow-y-auto overscroll-y-auto p-1">
              {customThemes.map((customTheme) => (
                <button
                  key={customTheme.id}
                  type="button"
                  data-custom-theme-option={customTheme.id}
                  aria-label={`${customTheme.title} 커스텀 테마`}
                  aria-pressed={settings.theme === customTheme.id}
                  onClick={() => handleThemeClick(customTheme.id)}
                  className={`relative flex aspect-square min-w-0 flex-col items-center justify-center rounded-[14px] border border-current/15 text-center transition-all active:scale-95 ${settings.theme === customTheme.id ? 'outline outline-2 outline-offset-2 outline-current' : ''}`}
                  style={{
                    backgroundColor: customTheme.bgColor,
                    color: customTheme.textColor,
                    ...getTexturePreviewStyle(customTheme.texture || 'none', customTheme.textColor),
                  }}
                >
                  <span className="font-serif text-[1.65rem] font-medium leading-none">Aa</span>
                  <span className="mt-1.5 max-w-full truncate px-1 text-[9px] font-medium sm:text-[10px]">{customTheme.title}</span>
                  {settings.theme === customTheme.id && (
                    <Check className="absolute right-1.5 top-1.5 text-current" size={13} strokeWidth={3} />
                  )}
                </button>
              ))}
            </div>
          </section>
        )}

        <div className="mb-6">
          <p className="mb-3 text-[10px] font-bold uppercase tracking-widest opacity-40">메뉴 스타일</p>
          <div className="grid grid-cols-4 gap-2">
            {([
              ['standard', '표준'],
              ['glass', '글래스'],
              ['modern', '모던'],
            ] as const).map(([value, label]) => {
              const selected = settings.shelfDockStyle === value;
              const previewClass = value === 'glass'
                ? 'viewer-cime-glass'
                : value === 'modern'
                  ? 'shelf-muzio-dock'
                  : 'border-[color:var(--viewer-theme-border)] bg-[color:var(--viewer-reader-glass-surface,var(--viewer-reader-surface))] backdrop-blur-xl';
              return (
                <button
                  key={value}
                  type="button"
                  data-shelf-dock-style-option={value}
                  onClick={() => onUpdateSettings({ shelfDockStyle: value })}
                  className={`relative flex aspect-square min-w-0 flex-col items-center justify-center gap-2 overflow-hidden rounded-[14px] border p-2 text-center text-[color:var(--viewer-theme-text)] transition-all active:scale-95 ${previewClass}`}
                >
                  <span data-menu-style-texture-preview="true" className="relative z-[1] flex h-9 w-[90%] items-end justify-center gap-1 overflow-hidden rounded-lg border border-current/10 bg-current/5 px-2 py-1.5">
                    <span className="h-2.5 w-1 rounded-full bg-current opacity-30" />
                    <span className="h-4 w-1 rounded-full bg-current opacity-55" />
                    <span className="h-3 w-1 rounded-full bg-current opacity-40" />
                  </span>
                  <span className="relative z-[1] block max-w-full truncate px-1 text-[9px] font-medium sm:text-[10px]">{label}</span>
                  {selected && (
                    <>
                      <span
                        data-shelf-dock-style-selected-box="true"
                        className="pointer-events-none absolute inset-0 z-[2] rounded-[14px] border-2 border-current"
                        aria-hidden="true"
                      />
                      <Check className="absolute right-1.5 top-1.5 z-[3] text-current" size={13} strokeWidth={3} />
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      </div>
    </ReaderModalFrame>
  );
};
