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
      title: `Custom ${customThemes.length + 1}`,
      bgColor: '#272728',
      textColor: '#b8b8b8',
      texture: 'none',
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
    });
    setEditingId(customTheme.id);
    setMode('edit');
  };

  const saveCustomTheme = () => {
    const title = form.title.trim() || 'Custom Theme';
    const nextTheme: CustomTheme = {
      id: editingTheme?.id || createCustomThemeId(),
      title,
      bgColor: normalizeHexColor(form.bgColor, '#272728'),
      textColor: normalizeHexColor(form.textColor, '#b8b8b8'),
      texture: form.texture,
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

  const renderThemeCard = (key: string, t: { bg: string; text: string }, label = key) => (
    <button
      key={key}
      type="button"
      data-theme-option={key}
      aria-label={`${label} 테마`}
      aria-pressed={settings.theme === key}
      onClick={() => handleThemeClick(key)}
      className={`
        relative h-20 min-w-0 p-4 rounded-2xl border-2 text-left transition-all active:scale-95
        ${t.bg} ${t.text}
        ${settings.theme === key ? 'border-accent-500 ring-2 ring-accent-500/20' : `border-transparent ${theme.border}`}
      `}
    >
      <div className="font-bold capitalize mb-1 truncate">{label}</div>
      <div className="text-[10px] opacity-60">Comfortable reading</div>
      {settings.theme === key && (
        <div className="absolute top-3 right-3 text-accent-500">
          <Check size={16} strokeWidth={3} />
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
              <span className="text-[10px] font-bold opacity-40 uppercase tracking-widest">Theme Title</span>
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

          <div>
            <p className="text-[10px] font-bold opacity-40 uppercase tracking-widest mb-1.5">Texture</p>
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
            className="rounded-2xl border border-current/10 p-3"
            style={{
              backgroundColor: previewBg,
              color: previewText,
              ...getTexturePreviewStyle(form.texture, previewText),
            }}
          >
            <p className="text-sm font-bold">미리보기 문장입니다.</p>
            <p className="mt-1.5 text-xs opacity-65">배경색, 글자색, 질감 설정을 확인하세요.</p>
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

      <div data-theme-modal-scroll-body="true" className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-6">
        <div
          data-theme-list-scroll="true"
          className="mb-8 grid max-h-[264px] grid-cols-2 gap-3 overflow-y-auto overscroll-contain"
        >
          {Object.entries(THEMES).map(([key, t]) => renderThemeCard(key, t))}
          {customThemes.map((customTheme) => (
            <button
              key={customTheme.id}
              data-custom-theme-option={customTheme.id}
              onClick={() => handleThemeClick(customTheme.id)}
              className={`
                relative h-20 min-w-0 p-4 rounded-2xl border-2 text-left transition-all active:scale-95
                ${settings.theme === customTheme.id ? 'border-accent-500 ring-2 ring-accent-500/20' : `border-transparent ${theme.border}`}
              `}
              style={{
                backgroundColor: customTheme.bgColor,
                color: customTheme.textColor,
                ...getTexturePreviewStyle(customTheme.texture || 'none', customTheme.textColor),
              }}
            >
              <div className="font-bold mb-1 truncate">{customTheme.title}</div>
              <div className="text-[10px] opacity-60">Custom theme</div>
              {settings.theme === customTheme.id && (
                <div className="absolute top-3 right-3 text-accent-500">
                  <Check size={16} strokeWidth={3} />
                </div>
              )}
            </button>
          ))}
        </div>

        <div className="mb-6">
          <p className="mb-3 text-[10px] font-bold uppercase tracking-widest opacity-40">메뉴 스타일 · 책장 / 리더</p>
          <div className="grid grid-cols-3 gap-2">
            {([
              ['standard', '표준', '반투명 유리'],
              ['glass', '글래스', '저블러 투명 유리'],
              ['modern', '모던', '선명한 미니바'],
            ] as const).map(([value, label, description]) => {
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
                  className={`relative min-w-0 overflow-hidden rounded-2xl border px-2.5 py-3 text-left text-[color:var(--viewer-theme-text)] transition-all active:scale-95 ${previewClass}`}
                >
                  <span className="relative z-[1] block text-sm font-bold">{label}</span>
                  <span className="relative z-[1] mt-0.5 block text-[10px] opacity-55">{description}</span>
                  {selected && (
                    <>
                      <span
                        data-shelf-dock-style-selected-box="true"
                        className="pointer-events-none absolute inset-0 z-[2] rounded-2xl border-2 border-accent-500"
                        aria-hidden="true"
                      />
                      <Check className="absolute right-3 top-3 z-[3] text-accent-500" size={14} strokeWidth={3} />
                    </>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {/* 포인트 컬러 설정 섹션 */}
        <div>
          <p className="text-[10px] font-bold opacity-40 uppercase tracking-widest mb-3">Point Color</p>
          <div className="flex items-center gap-3.5">
            {ACCENT_COLORS.map(color => (
              <button
                key={color}
                onClick={() => onUpdateSettings({ accentColor: color })}
                className={`w-6 h-6 rounded-full shrink-0 transition-all outline-none ${settings.accentColor === color ? 'ring-2 ring-offset-2 ring-accent-500 ring-offset-transparent scale-110 shadow-lg shadow-accent-500/20' : 'opacity-40 hover:opacity-100 hover:scale-110'}`}
                style={{ backgroundColor: ACCENT_PALETTE[color]?.[500] || ACCENT_PALETTE.indigo[500] }}
                title={`${color}`}
              />
            ))}
          </div>
        </div>
      </div>
    </ReaderModalFrame>
  );
};
