# Web Reader 1.8.1 로컬 범위 하이라이트

작성일: 2026-07-30

기준 커밋: `3faf93e`

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: 개발·Web GPT 3차 리뷰·자동검증 완료. 2026-08-01 빠른 연속 탭 안정화 패치·자동검증 반영, 실기기 재검증 대기. 진행률 충돌 알림 후속 안정화는 `update_1.8.1-hotfix.1.md`와 `update_1.8.1-hotfix.2.md`에서 별도 관리

## 목표

1.8.0의 reflow EPUB/TXT 텍스트 선택을 5색 범위 하이라이트로 저장·복원한다. 하이라이트는 기존 수동·자동 책갈피와 진행률 문서에 포함하지 않고, owner와 book으로 분리된 로컬 annotation 도메인으로 관리한다.

## 리뷰 판정

| 항목 | 판정 | 1.8.1 처리 |
| --- | --- | --- |
| 선택 범위의 CFI·원문·앞뒤 문맥 저장 | 수용 | CFI를 1차 anchor로 사용하고 quote/context가 불일치하면 그리지 않음 |
| 5색 하이라이트 생성·변경·삭제 | 수용 | 안정적인 color ID와 고정 기본 팔레트 사용 |
| 색상당 20개·책당 100개 제한 | 수용 | 한도 도달 시 기존 항목을 지우지 않고 새 저장만 차단 |
| 정확히 같은 범위의 재선택 | 수용 | 중복 생성하지 않고 기존 하이라이트 색상 변경 |
| 부분 중첩·포함 범위 | 수용 | 자동 병합하지 않고 별도 annotation으로 유지 |
| 마지막 생성·변경·삭제 실행 취소 | 수용 | 로컬 저장과 overlay를 함께 원복 |
| 기존 Bookmark 확장 | 제외 | progress/bookmark schema·Firestore payload 비변경 |
| 메모·목록·검색·정렬·팔레트 의미 편집 | 제외 | 1.8.2 범위 |
| 기기 간 동기화·outbox·Rules | 제외 | 1.8.3 범위 |

## 저장 계약

- IndexedDB schema version을 8로 올리고 `annotations-v8` store를 추가한다.
- key는 `[ownerKey, bookId, id]`이며 owner, owner+book, owner+book+color, owner+book+range index를 둔다.
- annotation은 `id`, `bookId`, `type`, `sectionIndex`, `rangeCfi`, `quote`, `prefix`, `suffix`, `colorId`, 빈 `note`, `progressPercent`, `chapter`, client timestamps, `anchorState`를 보존한다.
- `rangeCfi`가 복원돼도 normalized quote·prefix·suffix가 다르면 overlay를 그리지 않고 `anchorState: unresolved`로 저장한다.
- 생성·색상 변경·삭제와 제한 판정은 annotation store의 readwrite transaction 안에서 처리한다.
- 앱 update 승인 시 annotation write가 끝날 때까지 기다리도록 모든 local mutation을 local commit tracker에 등록한다.
- 서가에서 책을 완전히 삭제하면 현재 owner의 해당 책 annotation도 제거한다. 오프라인 캐시 관리에서 원본 캐시만 지울 때는 annotation을 보존한다.
- 기존 progress, manual bookmark, auto bookmark store와 저장 호출은 변경하지 않는다.

## UI 계약

- 텍스트 선택 메뉴 첫 줄에 44px 이상의 5색 버튼을 표시한다.
- 색상 버튼은 색상만 보여주지 않고 접근 가능한 한국어 이름을 제공한다.
- 하이라이트를 탭하면 같은 위치에 색상 변경·삭제 메뉴를 연다. 이 탭은 페이지 이동이나 controls toggle을 실행하지 않는다.
- 성공·제한·실패 상태를 짧은 메시지로 표시하고, 마지막 mutation은 제한된 시간 동안 실행 취소할 수 있다.
- fixed-layout PDF·archive에는 하이라이트 action과 overlay를 표시하지 않는다.

## Phase 1 — schema·repository·anchor policy

상태: 완료

- annotation type, 팔레트, 길이·개수 validation을 정의한다.
- IndexedDB v8 migration과 owner/book 격리 repository를 구현한다.
- exact-range 중복, 부분 중첩, quote/context 검증 정책을 테스트한다.

완료 조건: v7 데이터가 보존된 채 v8 store가 생성되고, 원자적 CRUD·제한·owner 격리 테스트가 통과함.

