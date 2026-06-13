export const DRIVE_UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024;

const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

type FetchLike = typeof fetch;

type DriveUploadMetadata = {
  name: string;
  parents: string[];
  mimeType: string;
};

export type DriveUploadResult = {
  id: string;
  name?: string;
  mimeType?: string;
  size?: string;
  modifiedTime?: string;
  md5Checksum?: string;
};

export type DriveUploadProgress = {
  uploadedBytes: number;
  totalBytes: number;
  retryCount: number;
};

export type ResumableUploadOptions = {
  file: Blob;
  fileName: string;
  folderId: string;
  token: string;
  mimeType: string;
  signal?: AbortSignal;
  chunkSize?: number;
  maxRetries?: number;
  fetchImpl?: FetchLike;
  sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>;
  onProgress?: (progress: DriveUploadProgress) => void;
};

export class DriveUploadHttpError extends Error {
  readonly status: number;
  readonly responseText: string;

  constructor(status: number, responseText: string) {
    super(`Google Drive upload failed (${status})`);
    this.name = 'DriveUploadHttpError';
    this.status = status;
    this.responseText = responseText;
  }
}

const abortError = () => new DOMException('Upload aborted', 'AbortError');

const defaultSleep = (delayMs: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  if (signal?.aborted) {
    reject(abortError());
    return;
  }

  const timeoutId = setTimeout(resolve, delayMs);
  signal?.addEventListener('abort', () => {
    clearTimeout(timeoutId);
    reject(abortError());
  }, { once: true });
});

const getRetryDelay = (retryCount: number) => Math.min(1000 * (2 ** retryCount), 8000);

const hasRateLimitReason = async (response: Response) => {
  if (response.status !== 403) return false;

  try {
    const payload = await response.clone().json() as {
      error?: { errors?: Array<{ reason?: string }> };
    };
    return payload.error?.errors?.some(({ reason }) => reason && RATE_LIMIT_REASONS.has(reason)) ?? false;
  } catch {
    return false;
  }
};

const isRetryableResponse = async (response: Response) => (
  RETRYABLE_STATUS.has(response.status) || await hasRateLimitReason(response)
);

const requestWithRetry = async (
  request: () => Promise<Response>,
  maxRetries: number,
  sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>,
  signal: AbortSignal | undefined,
  onRetry: (retryCount: number) => void,
) => {
  let retryCount = 0;

  while (true) {
    if (signal?.aborted) throw abortError();

    try {
      const response = await request();
      if (!await isRetryableResponse(response) || retryCount >= maxRetries) {
        return response;
      }
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      if (retryCount >= maxRetries) throw error;
    }

    retryCount += 1;
    onRetry(retryCount);
    await sleep(getRetryDelay(retryCount - 1), signal);
  }
};

const parseNextOffset = (response: Response, fallbackOffset: number) => {
  const range = response.headers.get('Range');
  const match = range?.match(/bytes=0-(\d+)/i);
  return match ? Number(match[1]) + 1 : fallbackOffset;
};

const assertChunkSize = (chunkSize: number) => {
  if (chunkSize <= 0 || chunkSize % (256 * 1024) !== 0) {
    throw new Error('Drive upload chunk size must be a positive multiple of 256KiB.');
  }
};

const throwUploadResponse = async (response: Response): Promise<never> => {
  throw new DriveUploadHttpError(response.status, await response.text());
};

export const uploadFileResumable = async ({
  file,
  fileName,
  folderId,
  token,
  mimeType,
  signal,
  chunkSize = DRIVE_UPLOAD_CHUNK_BYTES,
  maxRetries = 3,
  fetchImpl = fetch,
  sleep = defaultSleep,
  onProgress,
}: ResumableUploadOptions): Promise<DriveUploadResult> => {
  assertChunkSize(chunkSize);

  const metadata: DriveUploadMetadata = {
    name: fileName,
    parents: [folderId],
    mimeType,
  };
  let retryCount = 0;
  const reportProgress = (uploadedBytes: number) => {
    onProgress?.({ uploadedBytes, totalBytes: file.size, retryCount });
  };

  const sessionResponse = await requestWithRetry(
    () => fetchImpl(
      `${DRIVE_UPLOAD_URL}?uploadType=resumable&fields=id,name,mimeType,size,modifiedTime,md5Checksum`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json; charset=UTF-8',
          'X-Upload-Content-Type': mimeType,
          'X-Upload-Content-Length': String(file.size),
        },
        body: JSON.stringify(metadata),
        signal,
      },
    ),
    maxRetries,
    sleep,
    signal,
    (count) => {
      retryCount = count;
      reportProgress(0);
    },
  );

  if (!sessionResponse.ok) await throwUploadResponse(sessionResponse);
  const sessionUrl = sessionResponse.headers.get('Location');
  if (!sessionUrl) throw new Error('Google Drive upload session URL is missing.');

  reportProgress(0);
  let offset = 0;

  do {
    const end = Math.min(offset + chunkSize, file.size);
    const chunk = file.slice(offset, end);
    const contentRange = file.size === 0
      ? 'bytes */0'
      : `bytes ${offset}-${end - 1}/${file.size}`;

    const chunkResponse = await requestWithRetry(
      () => fetchImpl(sessionUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': mimeType,
          'Content-Range': contentRange,
        },
        body: chunk,
        signal,
      }),
      maxRetries,
      sleep,
      signal,
      (count) => {
        retryCount = count;
        reportProgress(offset);
      },
    );

    if (chunkResponse.status === 200 || chunkResponse.status === 201) {
      reportProgress(file.size);
      return chunkResponse.json() as Promise<DriveUploadResult>;
    }

    if (chunkResponse.status !== 308) await throwUploadResponse(chunkResponse);

    const nextOffset = parseNextOffset(chunkResponse, end);
    if (nextOffset <= offset || nextOffset > file.size) {
      throw new Error('Google Drive returned an invalid upload offset.');
    }
    offset = nextOffset;
    reportProgress(offset);
  } while (offset < file.size);

  throw new Error('Google Drive upload ended without a completion response.');
};
