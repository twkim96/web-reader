# Web Reader 1.8.12 — 동기화 안정화·도서 오픈 경합

작성일: 2026-08-14

기준 커밋: `1177d42`

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

이전 버전: [update_1.8.11.md](./update_1.8.11.md)

상태: 두 외부 리뷰의 P0/P1 안정화와 후속 도서정보 clipboard·탭→스크롤 폭 수정 구현·full gate 완료. 1.8.12 전체 외부 재리뷰에서 추가 P1/P2 동기화 invariant finding이 확인되어 [update_1.8.13.md](./update_1.8.13.md)로 후속 이관

## 목표

1.8.11까지 유지해 온 outbox, event receipt, target revision, Firestore transaction, tombstone, lease/owner fencing 구조는 보존한다. 1.8.12에서는 전송 엔진을 단순 CRUD나 짧은 주기 전체 polling으로 교체하지 않고 다음 두 결함군을 한 안정화 버전에서 해결한다.

1. 전체 동기화 리뷰: 책갈피 수신 상태 소유권, bookmark CRUD/CFI 결합, pending event 누적, healthy-but-stale listener 복구
2. 도서 오픈 경합 리뷰: ordinary remote resume의 navigate-first rollback 경합과 초기 reader CSS/font pagination 재계산 경합

## 리뷰 판정

### 첫 번째 리뷰

리뷰 기준 커밋은 `51cbc36f5748fea5026ef2b458c12750e37fbea5`였다. 개발 기준 HEAD `1177d42`에서도 다음 핵심 finding이 그대로 유효했다.

- progress listener가 bookmark domain을 포함한 `remoteProgress` 전체 객체를 다시 만들 수 있었다.
- bookmark listener 결과는 `progress-v5` canonical 상태가 아니라 임시 React 상태에만 반영됐다.
- `bookmark 수신 → progress snapshot`에서 bookmark가 사라지거나, `delete 수신 → progress snapshot`에서 삭제 bookmark가 부활할 수 있었다.
- bookmark delete가 현재 reader CFI 존재 여부에 종속됐다.

### 두 번째 리뷰

리뷰 기준 커밋은 `a3549ded5dee86e1e9cc86faff1a3ec0104e5ad3`였다. 현재 개발선에서 다시 대조한 결과 다음 경로도 실제로 남아 있었다.

- ordinary remote resume가 `navigate → canonical adopt → 실패 시 rollback` 순서였다.
- local progress target에 pending/in-flight/conflict가 있으면 adopt는 실패하지만 viewport는 이미 remote 위치로 이동한 뒤였다.
- 초기 jump 실패는 같은 remote head를 처리 완료로 남기지 않아 layout/current CFI 변화가 같은 시도를 다시 깨울 수 있었다.
- paginator는 staging section에 빈 style node만 만든 채 최초 `expand()`한 뒤 실제 reader CSS를 주입했다.
- RIDIBatang은 URL CSS로 먼저 열고 비동기 data URL CSS로 교체했으며 `isLoaded` 후 동일 style/layout도 다시 적용했다.
- 저장된 `anchorCfi`는 비교용 collapsed anchor인데 reader 진입에는 range `cfi`보다 우선 사용되고 있었다.

기존 revision conflict resolver와 단일 승자 정책은 유지한다. 두 번째 리뷰의 결함은 그 resolver보다 앞선 ordinary resume/bootstrap 단계의 문제로 판단했다.

## 유지하는 구조

- IndexedDB canonical progress + outbox 원자 저장
- event ID와 immutable receipt 기반 idempotency
- target별 revision과 Firestore transaction
- tombstone 삭제
- owner/runtime fencing과 lease epoch
- annotation의 canonical IndexedDB hydration 방식
- actual revision conflict의 기존 resolver와 staged command/finalize 계약

3초 전체 CRUD polling으로 교체하지 않는다. listener와 reconciliation은 변경 발견·복구 수단이며 정확성은 canonical local DB, revision, outbox, transaction이 보장한다.

## Phase A — progress/bookmark 수신 도메인 분리

상태: 구현·검증 완료

- 진행도 listener patch 타입을 `RemotePositionUpdate = Omit<RemoteProgressUpdate, 'bookmarks'>`로 제한했다.
- `mergeRemotePositionUpdates()`는 과거 remote entry에 bookmark 필드가 남아 있어도 progress snapshot 적용 시 제거한다.
- progress snapshot은 bookmark domain을 수정하거나 되살릴 수 없다.
- `useReaderBookmarks`는 `remoteProgress.bookmarks`를 별도 원본으로 소비하지 않고 상위 canonical `progress` 변경을 따른다.

