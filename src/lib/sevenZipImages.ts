import {
  ArchiveImageError,
  MAX_SEVEN_ZIP_TOTAL_EXPANDED_BYTES,
  createArchiveImageIndex,
  createArchiveImageBook,
  restoreArchiveImageInspection,
  selectArchiveImageEntries,
  type ArchiveImageIndex,
  type RawArchiveEntry,
} from './archiveImageBook.ts';
import { LatestRequestQueue } from './latestRequestQueue.ts';

export const SEVEN_ZIP_EXTRACT_TIMEOUT_MS = 60_000;

type SevenZipEntry = {
  name: string;
  size: number;
  directory: boolean;
  encrypted: boolean;
};

type WorkerSuccess = {
  id: number;
  ok: true;
  entries?: SevenZipEntry[];
  blob?: Blob;
};

type WorkerFailure = {
  id: number;
  ok: false;
  error: string;
};

type WorkerResponse = WorkerSuccess | WorkerFailure;

type PendingRequest = {
  resolve: (response: WorkerSuccess) => void;
  reject: (error: Error) => void;
  timeoutId?: ReturnType<typeof setTimeout>;
};

type ExtractRequest = {
  entryName: string;
  mimeType: string;
  expectedSize: number;
};

type SevenZipWorkerClientOptions = {
  worker?: Worker;
  extractTimeoutMs?: number;
};

const toArchiveError = (code: string) => {
  if (code === 'ENCRYPTED_ARCHIVE') {
    return new ArchiveImageError('encrypted', '비밀번호로 잠긴 압축 파일은 지원하지 않습니다.');
  }
  return new ArchiveImageError('damaged', '7z 파일이 손상되었거나 지원하지 않는 방식입니다.');
};

const abortError = () => new DOMException('7z preparation aborted', 'AbortError');

export class SevenZipWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly extractionQueue: LatestRequestQueue<ExtractRequest, Blob>;
  private readonly extractTimeoutMs: number;
  private nextId = 1;
  private closed = false;

  constructor(options: SevenZipWorkerClientOptions = {}) {
    this.worker = options.worker
      ?? new Worker('/7z/archive-worker.js', { type: 'module' });
    this.extractTimeoutMs = options.extractTimeoutMs
      ?? SEVEN_ZIP_EXTRACT_TIMEOUT_MS;
    this.extractionQueue = new LatestRequestQueue((request) => this.extractNow(request));
    this.worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const request = this.pending.get(event.data.id);
      if (!request) return;
      this.pending.delete(event.data.id);
      if (request.timeoutId) clearTimeout(request.timeoutId);
      if (event.data.ok) request.resolve(event.data);
      else this.fail(toArchiveError(event.data.error), request);
    });
    this.worker.addEventListener('error', () => this.fail(
      new ArchiveImageError('damaged', '7z 처리 Worker를 실행하지 못했습니다.'),
    ));
    this.worker.addEventListener('messageerror', () => this.fail(
      new ArchiveImageError('damaged', '7z 처리 Worker 응답을 읽지 못했습니다.'),
    ));
  }

  private fail(error: Error, currentRequest?: PendingRequest) {
    if (!this.closed) {
      this.closed = true;
      this.worker.terminate();
    }
    if (currentRequest?.timeoutId) clearTimeout(currentRequest.timeoutId);
    currentRequest?.reject(error);
    this.pending.forEach(({ reject, timeoutId }) => {
      if (timeoutId) clearTimeout(timeoutId);
      reject(error);
    });
    this.pending.clear();
    this.extractionQueue.close(error);
  }

  private request(message: Record<string, unknown>, timeoutMs?: number) {
    if (this.closed) {
      return Promise.reject(new ArchiveImageError('damaged', '7z 처리 Worker가 종료되었습니다.'));
    }
    const id = this.nextId++;
    return new Promise<WorkerSuccess>((resolve, reject) => {
      const request: PendingRequest = { resolve, reject };
      if (timeoutMs) {
        request.timeoutId = setTimeout(() => {
          if (this.pending.get(id) !== request) return;
          this.pending.delete(id);
          const error = new ArchiveImageError(
            'timeout',
            `7z 이미지 압축 해제 시간이 ${Math.max(
              1,
              Math.ceil(this.extractTimeoutMs / 1000),
            )}초 제한을 초과했습니다.`,
          );
          this.fail(error, request);
        }, timeoutMs);
      }
      this.pending.set(id, request);
      try {
        this.worker.postMessage({ ...message, id });
      } catch {
        this.pending.delete(id);
        const error = new ArchiveImageError(
          'damaged',
          '7z 처리 Worker에 요청을 보내지 못했습니다.',
        );
        this.fail(error, request);
      }
    });
  }

  async initialize(blob: Blob, signal?: AbortSignal) {
    if (signal?.aborted) {
      const error = abortError();
      this.fail(error);
      throw error;
    }
    const abort = () => this.fail(abortError());
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const response = await this.request({ type: 'init', blob });
      return response.entries ?? [];
    } finally {
      signal?.removeEventListener('abort', abort);
    }
  }

  extract(
    entryName: string,
    mimeType: string,
    expectedSize: number,
    signal?: AbortSignal,
  ) {
    return this.extractionQueue.request({
      entryName,
      mimeType,
      expectedSize,
    }, signal);
  }

  private async extractNow({ entryName, mimeType, expectedSize }: ExtractRequest) {
    const response = await this.request({
      type: 'extract',
      entryName,
      mimeType,
    }, this.extractTimeoutMs);
    if (!response.blob) {
      const error = new ArchiveImageError('damaged', '7z 이미지 페이지를 읽지 못했습니다.');
      this.fail(error);
      throw error;
    }
    if (response.blob.size !== expectedSize) {
      const error = new ArchiveImageError(
        'damaged',
        '7z 이미지의 실제 해제 크기가 인덱스와 일치하지 않습니다.',
      );
      this.fail(error);
      throw error;
    }
    return response.blob;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.worker.terminate();
    const error = new ArchiveImageError('damaged', '7z 처리 Worker가 종료되었습니다.');
    this.pending.forEach(({ reject, timeoutId }) => {
      if (timeoutId) clearTimeout(timeoutId);
      reject(error);
    });
    this.pending.clear();
    this.extractionQueue.close(error);
  }
}

