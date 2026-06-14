# 업데이트 1.6.2 안정화 계획

## 목표

- 1.6.0과 1.6.1에서 추가한 PDF, ZIP/CBZ, 7z, Google Drive 대용량 처리의 남은 자원 수명 문제를 정리한다.
- 실패하거나 취소된 작업이 네트워크, Worker, 압축 해제, PDF.js 내부 캐시에 남지 않게 한다.
- 작은 용량 안내 UI 외 신규 기능을 추가하지 않고 긴 문서, 빠른 페이지 이동, 불안정한 네트워크에서의 안정성을 높인다.
- 수정 비용이 큰 TXT 변환 구조 개편과 의도된 로컬 파일명 ID 정책은 변경하지 않는다.

## 현재 상태

- 1.6.1 정적 검사, 자동 테스트 61개, production build와 로컬 Chromium 회귀는 통과했다.
- 현재 1.6.2 변경 범위의 자동 회귀 102개, 전체 ESLint, TypeScript, production build를 통과했다.
- 포맷별 파일 크기 제한과 가져오기 모달 안내 UI는 구현했으며 자동 테스트와 production build를 통과했다.
- Drive resumable 업로드 복구 절차를 공식 상태 조회 방식으로 수정했으며 자동 회귀와 production build를 통과했다.
- 리더 닫기·도서 전환 시 Drive 다운로드와 준비 중인 압축 도서 자원을 취소·정리하도록 수정했으며 자동 회귀와 production build를 통과했다.
- 7z 페이지 추출은 현재 작업 1개와 마지막 대기 요청 1개만 유지하고, 60초 timeout과 1GB 전체 예상 해제 한도를 적용했으며 자동 회귀를 통과했다.
- PDF 페이지 캐시는 제거 시 `PDFPageProxy.cleanup()`을 수행하고 canvas를 8MP·8192px 이하로 제한했으며 105페이지 Chromium 회귀를 통과했다.
- 안내 UI는 360×640 Chromium에서 실제 클릭, 내부 스크롤과 가로 overflow 없음까지 확인했다.
- 일반적인 PDF와 압축 도서 사용에서 즉시 재현되는 크리티컬 오류는 확인되지 않았다.
- 55MB 규모 실제 solid 7z의 빠른 이동과 종료 자원 회수는 로컬 production Chromium에서 통과했다.
- 실제 Drive 청크 응답 유실은 로컬 fetch 프로토콜 시뮬레이션으로 검증했으며 외부 환경에서 강제 재현할 수 없는 경계로 남긴다.
- 압축 이미지 해상도 사전 검사와 Phase 6 통합 검증을 완료했다.
- 커밋 `a4576e6`을 `main`에 배포했으며 고정 배포 URL `https://twreader.vercel.app`의 전체 production Chromium 회귀를 통과했다.

## 확정 결정

### 포맷별 파일 크기 정책

- TXT는 50MB, EPUB은 100MB, PDF는 200MB, ZIP/CBZ/7z는 300MB로 제한한다.
- 로컬 파일 선택과 Google Drive 도서 열기에 같은 제한 맵을 사용한다.
- 일반 도서의 한 번 선택 총 500MB, 최대 10개 정책과 압축 도서 단독 선택 정책은 유지한다.
- 가져오기 모달의 느낌표 아이콘을 누르면 파일별 제한과 선택 정책을 펼쳐서 확인할 수 있게 한다.
- 큰 TXT의 Worker 변환이나 스트리밍 EPUB 생성은 이번 변경에 포함하지 않는다.

### 로컬 도서 ID 정책 유지

- Drive ID가 없는 로컬 도서는 파일명을 ID로 사용한다.
- 같은 이름의 파일을 다시 추가하면 기존 로컬 도서와 진행률을 교체하는 현재 동작을 의도된 정책으로 유지한다.
- UUID 도입, 중복 이름 UI, 데이터 마이그레이션은 1.6.2 범위에서 제외한다.

## 구현 원칙

1. 취소는 화면 상태만 막지 않고 가능한 범위에서 네트워크와 자원 소유자까지 전달한다.
2. 오래된 작업의 결과는 폐기하며, 폐기 시 생성한 Worker, Blob URL, PDF 페이지 자원을 정리한다.
3. 공식 프로토콜이 복구 절차를 제공하면 임의 재시도 대신 해당 절차를 따른다.
4. 보호 한도는 정상적인 일반 도서를 막지 않는 범위에서 메모리와 CPU의 최악 경로를 제한한다.
5. 외부 라이브러리 추가나 Foliate 전체 개편 없이 현재 어댑터 경계에서 수정한다.

