'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface UseReaderChromeOptions {
  onBack: () => void;
}

export const useReaderChrome = ({ onBack }: UseReaderChromeOptions) => {
  const [showControls, setShowControls] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showThemeModal, setShowThemeModal] = useState(false);
  const [showBookmarks, setShowBookmarks] = useState(false);
  const [showToc, setShowToc] = useState(false);
  const [showSearchModal, setShowSearchModal] = useState(false);
  const [showJumpInput, setShowJumpInput] = useState(false);
  const [jumpInput, setJumpInput] = useState('');
  const historyPushed = useRef(false);

  const toggleControls = useCallback(() => {
    setShowControls((prev) => !prev);
  }, []);

  const openJumpInput = useCallback(() => {
    setShowJumpInput(true);
    setShowControls(false);
  }, []);

  const closeJumpInput = useCallback(() => {
    setShowJumpInput(false);
    setJumpInput('');
  }, []);

  const closePanels = useCallback(() => {
    setShowSettings(false);
    setShowThemeModal(false);
    setShowBookmarks(false);
    setShowToc(false);
    setShowSearchModal(false);
    setShowJumpInput(false);
  }, []);

  const handleUIBack = useCallback(() => {
    window.history.back();
  }, []);

  useEffect(() => {
    if (!historyPushed.current) {
      window.history.pushState({ panel: 'reader' }, '', '');
      historyPushed.current = true;
    }

    const handlePopState = () => {
      if (showSettings || showThemeModal || showBookmarks || showToc || showSearchModal || showJumpInput) {
        window.history.pushState({ panel: 'reader' }, '', '');
        closePanels();
      } else {
        onBack();
      }
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, [closePanels, onBack, showBookmarks, showJumpInput, showSearchModal, showSettings, showThemeModal, showToc]);

  return {
    showControls,
    setShowControls,
    toggleControls,
    showSettings,
    setShowSettings,
    showThemeModal,
    setShowThemeModal,
    showBookmarks,
    setShowBookmarks,
    showToc,
    setShowToc,
    showSearchModal,
    setShowSearchModal,
    showJumpInput,
    setShowJumpInput,
    jumpInput,
    setJumpInput,
    openJumpInput,
    closeJumpInput,
    closePanels,
    handleUIBack,
  };
};