완료 조건:

- `bookmark 수신 → progress snapshot`에서 bookmark가 사라지지 않는다.
- `bookmark delete → progress snapshot`에서 bookmark가 부활하지 않는다.
- 위치 snapshot의 객체 identity 변화가 bookmark 수신을 위치 재처리 trigger로 만들지 않는다.

## Phase B — 원격 bookmark canonical hydration

상태: 구현·검증 완료

신규 `src/lib/bookmarkSyncLocal.ts`의 `hydrateRemoteBookmarkHeadsV5()`가 annotation hydration과 같은 소유권 원칙을 사용한다.

하나의 IndexedDB transaction에서 다음 store를 함께 다룬다.

- `progress-v5`
- `outbox-v5`
- `sync-conflicts-v5`
- `remote-heads-v5`
- `sync-meta-v5`

규칙:

1. remote head와 known revision은 기록한다.
2. 같은 target에 pending/in-flight/blocked/conflict/paused event 또는 open/deferred conflict가 있으면 canonical bookmark 적용을 보류한다.
3. 안전한 upsert/delete만 `progress-v5.bookmarks`의 manual 항목에 반영한다.
4. auto bookmark는 로컬 전용으로 보존한다.
5. transaction 성공 뒤 React `progress`, `progressRef`, commit baseline을 같은 canonical 결과로 재기준화한다.

## Phase C — bookmark CRUD와 읽기 위치 저장 분리

상태: 구현·검증 완료

`useProgressActions`에 `saveBookmarks(bookId, bookmarks)`를 추가했다.

- bookmark-only mutation은 현재 CFI가 비어 있어도 저장한다.
- 기존 읽기 위치, anchor, progress percent, lastRead를 유지한다.
- bookmark event의 `occurredAtClient`는 bookmark 조작 시각을 사용한다.
- canonical progress와 bookmark outbox event는 기존 `enqueueProgressMutationBatchV5` transaction으로 함께 commit한다.
- add/delete는 reading-position save gate에 종속되지 않는다.

## Phase D — pending bookmark event coalescing

상태: 구현·검증 완료

같은 bookmark target, 같은 session, `pending`, 아직 claim되지 않은 이벤트는 마지막 사용자 의도로 합친다.

- `upsert → upsert`: 마지막 upsert
- `upsert → delete`: delete
- `delete → upsert`: upsert

기존 event ID, sequence, base revision은 유지하고 payload/operation/occurredAtClient만 최신화한다. 이미 claim된 이벤트, 다른 session, conflict가 열린 target은 합치지 않는다.

## Phase E — ordinary remote resume를 canonical adoption-first로 전환

상태: 구현·targeted 검증 완료

두 번째 리뷰의 가장 중요한 수정이다.

기존:

```text
remote B 감지
→ viewport B 이동
→ IndexedDB canonical adopt 시도
→ local target work 때문에 실패
→ viewport A rollback
```

변경:

```text
remote B 감지
→ IndexedDB adoption transaction
→ adopted인 경우에만 viewport B 이동
→ blocked/stale/cancelled면 viewport를 전혀 움직이지 않음
```

구현 계약:

- `adoptRemoteProgressLocallyV5()`는 boolean 대신 `adopted / blocked-by-local-work / stale-remote / cancelled` 결과를 사용한다.
- outbox 상태와 open/deferred conflict, cached remote head identity, canonical progress 저장을 한 transaction 경계에서 판정한다.
- `useProgressActions.adoptRemoteProgress()`는 별도 precheck를 제거해 TOCTOU 경계를 없앴다.
- 신규 `executeCanonicalRemoteProgressNavigation()`은 adoption을 먼저 끝내고 성공한 경우에만 `prepare → navigate → finish`를 실행한다.
- ordinary quiet resume와 일반 prompt의 `원격 사용` 경로가 이 계약을 사용한다.
- actual revision conflict의 staged command/finalize 경로는 기존 resolver를 유지한다.
- remote identity는 가능한 경우 `syncRevision + acceptedEventId`를 사용한다. layout CFI나 server time 변화만으로 같은 authoritative head를 재시도하지 않는다.
- ordinary resume가 blocked/stale이면 같은 identity를 current CFI·progress·layout 변화만으로 반복 시도하지 않고 outbox worker/conflict resolver 또는 새 remote identity를 기다린다.
- adoption이 성공한 뒤 navigation이 사용자 입력으로 supersede돼도 canonical progress를 과거 A로 rollback하지 않는다.

