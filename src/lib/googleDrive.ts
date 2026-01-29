/**
 * 구글 드라이브 API 통신 전용 유틸리티
 * 비즈니스 로직 없이, 요청받은 데이터를 가져오는 기능만 수행합니다.
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

/**
 * [핵심 기능] 지정된 바이트 범위의 데이터를 요청합니다.
 * Reader.tsx에서 이 함수를 호출하여 필요한 만큼 텍스트를 가져갑니다.
 */
export const fetchFileChunk = async (fileId: string, token: string, startByte: number, chunkSize: number) => {
  const endByte = startByte + chunkSize - 1;
  const response = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Range: `bytes=${startByte}-${endByte}`,
      },
    }
  );

  if (!response.ok && response.status !== 206) throw new Error('구글 드라이브 데이터 로드 실패');

  const contentRange = response.headers.get('Content-Range');
  const totalSize = contentRange ? parseInt(contentRange.split('/')[1]) : 0;
  const text = await response.text();
  
  return { 
    text, 
    totalSize, 
    endByte: Math.min(endByte, totalSize - 1) 
  };
};