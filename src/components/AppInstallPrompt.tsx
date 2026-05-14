import React from 'react';
import { ReaderModalFrame } from './reader/ReaderModalFrame';
import { Download, Share, PlusSquare } from 'lucide-react';
import { ThemeClasses } from '../types';

interface Props {
  theme: ThemeClasses;
  isIOS: boolean;
  onClose: () => void;
  onInstall: () => void;
}

export const AppInstallPrompt: React.FC<Props> = ({ theme, isIOS, onClose, onInstall }) => {
  return (
    <ReaderModalFrame theme={theme as any} onClose={onClose} maxWidth="max-w-[20rem]" className="p-7 text-center font-sans z-[200]">
      <div className="w-16 h-16 bg-accent-500 text-white rounded-2xl flex items-center justify-center mx-auto mb-5 shadow-lg">
        <Download size={32} />
      </div>
      <h2 className="text-lg font-black mb-2">앱으로 쾌적하게 읽기</h2>
      <p className="text-xs opacity-70 mb-6 leading-relaxed">
        Web Reader를 홈 화면에 추가하면<br/>전체화면으로 더 쾌적하게 즐길 수 있습니다.
      </p>

      {isIOS ? (
        <div className="bg-black/5 dark:bg-white/5 rounded-xl p-5 text-left text-[11px] mb-6 space-y-3 font-medium">
          <p className="font-bold opacity-100 mb-2">iOS 설치 방법:</p>
          <div className="flex items-center gap-3 opacity-70">
            <Share size={16} className="shrink-0" /> 하단의 <b>공유</b> 버튼을 누르고
          </div>
          <div className="flex items-center gap-3 opacity-70">
            <PlusSquare size={16} className="shrink-0" /> <b>홈 화면에 추가</b>를 선택하세요.
          </div>
        </div>
      ) : (
        <button 
          onClick={onInstall} 
          className="w-full bg-accent-600 text-white font-bold py-3.5 rounded-xl mb-4 hover:bg-accent-700 active:scale-95 transition-all shadow-md shadow-accent-600/20"
        >
          앱 설치하기
        </button>
      )}
      
      <button onClick={onClose} className="text-[10px] font-bold opacity-40 hover:opacity-100 uppercase tracking-widest transition-opacity mt-2">
        다음에 할게요
      </button>
    </ReaderModalFrame>
  );
};
