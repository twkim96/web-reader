import React from 'react';
import { X } from 'lucide-react';
import { useMenuSheetDrag } from '../hooks/useMenuSheetDrag';

type MenuSheetHeaderProps = {
  title: string;
  onClose: () => void;
  borderClass: string;
  secondaryClass?: string;
  trailing?: React.ReactNode;
  titleId?: string;
  closeLabel?: string;
  closeDisabled?: boolean;
  kind?: string;
  closeButtonRef?: React.Ref<HTMLButtonElement>;
};

export const MenuSheetHeader: React.FC<MenuSheetHeaderProps> = ({
  title,
  onClose,
  borderClass,
  secondaryClass = '',
  trailing,
  titleId,
  closeLabel = `${title} 닫기`,
  closeDisabled = false,
  kind,
  closeButtonRef,
}) => {
  const dragHandlers = useMenuSheetDrag(onClose, closeDisabled);
  return (
  <header
    {...dragHandlers}
    data-menu-sheet-header="true"
    data-modal-header={kind}
    className={`app-menu-sheet-header flex min-h-11 shrink-0 items-center gap-2 px-3 py-1.5 sm:px-4 ${borderClass}`}
  >
    <button
      type="button"
      ref={closeButtonRef}
      data-menu-sheet-close="true"
      onClick={onClose}
      disabled={closeDisabled}
      aria-label={closeLabel}
      className={`app-modal-close flex size-8 shrink-0 items-center justify-center rounded-full ${secondaryClass} transition-opacity hover:opacity-75 disabled:opacity-35`}
    >
      <X size={16} strokeWidth={2.2} />
    </button>
    <div className="min-w-0 flex-1">
      <h2 id={titleId} className="truncate text-[15px] font-bold leading-tight tracking-tight sm:text-[17px]">
        {title}
      </h2>
    </div>
    {trailing && <div className="app-menu-sheet-header-actions flex shrink-0 items-center gap-1">{trailing}</div>}
  </header>
);
};
