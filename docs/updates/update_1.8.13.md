# Web Reader 1.8.13 — 동기화 invariant 안정화

작성일: 2026-08-14

기준 커밋: `090664d`

1차 구현 커밋: `bf7a9cb`

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

이전 버전: [update_1.8.12.md](./update_1.8.12.md)

상태: 1.8.12 전체 외부 재리뷰 P1/P2 correctness 후속 구현 후, `bf7a9cb` 1.8.13 재리뷰에서 확인된 P1 3건까지 후속 수정·full gate 완료. 외부 재리뷰·실기기 확인 대기

## 목표

1.8.12에서 도입한 canonical bookmark hydration, adoption-first remote resume, 초기 pagination 직렬화 구조를 유지하면서 외부 전체 재리뷰에서 확인된 남은 동기화 invariant를 닫는다.

이번 버전은 신규 기능 릴리스가 아니라 1.8.12의 동기화 correctness 후속 안정화 버전이다.

## 리뷰 판정

현재 `090664d`에서 다음 finding을 재확인했다.

1. authoritative snapshot을 아직 한 번도 받지 못한 healthy listener는 `lastAuthoritativeAt === 0` 상태에서 lifecycle reconciliation이 실질적으로 no-op이 될 수 있다.
2. canonical adoption은 성공했지만 renderer navigation이 실패한 경우 hook이 `navigated` 결과를 무시하고 같은 remote identity를 처리 완료로 기록한다.
3. `enqueueProgressMutationBatchV5()`가 transaction 밖에서 만든 progress aggregate 전체를 마지막에 put해, 다른 bookmark ID의 remote hydration과 local mutation이 교차하면 lost update가 가능하다.
4. observed remote revision을 active local chain이 남은 상태에서도 `knownRevision`에 즉시 반영해, server apply와 local acknowledge 사이에 새 event의 base revision을 이중 계산할 수 있다.
5. bookmark-only 조작이 position dirty flag를 설정한다.
6. 낮은 revision bookmark head가 remote cache에는 저장되지 않아도 canonical bookmark에는 적용될 수 있다.

### `bf7a9cb` 1.8.13 재리뷰 후속

첫 6개 finding을 구현한 `bf7a9cb`를 다시 검토한 결과 P0는 없었고, React state ↔ IndexedDB ↔ remote listener 경계에서 P1 3건을 추가 확인했다.

1. child bookmark state가 remote prop effect보다 늦게 갱신되면 stale 전체 배열 diff가 unrelated remote bookmark를 delete intent로 만들 수 있다.
2. transaction-current DB canonical은 `[X, Y]`로 맞아도 commit 시점 React object identity가 달라지면 canonical 적용을 건너뛰어 UI가 `[Y]`에 남을 수 있다.
3. automatic navigation retry timer가 살아 있는 동안 relocate/progress rerender가 발생하면 policy가 다시 실행되어 이미 adoption된 revision을 `ignore`로 소비할 수 있다.

후속 수정은 전체 배열 bookmark 저장 API를 제거하고 ID 단위 mutation으로 바꾸며, local write generation + persisted canonical 재수렴, retry timer pending policy guard로 닫는다.

## Phase A — listener freshness 계약

상태: 구현·회귀검증 완료

- `SnapshotListenerRecovery`에 attach/restart/authoritative 시각을 분리했다.
- 서버 snapshot을 한 번도 받지 못한 listener도 attach 후 15초가 지나면 lifecycle 이벤트에서 재구독한다.
- failed listener는 `retryNow()`, healthy stale listener는 `forceRestart()`로 분리했다.
- force restart는 `canRetry()`와 5초 cooldown을 지킨다.
- visibility/token/book-open 연속 신호가 중복 subscription churn을 만들지 않게 했다.
- cache-only snapshot 이후 15초 경과 재구독, cooldown 중복 방지, offline/canRetry false 방어를 테스트한다.

## Phase B — canonical adoption/navigation 결과 계약

상태: 구현·회귀검증 완료

