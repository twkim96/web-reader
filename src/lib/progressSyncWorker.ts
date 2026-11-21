import { ANNOTATION_BOOK_DELETE_MARKER_ID } from './annotationPolicy';
import { isAnnotationHeadV1, isAnnotationSyncReceiptV1, type AnnotationHeadV1 } from './annotationSyncSchema';
import { isEventReceiptV2 } from './progressV2Schema';
import type { OwnerSnapshot } from './ownerRuntime';
import { ownerRuntime } from './ownerRuntime';
import type { OwnerKey } from './ownerIdentity';
import {
  acknowledgeProgressEventV5,
  acquireSyncLeaseV5,
  claimNextProgressEventV5,
  getExpectedClaimV5,
  isSyncLeaseCurrentV5,
  pauseProgressEventV5,
  recordProgressConflictV5,
  recoverExpiredInFlightEventsV5,
  releaseSyncLeaseV5,
  scheduleProgressEventRetryV5,
  supersedeAnnotationDeletionV5,
  type SyncHeadV2,
  type SyncConflictV5,
  type SyncOutboxEventV5,
  type SyncLeaseV5,
} from './syncOutboxV5';

export type SyncTransactionDecision =
  | { status: 'superseded'; remoteMarker?: AnnotationHeadV1 | null }
  | { status: 'apply' | 'already_applied'; head: SyncHeadV2; receipt: unknown }
  | {
    status: 'conflict';
    remoteHead: SyncHeadV2 | null;
    conflictReason?: SyncConflictV5['conflictReason'];
    remoteBookGeneration?: number;
  };

type ProgressTransport = (
  event: SyncOutboxEventV5,
) => Promise<SyncTransactionDecision>;

type WorkerDependencies = {
  acknowledge?: typeof acknowledgeProgressEventV5;
  acquireLease?: typeof acquireSyncLeaseV5;
  claimNext?: typeof claimNextProgressEventV5;
  isLeaseCurrent?: typeof isSyncLeaseCurrentV5;
  pause?: typeof pauseProgressEventV5;
  recordConflict?: typeof recordProgressConflictV5;
  recover?: typeof recoverExpiredInFlightEventsV5;
  releaseLease?: typeof releaseSyncLeaseV5;
  scheduleRetry?: typeof scheduleProgressEventRetryV5;
  supersede?: typeof supersedeAnnotationDeletionV5;
  now?: () => number;
};

const retryableCodes = new Set([
  'aborted',
  'deadline-exceeded',
  'internal',
  'resource-exhausted',
  'unavailable',
  'unknown',
  'sync/write-lease-pending',
]);

const errorCode = (error: unknown) => {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String(error.code).replace(/^firestore\//, '');
  }
  if (error instanceof TypeError) return 'network-error';
  return error instanceof Error ? error.name : 'unknown';
};

export const isRetryableProgressSyncError = (error: unknown) => {
  const code = errorCode(error);
  return code === 'network-error' || retryableCodes.has(code);
};

export class ProgressSyncWorker {
  private readonly acknowledge;
  private readonly acquireLease;
  private readonly claimNext;
  private readonly isLeaseCurrent;
  private readonly pause;
  private readonly recordConflict;
  private readonly recover;
  private readonly releaseLease;
  private readonly scheduleRetry;
  private readonly supersede;
  private readonly now;
  private lease: SyncLeaseV5 | null = null;
  private recoveredLeaseEpoch: number | null = null;
  private disposed = false;

  constructor(
    private readonly owner: OwnerSnapshot,
    private readonly tabId: string,
    private readonly transport: ProgressTransport,
    dependencies: WorkerDependencies = {},
    private readonly syncOwnerKey: OwnerKey = owner.ownerKey,
  ) {
    this.acknowledge = dependencies.acknowledge ?? acknowledgeProgressEventV5;
    this.acquireLease = dependencies.acquireLease ?? acquireSyncLeaseV5;
    this.claimNext = dependencies.claimNext ?? claimNextProgressEventV5;
    this.isLeaseCurrent = dependencies.isLeaseCurrent ?? isSyncLeaseCurrentV5;
    this.pause = dependencies.pause ?? pauseProgressEventV5;
    this.recordConflict = dependencies.recordConflict ?? recordProgressConflictV5;
    this.recover = dependencies.recover ?? recoverExpiredInFlightEventsV5;
    this.releaseLease = dependencies.releaseLease ?? releaseSyncLeaseV5;
    this.scheduleRetry = dependencies.scheduleRetry ?? scheduleProgressEventRetryV5;
    this.supersede = dependencies.supersede ?? supersedeAnnotationDeletionV5;
    this.now = dependencies.now ?? Date.now;
  }