## Phase 0: 포맷별 파일 크기 제한과 안내 UI

### 상태

- 구현 완료.
- 자동 테스트, TypeScript, ESLint, production build와 production Chromium 회귀 통과.

### 대상

- `src/lib/bookFormats.ts`
- `src/components/shelf/ImportBookModal.tsx`
- `tests/bookFormats.test.mjs`

### 변경

- 포맷별 제한을 하나의 `BOOK_FILE_LIMITS_MB` 맵에서 관리한다.
- 로컬 선택과 Drive 다운로드 전 검사가 같은 `getBookMaxBytes()`를 사용한다.
- 제한을 정확히 허용하고 1바이트 초과를 거부하는 경계 테스트를 TXT, EPUB, PDF, 압축 도서에 적용한다.
- 가져오기 모달의 기존 느낌표를 접근 가능한 토글 버튼으로 바꾸고 제한표를 접어서 표시한다.
- 작은 화면에서 제한표를 펼쳐도 모달 전체를 스크롤할 수 있게 최대 높이를 제한한다.

### 완료 조건

- TXT 50MB, EPUB 100MB, PDF 200MB, ZIP/CBZ/7z 300MB 제한이 로컬과 Drive에 동일하게 적용된다.
- 안내 문구가 코드의 제한 맵에서 값을 읽어 정책과 어긋나지 않는다.
- 키보드와 터치로 안내를 열고 닫을 수 있으며 작은 화면에서 추가·취소 버튼까지 접근할 수 있다.

### 검증

- `npm run test:formats`: 29개 통과.
- `npx tsc --noEmit`: 통과.
- 변경 파일 ESLint: 통과.
- `npm run build`: 통과.
- 360×640 Chromium에서 안내 버튼 실제 클릭, 제한값 표시, 모달 내부 스크롤과 가로 overflow 0 확인.

## Phase 1: Drive resumable upload 복구 절차 수정

### 상태

- 구현 완료.
- 자동 테스트, TypeScript, ESLint, production build 통과.
- 실제 Drive에서 응답 유실을 강제로 재현하는 검증은 자동 fetch 시뮬레이션으로 대체.

### 대상

- `src/lib/driveUpload.ts`
- `tests/driveUpload.test.mjs`

### 변경

- 청크 요청이 응답 없이 실패하거나 5xx를 반환하면 같은 청크를 즉시 재전송하지 않는다.
- resumable session URI에 빈 `PUT`과 `Content-Range: bytes */{전체 크기}`를 보내 서버 수신 위치를 조회한다.
- `308 Resume Incomplete`의 `Range`를 기준으로 다음 offset을 계산한다.
- 상태 조회가 `200` 또는 `201`이면 이미 완료된 업로드 결과를 사용한다.
- `404` 또는 복구 불가능한 4xx는 세션 만료 오류로 처리하고 현재 파일 업로드를 명확히 실패시킨다.
- rate limit 응답에는 기존 지수 backoff를 유지하되 offset을 추측하지 않는다.
- 세션 생성 요청 재시도와 청크 복구 재시도를 별도 helper로 나눠 책임을 명확히 한다.

### 완료 조건

- 서버가 청크를 받았지만 응답이 유실된 경우 이미 받은 범위를 다시 보내지 않는다.
- 일부 바이트만 받은 `Range` 응답에서도 정확한 다음 바이트부터 업로드한다.
- 완료 응답 유실 후 상태 조회가 완료 결과를 반환하면 중복 파일이나 실패 안내가 발생하지 않는다.
- 401, 403, 취소, 일반 재시도와 진행률 표시가 기존 정책을 유지한다.

### 검증

- 응답 유실 후 상태 조회 `308`, 상태 조회 완료 `200`, 세션 만료 `404`를 자동 테스트한다.
- 상태 조회의 `Content-Range`와 다음 청크 offset을 요청 기록으로 검증한다.
- 기존 308, 401, 403, 취소, rate limit 테스트를 유지한다.
- `npm run test:drive`: 34개 통과.
- `npm run test:formats`: 29개 통과.
- `npm run test:archives`: 32개 통과.
- `npm run test:storage`: 1개 통과.
- `npm run test:shelf`: 5개 통과.
- `npx tsc --noEmit`, 변경 파일 ESLint, `git diff --check`: 통과.
- `npm run build`: 통과.

