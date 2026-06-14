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

const parseCommittedOffset = (response: Response, totalBytes: number) => {
  const range = response.headers.get('Range');
  if (!range) return 0;

  const match = range?.match(/bytes=0-(\d+)/i);
  if (!match) throw new Error('Google Drive returned an invalid upload range.');

  const offset = Number(match[1]) + 1;
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > totalBytes) {
    throw new Error('Google Drive returned an invalid upload offset.');
  }
  return offset;
};

const assertChunkSize = (chunkSize: number) => {
  if (chunkSize <= 0 || chunkSize % (256 * 1024) !== 0) {
    throw new Error('Drive upload chunk size must be a positive multiple of 256KiB.');
  }
};

const throwUploadResponse = async (response: Response): Promise<never> => {
  throw new DriveUploadHttpError(response.status, await response.text());
};

const requestUploadSession = (
  metadata: DriveUploadMetadata,
  fileSize: number,
  token: string,
  mimeType: string,
  fetchImpl: FetchLike,
  maxRetries: number,
  sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>,
  signal: AbortSignal | undefined,
  onRetry: (retryCount: number) => void,
) => requestWithRetry(
  () => fetchImpl(
    `${DRIVE_UPLOAD_URL}?uploadType=resumable&fields=id,name,mimeType,size,modifiedTime,md5Checksum`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': mimeType,
        'X-Upload-Content-Length': String(fileSize),
      },
      body: JSON.stringify(metadata),
      signal,
    },
  ),
  maxRetries,
  sleep,
  signal,
  onRetry,
);

const requestUploadStatus = (
  sessionUrl: string,
  token: string,
  totalBytes: number,
  fetchImpl: FetchLike,
  maxRetries: number,
  sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>,
  signal: AbortSignal | undefined,
  onRetry: (retryCount: number) => void,
) => requestWithRetry(
  () => fetchImpl(sessionUrl, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Range': `bytes */${totalBytes}`,
    },
    signal,
  }),
  maxRetries,
  sleep,
  signal,
  onRetry,
);

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
  const recordRetry = (uploadedBytes: number) => {
    retryCount += 1;
    reportProgress(uploadedBytes);
  };

  const sessionResponse = await requestUploadSession(
    metadata,
    file.size,
    token,
    mimeType,
    fetchImpl,
    maxRetries,
    sleep,
    signal,
    () => recordRetry(0),
  );

  if (!sessionResponse.ok) await throwUploadResponse(sessionResponse);
  const sessionUrl = sessionResponse.headers.get('Location');
  if (!sessionUrl) throw new Error('Google Drive upload session URL is missing.');

  reportProgress(0);
  let offset = 0;
  let stalledRetryCount = 0;

  do {
    if (signal?.aborted) throw abortError();

    const end = Math.min(offset + chunkSize, file.size);
    const chunk = file.slice(offset, end);
    const contentRange = file.size === 0
      ? 'bytes */0'
      : `bytes ${offset}-${end - 1}/${file.size}`;

    let chunkResponse: Response | null = null;
    let chunkError: unknown;
    try {
      chunkResponse = await fetchImpl(sessionUrl, {
        method: 'PUT',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': mimeType,
          'Content-Range': contentRange,
        },
        body: chunk,
        signal,
      });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
      chunkError = error;
    }

    if (chunkResponse?.status === 200 || chunkResponse?.status === 201) {
      reportProgress(file.size);
      return chunkResponse.json() as Promise<DriveUploadResult>;
    }

    if (chunkResponse?.status === 308) {
      const nextOffset = parseCommittedOffset(chunkResponse, file.size);
      if (nextOffset < offset || nextOffset > end) {
        throw new Error('Google Drive returned an invalid upload offset.');
      }
      if (nextOffset > offset) {
        offset = nextOffset;
        stalledRetryCount = 0;
        reportProgress(offset);
        continue;
      }
    } else if (chunkResponse && !await isRetryableResponse(chunkResponse)) {
      await throwUploadResponse(chunkResponse);
    }

    if (stalledRetryCount >= maxRetries) {
      if (chunkError) throw chunkError;
      if (chunkResponse?.status === 308) {
        throw new Error('Google Drive upload did not advance after retrying.');
      }
      if (chunkResponse) await throwUploadResponse(chunkResponse);
      throw new Error('Google Drive upload failed without a response.');
    }

    stalledRetryCount += 1;
    recordRetry(offset);
    await sleep(getRetryDelay(stalledRetryCount - 1), signal);

    const statusResponse = await requestUploadStatus(
      sessionUrl,
      token,
      file.size,
      fetchImpl,
      maxRetries,
      sleep,
      signal,
      () => recordRetry(offset),
    );

    if (statusResponse.status === 200 || statusResponse.status === 201) {
      reportProgress(file.size);
      return statusResponse.json() as Promise<DriveUploadResult>;
    }
    if (statusResponse.status !== 308) await throwUploadResponse(statusResponse);

    const confirmedOffset = parseCommittedOffset(statusResponse, file.size);
    if (confirmedOffset < offset) {
      throw new Error('Google Drive returned a regressed upload offset.');
    }
    if (confirmedOffset > offset) stalledRetryCount = 0;
    offset = confirmedOffset;
    reportProgress(offset);
  } while (offset < file.size);

  throw new Error('Google Drive upload ended without a completion response.');
};
