'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { AnnotationPaletteItem, HighlightColorId } from '../types';
import type { OwnerKey } from '../lib/ownerIdentity';
import {
  getStoredAnnotationPalette,
  normalizeAnnotationPalette,
  saveStoredAnnotationPalette,
} from '../lib/annotationPalette';
import type { AnnotationSyncContextV5 } from '../lib/syncOutboxV5';
import { trackLocalCommit } from '../lib/localCommitTracker';
import {
  broadcastAnnotationSyncChange,
  notifyAnnotationSyncChange,
  subscribeAnnotationSyncChanges,
} from '../lib/annotationSyncWake';
import {
  initializeLocalAnnotationPaletteV9,
  saveLocalAnnotationPaletteV9,
} from '../lib/localAnnotationPalette';

export const useAnnotationPalette = (
  ownerKey: OwnerKey,
  syncContext?: AnnotationSyncContextV5,
) => {
  const [palette, setPalette] = useState<AnnotationPaletteItem[]>(() => (
    getStoredAnnotationPalette(ownerKey)
  ));
  const paletteRef = useRef(palette);

  useEffect(() => {
    let cancelled = false;
    const fallback = getStoredAnnotationPalette(ownerKey);
    paletteRef.current = fallback;
    void initializeLocalAnnotationPaletteV9(ownerKey, fallback)
      .then((next) => {
        if (cancelled) return;
        paletteRef.current = next;
        saveStoredAnnotationPalette(ownerKey, next);
        setPalette(next);
      })
      .catch((error) => {
        console.error('[AnnotationPalette] canonical load failed:', error);
      });
    return () => {
      cancelled = true;
    };
  }, [ownerKey]);

  useEffect(() => subscribeAnnotationSyncChanges(ownerKey, (change) => {
    if (!change.palette) return;
    const next = normalizeAnnotationPalette(change.palette);
    paletteRef.current = next;
    setPalette(next);
  }), [ownerKey]);

  const updatePaletteItem = useCallback((
    colorId: HighlightColorId,
    patch: Partial<Pick<AnnotationPaletteItem, 'label' | 'meaning'>>,
  ) => {
    const previous = paletteRef.current;
    const next = normalizeAnnotationPalette(previous.map((item) => (
      item.id === colorId ? { ...item, ...patch } : item
    )));
    paletteRef.current = next;
    setPalette(next);
    void trackLocalCommit(saveLocalAnnotationPaletteV9(
      ownerKey,
      next,
      syncContext,
    )).then((saved) => {
      saveStoredAnnotationPalette(ownerKey, saved);
      broadcastAnnotationSyncChange({ ownerKey, palette: saved });
    }).catch((error) => {
      console.error('[AnnotationPalette] sync enqueue failed:', error);
      if (paletteRef.current === next) {
        paletteRef.current = previous;
        saveStoredAnnotationPalette(ownerKey, previous);
        setPalette(previous);
      }
    });
  }, [ownerKey, syncContext]);

  const resetPalette = useCallback(() => {
    const previous = paletteRef.current;
    const next = normalizeAnnotationPalette(undefined);
    paletteRef.current = next;
    setPalette(next);
    void trackLocalCommit(saveLocalAnnotationPaletteV9(
      ownerKey,
      next,
      syncContext,
    )).then((saved) => {
      saveStoredAnnotationPalette(ownerKey, saved);
      broadcastAnnotationSyncChange({ ownerKey, palette: saved });
    }).catch((error) => {
      console.error('[AnnotationPalette] reset sync enqueue failed:', error);
      if (paletteRef.current === next) {
        paletteRef.current = previous;
        saveStoredAnnotationPalette(ownerKey, previous);
        setPalette(previous);
      }
    });
  }, [ownerKey, syncContext]);

  const applyRemotePalette = useCallback(async (value: unknown) => {
    const next = normalizeAnnotationPalette(value);
    const saved = await saveLocalAnnotationPaletteV9(ownerKey, next);
    paletteRef.current = saved;
    saveStoredAnnotationPalette(ownerKey, saved);
    setPalette(saved);
    notifyAnnotationSyncChange({ ownerKey, palette: saved });
    return saved;
  }, [ownerKey]);

  return { palette, updatePaletteItem, resetPalette, applyRemotePalette };
};
