import { isAuthSyncErrorCode, type SyncHealth } from './syncHealth';

type TimerHandle = ReturnType<typeof setTimeout>;

export const SNAPSHOT_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 30_000, 60_000] as const;
export const SNAPSHOT_RESTART_COOLDOWN_MS = 5_000;

const getErrorCode = (error: unknown) => {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    return String(error.code).replace(/^firestore\//, '');
  }
  return error instanceof Error ? error.name : 'unknown';
};

const schemaErrorCodes = new Set([
  'data-loss',
  'failed-precondition',
  'invalid-argument',
  'unimplemented',
]);

export const classifySnapshotListenerError = (error: unknown): SyncHealth => {
  const code = getErrorCode(error);
  if (isAuthSyncErrorCode(code)) return 'paused-auth';
  if (code === 'permission-denied') return 'blocked-permission';
  if (schemaErrorCodes.has(code)) return 'blocked-schema';
  return 'retrying-receive';
};

export const getSnapshotRetryDelayMs = (attempt: number) => (
  SNAPSHOT_RETRY_DELAYS_MS[Math.min(
    Math.max(0, attempt),
    SNAPSHOT_RETRY_DELAYS_MS.length - 1,
  )]
);

type SnapshotListenerRecoveryOptions<T> = {
  subscribe: (
    onSnapshot: (snapshot: T) => void,
    onError: (error: unknown) => void,
  ) => () => void;
  onSnapshot: (snapshot: T) => void | Promise<void>;
  isAuthoritative: (snapshot: T) => boolean;
  onHealthChange: (health: SyncHealth) => void;
  onError?: (error: unknown) => void;
  canRetry?: () => boolean;
  setTimer?: (callback: () => void, delay: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
  now?: () => number;
};

export class SnapshotListenerRecovery<T> {
  private unsubscribe: (() => void) | undefined;
  private retryTimer: TimerHandle | undefined;
  private generation = 0;
  private retryAttempt = 0;
  private failed = false;
  private disposed = false;
  private health: SyncHealth = 'healthy';
  private processingTail = Promise.resolve();
  private lastAttachedAt = 0;
  private lastRestartAt = 0;
  private lastAuthoritativeSnapshotAt = 0;
  private readonly setTimer;
  private readonly clearTimer;
  private readonly now;

  constructor(private readonly options: SnapshotListenerRecoveryOptions<T>) {
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? clearTimeout;
    this.now = options.now ?? Date.now;
  }

  start() {
    if (this.disposed || this.unsubscribe) return;
    this.options.onHealthChange('healthy');
    this.attach();
  }

  retryNow() {
    if (this.disposed || !this.failed) return false;
    if (this.options.canRetry && !this.options.canRetry()) return false;
    this.clearRetryTimer();
    this.attach();
    return true;
  }

  forceRestart(restartCooldownMs = SNAPSHOT_RESTART_COOLDOWN_MS) {
    if (this.disposed) return false;
    if (this.options.canRetry && !this.options.canRetry()) return false;
    const now = this.now();
    if (
      this.lastRestartAt > 0
      && now - this.lastRestartAt < restartCooldownMs
    ) return false;
    this.lastRestartAt = now;
    this.clearRetryTimer();
    this.attach();
    return true;
  }

  reconcile(options?: { force?: boolean; staleAfterMs?: number; now?: number }) {
    if (this.disposed) return false;
    if (this.failed) return this.retryNow();
    if (options?.force) return this.forceRestart();
    const now = options?.now ?? this.now();
    const staleAfterMs = options?.staleAfterMs ?? 15_000;
    const neverReceivedAuthoritative = this.lastAuthoritativeSnapshotAt === 0
      && this.lastAttachedAt > 0
      && now - this.lastAttachedAt >= staleAfterMs;
    const authoritativeIsStale = this.lastAuthoritativeSnapshotAt > 0
      && now - this.lastAuthoritativeSnapshotAt >= staleAfterMs;
    if (!neverReceivedAuthoritative && !authoritativeIsStale) return false;
    return this.forceRestart();
  }

  isFailed() {
    return this.failed;
  }

  getFreshness() {
    return {
      lastAttachedAt: this.lastAttachedAt,
      lastRestartAt: this.lastRestartAt,
      lastAuthoritativeAt: this.lastAuthoritativeSnapshotAt,
    };
  }

  getLastAuthoritativeSnapshotAt() {
    return this.lastAuthoritativeSnapshotAt;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.generation += 1;
    this.clearRetryTimer();
    this.detachSubscription();
  }

  private attach() {
    if (this.disposed) return;
    this.clearRetryTimer();
    this.detachSubscription();
    const generation = this.generation + 1;
    this.generation = generation;
    this.lastAttachedAt = this.now();

    try {
      const unsubscribe = this.options.subscribe(
        (snapshot) => {
          this.enqueueSnapshot(snapshot, generation);
        },
        (error) => {
          this.handleError(error, generation);
        },
      );
      if (!this.isCurrent(generation)) unsubscribe();
      else this.unsubscribe = unsubscribe;
    } catch (error) {
      this.handleError(error, generation);
    }
  }

  private enqueueSnapshot(snapshot: T, generation: number) {
    this.processingTail = this.processingTail
      .catch(() => undefined)
      .then(async () => {
        if (!this.isCurrent(generation)) return;
        await this.options.onSnapshot(snapshot);
        this.handleProcessedSnapshot(snapshot, generation);
      })
      .catch((error) => this.handleError(error, generation));
  }

  private handleProcessedSnapshot(snapshot: T, generation: number) {
    if (!this.isCurrent(generation) || !this.options.isAuthoritative(snapshot)) return;
    this.failed = false;
    this.retryAttempt = 0;
    this.lastAuthoritativeSnapshotAt = this.now();
    this.clearRetryTimer();
    this.setHealth('healthy');
  }

  private handleError(error: unknown, generation: number) {
    if (!this.isCurrent(generation)) return;
    this.generation += 1;
    this.failed = true;
    this.detachSubscription();
    const health = classifySnapshotListenerError(error);
    // Firestore can report one transient listener failure while a fresh app
    // session is restoring its network/auth state. Keep that first recoverable
    // failure silent and surface it only if the retry also fails.
    if (health === 'blocked-schema' || this.retryAttempt > 0) {
      this.setHealth(health);
    }
    this.options.onError?.(error);
    if (health !== 'blocked-schema') this.scheduleRetry();
  }

  private scheduleRetry() {
    if (this.disposed || !this.failed || this.retryTimer !== undefined) return;
    if (this.options.canRetry && !this.options.canRetry()) return;
    const delay = getSnapshotRetryDelayMs(this.retryAttempt);
    this.retryAttempt += 1;
    this.retryTimer = this.setTimer(() => {
      this.retryTimer = undefined;
      if (this.options.canRetry && !this.options.canRetry()) return;
      this.attach();
    }, delay);
  }

  private setHealth(health: SyncHealth) {
    if (this.health === health) return;
    this.health = health;
    this.options.onHealthChange(health);
  }

  private clearRetryTimer() {
    if (this.retryTimer === undefined) return;
    this.clearTimer(this.retryTimer);
    this.retryTimer = undefined;
  }

  private detachSubscription() {
    const unsubscribe = this.unsubscribe;
    this.unsubscribe = undefined;
    unsubscribe?.();
  }

  private isCurrent(generation: number) {
    return !this.disposed && this.generation === generation;
  }
}
