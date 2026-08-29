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
    const customSetTimer = options.setTimer;
    const customClearTimer = options.clearTimer;
    this.setTimer = (callback: () => void | Promise<void>, delay: number) => (
      customSetTimer ? customSetTimer(callback, delay) : setTimeout(callback, delay)
    );
    this.clearTimer = (timer: TimerHandle) => {
      if (customClearTimer) customClearTimer(timer);
      else clearTimeout(timer);
    };
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
    if (this.disposed) return;
    this.disposed = true;
    this.wakeRequested = false;
    const timer = this.timer;
    this.timer = undefined;
    if (timer !== undefined) this.clearTimer(timer);
  }

  private schedule(delay: number) {
    if (this.disposed) return;
    const timer = this.timer;
    this.timer = undefined;
    if (timer !== undefined) this.clearTimer(timer);
    if (!this.options.isVisible() && delay > 0) return;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      return this.pump();
    }, delay);
  }
}