- adoption과 renderer navigation 결과를 하나의 status union으로 올렸다.
- `navigated`, `blocked-by-local-work`, `stale-remote`, `adopted-navigation-superseded`, `adopted-navigation-failed`, `cancelled`을 구분한다.
- retryable navigation failure/cancel은 remote identity를 처리 완료로 기록하지 않는다.
- 자동 quiet resume는 750ms, 2초 bounded retry를 거친 뒤 계속 실패하면 사용자 prompt로 승격한다.
- 수동 `이동하기`는 실제 navigation 성공 시에만 dialog를 닫고 실패 시 재시도 안내를 유지한다.
- set navigation은 `cfi` 실패 시 서로 다른 `anchorCfi`를 한 번 fallback한다.
- adoption 성공 후 renderer 실패와 더 최신 사용자 navigation에 의한 supersede를 별도 결과로 테스트한다.
- retry timer가 pending인 같은 remote identity는 `currentCfi`/`totalProgress`/`localRevision` rerender가 와도 policy를 다시 판정하지 않는다. timer callback만 다음 retry nonce를 깨운다.
- hook-level 회귀에서 1차 navigation 실패 → 750ms retry 대기 → relocate/localRevision rerender → timer wake 뒤 2차 navigation이 실제 실행되는지 검증한다.

## Phase C — transaction-current progress aggregate merge

상태: 구현·storage 교차순서 검증 완료

- `enqueueProgressMutationBatchV5()`는 transaction 안에서 현재 `progress-v5`를 다시 읽는다.
- position event가 있을 때만 requested position fields를 적용한다.
- bookmark event는 existing manual bookmark map에 ID별 upsert/delete한다.
- unrelated remote bookmark와 local bookmark가 서로 덮지 못하게 한다.
- auto bookmark는 로컬 전용 값으로 보존/적용한다.
- sync revision identity는 transaction-current canonical 값을 우선한다.
- batch는 최종 canonical progress를 반환하고 React state/commit baseline도 그 반환값으로 재기준화한다.
- authenticated progress 저장은 sync event가 없는 경우에도 whole-record `put`으로 우회하지 않고 동일 transaction-current merge 경로를 사용해 stale manual bookmark 배열이 canonical을 덮지 못하게 한다.
- local write generation이 최신인 상태에서 commit 도중 remote hydration이 React object를 바꾼 경우 `progress-v5`를 다시 읽어 persisted canonical로 state를 수렴한다. 재-read 중 더 최신 local/remote update가 들어오면 오래된 canonical 적용을 중단한다.
- `remote Y → local X`, `local X → remote Y`, `remote bookmark Y → local position move` 세 순서를 모두 고정해 unrelated bookmark가 유지되는지 검증한다.
- hook-level 경합에서 `local X optimistic → remote React Y → transaction canonical X+Y`를 만들어 DB와 React가 모두 `[X, Y]`로 수렴하는지 검증한다.

## Phase D — observed remote revision과 settled baseline 분리

상태: 구현·outbox/annotation 기존 회귀검증 완료

스키마 migration 없이 기존 필드의 의미를 엄격히 했다.

- `remote-heads-v5.revision`: 관찰한 최신 서버 head
- `sync-meta-v5.knownRevision`: active local chain이 시작되는 settled baseline

같은 target에 pending/in-flight/blocked/conflict/paused event 또는 open/deferred conflict가 있으면 remote head cache는 갱신하되 `knownRevision`은 올리지 않는다. worker acknowledge/conflict resolution이 settled revision을 전진시킨다.

이 규칙을 progress/bookmark 공통 remote-head 저장뿐 아니라 annotation hydration과 annotation book-deletion marker에도 적용했다. 동일 revision에 다른 `acceptedEventId`가 들어오면 schema invariant 위반으로 처리한다.

`E1 base=0 → in-flight → 서버 revision 1 exact echo 관찰 → local ack 전 E2 enqueue`에서 E2의 `baseRevision === 1`을 검증한다.

## Phase E — bookmark dirty/monotonic 방어

상태: 구현·storage/browser regression 완료

