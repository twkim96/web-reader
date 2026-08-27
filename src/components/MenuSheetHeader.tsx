import React from 'react';
import { X } from 'lucide-react';

type MenuSheetHeaderProps = {
  title: string;
  onClose: () => void;
  borderClass: string;
  secondaryClass?: string;
  subtitle?: React.ReactNode;
  trailing?: React.ReactNode;
  titleId?: string;
  closeLabel?: string;
  closeDisabled?: boolean;
  kind?: string;
};

export const MenuSheetHeader: React.FC<MenuSheetHeaderProps> = ({
  title,
  onClose,
  borderClass,
  secondaryClass = '',
  subtitle,
  trailing,
  titleId,
  closeLabel = `${title} 닫기`,
  closeDisabled = false,
  kind,
}) => (
  <header
    data-menu-sheet-header="true"
    data-modal-header={kind}
    className={`flex shrink-0 items-center gap-3 border-b px-3 py-3 sm:px-4 ${borderClass}`}
  >
    <button
      type="button"
      data-menu-sheet-close="true"
      onClick={onClose}
      disabled={closeDisabled}
      aria-label={closeLabel}
      className={`flex size-10 shrink-0 items-center justify-center rounded-full ${secondaryClass} transition-opacity hover:opacity-75 disabled:opacity-35`}
    >
      <X size={20} strokeWidth={2.2} />
    </button>
    <div className="min-w-0 flex-1">
      <h2 id={titleId} className="truncate text-base font-bold tracking-tight sm:text-lg">
        {title}
      </h2>
      {subtitle && <div className="mt-0.5 truncate text-[10px] font-medium opacity-50 sm:text-[11px]">{subtitle}</div>}
    </div>
    {trailing && <div className="flex shrink-0 items-center gap-1">{trailing}</div>}
  </header>
);