  async flushOne(now = this.now(), onLeader?: () => void) {
    if (this.disposed || !ownerRuntime.isCurrent(this.owner)) return 'stale_owner' as const;
    this.lease = await this.acquireLease(this.syncOwnerKey, this.tabId, now);
    if (!this.lease) return 'not_leader' as const;
    if (this.recoveredLeaseEpoch !== this.lease.epoch) {
      await this.recover(this.syncOwnerKey, this.tabId, this.lease.epoch, now);
      this.recoveredLeaseEpoch = this.lease.epoch;
    }
    if (this.disposed || !ownerRuntime.isCurrent(this.owner)) return 'stale_owner' as const;
    onLeader?.();
    const event = await this.claimNext(
      this.syncOwnerKey,
      this.tabId,
      this.lease.epoch,
      now,
    );
    if (!event) return 'idle' as const;
    const expectedClaim = getExpectedClaimV5(event);
    if (!expectedClaim) return 'stale_claim' as const;

    try {
      const result = await this.transport(event);
      if (this.disposed || !ownerRuntime.isCurrent(this.owner)) return 'stale_owner' as const;
      const completedAt = this.now();
      const leaseStillCurrent = await this.isLeaseCurrent(
        this.syncOwnerKey,
        this.tabId,
        this.lease.epoch,
        completedAt,
      );
      if (!leaseStillCurrent) return 'stale_lease' as const;

      if (result.status === 'superseded') {
        const superseded = await this.supersede(this.syncOwnerKey, event.eventId, expectedClaim, result.remoteMarker, completedAt);
        return superseded ? 'superseded' as const : 'stale_claim' as const;
      }
      if (result.status === 'conflict') {
        const recorded = await this.recordConflict(
          this.syncOwnerKey,
          event.eventId,
          result.remoteHead,
          expectedClaim,
          completedAt,
          result.conflictReason,
          result.remoteBookGeneration,
        );
        if (!recorded) return 'stale_claim' as const;
        return 'conflict' as const;
      }
      let acceptedRevision: number | undefined;
      if (event.target.kind === 'progress') {
        const receipt = result.receipt;
        if (!isEventReceiptV2(receipt)
          || receipt.eventId !== event.eventId
          || receipt.targetKind !== 'progress'
          || receipt.targetKey !== event.targetKey
          || receipt.bookId !== event.target.bookId
          || receipt.bookmarkId !== null
          || !('bookId' in result.head)
          || result.head.bookId !== event.target.bookId
          || receipt.revision > result.head.revision
          || (receipt.revision === result.head.revision && result.head.acceptedEventId !== event.eventId)
          || (result.status === 'apply' && receipt.revision !== result.head.revision)) {
          throw Object.assign(new Error('진행률 receipt와 head가 요청 event와 일치하지 않습니다.'), { code: 'invalid-argument' });
        }
        acceptedRevision = receipt.revision;
      }
      if (event.target.kind === 'annotation' && event.target.annotationId === ANNOTATION_BOOK_DELETE_MARKER_ID) {
        const { receipt, head } = result;
        if (!isAnnotationSyncReceiptV1(receipt)
          || receipt.eventId !== event.eventId
          || receipt.targetKind !== 'annotation'
          || receipt.targetKey !== event.targetKey
          || receipt.bookId !== event.target.bookId
          || receipt.annotationId !== event.target.annotationId
          || !isAnnotationHeadV1(head) || head.operation !== 'delete'
          || head.bookId !== event.target.bookId || head.annotationId !== event.target.annotationId
          || receipt.revision > head.revision
          || (receipt.revision === head.revision && head.acceptedEventId !== event.eventId)
          || (result.status === 'apply' && receipt.revision !== head.revision)) {
          throw Object.assign(new Error('annotation 삭제 marker receipt가 요청 event와 일치하지 않습니다.'), { code: 'invalid-argument' });
        }
        acceptedRevision = receipt.revision;
      }
      const acknowledged = await this.acknowledge(
        this.syncOwnerKey,
        event.eventId,
        result.head,
        expectedClaim,
        completedAt,
        acceptedRevision,
      );
      if (!acknowledged) return 'stale_claim' as const;
      return result.status;
    } catch (error) {
      if (this.disposed || !ownerRuntime.isCurrent(this.owner)) return 'stale_owner' as const;
      const completedAt = this.now();
      const leaseStillCurrent = await this.isLeaseCurrent(
        this.syncOwnerKey,
        this.tabId,
        this.lease.epoch,
        completedAt,
      );
      if (!leaseStillCurrent) return 'stale_lease' as const;
      const code = errorCode(error);
      if (isRetryableProgressSyncError(error)) {
        const scheduled = await this.scheduleRetry(
          this.syncOwnerKey,
          event.eventId,
          code,
          expectedClaim,
          completedAt,
        );
        if (!scheduled) return 'stale_claim' as const;
        return 'retry_scheduled' as const;
      }
      const paused = await this.pause(
        this.syncOwnerKey,
        event.eventId,
        code,
        expectedClaim,
      );
      if (!paused) return 'stale_claim' as const;
      return 'paused' as const;
    }
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.lease) {
      await this.releaseLease(
        this.syncOwnerKey,
        this.tabId,
        this.lease.epoch,
      );
    }
  }
}