- bookmark add/delete는 `markUserInteraction()`만 호출하고 position dirty를 만들지 않는다.
- reader의 수동 bookmark add/delete 저장 계약을 전체 배열 `saveBookmarks(next[])`에서 `saveBookmarkMutation({ kind: 'upsert' | 'delete', ... })`로 바꿔 사용자 의도를 ID 한 개에만 한정한다.
- full-array `diffManualBookmarks()`는 progress reset/book delete처럼 명시적인 전체 교체 의미가 있는 경로에만 남긴다. 일반 위치 저장은 manual bookmark diff event를 만들지 않는다.
- page/slider/TOC 등 실제 위치 변경만 `markUserProgressChange()`를 사용한다.
- bookmark hydration은 cached remote보다 낮은 revision을 canonical에 적용하지 않는다.
- 같은 revision의 다른 event identity는 invalid-argument로 차단한다.
- bookmark 저장 실패 시 현재 canonical baseline으로 React/bookmark UI를 되돌리되, 더 최신 mutation이나 canonical update가 있으면 오래된 rollback이 덮지 못하게 generation을 사용한다.
- production browser regression에서 bookmark add/delete가 `user-interaction`은 남기지만 position `user-change`는 만들지 않는지 검증한다.

## Phase F — observability와 multi-context gate

상태: privacy-safe trace 구현 완료. Firebase 두-context 앱 E2E는 테스트 인프라 선행 필요로 보류

- privacy-safe reader/sync bootstrap trace를 `?readerDebug=1` 또는 로컬 debug flag에서만 활성화되는 160개 ring buffer로 추가했다.
- CFI/본문/북마크 이름/annotation note 원문은 기록하지 않는다. remote identity는 hash만 기록한다.
- listener attach/authoritative/reconcile, remote decision/navigation result, font/style/layout, relocate/page geometry를 구분한다.
- 기존 독서 통계의 `진단` JSON에 trace가 활성화된 경우에만 `readerBootstrapTrace`를 함께 내보낸다.
- trace disabled에서는 buffer 자체를 생성하지 않는 테스트를 추가했다.

### Firebase Emulator + Playwright 두-context E2E 보류 사유

현재 저장소에는 Firestore emulator(`127.0.0.1:8089`)와 Rules test runner는 있지만 Auth emulator가 없고, Playwright app server가 Firebase browser SDK를 emulator/mock user로 연결하는 전용 테스트 bootstrap도 없다. production Firebase 설정을 우회해 두 browser context를 억지로 연결하면 실제 인증/동기화 경계를 오염시킬 위험이 있어 이번 릴리스 gate에는 넣지 않았다.

대신 이번 finding의 핵심 interleaving은 IndexedDB/outbox transaction 테스트와 production browser regression으로 고정했다. 두-context E2E를 추가하려면 다음 선행 작업이 필요하다.

1. Playwright 전용 Firebase emulator mode와 Firestore `mockUserToken` 또는 Auth emulator bootstrap
2. production config와 emulator config의 명시적 격리
3. context A/B별 독립 IndexedDB/session/device identity fixture
4. progress pending/remote head/bookmark X/Y/ack-race 시나리오 seed API

이 인프라를 다음 동기화 gate 개선 작업으로 분리한다.

## 이번 버전에서 계속 보류

- pre-open `InitialReaderDecision`
- `resumeCfi` schema migration
- `bookmarks-v14`
- Live Follow
- vendor `applyLayout()` 일괄 API
- selected-font/Noto asset 전략 전체 개편
- visualViewport 기반 고정 viewport 시스템

이 항목들은 이번 correctness 수정의 전제조건이 아니다.

## 추가 회귀검증

