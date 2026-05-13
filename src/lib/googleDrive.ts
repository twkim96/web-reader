// src/lib/googleDrive.ts

/**
 * 타임아웃 기능이 포함된 fetch 함수
 * 지정된 시간(ms) 안에 응답이 없으면 요청을 취소하고 에러를 발생시킵니다.
 */
const fetchWithTimeout = async (url: string, options: RequestInit = {}, timeout = 5000) => {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (error: any) {
    if (error.name === 'AbortError') {
      throw new Error('Network timeout');
    }
    throw error;
  } finally {
    clearTimeout(id);
  }
};

/**
 * 구글 드라이브 내 특정 이름의 폴더 ID를 조회합니다.
 */
export const findFolderId = async (folderName: string, token: string) => {
  const query = `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  
  const response = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)`,
    { headers: { Authorization: `Bearer ${token}` } },
    5000 
  );
  
  if (!response.ok) return null;
  const data = await response.json();
  return data.files?.[0]?.id || null;
};

/**
 * 구글 드라이브에 새로운 폴더를 생성합니다.
 */
export const createFolder = async (folderName: string, token: string) => {
  const response = await fetchWithTimeout(
    'https://www.googleapis.com/drive/v3/files',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: folderName,
        mimeType: 'application/vnd.google-apps.folder',
      }),
    },
    10000
  );

  if (!response.ok) throw new Error('폴더 생성 실패');
  const data = await response.json();
  return data.id;
};

/**
 * 파일을 구글 드라이브의 특정 폴더에 업로드합니다 (Multipart Upload).
 */
export const uploadFile = async (
  fileName: string,
  content: ArrayBuffer,
  folderId: string,
  token: string,
  mimeType: string
) => {
  const boundary = '-------antigravity_sync_boundary';
  const delimiter = `\r\n--${boundary}\r\n`;
  const closeDelimiter = `\r\n--${boundary}--`;

  const metadata = {
    name: fileName,
    parents: [folderId],
    mimeType,
  };

  const head = `${delimiter}Content-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n${delimiter}Content-Type: ${mimeType}\r\n\r\n`;
  
  const body = new Blob([
    head,
    new Uint8Array(content),
    closeDelimiter
  ]);

  const response = await fetchWithTimeout(
    'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: body,
    },
    60000 
  );

  if (!response.ok) {
    const errorText = await response.text();
    console.error('Google Drive Upload Error:', errorText);
    throw new Error('클라우드 업로드 실패');
  }

  return response.json();
};

export const fetchDriveFiles = async (token: string, folderId?: string) => {
  let q = "(mimeType='application/epub+zip' or mimeType='text/plain') and trashed=false";
  if (folderId) q = `'${folderId}' in parents and ${q}`;
  
  // 파일 목록 조회도 5초 타임아웃 (오프라인 감지용)
  const response = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id, name, mimeType)`,
    { headers: { Authorization: `Bearer ${token}` } },
    5000
  );
  
  return response.json();
};

export const fetchFullFile = async (fileId: string, token: string) => {
  // [Modified] 파일 다운로드는 대용량(10MB+)을 고려하여 3분(180초) 대기
  const response = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } },
    180000 
  );

  if (!response.ok) throw new Error('파일 로드 실패');
  
  return await response.arrayBuffer();
};
