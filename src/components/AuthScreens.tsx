import React from 'react';
import { HardDrive, User as UserIcon } from 'lucide-react';

type AuthTheme = {
  bg: string;
  text: string;
  border: string;
  secondary: string;
};

interface AuthLandingProps {
  theme: AuthTheme;
  onGoogleSignIn: () => void;
  onGuestMode: () => void;
}

export const AuthLanding: React.FC<AuthLandingProps> = ({
  theme,
  onGoogleSignIn,
  onGuestMode,
}) => (
  <div className="h-screen w-screen flex flex-col items-center justify-center gap-12 p-10 text-center">
    <div className="p-10 bg-accent-600 text-white rounded-[3.5rem] shadow-2xl shadow-accent-500/20">
      <HardDrive size={64} />
    </div>
    <h1 className="text-4xl font-black uppercase tracking-tighter">TW READER</h1>
    <div className="flex flex-col gap-4 w-full max-w-xs">
      <button onClick={onGoogleSignIn} className={`w-full py-5 ${theme.secondary} border ${theme.border} font-black rounded-[2rem] text-xs uppercase tracking-widest shadow-xl active:scale-95 hover:opacity-80 transition-all`}>
        Sign in with Google
      </button>
      <button onClick={onGuestMode} className={`w-full py-5 ${theme.secondary} opacity-70 hover:opacity-100 border ${theme.border} font-bold rounded-[2rem] text-xs uppercase tracking-widest shadow-lg active:scale-95 flex items-center justify-center gap-2 transition-colors`}>
        <UserIcon size={16} />
        <span>Guest Mode (Offline)</span>
      </button>
    </div>
  </div>
);