이 변경으로 초기 pending outbox가 있는 상태의 `B → A → B → A` 반복 경로를 제거한다.

## Phase F — reader 초기 presentation 직렬화

상태: 구현·Chromium/WebKit targeted E2E 완료

초기 page geometry가 실제 reader CSS/font 기준으로 한 번에 수렴하도록 변경했다.

- RIDIBatang CSS는 URL CSS로 먼저 렌더한 뒤 data URL CSS로 교체하지 않는다. module-level promise로 최종 embedded CSS를 준비한다.
- EPUB `beforeInit`은 async로 최종 font CSS 적용을 기다린다. `view.init(initialCfi)`보다 먼저 완료된다.
- paginator staging document는 style node를 만든 즉시 현재 `#styles`를 주입하고 그 뒤 최초 `render/expand`를 수행한다.
- RIDIBatang 선택 시 staging view가 아직 숨겨진 상태에서 `document.fonts.load()`와 한 frame을 기다린 뒤 expand하고 화면에 붙인다.
- `#writeStyles()`는 동일 CSS면 DOM을 다시 변경하지 않는다. `setStyles()`도 실제 변경이 없으면 font-ready expand를 추가로 예약하지 않는다.
- `setLayout()`은 동일 attribute 값이면 `setAttribute`를 다시 호출하지 않는다.
- `useReaderBookSource`는 초기 style/layout key를 기록해 `isLoaded` 직후 같은 설정을 다시 적용하지 않는다. 실제 사용자 설정이 바뀐 경우에만 재적용한다.
- reader 진입과 remote navigation은 measurable range `cfi`를 우선하고 collapsed `anchorCfi`는 동일 위치 비교용으로 유지한다.

기존 1.8.11의 이전 장 끝 `pages - 2` 계산 및 section-end pagination wait는 유지한다.

## Phase G — foreground·online·book-open listener reconciliation

상태: 구현·targeted 검증 완료

`SnapshotListenerRecovery`에 다음 계약을 추가했다.

- 마지막 authoritative server snapshot 시각 기록
- `getLastAuthoritativeSnapshotAt()`
- failed 여부와 무관하게 현재 subscription을 교체할 수 있는 `forceRestart()`

수명주기 정책:

- `offline → online`: progress와 active-book bookmark listener를 즉시 강제 재구독한다.
- `hidden → visible`: 마지막 authoritative snapshot이 15초 이상 오래됐으면 강제 재구독하고, 실패 상태면 기존 retry를 즉시 실행한다.
- Firebase token refresh: 동일 stale 기준을 적용한다.
- book open: 새 bookmark listener는 원래부터 새로 열리므로, 장수하는 account-wide progress listener만 stale 기준으로 reconciliation한다.

foreground에서 10~15초마다 collection 전체를 읽는 watchdog polling은 추가하지 않았다. lifecycle signal이 없는데 정상 listener가 살아 있는 경우 Firestore realtime을 유지한다.

## Phase H — conflict 가시성·진단

상태: 후속 검토

첫 번째 리뷰의 장기 P1이다. 이번 P0 정확성의 전제조건은 아니므로 실기기 결과 전까지 보류한다.

- 동일 delete/delete, 동일 payload upsert/upsert 등 자동 해소 가능한 경우를 추가 분류할 수 있다.
- 실제 사용자 선택이 필요한 동일 bookmark ID 상이 수정, delete/update 충돌만 더 직접적으로 제시할 수 있다.
- 필요하면 oldest outbox age, pending count, last ack, last authoritative apply를 진단에 추가한다.
- bookmark/note 본문은 로그에 남기지 않는다.

## Phase I — 도서정보 이미지 공유·탭→스크롤 전환 폭 안정화

상태: 구현·targeted 검증 완료

1.8.12 전체 리뷰 전에 실사용에서 확인된 두 항목을 같은 릴리스에 추가한다.

### 도서정보 이미지 클립보드 저장

- 도서정보 하단의 이미지 다운로드 버튼 왼쪽에 클립보드 아이콘 버튼을 추가했다.
- 기존 독서 인증 PNG 생성 경로를 `createReadingProofBlob()`으로 공용화해 다운로드와 클립보드 저장이 같은 이미지를 사용한다.
- `ClipboardItem({ 'image/png': blobPromise })`을 사용자 클릭 직후 `navigator.clipboard.write()`에 전달해 transient user activation 제약이 있는 브라우저에서도 가능한 한 이미지 쓰기 권한을 유지한다.
- 이미지 clipboard API가 없는 브라우저는 기능 미지원 안내를 표시하고 다운로드 버튼은 그대로 사용할 수 있다.
- 서재 도서정보와 reader 내부 도서정보가 같은 `BookInfoModal`을 사용하므로 양쪽 모두 동일하게 제공한다.

