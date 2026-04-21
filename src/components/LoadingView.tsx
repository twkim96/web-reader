// src/components/LoadingView.tsx
'use client';

import React from 'react';

interface LoadingViewProps {
  theme: {
    bg: string;
    text: string;
  };
  dynamicStyles: React.CSSProperties;
}

export function LoadingView({ theme, dynamicStyles }: LoadingViewProps) {
  return (
    <div className={`h-screen w-screen flex flex-col items-center justify-center ${theme.bg} ${theme.text} gap-4 transition-colors duration-300`} style={dynamicStyles}>
      <div className="w-12 h-12 border-4 border-accent-500 border-t-transparent rounded-full animate-spin" />
      <p className="font-black uppercase tracking-widest text-xs opacity-30">Loading Library...</p>
    </div>
  );
}
