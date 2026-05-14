import { useCallback, useEffect, useState } from 'react';

type BeforeInstallPromptOutcome = 'accepted' | 'dismissed';

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: BeforeInstallPromptOutcome; platform: string }>;
}

interface NavigatorWithStandalone extends Navigator {
  standalone?: boolean;
}

type PWAEnvironment = {
  isIOS: boolean;
  isStandalone: boolean;
  isMobile: boolean;
};

const getPWAEnvironment = (): PWAEnvironment => {
  if (typeof window === 'undefined') {
    return {
      isIOS: false,
      isStandalone: false,
      isMobile: false,
    };
  }

  const navigatorWithStandalone = window.navigator as NavigatorWithStandalone;
  const userAgent = window.navigator.userAgent.toLowerCase();
  const isIOS = /iphone|ipad|ipod/.test(userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || Boolean(navigatorWithStandalone.standalone);
  const isMobile = /iphone|ipad|ipod|android/.test(userAgent);

  return {
    isIOS,
    isStandalone,
    isMobile,
  };
};

export function usePWAInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [environment, setEnvironment] = useState<PWAEnvironment>(getPWAEnvironment);

  useEffect(() => {
    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };
    const refreshEnvironment = () => {
      setEnvironment(getPWAEnvironment());
    };
    const handleAppInstalled = () => {
      setDeferredPrompt(null);
      refreshEnvironment();
    };

    const standaloneMedia = window.matchMedia('(display-mode: standalone)');
    window.addEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
    window.addEventListener('appinstalled', handleAppInstalled);
    if (typeof standaloneMedia.addEventListener === 'function') {
      standaloneMedia.addEventListener('change', refreshEnvironment);
    } else {
      standaloneMedia.addListener(refreshEnvironment);
    }

    return () => {
      window.removeEventListener('beforeinstallprompt', handleBeforeInstallPrompt);
      window.removeEventListener('appinstalled', handleAppInstalled);
      if (typeof standaloneMedia.removeEventListener === 'function') {
        standaloneMedia.removeEventListener('change', refreshEnvironment);
      } else {
        standaloneMedia.removeListener(refreshEnvironment);
      }
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferredPrompt) {
      return false;
    }

    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    setDeferredPrompt(null);
    return outcome === 'accepted';
  }, [deferredPrompt]);

  const { isIOS, isStandalone, isMobile } = environment;

  return { 
    isInstallable: isMobile && !isStandalone && (!!deferredPrompt || isIOS), 
    isIOS, 
    promptInstall, 
    isStandalone,
    isMobile
  };
}