## Phase 2 — selection·Foliate overlay 연결

상태: 완료

- selection snapshot에 section index, cloned Range, prefix, suffix를 포함한다.
- Foliate range CFI 생성과 `addAnnotation`/`deleteAnnotation` adapter를 연결한다.
- `draw-annotation`, `show-annotation`, `create-overlay` lifecycle에서 검증·복원·탭 선택을 처리한다.
- style/layout/section 교체 뒤 현재 overlay를 다시 그린다.

완료 조건: 재진입과 레이아웃 변경 뒤 검증된 범위만 같은 위치에 다시 표시됨.

## Phase 3 — 5색 UI·삭제·실행 취소

상태: 완료

- 선택 메뉴에 5색 생성 action을 추가한다.
- 기존 하이라이트 탭 메뉴에서 색상 변경과 삭제를 제공한다.
- 마지막 mutation의 실행 취소를 로컬 저장과 화면에 함께 적용한다.
- 색상당 20개와 책당 100개 제한 메시지를 제공한다.

완료 조건: 생성·변경·삭제·undo와 exact duplicate recolor가 기존 탭 탐색을 깨지 않고 동작함.

## Phase 4 — 회귀·독립 리뷰

상태: 완료

- schema migration, repository, anchor policy Node 테스트를 실행한다.
- Chromium/WebKit에서 생성·복원·색상 변경·삭제·tap suppression을 검증한다.
- production Chrome regression에서 IndexedDB 재진입 복원과 기존 책갈피·fixed-layout 회귀를 확인한다.
- `npm run check:full`과 `git diff --check`를 통과시킨다.
- `3faf93e..HEAD`와 uncommitted 1.8.1 diff를 독립 리뷰하고 사용자에게 Web GPT 리뷰 packet을 전달한다.

완료 조건: 제품 코드 기준 중요 finding과 자동검증 실패가 없고 실기기 항목만 명시적으로 남음.

## 자동검증 계획

- 변경 파일 ESLint와 typecheck
- annotation policy·IndexedDB migration·CRUD·limit 단위 테스트
- selection·navigation 기존 회귀 테스트
- Playwright Chromium/WebKit overlay lifecycle E2E
- production Chrome 저장·재진입·편집 회귀
- `npm run check:full`
- `git diff --check`

## 실기기 테스트 계획

- iPad Safari browser tab과 home-screen PWA
- page·left-right·all-dir·scroll에서 5색 생성
- 단어·문장·여러 문단·같은 section 페이지 경계 범위
- exact duplicate, 부분 중첩, 포함 범위
- 색상 변경·삭제·실행 취소
- offline 생성·재실행·PWA update 전후 복원
- 폰트·줄 간격·여백·테마·탐색 모드 변경 뒤 위치
- 색상당 20개와 책당 100개 제한
- 기존 manual/auto bookmark가 있는 도서

## 구현 결과

- 버전을 `1.8.1`로 올리고 app shell·Foliate runtime cache도 같은 release version으로 맞췄다.
- IndexedDB v8에 owner·book·color·exact-range index를 갖는 `annotations-v8` store를 추가했다. v6/v7 progress와 manual/auto bookmark는 migration에서 그대로 보존된다.
- 5색 stable color ID, 입력 길이, 색상당 20개, 책당 100개 validation과 원자적 CRUD를 구현했다.
- 선택 snapshot에 cloned `Range`, `sectionIndex`, quote 앞뒤 문맥을 추가하고 Foliate CFI와 연결했다.
- Foliate overlay 생성·삭제·탭 lifecycle을 연결했다. 하이라이트 탭은 기존 페이지 이동·controls toggle보다 우선 처리된다.
- quote·prefix·suffix가 맞는 CFI만 그린다. 불일치는 `unresolved`로 남기고, 사용자가 같은 범위를 다시 선택하면 현재 위치 증거로 복구할 수 있다.
- overlay 재생성 시 해당 `sectionIndex`의 annotation만 다시 그려 큰 책에서 불필요한 전체 반복을 피한다.
- CFI가 저장 당시와 다른 section으로 해석되면 실제 resolved index를 메모리와 field-only IndexedDB transaction에 반영한다. quote/context 검증 성공 전에는 임의로 `active` 전환하지 않는다.
- 생성·색상 변경·삭제와 6초 실행 취소를 구현했다. 변경·undo timestamp는 이전 mutation보다 단조 증가한다.
- selection·highlight 메뉴와 undo 버튼의 touch target을 44px 이상으로 유지하고 visual viewport 안에서 배치한다.
- 선택 중 publication document의 `contextmenu` default를 취소하고 WebKit touch callout을 억제해 브라우저 native 선택 툴바와 자체 메뉴의 중복을 줄인다. 링크 callout은 유지한다.
- fixed-layout PDF·archive에서는 저장소 load, action, overlay를 모두 비활성화한다.
- 서가의 완전한 책 삭제는 원본·metadata·inspection과 현재 owner/book annotation을 하나의 tracked IndexedDB transaction에서 정리한다. 오프라인 캐시 관리 삭제는 annotation을 보존한다.
- annotation write와 anchor 상태 write를 Service Worker update 대기 경계에 포함했다.