- healthy listener가 cache snapshot만 받은 상태로 15초 경과 후 reconcile되며 5초 cooldown 안에서는 중복 restart하지 않는다.
- `canRetry()`가 false인 동안 healthy listener를 강제로 끊지 않는다.
- canonical adoption 성공 후 renderer navigation 실패는 `adopted-navigation-failed`로 남고 재시도 가능하다.
- 더 최신 navigation이 들어온 경우는 실패와 구분해 `adopted-navigation-superseded`로 종료한다.
- remote bookmark Y와 local bookmark X의 commit 순서를 양방향으로 뒤집어도 최종 canonical은 `[X, Y]`를 유지한다.
- remote bookmark Y와 local position mutation이 교차해도 Y와 최신 local position이 함께 유지된다.
- stale bookmark revision은 canonical에 적용되지 않고 동일 revision의 다른 event identity는 거부된다.
- in-flight E1의 exact server echo를 local ack 전에 관찰한 뒤 E2를 enqueue해도 E2 `baseRevision`은 서버 current revision과 일치한다.
- bookmark add/delete는 browser regression에서 position dirty event를 만들지 않는다.
- debug trace는 160개로 제한되고 disabled 상태에서는 메모리를 할당하지 않으며 raw remote identity를 내보내지 않는다.
- explicit bookmark upsert/delete는 unrelated remote bookmark에 tombstone을 만들지 않는다.
- `local X optimistic → remote React Y → IDB X+Y commit` interleaving에서 최종 React/IDB가 모두 `[X, Y]`이고 outbox에는 X target 하나만 생긴다.
- retry timer pending 중 reader state rerender가 발생해도 remote identity를 소비하지 않고 timer wake 뒤 2차 canonical navigation을 실행한다.

## 릴리스 메타데이터

- package version: `1.8.13`
- Service Worker cache: `pc-reader-v1.8.13`
- Foliate runtime version: `1.8.13`
- Foliate runtime revision: `1.8.13.1`
- 1.8.12 Foliate runtime cache는 stale release cache 정리 대상이다.

## 현재 자동검증

현재 `bf7a9cb` 후속 작업 트리 기준:

- `npm run lint` — 오류 0, 기존 `public/foliate-js` 경고 2개만 유지
- `npm run typecheck` 통과
- 기존 핵심 P1/P2 targeted tests 59개 통과
- `bf7a9cb` 재리뷰 후속 hook/convergence targeted tests 5개 통과
- `npm run test:storage` — 301개 전부 통과
- `npm run test:shelf` — 82개 전부 통과
- `npm run test:release` — 3개 전부 통과
- `npm run check:full` 통과
  - Firestore Rules 29개 통과
  - Playwright Chromium·WebKit E2E 20개 통과
  - production browser regression 통과
  - production build 통과
- Firebase Emulator + Playwright 두-context 앱 E2E는 위 Phase F 사유로 이번 gate에 포함하지 않았다.

## 실기기 확인 계획

동기화 invariant:

- 앱을 오래 background에 둔 뒤 foreground 복귀했을 때 progress/bookmark listener가 최신 서버 상태로 수렴하는지 확인한다.
- 최초 연결에서 cache 상태만 오래 보이는 환경에서도 foreground/token/online 수명주기 뒤 최신 상태가 들어오는지 확인한다.
- 기기 A에서 pending progress가 남은 동안 기기 B에서 진행도를 갱신하고 A가 책을 열어도 위치가 왕복하지 않는지 확인한다.
- 원격 위치 canonical adoption 직후 renderer 이동이 일시적으로 실패하는 상황에서 현재 위치가 영구적으로 어긋나지 않고 재시도/안내로 수렴하는지 확인한다.
- 양 기기에서 서로 다른 bookmark X/Y를 동시에 추가해 최종 양쪽 모두 X/Y를 유지하는지 확인한다.
- remote bookmark Y가 UI에 들어오는 바로 그 시점에 local X를 add/delete해도 Y에 잘못된 delete intent가 생기지 않고 최종 X/Y가 수렴하는지 확인한다.
- local X optimistic 직후 remote Y hydration이 React를 먼저 갱신해도 화면에서 X가 사라진 채 고정되지 않는지 확인한다.
- remote adoption 뒤 첫 renderer navigation을 실패시키고 retry 대기 중 page/relocate 상태를 변화시켜도 timer wake 뒤 retry가 실제 실행되는지 확인한다.
- bookmark add/delete만 한 뒤 앱 업데이트·종료를 해도 불필요한 progress 위치 event가 새로 생기지 않는지 확인한다.

진단:

- 문제 재현 시 `?readerDebug=1`로 열거나 debug flag를 켜고 독서 통계의 `진단` JSON을 저장해 listener/remote navigation/layout/relocate 순서를 확인한다.
- 진단 JSON에 CFI, 본문, bookmark 이름, annotation note 원문이 포함되지 않는지 확인한다.
