import { IDLE_SYNC_POLL_DELAY_MS } from './progressSyncPolling';

type TimerHandle = ReturnType<typeof setTimeout>;

export type ProgressSyncPumpOptions = {
  poll: () => Promise<number>;
  refreshHealth: () => Promise<void>;
  reportHealthError: (error: unknown) => void;
  isOnline: () => boolean;
  isVisible: () => boolean;
  setTimer?: (callback: () => void | Promise<void>, delay: number) => TimerHandle;
  clearTimer?: (timer: TimerHandle) => void;
};

export class ProgressSyncPumpController {
  private timer: TimerHandle | undefined;
  private running = false;
  private wakeRequested = false;
  private disposed = false;
  private readonly setTimer;
  private readonly clearTimer;

  constructor(private readonly options: ProgressSyncPumpOptions) {
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  request() {
    if (this.disposed) return;
    if (this.running) {
      this.wakeRequested = true;
      return;
    }
    this.schedule(0);
  }

  async pump() {
    if (this.disposed || !this.options.isOnline()) return;
    if (this.running) {
      this.wakeRequested = true;
      return;
    }

    this.running = true;
    let nextDelay = IDLE_SYNC_POLL_DELAY_MS;
    try {
      nextDelay = await this.options.poll();
      try {
        await this.options.refreshHealth();
      } catch (error) {
        this.options.reportHealthError(error);
      }
    } finally {
      this.running = false;
      const delay = this.wakeRequested ? 0 : nextDelay;
      this.wakeRequested = false;
      this.schedule(delay);
    }
  }

  dispose() {
    this.disposed = true;
    this.wakeRequested = false;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
  }

  private schedule(delay: number) {
    if (this.disposed) return;
    if (this.timer !== undefined) this.clearTimer(this.timer);
    this.timer = undefined;
    if (!this.options.isVisible() && delay > 0) return;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      return this.pump();
    }, delay);
  }
}