const prepareSevenZip = async (
  blob: Blob,
  cachedIndex?: ArchiveImageIndex,
  signal?: AbortSignal,
) => {
  const client = new SevenZipWorkerClient();
  try {
    const entries = await client.initialize(blob, signal);
    const rawEntries: RawArchiveEntry<string>[] = entries.map((entry) => ({
      ...entry,
      source: entry.name,
    }));
    return {
      client,
      inspection: cachedIndex
        ? restoreArchiveImageInspection(rawEntries, cachedIndex, {
            maxTotalExpandedBytes: MAX_SEVEN_ZIP_TOTAL_EXPANDED_BYTES,
          })
        : selectArchiveImageEntries(rawEntries, {
            maxTotalExpandedBytes: MAX_SEVEN_ZIP_TOTAL_EXPANDED_BYTES,
          }),
    };
  } catch (error) {
    client.close();
    throw error;
  }
};

export const inspectSevenZipImageArchive = async (blob: Blob) => {
  const { client, inspection } = await prepareSevenZip(blob);
  client.close();
  return {
    imageCount: inspection.entries.length,
    totalImageBytes: inspection.totalImageBytes,
    names: inspection.entries.map((entry) => entry.normalizedName),
    index: createArchiveImageIndex(inspection),
  };
};

export const prepareSevenZipImageBook = async (
  blob: Blob,
  fileName: string,
  cachedIndex?: ArchiveImageIndex,
  signal?: AbortSignal,
) => {
  const { client, inspection } = await prepareSevenZip(blob, cachedIndex, signal);
  return {
    book: createArchiveImageBook({
      entries: inspection.entries,
      fileName,
      loadBlob: (entry, signal) => client.extract(
        entry.source,
        entry.mimeType,
        entry.size,
        signal,
      ),
      close: () => client.close(),
    }),
    index: createArchiveImageIndex(inspection),
  };
};

export const createSevenZipImageBook = async (blob: Blob, fileName: string) => (
  prepareSevenZipImageBook(blob, fileName).then(({ book }) => book)
);
