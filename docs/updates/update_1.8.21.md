# Web Reader 1.8.21

## 목표

1.8.20 iPad 진단에서 EPUB cold-open 총 10.996초 중 9.745초가 `foliate-section-stabilize`의 `ridi-font` 단계에 집중된 것을 확인했다. 1.8.21은 이 구간을 더 세분화해 실제 병목이 폰트 준비인지, WebKit multi-column 재배치인지, Range/root geometry 계산인지 구분한다.

## 계측 분리

`readerOpenPerformanceTrace`에 다음 단계가 추가된다.

- `foliate-reader-font-load`: EPUB iframe의 `document.fonts.load('16px "RIDIBatang"')`
- `foliate-reader-font-frame`: 폰트 적용 뒤 다음 animation frame까지 대기
- `foliate-reader-font-expand`: 최종 `View.expand()` 전체
- `foliate-content-range-rect`: multi-column 전체 content Range의 `getBoundingClientRect()`
- `foliate-root-rect`: XHTML root의 `getBoundingClientRect()`

기존 `foliate-section-stabilize`는 유지한다. 세부 단계는 그 내부 시간을 설명하며 중첩되므로 단순 합산하지 않는다.

## 계측 오버헤드

- 상세 계측은 이미 실행되는 작업 전후의 `performance.now()` 호출만 추가한다.
- `openFoliateBook()`이 진행 중인 동안에만 timing counter를 켜며, 책이 열린 뒤 일반 페이지/챕터 이동에서는 세부 계측을 비활성화한다.
- 기존에 없던 `getBoundingClientRect()`나 font/layout 작업을 새로 실행하지 않는다.
- timing event dispatch는 `foliate-section-stabilize` 종료 시간을 먼저 캡처한 뒤 수행해 외부 진단 기록 비용이 해당 작업 시간에 포함되지 않게 한다.
- 원인 수정 후에는 장기 진단에 필요한 상위 단계만 유지하고 geometry 세부 계측은 제거하거나 debug-only로 축소할 수 있다.

## 런타임 캐시

- 앱 버전: `1.8.21`
- Foliate runtime revision: `1.8.21.1`
- Service Worker cache: `pc-reader-v1.8.21`

## 자동검증

- `git diff --check` 통과
- `npm run typecheck` 통과
- `npm run test:release` 3/3 통과
- 집중 Playwright Chromium/WebKit 4/4 통과
  - RIDIBatang section 전환에서 5개 세부 timing phase 확인
  - 기존 section-boundary tap fast path 확인
  - pre-view paginator 방어 확인
- 전체 `npm run check` 통과
  - storage 305건
  - shelf 111건
  - shelf-ui 8건
  - SW/release/publisher 및 production Next.js build 통과

실기기 iPad 진단 JSON 재수집 전이므로 원인 수정 자체는 아직 하지 않는다.

## iPad 재검증

느린 TXT→EPUB 도서를 다시 연 뒤 `독서 통계 → 진단` JSON의 `readerOpenPerformanceTrace`를 비교한다.

판별 기준:

- `foliate-reader-font-load`가 대부분이면 iframe FontFaceSet/RIDIBatang 로딩 경로가 병목이다.
- `foliate-reader-font-frame`이 대부분이면 WebKit의 폰트 적용/reflow가 animation frame을 장시간 막는 것이다.
- `foliate-reader-font-expand`가 대부분이고 그중 `foliate-content-range-rect`가 크면 전체 Range geometry 기반 page-count 계산이 병목이다.
- `expand`는 큰데 두 rect 측정이 짧으면 style/element sizing 또는 `onExpand()` 후속 작업을 추가로 분해한다.
