'use client';

import React from 'react';
import { RefreshCw } from 'lucide-react';
import { SyncConflict } from '../../hooks/reader/useRemoteProgressPrompt';

type ReaderTheme = {
  bg: string;
};

interface SyncConflictDialogProps {
  theme: ReaderTheme;
  syncConflict: SyncConflict;
  onDismiss: () => void;
  onAccept: () => void;
}

export const SyncConflictDialog: React.FC<SyncConflictDialogProps> = ({
  theme,
  syncConflict,
  onDismiss,
  onAccept,
}) => (
  <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
    <div className={`${theme.bg} rounded-2xl p-6 shadow-2xl border border-white/10 w-full max-w-sm`}>
      <div className="flex items-center gap-3 text-accent-500 mb-2">
        <RefreshCw size={22} />
        <h3 className="text-lg font-bold tracking-tight">클라우드 동기화</h3>
      </div>
      <p className="text-sm opacity-80 mb-6 leading-relaxed">
        다른 기기에서 <span className="font-bold text-accent-500">{syncConflict.percent.toFixed(1)}%</span>까지 읽은 기록이 있습니다.<br />해당 위치로 이동하시겠습니까?
      </p>
      <div className="flex gap-3">
        <button onClick={onDismiss} className="flex-1 py-3 px-4 rounded-xl text-sm font-bold bg-gray-500/10 hover:bg-gray-500/20 transition-colors">
          무시
        </button>
        <button
          onClick={onAccept}
          className="flex-1 py-3 px-4 rounded-xl text-sm font-bold bg-accent-500 text-white hover:bg-accent-600 transition-colors shadow-lg shadow-accent-500/30"
        >
          이동하기
        </button>
      </div>
    </div>
  </div>
);