### 독립 리뷰에서 반영한 보강

- overlay draw 실패 상태를 별도 field-only transaction으로 기록해 동시에 바뀐 색상·메모 후보 필드를 덮어쓰지 않게 했다.
- 초기 복원과 section overlay 생성 경로를 분리해 section 수와 annotation 수의 곱만큼 반복 그리지 않게 했다.
- 같은 CFI·같은 색 재선택도 quote/context가 바뀌었거나 `unresolved`이면 no-op 처리하지 않고 anchor를 복구하게 했다.
- 책 완전 삭제와 단순 오프라인 캐시 삭제의 annotation 보존 정책을 분리했다.
- fixed-layout reader에서 annotation repository 자체가 열리지 않게 했다.
- 1.8.0 Android 실기기에서 확인된 native 선택 툴바 중첩에 대해, 선택 중에만 DOM context menu를 취소하고 일반 context menu는 유지하는 best-effort 억제를 추가했다.
- 링크 텍스트 위 하이라이트 hit-test를 capture 단계에서 먼저 처리하고 `stopImmediatePropagation()`하여 하이라이트 메뉴와 링크 이동이 동시에 실행되지 않게 했다.
- annotation section resolution은 색상·note·quote·timestamp를 보존하는 전용 field-only transaction으로 교정한다.
- 완전한 책 삭제를 단일 transaction으로 합치고 중간 예외에서 명시적으로 abort해 annotation만 먼저 사라지는 부분 삭제를 막았다.
- IndexedDB mutation 성공 후 React 상태·undo·feedback을 먼저 확정하고 overlay add/delete는 best-effort로 분리했다. 일시적인 overlay 실패를 저장 실패로 표시하거나 mutation lock을 붙잡지 않는다.
- 완전한 책 삭제는 시작 시 캡처한 `OwnerSnapshot`을 Drive 삭제, progress reset, annotation·원문 삭제, 최종 shelf UI 갱신까지 그대로 전달한다. 단계 사이에 owner generation이 바뀌면 새 owner의 progress·UI와 기기 공용 원문 삭제를 중단한다.
- annotation schema는 내용이 있는 완전한 `epubcfi(...)` wrapper만 허용한다. Foliate의 CFI 해석·Range 생성이 실패하거나 유효 section으로 해석되지 않으면 해당 항목만 field-only update로 `unresolved` 처리한다.
- Foliate 링크 하이라이트 E2E는 하이라이트 탭 직후 overlay 1개와 일반 링크 이동 후 section overlay 2개를 각각 기다리고 검증한다.
- paginated 탭 모드(`page`, `left-right`, `all-dir`)는 Foliate의 swipe pagination을 끄고 viewport overscroll도 억제한다. touch event의 기본 동작은 취소하지 않아 길게 누르기와 선택 손잡이는 유지한다. `scroll` 모드의 세로 스크롤은 그대로 둔다.

## 자동검증 결과

- `npm run check:full`: 통과
- ESLint: 오류 0, 기존 Foliate vendor 경고 2개
- TypeScript: 통과
- Node 테스트: 전체 통과
  - formats 55/55
- storage 95/95 — schema migration, owner/book 격리, exact duplicate, 부분 중첩 분리, 제한, section field-only update, 책+annotation 원자 삭제·강제 abort rollback, owner 전환 뒤 삭제 baseline 격리 포함
  - 기존 drive·archive·shelf·service worker·release suite 통과
