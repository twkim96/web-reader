# Web Reader 1.8.19 — iPad EPUB 챕터 경계 탭 이동 최적화

작성일: 2026-08-19

이전 버전: [update_1.8.18.md](./update_1.8.18.md)

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: 코드 수정·전체 `npm run check`·집중 Chromium/WebKit 회귀 완료, iPad 실기기 재검증 대기

## 배경

iPad에서 TXT를 Web Reader의 EPUB 변환기로 만든 일부 도서를 페이지 탭으로 읽을 때 챕터 마지막 페이지에서 다음 챕터로 넘어가는 데 약 10초가 걸렸다. 같은 목표 챕터를 메뉴바 목차에서 직접 선택하면 즉시 이동했다.

## 원인

- paginated Foliate view는 실제 본문 앞뒤에 한 페이지씩 blank sentinel을 둔다.
- 기존 `next()` / `prev()`는 실제 본문 경계에서도 먼저 이 sentinel로 스크롤한 뒤 인접 spine section을 열었다.
- sentinel 이동은 outgoing section에서 `#afterScroll()`을 발생시키고 `getVisibleRange()`가 TreeWalker와 `Range.getBoundingClientRect()` / `getClientRects()`를 사용해 visible range와 CFI를 다시 계산한다.
- TXT→EPUB 변환 결과처럼 한 section에 긴 reflowable 텍스트가 들어 있으면 이 geometry scan이 iPad WebKit에서 매우 비싸질 수 있다.
- 다음 section을 staging하는 동안 outgoing view의 ResizeObserver가 늦게 반응하면 같은 outgoing range scan이 한 번 더 발생할 수 있었다.
- 목차 이동은 trailing sentinel을 거치지 않고 목표 section을 직접 열기 때문에 같은 지연이 나타나지 않았다.

## 수정

- paginated mode의 discrete `next()` / `prev()`가 실제 본문 경계에 있고 인접 section이 존재하면 blank sentinel을 거치지 않고 바로 다음/이전 section으로 이동한다.
- section 내부 page turn은 기존 동작을 유지한다.
- swipe/snap용 sentinel 계약은 유지한다. 이번 최적화는 discrete page-turn 경로에만 적용한다.
- 새 section이 staging되는 동안 outgoing active view의 ResizeObserver `onExpand`가 기존 section을 다시 anchor하지 않도록 한다. 성공 시 곧 폐기될 document에 대해 불필요한 visible-range/CFI scan을 하지 않는다.
- 이전 section으로 이동할 때는 기존 `SECTION_END` 안정화 경로를 그대로 사용해 마지막 실제 본문 페이지에 정확히 도착한다.
- section load가 실패한 경우 lock/failure recovery 계약은 그대로 유지한다.
- Foliate runtime revision을 `1.8.19.1`, app/service-worker cache version을 `1.8.19`로 올린다.

## 트레이드오프 검토

- 페이지 모드에서 앱은 `swipe-navigation=false`를 사용하므로 탭 이동이 blank sentinel을 반드시 방문해야 하는 기능적 이유가 없다.
- swipe/snap 구현 자체는 수정하지 않아 제스처 기반 sentinel 동작을 보존한다.
- 제거되는 relocate는 사용자가 볼 수 없는 blank sentinel의 중간 relocate뿐이다. 최종 인접 section의 relocate와 진행률 저장은 그대로 발생한다.
- 따라서 현재 Reader 계약 기준으로 사용자 기능 손실 없이 불필요한 outgoing layout 작업만 제거하는 변경이다.

## 자동검증

- `npm run check` 통과: lint, typecheck, 전체 Node 테스트, publisher/service-worker/release 테스트, production build 포함.
- Chromium/WebKit 집중 회귀 8건 통과: boundary fast path, previous-section end, section-load failure recovery, overlapping latest navigation 포함.
- Chromium/WebKit: 큰 TXT형 section 마지막 실제 페이지에서 `next()` 후 outgoing document `Range` 생성 0회 및 transient outgoing relocate 0회 확인.
- Chromium/WebKit: 첫 페이지에서 `prev()` 시 이전 section의 계산된 마지막 실제 페이지와 마지막 문단이 그대로 노출되는지 확인.
- Chromium/WebKit: section load 예외 뒤 page-turn lock 해제와 후속 direct navigation recovery 확인.

## iPad 실기기 재검증

1. 지연이 재현되던 TXT→EPUB 도서를 iPad에서 연다.
2. 페이지 모드로 문제 챕터의 마지막 실제 페이지까지 탭으로 이동한다.
3. 다음 탭에서 다음 챕터가 즉시 열리는지 확인한다.
4. 이전 챕터로 돌아갈 때 마지막 실제 페이지가 정확히 표시되는지 확인한다.
5. 같은 목표 챕터를 목차 이동했을 때와 체감 차이가 거의 없는지 비교한다.
6. 일반 EPUB 한 권에서도 앞/뒤 챕터 경계 탭 이동과 진행률 저장을 확인한다.
