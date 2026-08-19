# Web Reader 1.8.22

## 목표

1.8.21 iPad 진단에서 느린 TXT→EPUB section open 10.129초 중 `foliate-reader-font-frame`이 9.851초를 차지했고, `document.fonts.load()`는 0ms, 최종 `expand()`와 content Range geometry는 각각 5ms 수준이었다. 1.8.22는 이 지연을 hidden publication iframe의 `requestAnimationFrame` throttling으로 보고 실제 navigation 경로를 수정한다.

## 원인

새 section은 최종 pagination이 끝날 때까지 staging view로 생성되며 `visibility: hidden` 상태다. 기존 `View.waitForReaderFont()`과 `View.waitForPagination()`은 publication iframe의 `document.defaultView.requestAnimationFrame()`을 기다렸다.

실기기 계측에서는 RIDIBatang 자체는 즉시 준비됐지만 이 hidden iframe frame 대기만 약 9.85초가 걸렸다. 이후 synchronous `expand()`와 `getBoundingClientRect()`는 수 ms에 끝났으므로 EPUB ZIP/OPF/CFI/Range 계산이 주 병목은 아니었다.

## 수정

- `View.waitForReaderFont()`은 font readiness 뒤 publication iframe rAF 대신 visible paginator document의 rAF를 한 번 기다린다.
- `View.waitForPagination()`도 images/fonts readiness 뒤 세 번의 stabilization frame을 visible host renderer에서 기다린다.
- 각 frame 뒤 기존 `expand()`를 그대로 실행해 최종 multi-column page geometry를 동기적으로 계산한다.
- staging view의 `visibility: hidden` 정책은 유지한다. 아직 pagination이 끝나지 않은 section을 사용자에게 노출하지 않는다.
- AbortSignal/cancel semantics, image readiness, font readiness, stable navigation timeout, section-end anchor 계산은 변경하지 않는다.
- 1.8.21에서 추가한 open timing은 유지해 iPad 실기기에서 수정 효과를 같은 `readerOpenPerformanceTrace`로 비교할 수 있다.

## 회귀 범위

hidden/staging view를 사용하는 경로 전체에 같은 규칙을 적용한다.

- 최초 RIDIBatang EPUB resume/start
- 이전 section 끝으로 이동하는 `SECTION_END` pagination
- remote stable navigation이 사용하는 target-aware pagination
- navigation readiness에서 사용하는 active view pagination

active view의 visible renderer frame을 사용하므로 publication iframe이 offscreen/hidden으로 분류되어도 stabilization frame 자체가 장시간 throttle되지 않는다.

## 런타임 캐시

- 앱 버전: `1.8.22`
- Foliate runtime revision: `1.8.22.1`
- Service Worker cache: `pc-reader-v1.8.22`

## 자동검증

- focused Playwright Chromium/WebKit 8/8 통과
  - reader-font staging이 section load 뒤 host `requestAnimationFrame`을 사용
  - section-end staging이 세 번 모두 host `requestAnimationFrame`을 사용
  - 1.8.19 section-boundary tap fast path 유지
  - previous-section final page 계산 유지
- 전체 `npm run check` 통과
  - storage 305건
  - shelf 111건
  - shelf-ui 8건
  - SW/release/publisher 통과
  - production Next.js build 통과

## iPad 실기기 재검증

문제 TXT→EPUB의 동일한 긴 section을 다시 cold open한 뒤 `독서 통계 → 진단` JSON을 비교한다.

기대값:

- `foliate-reader-font-load`: 기존처럼 거의 0ms
- `foliate-reader-font-frame`: 기존 약 9.85초에서 일반 frame 수준으로 감소
- `foliate-reader-font-expand` / `foliate-content-range-rect`: 기존과 비슷한 수 ms 수준
- `foliate-initial-navigation` / `reader-open-total`: 10초 지연이 제거되어 크게 감소

마지막 짧은 section뿐 아니라 동일한 긴 section에서도 반복해서 빠르게 열리는지 확인한다.
