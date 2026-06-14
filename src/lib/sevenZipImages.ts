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
};

const toArchiveError = (code: string) => {
  if (code === 'ENCRYPTED_ARCHIVE') {
    return new ArchiveImageError('encrypted', '비밀번호로 잠긴 압축 파일은 지원하지 않습니다.');
  }
  return new ArchiveImageError('damaged', '7z 파일이 손상되었거나 지원하지 않는 방식입니다.');
};

class SevenZipWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private closed = false;

  constructor() {
    this.worker = new Worker('/7z/archive-worker.js', { type: 'module' });
    this.worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
      const request = this.pending.get(event.data.id);
      if (!request) return;
      this.pending.delete(event.data.id);
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
    currentRequest?.reject(error);
    this.pending.forEach(({ reject }) => reject(error));
    this.pending.clear();
  }

  private request(message: Record<string, unknown>) {
    if (this.closed) {
      return Promise.reject(new ArchiveImageError('damaged', '7z 처리 Worker가 종료되었습니다.'));
    }
    const id = this.nextId++;
    return new Promise<WorkerSuccess>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ ...message, id });
    });
  }

  async initialize(blob: Blob) {
    const response = await this.request({ type: 'init', blob });
    return response.entries ?? [];
  }

  async extract(entryName: string, mimeType: string, expectedSize: number) {
    const response = await this.request({
      type: 'extract',
      entryName,
      mimeType,
    });
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
    this.pending.forEach(({ reject }) => reject(error));
    this.pending.clear();
  }
}

const prepareSevenZip = async (blob: Blob, cachedIndex?: ArchiveImageIndex) => {
  const client = new SevenZipWorkerClient();
  try {
    const entries = await client.initialize(blob);
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
) => {
  const { client, inspection } = await prepareSevenZip(blob, cachedIndex);
  return {
    book: createArchiveImageBook({
      entries: inspection.entries,
      fileName,
      loadBlob: (entry) => client.extract(entry.source, entry.mimeType, entry.size),
      close: () => client.close(),
    }),
    index: createArchiveImageIndex(inspection),
  };
};

export const createSevenZipImageBook = async (blob: Blob, fileName: string) => (
  prepareSevenZipImageBook(blob, fileName).then(({ book }) => book)
);