### 탭 모드 → 스크롤 모드 전환 시 가로 overflow 제거

- paginated horizontal mode에서 Foliate overlayer는 페이지 전체 너비만큼 확장된다.
- 기존 scrolled 전환은 iframe/view wrapper의 inactive dimension은 100%로 되돌렸지만 overlayer의 이전 width를 초기화하지 않아 `overflow:auto` container에 좌우 scroll 영역이 남을 수 있었다.
- `View.expand()`의 paginated/scrolled 양쪽에서 overlayer의 비활성 축을 항상 `100%`로 재설정한다.
- 기존 active scroll axis 전환 시 `scrollLeft/scrollTop` 초기화 계약은 유지한다.
- Foliate runtime revision을 `1.8.12.2`로 올려 이미 1.8.12를 받은 PWA도 수정된 paginator를 새 URL로 로드하도록 한다.

## 리뷰 제안 중 이번 1.8.12에서 미반영·보류한 항목

아래 항목은 누락이 아니라 현재 P0/P1 안정화에 필수적이지 않거나 migration/UX 범위가 커서 의도적으로 남긴 것이다. 전체 1.8.12 재리뷰와 실기기 결과에서 필요성이 확인되면 후속 버전 또는 1.8.12 hotfix 후보로 사용한다.

- `InitialReaderDecision` 형태로 reader를 열기 전에 local/remote/outbox 승자를 모두 정하고 remote head를 bounded wait하는 **pre-open 단일 초기 위치 결정 구조**는 도입하지 않았다. 현재는 local work가 없을 때 local A가 먼저 표시된 뒤 canonical remote B로 한 번 이동할 수 있다.
- `ProgressPosition`을 `resumeCfi`와 `anchorCfi`로 새 schema까지 분리하는 migration은 하지 않았다. 이번 버전은 기존 `cfi`를 navigation에 우선하고 `anchorCfi`를 비교 기준으로 사용하는 수준이다.
- layout attribute 여러 개를 하나의 vendor `applyLayout()` 호출로 묶어 render를 정확히 한 번만 실행하는 구조 개편은 하지 않았다. 동일 값 no-op과 초기 presentation guard로 불필요한 재적용만 차단했다.
- `ReaderBootstrapTrace`의 `remote-decision`, `font-ready`, `paginator-expand`, viewport/page geometry 전체 진단 스키마는 추가하지 않았다. 실기기에서 잔여 진동이 재현되면 우선순위 높은 진단 hotfix 후보다.
- `100vh`/`100dvh`를 `visualViewport.height` 기반 고정 CSS 변수와 안정화 debounce로 교체하는 모바일 viewport 시스템은 넣지 않았다. iPad/Android에서 browser chrome resize가 실제 잔여 trigger로 확인될 때 적용한다.
- 앱이 직접 제공하는 RIDIBatang 외에 Google Noto Serif `@import` 및 출판물의 모든 원격 font를 initial open에서 기다리지 않는다. 무한/장시간 font wait를 피하기 위한 의도적 제한이다.
- Firebase Emulator + 두 browser context로 `A 기기 pending progress + B 기기 최신 remote + A book open` 전체 시나리오를 자동 E2E fixture로 만들지는 않았다. adoption ordering unit test, Chromium/WebKit paginator E2E, production browser regression과 실제 두 기기 검증으로 우선 커버한다.
- conflict UI/진단의 추가 세분화(동일 delete/delete 자동 해소, oldest outbox age, last ack 등)는 Phase H 후속 검토로 남긴다.
- 별도 `bookmarks-v14` store와 `UserProgress`/`BookmarkCollection` 완전 분리는 migration 위험 때문에 이번 릴리스에서 하지 않는다.
- 선택적 Live Follow leader/follower 모드는 기본 resume 동기화와 별도 기능으로 남긴다.

## 추가된 회귀검증

### bookmark/canonical sync

- 원격 bookmark upsert가 `progress-v5`에 저장되고 local auto bookmark를 보존한다.
- 원격 bookmark tombstone이 canonical manual bookmark를 제거한다.
- 같은 target에 pending local bookmark 작업이 있으면 remote canonical overwrite를 보류한다.
- bookmark-only mutation이 `cfi == ''` 상태에서도 local DB와 outbox에 commit된다.
- progress snapshot이 bookmark를 덮거나 부활시키지 않는다.
- same-session pending bookmark event coalescing

