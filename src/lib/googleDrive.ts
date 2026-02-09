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

export const findFolderId = async (folderName: string, token: string) => {
  const query = `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  
  // 폴더 ID 찾기는 데이터가 작으므로 5초 타임아웃 (오프라인 감지용)
  const response = await fetchWithTimeout(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)`,
    { headers: { Authorization: `Bearer ${token}` } },
    5000 
  );
  
  const data = await response.json();
  return data.files?.[0]?.id || null;
};

export const fetchDriveFiles = async (token: string, folderId?: string) => {
  let q = "mimeType='text/plain' and trashed=false";
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