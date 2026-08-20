# Web Reader 1.8.27

## 목표

책장의 그리드형·리스트형 도서 카드에서 기존 도서 아이콘 대신 EPUB 내장 표지, PDF 첫 페이지, ZIP/CBZ 첫 이미지 표지를 표시한다.

- EPUB/PDF/ZIP/CBZ를 지원한다.
- TXT와 7z 이미지 압축 도서는 기존 아이콘을 유지한다.
- 책장 진입이나 스크롤만으로 원본 파일을 읽거나 클라우드 도서를 다운로드하지 않는다.
- 표지는 오프라인 도서를 업로드할 때 또는 도서를 실제로 처음 열 때만 생성한다.
- 표지 캐시가 사라지면 자동 복구하지 않고, 해당 도서를 다시 열 때 생성한다.

## 저장 구조

- IndexedDB schema를 14로 올리고 `book-covers-v14` 저장소를 추가한다.
- 표지는 기존 `Book`, Drive 파일 metadata, `metadata-v5`에 넣지 않고 기기 공용 content namespace에 별도로 저장한다.
- cache key는 `[ownerKey, bookId]`이며 `md5Checksum` 또는 `modifiedTime + size` fingerprint를 함께 기록한다.
- 현재 도서 fingerprint와 다르면 책장에서는 오래된 표지를 사용하지 않는다. 새 표지는 도서를 다시 열거나 다시 업로드할 때 덮어쓴다.
- 오프라인 사본 또는 도서를 삭제할 때 대응하는 표지 캐시도 같은 로컬 transaction에서 삭제한다.

## 생성 시점

### 업로드/가져오기

- EPUB/PDF/ZIP/CBZ 원본이 로컬 오프라인 저장에 성공한 경우에만 표지 생성을 시도한다.
- ZIP/CBZ는 기존 업로드 검사의 자연 정렬된 이미지 목록에서 첫 이미지만 추가 압축 해제한다. 원본 전체 이미지를 순회하지 않는다.
- 기존 import batch의 순차 실행 안에서 처리하므로 여러 대용량 도서의 표지 추출을 동시에 실행하지 않는다.
- 표지 추출 실패는 이미 완료된 원본 업로드·로컬 저장을 되돌리지 않는다. 책장은 기존 아이콘으로 안전하게 fallback한다.

### 최초 열기

- 실제 리더 open과 initial navigation이 성공한 뒤 표지 캐시 존재 여부를 확인한다.
- 캐시가 있으면 원본 표지를 다시 추출하지 않는다.
- 캐시가 없으면 열린 Foliate publication의 `getCover()`를 사용한다.
  - EPUB: package의 cover image
  - PDF: 첫 페이지 저해상도 render
  - ZIP/CBZ: 자연 정렬된 첫 이미지 페이지
- ZIP/CBZ 첫 페이지가 리더 초기화 중 이미 로드됐다면 같은 Blob을 표지 생성에 재사용하고 다시 압축 해제하지 않는다.
- 생성과 저장은 reader commit 뒤 deferred persistence로 실행해 리더 표시 성공을 표지 작업이 막지 않게 한다.

## 이미지 제한

- 원본 표지 Blob은 최대 25MB까지만 처리한다.
- canvas에서 최대 `480 × 720` 안으로 축소하고 WebP quality 0.82로 저장한다.
- WebP 생성이 불가능한 브라우저에서는 JPEG quality 0.86으로 fallback한다.
- EPUB의 SVG 또는 큰 원본 이미지도 그대로 책장에 노출하지 않고 raster cache로 정규화한다.
- 책장에서는 캐시 Blob의 object URL만 만들고 component 갱신·unmount 때 즉시 revoke한다.

## 책장 UI

- 그리드형 표지는 기존 도서 아이콘과 같은 56px 폭의 `2:3` 세로형으로 표시한다.
- 리스트형 표지는 기존 도서 아이콘과 같은 44/48px 폭을 유지하고 높이는 64/68px로 조금 줄여 행 간격을 보존한다.
- 캐시 표지에는 아이콘용 accent 배경·그림자·둥근 테두리를 적용하지 않고 `object-cover`로 가로폭을 채운다.
- 표지가 없는 도서는 기존 정사각형 accent 배경과 `BookOpen` 아이콘을 유지한다.
- 캐시가 없거나 fingerprint가 다르거나 Blob을 읽지 못하면 기존 `BookOpen` 아이콘을 유지한다.
- 그리드 카드에 표지가 있을 때는 중복되는 대형 배경 도서 아이콘을 숨긴다.

## 회귀 검증

- EPUB/PDF/ZIP/CBZ만 표지 캐시 대상이고 TXT/7z는 제외되는지 확인한다.
- ZIP/CBZ의 자연 정렬된 첫 이미지를 업로드 표지로 추출하고, 리더가 로드한 첫 페이지 Blob을 중복 압축 해제 없이 재사용하는지 확인한다.
- 큰 표지가 `480 × 720` 경계 안으로 축소되는지 확인한다.
- 현재 fingerprint의 Blob만 로드하고 변경된 도서는 cache miss가 되는지 확인한다.
- 오프라인 사본 삭제 시 표지 캐시도 함께 제거되는지 확인한다.
- 그리드형·리스트형 모두 표지가 있으면 이미지, 없으면 기존 아이콘을 렌더하는지 확인한다.
- 기존 책장 태그·조회수·진행률 레이아웃과 도서 열기 동작은 유지한다.

검증 결과:

- `npm run test:node` 전체 통과
- `npm run test:browser:ci` 전체 통과
  - 캐시 표지의 그리드/리스트 표시와 아이콘 fallback 확인
  - 표지 프레임의 투명 배경, 무테·무그림자, 기존 아이콘 폭과 축소된 리스트 높이 및 행 내부 배치 확인
  - PDF 첫 페이지 cover Blob 생성 확인
  - 새 `book-covers-v14` 저장소를 포함하도록 브라우저 fixture 정리 경계 갱신
  - 현재 glass shelf dock 계약인 surface alpha `0.88`, radius `16px`로 오래된 기대값 보정
- `npm run test:e2e`: 36 passed, 2 skipped
  - Chromium에서 실제 PDF와 CBZ 업로드, 표지 저장, 그리드/리스트 표시, cache 삭제 후 아이콘 복귀 통과
  - Playwright WebKit의 input-backed `File` → IndexedDB 저장 엔진 제한은 명시적으로 skip; 앱의 기존 Safari 대용량 저장 경로는 변경하지 않음
- `npm run lint`, `npm run typecheck`, `npm run build`, `git diff --check` 통과
- lint에는 기존 Foliate vendor warning 2건만 남음

## 버전/캐시

- 앱 버전: `1.8.27`
- Service Worker cache: `pc-reader-v1.8.27`
- Foliate renderer 코드는 변경하지 않아 runtime revision은 `1.8.22.1`을 유지한다.