## Phase 2: 도서 열기 취소와 자원 소유권 정리

### 상태

- 구현 완료.
- 자동 테스트, TypeScript, ESLint, production build 통과.
- Drive fetch signal 전달과 준비 중인 7z Worker 즉시 종료를 자동 검증했다.

### 대상

- `src/hooks/reader/useReaderBookSource.ts`
- `src/lib/googleDrive.ts`
- `src/lib/bookContent.ts`
- `src/lib/readerLoadLifecycle.ts`
- `tests/readerLoadLifecycle.test.mjs`
- `tests/googleDrive.test.mjs`

### 변경

- 리더를 닫거나 다른 도서로 전환하면 현재 도서 다운로드에 `AbortSignal`을 전달한다.
- `fetchWithTimeout`은 호출자가 전달한 signal과 내부 timeout signal을 함께 처리한다.
- 취소 후 완료된 `prepareBookSource` 결과는 `openBook`에 전달하지 않는다.
- 취소 시 이미 만들어진 Foliate archive book은 `destroy()`를 호출해 ZIP reader 또는 7z Worker를 닫는다.
- ZIP/7z 인덱스 준비에도 같은 signal을 전달하고, 7z 초기화 취소 시 Worker를 즉시 종료한다.
- 취소된 작업은 사용자 오류 alert와 `onBack`을 다시 발생시키지 않는다.
- IndexedDB 저장이 시작된 뒤 취소된 경우 데이터 일관성을 깨지 않되 화면에는 오래된 결과를 반영하지 않는다.

### 완료 조건

- 300MB Drive 파일 다운로드 중 리더를 닫으면 네트워크 요청이 중단된다.
- 압축 인덱스 준비 직후 취소돼도 Worker와 archive reader가 남지 않는다.
- 이전 도서의 늦은 완료가 새 도서를 열거나 로딩 상태를 변경하지 않는다.
- 정상 로컬·클라우드 도서 열기와 오프라인 캐시 폴백은 유지된다.

### 검증

- 지연 fetch와 지연 prepare를 사용해 unmount, 도서 교체, timeout을 자동 검증한다.
- 취소 후 `openBook`, alert, `onBack` 호출 수와 `destroy()` 호출을 검증한다.
- 실제 Drive 인증이 필요한 큰 파일 네트워크 관찰은 고정 배포 환경 확인 항목으로 남긴다.
- `npm run test:formats`: 24개 통과.
- `npm run test:drive`: 34개 통과.
- `npm run test:archives`: 12개 통과.
- `npm run test:storage`: 1개 통과.
- `npm run test:shelf`: 5개 통과.
- `npx tsc --noEmit`, 변경 파일 ESLint, `git diff --check`: 통과.
- `npm run build`: 통과.
- 7z 초기화 AbortSignal 단위 검증: init 대기 Promise가 `AbortError`로 종료되고 Worker terminate 확인.
- production Chromium의 실제 solid 7z 종료: Worker terminate 1회, 활성 Blob URL 0개.

## Phase 3: 7z 이동 요청 병합과 보호 한도 조정

### 상태

- 구현 완료.
- 자동 테스트, TypeScript, ESLint, production build와 실제 solid 7z Chromium 회귀 통과.

### 대상

- `public/foliate-js/fixed-layout.js`
- `src/hooks/foliate/types.ts`
- `src/lib/archiveImageBook.ts`
- `src/lib/latestRequestQueue.ts`
- `src/lib/sevenZipImages.ts`
- `tests/archiveImages.test.mjs`
- `tests/latestRequestQueue.test.mjs`
- `tests/sevenZipImages.test.mjs`
- 고정 레이아웃 및 브라우저 회귀 테스트

### 변경

- fixed-layout의 section load에 현재 이동 요청 signal을 전달할 수 있게 한다.
- 아직 시작하지 않은 오래된 7z 추출 요청은 `LatestRequestQueue`에서 취소하고 마지막 유효 요청 하나만 남긴다.
- 이미 WASM에서 실행 중인 동기 추출은 중단할 수 없으므로 호출자에게는 즉시 취소를 알리고 결과는 폐기한다.
- 같은 페이지의 취소된 pending 추출을 새 이동 요청이 재사용하지 않게 요청 signal별 수명을 분리한다.
- 7z 전체 예상 해제 한도는 2GB에서 1GB로 낮춘다.
- 단일 이미지 추출에 60초 제한을 두고 초과 시 Worker를 종료하며 active·pending Promise를 모두 정리한다.
- Worker 오류와 `postMessage` 동기 실패도 같은 종료 경로에서 timer와 대기 요청을 정리한다.
- ZIP/CBZ는 현재 지연 추출과 4페이지 LRU 동작을 유지한다.