- production build: 통과
- Firestore Rules: 9/9 통과. 1.8.1은 원격 annotation schema나 Rules를 추가하지 않는다.
- Playwright Chromium/WebKit 직렬 실행: 12/12 통과
  - 두 엔진에서 Foliate range annotation draw·tap suppression·delete 확인
  - 링크 텍스트 하이라이트 탭은 `show-annotation`만 발생하고 section을 유지하며, 하이라이트 삭제 후 같은 링크는 정상 이동
  - 탭 모드의 가로 touch drag는 renderer 위치를 바꾸지 않고 기본 text-selection touch 동작도 취소하지 않음
- production Chrome regression: 통과
  - 생성·5색 변경·삭제·undo·exact-range recolor
  - 44px action과 viewport 배치
  - 선택 중 context menu 취소, 선택 해제 후 context menu 허용, WebKit callout style 확인
  - style·flow 변경, 책 재진입 복원
  - 저장 section index 불일치를 실제 CFI resolved index로 교정하면서 color·quote·anchor 상태 보존
  - 유효 spine 내부의 손상된 Range offset CFI만 `unresolved` 처리하고 정상 annotation overlay·`active` 상태 유지
  - 실제 `left-right` reader renderer에 `swipe-navigation=false` 적용
  - quote drift fail-closed와 같은 범위 재선택 복구
  - overlay delete·restore 강제 실패 뒤에도 DB 삭제·undo·성공 feedback 유지
  - 기존 탭 이동·책갈피·fixed-layout·PDF·archive·Service Worker 회귀
- `git diff --check`: 통과

첫 sandbox 실행은 Turbopack 보조 프로세스의 port bind가 허용되지 않아 build에서 중단됐으며, 동일 명령을 정상 로컬 권한으로 재실행해 전체 통과를 확인했다. 제품 코드 실패로 판정하지 않는다.

### 2026-07-31 mobile native toolbar 후속 검증

- 1.8.0 Android 실기기 finding에 따라 `-webkit-touch-callout` 억제와 선택 중 `contextmenu.preventDefault()`를 추가했다.
- 일반 context menu는 선택이 없을 때 취소하지 않으며, 링크에는 WebKit callout 기본값을 복원했다.
- `npm run lint`: 오류 0, 기존 vendor warning 2개
- `npm run typecheck`: 통과
- `npm run test:formats`: 55/55 통과
- browser regression에 선택 중 context menu 취소·선택 해제 후 허용·callout CSS 확인을 추가했고 `node --check`를 통과했다.
- `git diff --check`: 통과
- 이후 Web GPT 1차 P2 3건·P3 1건과 2차 P1 1건·P2 2건 수정까지 포함한 `npm run check:full`을 정상 로컬 권한으로 재실행해 lint, typecheck, Node, build, Rules 9/9, Playwright 12/12, production Chrome까지 모두 통과했다.
- 2차 finding 수정 후 첫 `check:full`은 마지막 production Chrome의 기존 guest auth bootstrap P3에서 selection 단계 전에 `LOADING LIBRARY...` timeout으로 실패했다. 같은 production build의 개별 회귀는 통과했고, 전체 명령 재실행도 끝까지 통과했다. 제품 변경 회귀로 숨기거나 실기기 통과로 간주하지 않는다.

## 실기기 검증 결과

검증 대기.

특히 자동화가 대체하지 못하는 iPad Safari 선택 손잡이, 길게 누르기, 실제 PWA update 전후 IndexedDB 복원은 실기기 결과로만 완료 처리한다.

Android 브라우저의 선택 툴바는 browser-native UI이므로 DOM 자동화 통과만으로 제거를 확정하지 않는다. 2026-07-31 문제가 확인된 동일 휴대폰 브라우저에서 선택 손잡이 유지, native 툴바 중복 여부, 링크 long-press를 다시 확인해야 한다.

### 2026-07-31 사용자 사전 리뷰 — 탭 모드 가로 스크롤

- finding: 탭 이동 모드에서도 손가락 가로 drag로 Foliate page strip이 움직였다.
- 판정: 수용. 탭 모드는 설정 이름과 동작 모두 tap navigation이며 swipe pagination이 공존할 이유가 없다.
- 수정: paginated renderer에 `swipe-navigation=false`를 적용하고 Foliate touch handler는 이동·snap을 하지 않는다. native selection을 위해 `touchmove.preventDefault()`는 추가하지 않는다.
- 자동 회귀: Chromium·WebKit에서 60px 가로 touch drag 후 renderer 시작 위치 불변, touch event default 허용을 확인한다. production reader에서는 `left-right` 모드의 실제 renderer attribute를 확인한다.
- 검증: 최종 `npm run check:full` 통과. 첫 전체 실행과 첫 production 단독 재시도는 기존 guest auth bootstrap P3의 `LOADING LIBRARY...` timeout으로 reader 진입 전에 실패했고, 다음 production 단독 실행과 전체 명령 재실행은 끝까지 통과했다.
- 실기기 확인 대기: 동일 휴대폰에서 좌우 drag 시 본문이 따라 움직이지 않는지, 길게 누르기와 선택 손잡이는 계속 동작하는지 확인한다.

