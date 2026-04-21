// src/components/AuthView.tsx
'use client';

import React from 'react';
import { User as FirebaseUser } from 'firebase/auth';
import { HardDrive, LogOut, ShieldCheck, Wifi, WifiOff, User as UserIcon } from 'lucide-react';

interface AuthViewProps {
  user: FirebaseUser | null;
  theme: {
    bg: string;
    text: string;
    border: string;
    secondary: string;
  };
  isPublicPC: boolean;
  setIsPublicPC: (v: boolean) => void;
  onSignIn: () => void;
  onGuestMode: () => void;
  onConnect: () => void;
  onLocalMode: () => void;
  onLogout: () => void;
}

export function AuthView({
  user, theme, isPublicPC, setIsPublicPC,
  onSignIn, onGuestMode, onConnect, onLocalMode, onLogout
}: AuthViewProps) {
  // 비로그인 화면
  if (!user) {
    return (
      <div className="h-screen w-screen flex flex-col items-center justify-center gap-12 p-10 text-center">
        <div className="p-10 bg-accent-600 text-white rounded-[3.5rem] shadow-2xl shadow-accent-500/20">
          <HardDrive size={64} />
        </div>
        <h1 className="text-4xl font-black italic uppercase tracking-tighter">TW-WEB Reader</h1>
        <div className="flex flex-col gap-4 w-full max-w-xs">
          <button onClick={onSignIn} className={`w-full py-5 ${theme.secondary} border ${theme.border} font-black rounded-[2rem] text-xs uppercase tracking-widest shadow-xl active:scale-95 hover:opacity-80 transition-all`}>
            Sign in with Google
          </button>
          <button onClick={onGuestMode} className={`w-full py-5 ${theme.secondary} opacity-70 hover:opacity-100 border ${theme.border} font-bold rounded-[2rem] text-xs uppercase tracking-widest shadow-lg active:scale-95 flex items-center justify-center gap-2 transition-colors`}>
            <UserIcon size={16} />
            <span>Guest Mode (Offline)</span>
          </button>
        </div>
      </div>
    );
  }

  // 로그인 후 모드 선택 화면
  return (
    <div className="h-screen w-screen flex flex-col items-center justify-center gap-8 p-10 text-center">
      <div className="relative mb-4">
        <div className="p-10 bg-accent-600 text-white rounded-[3.5rem] shadow-2xl">
          <HardDrive size={64} />
        </div>
        <button onClick={onLogout} className="absolute -top-2 -right-2 p-3 bg-red-500 rounded-full shadow-lg active:scale-90"><LogOut size={18} /></button>
      </div>
      <div className="space-y-1 mb-2">
        <p className="text-accent-400 font-black text-[10px] uppercase tracking-[0.3em]">Welcome back</p>
        <h1 className="text-xl font-bold">{user.displayName || user.email}</h1>
      </div>
      <div className="w-full max-w-xs space-y-4">
        <button onClick={onConnect} className={`group relative w-full py-5 ${theme.secondary} border ${theme.border} font-black rounded-[2rem] text-xs uppercase tracking-widest shadow-xl active:scale-95 flex items-center justify-center gap-3 overflow-hidden hover:opacity-80 transition-all`}>
          <div className="absolute inset-0 bg-accent-500 opacity-0 group-hover:opacity-10 transition-opacity" />
          <Wifi size={18} className="text-accent-600 dark:text-accent-400" />
          <span>Connect Cloud</span>
        </button>
        <button onClick={onLocalMode} className={`w-full py-5 ${theme.secondary} opacity-70 hover:opacity-100 border ${theme.border} font-bold rounded-[2rem] text-xs uppercase tracking-widest shadow-lg active:scale-95 flex items-center justify-center gap-3 transition-colors`}>
          <WifiOff size={18} />
          <span>Local Library Only</span>
        </button>
        <label className={`flex items-center justify-center gap-3 p-4 rounded-2xl border-2 transition-all cursor-pointer ${isPublicPC ? 'border-accent-500 bg-accent-500/10' : `border-transparent ${theme.secondary}`}`}>
          <input type="checkbox" checked={isPublicPC} onChange={(e) => setIsPublicPC(e.target.checked)} className="hidden" />
          <ShieldCheck size={20} className={isPublicPC ? 'text-accent-500' : 'opacity-40'} />
          <span className={`text-[11px] font-bold uppercase tracking-wider ${isPublicPC ? 'text-accent-500' : 'opacity-60'}`}>
            {isPublicPC ? 'Public PC (Session Only)' : 'Private PC (Keep Logged in)'}
          </span>
        </label>
      </div>
    </div>
  );
}