### 완료 조건

- 느린 solid 7z에서 연속 페이지 이동 시 오래된 대기 요청이 모두 실행되지 않는다.
- 마지막 이동 요청이 불필요한 이전 추출 수만큼 지연되지 않는다.
- 시간 제한이나 보호 한도 실패 후 Worker와 대기 Promise가 남지 않는다.
- 정상 혼합 7z의 이미지 필터, 자연 정렬, 캐시 인덱스 재사용을 유지한다.

### 검증

- 느린 가짜 추출기로 `next → next → prev` 요청 수와 마지막 결과를 자동 검증한다.
- 대기 요청 취소, active 추출 결과 폐기, timeout, Worker 실패 후 정리를 검증한다.
- 작은 이미지와 큰 비이미지가 섞인 solid 7z 보호 테스트를 유지한다.
- 실제 solid 7z에서 빠른 이동 후 추출 횟수, 마지막 페이지, Worker 종료를 로컬 Chromium에서 확인한다.
- `npm run test:archives`: 32개 통과.
- `npx tsc --noEmit`, 변경 파일 ESLint, `git diff --check`: 통과.
- `npm run build`: 통과.
- 저장소의 `7zz.wasm`으로 `Solid = +`, 6페이지, 해제 후 약 55MB fixture를 생성해 검증.
- 빠른 `1 → 5 → 2` 이동 시 Worker 추출은 `01.bmp`, `02.bmp`, `03.bmp`만 실행되고 오래된 `06.bmp` 요청은 실행되지 않음.
- 최종 index 2, 프레임 1개, 이미지 로드 완료, 전역 오류 0개.
- 도서 종료 후 7z Worker terminate 1회, 활성 Blob URL 0개.

## Phase 4: PDF.js 페이지 캐시 수명 정리

### 상태

- 구현 완료.
- 자동 테스트, TypeScript, ESLint, production build와 로컬 Chromium 회귀 통과.

### 대상

- `public/foliate-js/pdf.js`
- `public/foliate-js/pdf-page-lifecycle.js`
- `tests/pdfPageLifecycle.test.mjs`
- `tests/browserRegression.mjs`
- PDF 브라우저 회귀 테스트

### 변경

- PDF 페이지 캐시는 `{ page, source }` 형태로 `PDFPageProxy`와 renderer 소유권을 함께 관리한다.
- 4페이지 LRU에서 페이지를 제거할 때 frame, render task와 text layer를 취소하고 `page.cleanup()`을 호출한다.
- cleanup이 active render 때문에 실패하면 render 종료를 기다린 뒤 한 번 재시도하며 실패 Promise도 수거한다.
- 취소된 section load는 새 요청과 분리하고, 늦게 완료된 page와 Blob URL을 즉시 정리한다.
- 도서 종료 시 cache, pending section, cover와 cleanup 작업이 정리된 뒤 PDF document와 Worker를 종료한다.
- canvas는 화면 배율과 devicePixelRatio를 반영하되 8MP 및 한 변 8192px를 넘으면 내부 렌더 배율만 낮춘다.
- 보정된 CSS 확대율로 화면상 페이지 크기와 텍스트·주석 레이어 위치를 유지한다.

### 완료 조건

- 수백 페이지 PDF를 순차 이동해도 PDF.js 페이지 렌더 자원이 방문 페이지 수에 비례해 계속 증가하지 않는다.
- 고해상도 화면이나 큰 페이지에서도 canvas가 브라우저 한도를 넘지 않는다.
- 리사이즈 경쟁 방지, 텍스트 선택, 주석 링크, 4페이지 LRU 동작은 유지된다.
- 도서 종료 후 Worker, Blob URL, canvas와 PDF page 자원이 남지 않는다.

### 검증