### 2026-08-01 실기기 후속 finding — 빠른 연속 탭의 단어 선택·지연 이동

- finding 1: 탭 이동 영역의 같은 화면 좌표를 페이지 전환 직후 다시 빠르게 누르면, 사용자가 보기에는 서로 다른 페이지의 단일 탭이지만 브라우저가 연속 탭으로 판정해 단어 선택을 만들 수 있었다.
- finding 2: 빠르게 입력한 탭이 합성 `click`으로 늦게 전달되면 사용자가 탭을 멈춘 뒤에도 페이지가 추가로 넘어가는 것처럼 보였다.
- 원인: publication document는 네이티브 긴 누르기 선택을 위해 `user-select: text`를 유지한다. 기존 입력은 네이티브 `selectionchange`와 지연 합성 `click` 뒤에 처리했으므로, 브라우저의 단어 선택이 먼저 확정되면 페이지 탭이 선택으로 오인됐다. Foliate renderer에는 이동 중 호출을 버리는 잠금이 이미 있으며 앱이 별도의 무제한 페이지 이동 큐를 두고 있던 것은 아니다.
- 수정: pointer 시작 시각과 최대 이동 거리를 기록해 280ms 이하·14px 이하의 짧은 탭을 `pointerup`에서 즉시 처리한다. 이 탭 뒤에 생성되는 합성 `click`은 한 번만 소비해 중복 이동과 지연 실행을 막는다.
- 수정: 직전 페이지 이동 탭으로부터 650ms 안, 화면상 96px 안에서 발생한 두 번째 빠른 탭에 브라우저 단어 선택이 생겼다면 그 선택만 제거하고 페이지 탭을 계속 실행한다. 좌표는 Foliate의 넓은 iframe 내부 좌표가 아니라 매 이벤트 시점의 상위 viewport 좌표로 환산한다.
- 보존: 280ms를 넘는 긴 누르기, 14px를 넘는 드래그 선택, 직전 페이지 탭과 무관한 선택, publication link는 즉시 탭 경로에서 제외한다. `touch-action: manipulation`으로 불필요한 더블탭 지연을 줄이되 네이티브 텍스트 선택과 scroll 모드는 유지한다.
- 자동 회귀:
  - tap classifier 단위 테스트는 짧은 탭·긴 누르기·드래그와 동일 영역 연속 탭의 시간·거리 경계를 검증한다.
  - production Chrome에서 첫 탭으로 한 페이지를 이동한 뒤 브라우저 단어 선택을 강제로 만든 상태에서 같은 화면 좌표를 다시 탭한다. 두 번째 페이지 이동이 실행되고 Range와 자체 선택 메뉴가 모두 제거되는 것을 확인한다.
  - `npm run lint`: 오류 0, 기존 Foliate vendor 경고 2개.
  - `npm run typecheck`: 통과.
  - Node 전체 테스트: 통과. formats는 새 2건을 포함해 57/57, storage 95/95, shelf 32/32.
  - production build: 통과.
  - Playwright Chromium/WebKit 직렬 실행: 12/12 통과.
  - production Chrome regression: 통과.
- 검증 환경 메모: 샌드박스 안 `npm run check`의 마지막 Turbopack build는 PostCSS 보조 프로세스 port bind 권한으로 중단됐다. 앞 단계 lint·typecheck·Node 전체는 통과했고, 동일 소스의 production build를 정상 로컬 권한으로 재실행해 통과했다.
- 실기기 재검증 대기:
  - 같은 상단/하단 영역을 빠르게 연속 탭해도 단어 선택이 생기지 않는지 확인한다.
  - 탭을 멈춘 뒤 지연된 페이지 이동이 이어지지 않는지 확인한다.
  - 길게 누르기, 선택 손잡이 드래그, 여러 문단 선택, 링크 탭·긴 누르기가 유지되는지 확인한다.
  - Android Chrome browser/PWA와 iPad Safari browser tab/home-screen PWA에서 각각 확인한다.

