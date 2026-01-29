// src/lib/googleDrive.ts
/**
 * 구글 드라이브 API 통신 전용 유틸리티
 */

export const findFolderId = async (folderName: string, token: string) => {
  const query = `name = '${folderName}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false`;
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await response.json();
  return data.files?.[0]?.id || null;
};

export const fetchDriveFiles = async (token: string, folderId?: string) => {
  let q = "mimeType='text/plain' and trashed=false";
  if (folderId) q = `'${folderId}' in parents and ${q}`;
  
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(q)}&fields=files(id, name, mimeType)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  return response.json();
};

// src/lib/googleDrive.ts
export const fetchFullFile = async (fileId: string, token: string) => {
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    { headers: { Authorization: `Bearer ${token}` } }
  );

  if (!response.ok) throw new Error('파일 로드 실패');
  
  // 텍스트 대신 ArrayBuffer로 받아 리더에서 처리하도록 합니다.
  return await response.arrayBuffer();
};