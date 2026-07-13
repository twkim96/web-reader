export type DriveLoadContext = {
  key: string;
  generation: number;
  signal: AbortSignal;
};

export class DriveLoadCoordinator {
  private generation = 0;
  private active: DriveLoadContext | null = null;
  private controller: AbortController | null = null;
  private inFlight = new Map<string, {
    context: DriveLoadContext;
    promise: Promise<boolean>;
  }>();

  isCurrent(context: DriveLoadContext) {
    return this.active?.generation === context.generation
      && this.active.key === context.key
      && !context.signal.aborted;
  }

  run(
    key: string,
    work: (context: DriveLoadContext) => Promise<boolean>,
  ): Promise<boolean> {
    const current = this.inFlight.get(key);
    if (current && this.isCurrent(current.context)) return current.promise;
    if (current) this.inFlight.delete(key);

    this.controller?.abort();
    const controller = new AbortController();
    const context = {
      key,
      generation: this.generation + 1,
      signal: controller.signal,
    };
    this.generation = context.generation;
    this.controller = controller;
    this.active = context;

    const promise = work(context).finally(() => {
      if (this.inFlight.get(key)?.promise === promise) this.inFlight.delete(key);
    });
    this.inFlight.set(key, { context, promise });
    return promise;
  }

  cancel() {
    this.controller?.abort();
    if (this.active) this.inFlight.delete(this.active.key);
    this.controller = null;
    this.active = null;
    this.generation += 1;
  }
}