- 4페이지 초과 이동 시 제거된 페이지의 cleanup 호출을 자동 또는 브라우저 계측으로 확인한다.
- 100페이지 이상 생성 PDF를 왕복 이동해 heap, canvas 수와 오류를 확인한다.
- 큰 MediaBox와 높은 devicePixelRatio에서 최대 canvas 픽셀 예산을 검증한다.
- 기존 7페이지 PDF 리사이즈, 진행률, 북마크, 재개 위치 회귀를 유지한다.
- `npm run test:formats`: 29개 통과.
- PDF lifecycle 순수 테스트: 일반 배율, 8MP·8192px 경계, cleanup 즉시 성공과 render 종료 후 재시도 통과.
- `npm run test:browser`: 통과.
- Chromium 20배 확대 canvas: `2545 × 3294`, 8MP 이하.
- Chromium 105페이지 전체 렌더 후 첫 페이지 복귀: 최대 활성 canvas 1개, page source release 106회.
- PDF 2권 종료 후 활성 Blob URL 0개, PDF Worker 2개 종료.
- 취소된 PDF section load: `AbortError`.
- 브라우저 전역 오류와 처리되지 않은 Promise: 0개.

## Phase 5: 압축 이미지 디코드 크기 방어

### 상태

- 완료.

### 대상

- `src/lib/archiveImageBook.ts`
- 필요 시 이미지 메타데이터 probe helper
- `tests/archiveImages.test.mjs`

### 변경

- 압축 이미지의 파일 바이트뿐 아니라 폭, 높이와 전체 픽셀 수를 검사한다.
- 브라우저가 전체 이미지를 디코드하기 전에 확인할 수 있는 메타데이터 경로를 우선 사용한다.
- 지원 형식 전체에 대한 안전한 사전 검사가 작은 helper로 구현되지 않으면 대규모 이미지 파서 도입은 중단한다.
- 사전 검사가 어려운 형식은 현재 100MB 단일 이미지 제한과 추출 크기 검증을 유지하고 명시적인 잔여 위험으로 남긴다.
- 정상적인 만화 스캔 페이지는 허용하고 비정상적으로 큰 해상도만 거부하도록 픽셀 상한을 샘플 기반으로 정한다.
- PNG, JPEG, GIF, BMP, WebP는 전체 디코드 없이 헤더 일부만 읽어 폭과 높이를 확인한다.
- 폭 또는 높이 `32768px`, 전체 `64MP`를 초과하면 Blob URL 생성 전에 거부한다.
- AVIF는 BMFF item 연결을 안전하게 해석하려면 변경 범위가 커지므로 기존 100MB 단일 이미지 제한과 추출 크기 검증을 유지한다.

### 완료 조건

- 작은 파일 크기지만 비정상적으로 큰 픽셀 수를 가진 검증 가능한 이미지가 표시 전에 거부된다.
- 검증 과정 자체가 동일한 대용량 디코드를 먼저 수행하지 않는다.
- 정상 PNG, JPEG, WebP, GIF, BMP, AVIF의 기존 지원을 불필요하게 축소하지 않는다.
- 구현이 형식별 대형 파서나 새 의존성을 요구하면 이 Phase는 완료 처리하지 않고 제외 사유를 기록한다.

### 검증

- 정상 해상도, 최대 경계, 픽셀 상한 초과 이미지 메타데이터를 자동 테스트한다.
- Blob 크기 제한과 실제 추출 크기 불일치 테스트를 유지한다.
- 로컬 Chromium에서 거부 시 Worker, Blob URL과 페이지 캐시가 남지 않는지 확인한다.
- `npm run test:archives`: 32개 통과.
- PNG, JPEG, GIF, BMP, WebP VP8/VP8L/VP8X의 정상 크기 probe 통과.
- JPEG의 60,000바이트 APP 메타데이터를 전체 로드하지 않고 건너뛰는 sparse read 검증 통과.
- `8192 × 8192` 경계 허용, 64MP 및 32768px 초과 거부 검증 통과.
- 실제 ZIP 추출 결과가 제한을 넘을 때 source를 닫고 Blob URL을 만들지 않는 검증 통과.
- 앞쪽 정상 페이지가 캐시된 뒤 제한 초과 이미지를 만나도 기존 페이지 Blob URL을 모두 회수하는 검증 통과.
- Chromium UI에서 초과 CBZ를 열면 제한 안내가 표시되고 생성된 Blob URL은 0개.

## Phase 6: 통합 회귀와 1.6.2 릴리스 준비

### 상태

- 완료. 1.6.2 production 배포 및 고정 URL 검증 통과.

### 변경