## Web GPT 1차 리뷰 결과

- 기준: `3faf93e` 이후 현재 1.8.1 working tree
- 판정: P0 없음, P1 없음, P2 3건, P3 1건
- P2 링크 하이라이트와 링크 이동 동시 실행: 수용. capture hit-test, `stopImmediatePropagation()`, Chromium/WebKit 링크 회귀 추가.
- P2 저장 section index와 CFI resolved index 불일치: 수용. runtime 즉시 교정과 field-only IndexedDB resolution update, production 재진입 회귀 추가.
- P2 책 원본과 annotation의 분리 transaction 삭제: 수용. 단일 tracked transaction과 강제 abort rollback 테스트 추가.
- P3 overlay 실패 뒤 저장 성공을 실패로 표시: 수용. IndexedDB를 source of truth로 두고 overlay를 best-effort로 분리, production 강제 실패 회귀 추가.
- 기각·보류 finding: 없음. 네 건 모두 실제 코드 순서 또는 transaction 경계에서 실패 경로가 성립했다.
- 수정 후 Codex 판정: 제품 코드 중요 finding 없음. Web GPT 재리뷰와 실제 mobile browser/PWA 검증은 아직 남아 있다.

## Web GPT 2차 리뷰 결과

- 기준: `3faf93e` 이후 현재 1.8.1 working tree 전체
- 판정: P0 없음, P1 1건, P2 2건
- P1 링크 E2E 최종 overlay 기대값 오류: 수용. 하이라이트 탭 시점과 실제 section 이동 시점을 분리하고 overlay 생성을 상태 기반으로 기다린다.
- P2 비동기 책 삭제 중 owner 전환 경합: 수용. 하나의 `OwnerSnapshot`과 generation predicate를 전체 삭제 단계에 전달하고 stale continuation은 progress·공용 원문·shelf UI를 수정하지 않는다.
- P2 CFI 해석·Range 복원 실패가 `active`로 잔류: 수용. 최소 wrapper schema와 runtime `unresolved` 전환을 추가하고 section resolution DB write는 catch 경계 밖에 유지한다.
- 기각·보류 finding: 없음. 세 건 모두 실제 테스트 기대값, owner 경계, anchor 상태 전환에서 실패 경로가 성립했다.
- 새 회귀: 지연 Drive 작업 중 owner 전환, 불완전 CFI schema 거부, 유효 spine의 손상 Range offset 복원 실패, 정상 annotation 공존, Chromium·WebKit overlay 생성 시점 분리.
- 수정 후 Codex 판정: 제품 코드 중요 finding 없음. Web GPT 재리뷰와 실제 mobile browser/PWA 검증은 아직 남아 있다.

## Web GPT 3차 리뷰 결과

- 기준: `3faf93e` 이후 현재 1.8.1 working tree 전체
- 판정: P0 없음, P1 없음, P2 없음, P3 제품 코드 1건, P3 검증 인프라 1건
- P3 owner 전환 뒤 삭제된 progress baseline 잔류: 수용. A의 persistence commit 성공 직후 A baseline을 먼저 제거하고, current owner 확인은 B의 React state·`progressRef` 갱신 직전에 별도로 수행한다.
- 회귀: A와 B의 같은 book baseline을 준비한 뒤 A만 삭제해 A baseline은 사라지고 B baseline은 유지되는지 확인한다.
- 검증 인프라 P3: production Chrome의 guest Firebase bootstrap이 selection 진입 전에 간헐적으로 timeout 되는 기존 현상이다. 동일 build 재실행과 최종 `check:full`은 통과했으며 제품 finding으로 보지 않는다. auth bootstrap 분리·진단 확장은 1.8.1 제품 scope에 포함하지 않는다.
- 이전 3차 검토 대상과 사용자 paginated swipe finding은 정상 수정 확인됐다.
- 최종 Codex 판정: 제품 코드 중요 finding 없음. 전체 자동검증 통과. 실제 Android/iPad Safari와 PWA 검증만 남아 있다.

## 보류·후속 버전

- 1.8.2: 메모, 팔레트 의미, 색상별 접이식 목록·검색·정렬
- 1.8.3: annotation 동기화, outbox, revision, receipt, tombstone, conflict
- 1.8.4: 라이브러리 전체 검색과 Markdown/JSON 내보내기