### remote open race

- canonical remote navigation에서 `adopt`가 `prepare/navigate`보다 먼저 실행된다.
- pending local progress가 있으면 `prepare/navigate/rollback`이 한 번도 호출되지 않는다.
- stale remote identity도 viewport를 움직이지 않는다.
- navigation이 supersede돼도 canonical state를 과거 위치로 rollback하지 않는다.
- 같은 `revision + acceptedEventId`는 CFI/time 변화에도 같은 identity로 취급한다.

### presentation/listener

- Chromium·WebKit에서 staging document에 36px reader style이 최초 navigation 완료 시점부터 적용돼 있다.
- 초기 goTo 완료 뒤 ResizeObserver relocate가 더 발생하더라도 page/pages가 `N ↔ N+1`로 왕복하지 않는다.
- authoritative snapshot 시각을 기록하고 healthy listener도 `forceRestart()`할 수 있다.
- stale callback generation은 기존처럼 무시된다.
- release cache는 1.8.12, Foliate runtime revision은 `1.8.12.2`이며 1.8.11 Foliate runtime entry는 stale cache 정리 대상이다.
- 도서정보 PNG를 다운로드와 image clipboard write 양쪽에서 동일 capture blob으로 생성한다.
- paginated → scrolled 전환 시 overlayer width가 `100%`로 복귀하고 Chromium·WebKit에서 horizontal content overflow가 남지 않는다.

## 현재 자동검증

현재 작업 트리 기준:

- `npm run typecheck` 통과
- `npm run lint` — 오류 0, 기존 `public/foliate-js` 경고 2개만 남음
- targeted sync/open/listener tests 65개 통과
- `npm run test:storage` — 286개 전부 통과
- `npm run test:shelf` — 79개 전부 통과
- 신규 initial pagination/flow-switch Playwright — Chromium·WebKit targeted 통과
- `npm run test:release` 통과
- `npm run check:full` 통과
  - storage 286개 통과
  - shelf 79개 통과
  - Firestore Rules 29개 통과
  - Playwright Chromium·WebKit E2E 20개 통과
  - production browser regression 통과 — 도서정보 image clipboard PNG 및 탭→스크롤 horizontal overflow 포함
  - production build 통과
- `git diff --check` 통과

## 실기기 확인 계획

동기화:

- iPad에서 bookmark 생성 후 페이지를 연속 이동해도 Android에서 bookmark가 유지되는지 확인한다.
- bookmark 삭제 후 페이지를 계속 이동해도 반대 기기에서 삭제 항목이 부활하지 않는지 확인한다.
- 반대 방향 Android → iPad도 동일하게 확인한다.
- bookmark 수신 후 reload하고 네트워크를 끊어도 IndexedDB에서 복원되는지 확인한다.
- 서로 다른 bookmark를 양 기기에서 동시에 추가하면 양쪽 결과가 합쳐지는지 확인한다.
- 같은 bookmark update/delete conflict가 숨겨지지 않는지 확인한다.

도서 오픈 경합:

- 기기 A에 미전송 progress event가 있고 서버에는 더 최신 B가 있는 상태에서 A가 책을 열어도 viewport가 `A ↔ B`로 반복하지 않는지 확인한다.
- 같은 조건에서 사용자가 페이지를 넘기지 않아도 화면이 스스로 수렴하는지 확인한다.
- local work가 없는 최신 remote resume는 remote 위치로 한 번만 이동하는지 확인한다.
- iPad Safari·Android Chrome·설치형 PWA에서 RIDIBatang 책을 페이지 경계 CFI로 열었을 때 font load 전후 페이지가 앞뒤로 왕복하지 않는지 확인한다.
- `offline → online`, 장시간 background → foreground 후 최신 progress/bookmark가 재수신되는지 확인한다.

추가 UI/layout:

- 서재와 reader의 도서정보에서 클립보드 버튼이 다운로드 버튼 왼쪽에 표시되고 PNG가 이미지 형태로 붙여넣기 가능한지 확인한다.
- 이미지 clipboard 미지원 환경에서는 안내 후 다운로드 기능이 그대로 동작하는지 확인한다.
- iPad Safari·Android Chrome에서 탭 모드로 여러 페이지 이동한 뒤 스크롤 모드로 바꿔도 화면 폭이 viewport보다 넓어지거나 좌우 스크롤이 생기지 않는지 확인한다.
- 하이라이트 overlayer가 존재하는 책에서도 탭↔스크롤 반복 전환 후 annotation 위치와 세로 스크롤이 정상인지 확인한다.
