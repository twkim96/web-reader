import React from 'react';

type ReaderModalTheme = {
  bg: string;
  text?: string;
  border: string;
};

interface ReaderModalFrameProps {
  theme: ReaderModalTheme;
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: string;
  className?: string;
  zIndex?: string;
  noBlur?: boolean;
}

export const ReaderModalFrame: React.FC<ReaderModalFrameProps> = ({
  theme,
  onClose,
  children,
  maxWidth = 'max-w-sm',
  className = '',
  zIndex = 'z-[110]',
  noBlur = false,
}) => (
  <div
    className={`fixed inset-0 ${zIndex} flex items-center justify-center p-4 sm:p-6 ${noBlur ? 'bg-black/20' : 'bg-black/60 backdrop-blur-sm'} animate-in fade-in duration-200`}
    onClick={onClose}
  >
    <div
      onClick={(event) => event.stopPropagation()}
      className={`w-full ${maxWidth} ${theme.bg} ${theme.text || ''} rounded-3xl shadow-2xl border ${theme.border} overflow-hidden animate-in zoom-in-95 duration-200 ${className}`}
    >
      {children}
    </div>
  </div>
);
