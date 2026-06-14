type QueuedRequest<Input, Output> = {
  input: Input;
  signal?: AbortSignal;
  started: boolean;
  settled: boolean;
  resolve: (value: Output) => void;
  reject: (error: Error) => void;
  abort: () => void;
};

const abortError = () => new DOMException('Request aborted', 'AbortError');

export class LatestRequestQueue<Input, Output> {
  private active: QueuedRequest<Input, Output> | null = null;
  private queued: QueuedRequest<Input, Output> | null = null;
  private closedError: Error | null = null;
  private readonly run: (input: Input) => Promise<Output>;

  constructor(run: (input: Input) => Promise<Output>) {
    this.run = run;
  }

  request(input: Input, signal?: AbortSignal) {
    if (this.closedError) return Promise.reject(this.closedError);
    if (signal?.aborted) return Promise.reject(abortError());

    return new Promise<Output>((resolve, reject) => {
      const request: QueuedRequest<Input, Output> = {
        input,
        signal,
        started: false,
        settled: false,
        resolve,
        reject,
        abort: () => {
          if (request.settled) return;
          request.settled = true;
          request.reject(abortError());
          if (!request.started && this.queued === request) this.queued = null;
        },
      };
      signal?.addEventListener('abort', request.abort, { once: true });

      if (!this.active) {
        this.start(request);
        return;
      }

      this.rejectQueued(abortError());
      this.queued = request;
    });
  }

  close(error: Error) {
    if (this.closedError) return;
    this.closedError = error;
    this.rejectRequest(this.active, error);
    this.rejectRequest(this.queued, error);
    this.active = null;
    this.queued = null;
  }

  private start(request: QueuedRequest<Input, Output>) {
    if (request.settled) {
      this.startQueued();
      return;
    }
    if (this.closedError) {
      this.rejectRequest(request, this.closedError);
      return;
    }

    request.started = true;
    this.active = request;
    void this.run(request.input).then(
      (value) => this.finish(request, null, value),
      (error: unknown) => this.finish(
        request,
        error instanceof Error ? error : new Error(String(error)),
      ),
    );
  }

  private finish(
    request: QueuedRequest<Input, Output>,
    error: Error | null,
    value?: Output,
  ) {
    if (this.active !== request) return;
    this.active = null;
    request.signal?.removeEventListener('abort', request.abort);

    if (!request.settled) {
      request.settled = true;
      if (error) request.reject(error);
      else request.resolve(value as Output);
    }
    this.startQueued();
  }

  private startQueued() {
    const next = this.queued;
    this.queued = null;
    if (next) this.start(next);
  }

  private rejectQueued(error: Error) {
    this.rejectRequest(this.queued, error);
    this.queued = null;
  }

  private rejectRequest(request: QueuedRequest<Input, Output> | null, error: Error) {
    if (!request) return;
    request.signal?.removeEventListener('abort', request.abort);
    if (request.settled) return;
    request.settled = true;
    request.reject(error);
  }
}
