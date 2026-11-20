export async function fetchCoverSource(coverUrl: string, signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException('Metadata cover fetch aborted', 'AbortError');
  const response = await fetch('/api/book-cover/source', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: coverUrl }),
    signal,
  });
  if (!response.ok) throw new Error(`표지 이미지를 가져오지 못했습니다. (${response.status})`);
  const contentType = response.headers.get('content-type')?.split(';', 1)[0]?.trim() ?? '';
  if (!contentType.startsWith('image/')) throw new Error('표지 응답이 이미지가 아닙니다.');
  const source = await response.blob();
  if (source.size === 0) throw new Error('표지 이미지가 비어 있습니다.');
  return source;
}
