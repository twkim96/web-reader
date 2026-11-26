import type { UserProgress } from '../types';
import type { OwnerKey } from './ownerIdentity';

export type GuestReadingEdit = { generation: string; id: string };
export type GuestReadingPosition = UserProgress & { guestReadingEdit?: GuestReadingEdit };
export type GuestReadingBasis = Pick<UserProgress, 'syncRevision' | 'acceptedEventId' | 'ignoredRemoteRevision' | 'localPositionToken'>;

export type GuestReadingHandoff = {
  ownerKey: OwnerKey;
  targetKey: 'guest-reading-handoff';
  account: OwnerKey;
  attemptId: string;
  startedAt: number;
  confirmed: boolean;
  editGeneration?: string;
  legacyStartedAt?: number;
  bases?: Record<string, GuestReadingBasis>;
  importedEditIds?: Record<string, string>;
  importedThrough?: Record<string, number>;
  restoreConfirmedOnCancel?: boolean;
};

export function pendingGuestReadingEdit(handoff: GuestReadingHandoff, row: GuestReadingPosition) {
  if (!Number.isSafeInteger(row.lastRead) || row.lastRead < 0) return;
  const { guestReadingEdit: edit, bookId, lastRead } = row;
  if (edit) {
    if (edit.generation === (handoff.editGeneration ?? handoff.attemptId) && handoff.importedEditIds?.[bookId] !== edit.id) {
      return { id: edit.id };
    }
    return;
  }
  const legacyStart = handoff.editGeneration ? handoff.legacyStartedAt : handoff.startedAt;
  if (legacyStart !== undefined && lastRead > Math.max(legacyStart, handoff.importedThrough?.[bookId] ?? 0)) {
    return { lastRead };
  }
}
