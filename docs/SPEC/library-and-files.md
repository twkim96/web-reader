# 서재와 도서 파일

## 책장

클라우드 서재는 연결된 Drive 계정의 확정된 `web viewer` 폴더에 있는 직접 자식 도서를 표시합니다. 로컬 서재는 현재 브라우저 프로필에 저장한 파일을 표시하며 오프라인에서 사용할 수 있습니다. 폴더 선택·권한·재연결은 [Drive 연동](../integrations/firebase-and-drive.md)이 담당합니다.

제목 검색, 제목/최근/인기 정렬, 출처·장르·태그·형식 복수 선택 필터를 제공합니다. 형식 필터는 TXT, EPUB, PDF, ZIP이며 변환된 TXT는 원본 형식으로, ZIP·CBZ·7z는 ZIP으로 분류합니다. 형식 필터는 공개 카탈로그가 로딩 중이어도 사용할 수 있습니다. 검색·필터 초기화는 정렬 설정을 유지합니다.

목록·표지·압축 표지 보기를 지원합니다. 저장된 `grid` 설정은 압축 표지 보기로 이어집니다. 카드의 정보 버튼과 길게 누르기는 도서 정보창을 열고, 본문 진입과 분리됩니다. 책장은 로컬 표지 캐시만 읽고 진입/스크롤 중 원본이나 외부 표지를 다시 요청하지 않습니다. 성공한 도서 열기에서 내장 표지 또는 플랫폼 fallback을 캐시하며, 없으면 자동 생성 표면을 사용합니다. 진행도 0.0%와 100%는 읽는 중 우선 정렬에서 제외합니다.

## 형식과 가져오기

| 원본 | 읽기와 로컬 보관 |
| --- | --- |
| TXT | 인코딩을 판별하고 EPUB으로 변환해 읽기용 캐시를 저장 |
| EPUB | EPUB 구조 검증 후 Foliate로 열기 |
| PDF | PDF.js와 Foliate의 고정 레이아웃 경로로 열고 원본 Blob 보관 |
| ZIP·CBZ·7z | 지원 이미지 항목을 검사·정렬해 고정 레이아웃 책으로 열고 원본 Blob과 검사 인덱스 보관 |

Drive 업로드는 사용자가 선택한 원본을 보존합니다. 로컬 TXT 캐시의 파일명이 EPUB으로 바뀌어도 `sourceFormat`을 유지합니다. PDF·압축 도서를 EPUB으로 변환한다는 가정은 사용하지 않습니다.

TXT 변환은 UTF-8·EUC-KR·UTF-16 계열 인코딩을 처리합니다. 변환/목차 변경은 새로 만드는 EPUB에 적용하며 기존 저장 EPUB을 임의로 다시 변환하지 않습니다.

일반 가져오기에는 파일 수·개별 용량·총용량 제한이 있고 압축 도서는 한 번에 하나만 단독 선택합니다. 정확한 한도와 활성 형식은 [bookFormats.ts](../../src/lib/bookFormats.ts)의 `ACTIVE_SOURCE_FORMATS`, `BOOK_FILE_LIMITS_MB`, `updateImportSelection`이 기준입니다. 암호화된 압축과 손상·지원하지 않는 압축은 오류로 처리합니다. 이미지/압축 해제 한도는 [archiveImageBook.ts](../../src/lib/archiveImageBook.ts)를 기준으로 합니다.

ZIP은 Apple 모바일 WebKit에서 Worker/stream 전송 정지를 피하려고 같은 스레드 대체 경로를 사용합니다. 7z는 Worker와 직렬 추출 큐를 사용하며 취소·타임아웃 시 작업과 자원을 정리합니다. PDF.js의 메인 실행과 Worker에는 `Map/WeakMap.getOrInsertComputed` 호환 처리가 있습니다.

## 캐시·삭제 계약

본문·메타데이터·표지·압축 검사 캐시는 `DEVICE_CONTENT_OWNER_KEY`의 기기 공용 공간에 속합니다. Firebase나 Drive 계정을 바꿔도 파일 캐시 소유권을 새 계정으로 옮기지 않습니다. 진행률·주석·통계는 별도 계정 공간입니다. 저장 구조와 업그레이드의 보존 범위는 [운영 가이드](../operations/deployment-and-recovery.md)에 있습니다.

책을 열 때 유효한 로컬 캐시를 우선 사용하고 필요한 경우 Drive에서 내려받습니다. `bookFingerprint`로 원본 호환성을 확인합니다. 저장 공간 부족을 일반 성공으로 처리하지 않으며, 취소된 이전 열기의 응답이 새 도서를 덮지 않아야 합니다.

클라우드 도서 삭제는 Drive 삭제 → 진행률 초기화 성공 → 로컬 콘텐츠 제거 순서입니다. 앞 단계가 실패하거나 계정 수명이 바뀌면 뒤 단계를 진행하지 않습니다. 도서 주석 삭제에는 generation/tombstone 경계가 있으므로 콘텐츠 제거만으로 원격 삭제가 끝났다고 판단하지 않습니다.

기기 사본이 있는 Drive 도서의 `로컬 삭제`는 기기 콘텐츠·메타데이터·표지·압축 검사 캐시를 제거하고 계정 진행률·주석과 Drive 원본은 유지합니다. `전체 삭제`는 위의 안전 삭제 순서를 사용합니다. 로컬 전용 도서의 삭제는 유일한 기기 사본에도 영향을 주므로 실제 삭제 범위를 확인창에서 구분합니다.

## 코드와 검증

- 책장: [shelf/index.tsx](../../src/components/shelf/index.tsx), `useShelfPreferences`, `useFilteredBooks`, [bookUtils.ts](../../src/components/shelf/bookUtils.ts), `useShelfBookCovers`
- 가져오기·읽기 소스: `ImportBookModal`, `FileUploader`, [bookContent.ts](../../src/lib/bookContent.ts)의 `prepareBookSource`, [useReaderBookSource.ts](../../src/hooks/reader/useReaderBookSource.ts)
- 저장·삭제: [localDBV5.ts](../../src/lib/localDBV5.ts), [bookDeletion.ts](../../src/lib/bookDeletion.ts), `annotationBookDeletion`, `bookFingerprint`
- 최소 관련 검증: `npm run test:formats`, `npm run test:archives`, `npm run test:drive`, `npm run test:shelf`, `npm run test:shelf-ui` 중 변경 영역을 선택합니다. 실제 도서/기기 확인은 [TODO](../TODO.md)에 있습니다.
