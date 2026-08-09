'use client';

import { useLayoutEffect } from 'react';

type ScrollLockSnapshot = {
  scrollX: number;
  scrollY: number;
  htmlOverflow: string;
  htmlOverscrollBehavior: string;
  bodyOverflow: string;
  bodyOverscrollBehavior: string;
  bodyPosition: string;
  bodyTop: string;
  bodyLeft: string;
  bodyRight: string;
  bodyWidth: string;
  bodyPaddingRight: string;
};

let activeScrollLocks = 0;
let scrollLockSnapshot: ScrollLockSnapshot | null = null;

const lockBodyScroll = () => {
  if (activeScrollLocks > 0) {
    activeScrollLocks += 1;
    return;
  }

  const html = document.documentElement;
  const body = document.body;
  const scrollX = window.scrollX;
  const scrollY = window.scrollY;
  const scrollbarWidth = Math.max(0, window.innerWidth - html.clientWidth);
  const bodyPaddingRight = window.getComputedStyle(body).paddingRight;

  scrollLockSnapshot = {
    scrollX,
    scrollY,
    htmlOverflow: html.style.overflow,
    htmlOverscrollBehavior: html.style.overscrollBehavior,
    bodyOverflow: body.style.overflow,
    bodyOverscrollBehavior: body.style.overscrollBehavior,
    bodyPosition: body.style.position,
    bodyTop: body.style.top,
    bodyLeft: body.style.left,
    bodyRight: body.style.right,
    bodyWidth: body.style.width,
    bodyPaddingRight: body.style.paddingRight,
  };

  html.style.overflow = 'hidden';
  html.style.overscrollBehavior = 'none';
  body.style.overflow = 'hidden';
  body.style.overscrollBehavior = 'none';
  body.style.position = 'fixed';
  body.style.top = `${-scrollY}px`;
  body.style.left = `${-scrollX}px`;
  body.style.right = '0';
  body.style.width = '100%';

  if (scrollbarWidth > 0) {
    const currentPaddingRight = Number.parseFloat(bodyPaddingRight) || 0;
    body.style.paddingRight = `${currentPaddingRight + scrollbarWidth}px`;
  }

  activeScrollLocks = 1;
};

const unlockBodyScroll = () => {
  if (activeScrollLocks === 0) return;

  activeScrollLocks -= 1;
  if (activeScrollLocks > 0 || !scrollLockSnapshot) return;

  const html = document.documentElement;
  const body = document.body;
  const snapshot = scrollLockSnapshot;
  scrollLockSnapshot = null;

  html.style.overflow = snapshot.htmlOverflow;
  html.style.overscrollBehavior = snapshot.htmlOverscrollBehavior;
  body.style.overflow = snapshot.bodyOverflow;
  body.style.overscrollBehavior = snapshot.bodyOverscrollBehavior;
  body.style.position = snapshot.bodyPosition;
  body.style.top = snapshot.bodyTop;
  body.style.left = snapshot.bodyLeft;
  body.style.right = snapshot.bodyRight;
  body.style.width = snapshot.bodyWidth;
  body.style.paddingRight = snapshot.bodyPaddingRight;
  window.scrollTo(snapshot.scrollX, snapshot.scrollY);
};

export const useBodyScrollLock = (enabled = true) => {
  useLayoutEffect(() => {
    if (!enabled) return;
    lockBodyScroll();
    return unlockBodyScroll;
  }, [enabled]);
};
