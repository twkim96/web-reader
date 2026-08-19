# Web Reader 1.8.20 — iPad EPUB cold-open 계측 및 pre-view 안정화

작성일: 2026-08-19

이전 버전: `1.8.19`

상태: 구현·전체 `npm run check`·집중 Chromium/WebKit 회귀 완료, iPad 실기기 계측 확인 대기

## 배경

1.8.19에서 큰 TXT→EPUB 도서의 챕터 경계 탭 이동 시 outgoing section의 blank sentinel/range scan을 제거했다. 후속 실기기 확인에서 같은 로컬 EPUB도 Android는 빠르지만 iPad에서 첫 open이 약 6~7초 걸리는 현상이 남았다. 특히 마지막처럼 짧은 section에서 시작하면 일관되게 빠르고, 책을 연 뒤 목차/책갈피로 다른 section을 이동하는 것은 빠르다.

이 관찰은 단순 네트워크 또는 전체 파일 크기보다 cold open의 ZIP/package/font/첫 section layout 중 특정 단계가 iPad WebKit에서 커지는지 분리 계측할 필요가 있음을 뜻한다.

별도로 iPad에서 클라우드 도서를 처음 여는 동안 `undefined is not an object (evaluating 'this.#view.element')` 오류가 보고됐다. paginator가 첫 내부 view를 만들기 전에 `viewSize`가 읽히는 pre-view 경로를 방어한다.

## 변경 사항

### 1. 항상 수집되는 reader-open 성능 trace

`readerBootstrapTrace`의 기존 상세 sync trace는 debug flag 계약을 유지한다. 대신 cold-open 성능만을 위한 `readerOpenPerformanceTrace`를 별도의 작은 in-memory ring buffer로 추가한다.

수집 값은 phase, duration, byte/count, section index/size뿐이다. 책 제목, CFI, 사용자 식별자, 원문은 기록하지 않는다.

주요 phase:

- `reader-open-start`
- `indexeddb-book-read`
- `epub-jszip-validation`
- `prepare-book-source`
- `cloud-book-download`
- `foliate-zip-index`
- `foliate-epub-init`
- `foliate-progress-index`
- `foliate-view-open`
- `reader-font-source-ready`
- `reader-style-layout-init`
- `foliate-section-load`
- `foliate-section-stabilize`
- `foliate-section-anchor`
- `foliate-initial-navigation`
- `reader-open-total`

### 2. 진단 JSON export

책장 → 독서 통계 → `진단`에서 내려받는 JSON에 `readerOpenPerformanceTrace`를 포함한다. 별도 `readerDebug=1` 설정 없이도 직전 cold-open timing을 확인할 수 있다.

### 3. iPad pre-view paginator crash 방어

- 첫 section이 아직 생성되지 않았으면 `paginator.viewSize`는 `0`을 반환한다.
- view 또는 scroll bounds가 준비되기 전 `snap()`은 `false`로 종료한다.
- 초기 cloud open 중 touch/layout event ordering이 먼저 들어와도 `this.#view.element`를 역참조하지 않는다.

### 4. runtime/cache revision

- app version: `1.8.20`
- Foliate runtime: `1.8.20.1`
- service-worker cache: `pc-reader-v1.8.20`

## 실기기 확인 방법

1. iPad에서 문제의 큰 TXT→EPUB 도서를 닫은 뒤 다시 연다.
2. 느린 section 시작 위치와 빠른 마지막 section 시작 위치를 각각 재현한다.
3. 책장으로 나온다.
4. `독서 통계` → `진단`을 눌러 JSON을 저장한다.
5. JSON의 `readerOpenPerformanceTrace`를 비교한다.

`foliate-section-load`/`stabilize`/`anchor`가 크면 section DOM/layout 쪽이고, `epub-jszip-validation`/`foliate-zip-index`/`foliate-epub-init`이 크면 전체 EPUB cold-open 쪽이다. `reader-font-source-ready`가 크면 RIDIBatang cold load 영향이다.

## 완료 조건

- [x] typecheck 및 관련 unit tests 통과
- [x] Chromium/WebKit에서 pre-view access와 1.8.19 section-boundary 회귀 통과
- [x] full `npm run check` 통과
- iPad에서 느린 section/빠른 마지막 section 각각의 진단 JSON 확보
- cloud first-open에서 `this.#view.element` 오류 재발 여부 확인