- 앱과 서비스워커 버전을 `1.6.2`로 일치시킨다.
- 이번 안정화 범위에서 추가한 signal, cleanup, retry helper의 중복을 제거한다.
- 변경 범위에 남은 trailing whitespace와 사용하지 않는 디버그 코드를 정리한다.
- 계획 문서에는 현재 실행해 통과한 검증만 기록한다.
- 앱, lockfile과 서비스워커 캐시 버전을 `1.6.2`로 맞추고 정합성 자동 테스트를 추가한다.
- 압축 이미지 제한 실패 시 기존 페이지 캐시까지 닫는 공통 종료 경로로 정리한다.
- 모바일 환경에서 `dvh` 해석 차이로 모달이 화면을 넘지 않도록 바깥 컨테이너 높이를 기준으로 제한한다.

### 완료 조건

- 포맷별 50/100/200/300MB 정책과 파일명 기반 로컬 ID 정책이 유지된다.
- PDF, ZIP/CBZ, 7z, TXT/EPUB, 진행률, 북마크, 오프라인 캐시와 Drive 목록 동작이 유지된다.
- 취소된 네트워크·압축·PDF 작업이 늦게 화면 상태를 변경하지 않는다.
- Drive resumable 복구가 서버 `Range`를 기준으로 동작한다.
- 서비스워커가 1.6.2 자산을 사용하고 이전 앱 캐시를 정리한다.

### 검증

- `git diff --check`: 통과.
- `npx tsc --noEmit`: 통과.
- `npx eslint src tests public/sw.js public/foliate-js/pdf.js public/foliate-js/pdf-page-lifecycle.js public/foliate-js/fixed-layout.js public/7z/archive-worker.js`: 통과.
- `npm run test:formats`: 29개 통과.
- `npm run test:drive`: 34개 통과.
- `npm run test:archives`: 32개 통과.
- `npm run test:storage`: 1개 통과.
- `npm run test:shelf`: 5개 통과.
- `npm run test:release`: 1개 통과.
- 전체 자동 회귀: 102개 통과.
- `npm run build`: 통과.
- production 서버 `npm run test:browser`: 통과.
- 360×640 안내 모달: 592px 높이, 내부 `overflow-y: auto`, 가로 overflow 0.
- 1,100권 서가 검색·정렬: 1초 이상 long task 및 전역 오류 0개.
- 초과 CBZ: 사용자 안내 표시, Blob URL 생성 0개.
- 실제 solid 7z: 오래된 대기 추출 제거, 최종 index 2, Worker 종료 및 Blob URL 회수 확인.
- 105페이지 PDF 전체 이동: 최대 활성 canvas 1개, page source release 106회.
- PDF 2권 종료 후 활성 Blob URL 0개, PDF Worker 2개 종료.
- 서비스워커 실제 등록: `pc-reader-v1.6.1` 캐시 삭제, `pc-reader-v1.6.2` 생성, 프리캐시 8개 확인.
- 커밋 `a4576e6`을 `main`에 push하고 Vercel production 배포 완료.
- 고정 배포 URL `https://twreader.vercel.app/sw.js`: `pc-reader-v1.6.2` 확인.
- 고정 배포 URL에서 `npm run test:browser`: 통과.
- 배포 환경에서도 실제 solid 7z 최종 index 2, Worker 종료 1회, 활성 Blob URL 0개.
- 배포 환경에서도 105페이지 PDF 최대 활성 canvas 1개, cleanup 106회, PDF Worker 종료 2회.
- 배포 환경 서비스워커: 이전 `v1.6.1` 캐시 삭제, `v1.6.2` 프리캐시 8개 확인.

## 제외 범위

- TXT 변환 Worker 이전 또는 스트리밍 EPUB 생성
- 파일명 기반 로컬 도서 ID 변경과 데이터 마이그레이션
- 신규 도서·이미지·압축 형식 지원
- PDF 검색, OCR, 이미지 텍스트 검색
- 암호화 압축 비밀번호 입력
- 서버 측 압축 해제, PDF 변환, 썸네일 생성
- 외부 PDF 뷰어, 이미지 파서 또는 가상화 라이브러리 도입
- 리더 UI 재설계

## 완료 정의

- 각 Phase는 코드 작성만으로 완료 처리하지 않고 해당 완료 조건과 현재 검증을 통과해야 한다.
- Phase 5가 작은 변경 범위를 넘으면 1.6.2 필수 완료 조건에서 제외하고 잔여 위험을 기록한다.
- 고정 배포 URL 검증을 수행하지 못하면 해당 항목은 미완료로 남긴다.
