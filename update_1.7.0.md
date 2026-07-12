# 업데이트 1.7.0 개발 계획

> 기준 브랜치: `main`
>
> 구현 시작 기준 커밋: `b0427177e49e603a4121a9205e2da1164899e4c3`
>
> 기준 앱 버전: `1.6.6`
>
> 문서 상태: 구현 중

## 문서 목적

코드 총 리뷰와 외부 수정본을 현재 코드에 대조해, 1.7.0에서 실제로 구현할 작업을 데이터 안전 중심으로 정리한다. 수정본의 안전한 설계는 수용하되, 구현 명세·프롬프트·보고 양식까지 한 문서에 중복한 14개 작업은 9개 응집된 Phase로 합쳤다.

이 문서는 다음 원칙으로 사용한다.

- Phase 하나를 구현·검증한 뒤 다음 Phase로 진행한다.
- 완료 조건과 현재 증거가 모두 맞을 때만 상태를 완료로 바꾼다.
- 사용자 데이터 원본, 기존 v4 IndexedDB, v1 Firestore 문서는 1.7.0에서 삭제하지 않는다.
- 버전 문자열은 마지막 릴리스 Phase 전까지 `1.6.6`을 유지한다.
- 관련 없는 리팩터링, 의존성 일괄 업그레이드, UI 전면 재설계는 하지 않는다.
- 보안·동기화 테스트를 삭제·skip·완화해서 완료 조건을 맞추지 않는다.

## 구현 시작 전 기준선

Phase 1을 시작하기 전에 `git status --short`, `git rev-parse HEAD`, Node/npm 버전과 `npm ci` 결과를 기록한다. 현재 lint, Node 테스트, 브라우저 회귀와 production build를 각각 실행해 기존 실패와 1.7.0 변경으로 생긴 실패를 구분한다. 실제 시작 HEAD가 `02915db`와 다르면 새 HEAD와 차이를 먼저 기록하고 계획의 코드 전제를 다시 확인한다.

## 검토 결과

| 항목 | 판정 | 현재 코드 근거 | 1.7.0 처리 |
| --- | --- | --- | --- |
| 오프라인 진행률의 늦은 덮어쓰기 | 수용, P0 | 책별 단일 Firestore 문서를 `setDoc(..., { merge: true })`로 저장하며 queue는 한 클라이언트 내부 순서만 보장한다. | IndexedDB outbox, revision transaction, event receipt, 사용자 충돌 선택 |
| outbox payload와 revision chain | 보강, P0 | 기존 계획의 event 타입에는 실제 payload와 연속 event의 `baseRevision` 계산이 빠졌다. | operation별 payload, 예상 revision chain, coalescing·충돌 해결 규칙 고정 |
| 멀티탭 worker 중복 | 보강, P0 | 운영 Firestore와 앱 IndexedDB가 여러 탭에 공유되어 탭마다 worker가 시작될 수 있다. | IndexedDB lease/epoch로 active leader를 하나로 제한하고 receipt로 최종 중복 방지 |
| 북마크 배열 동시 쓰기 유실 | 수용, P0 | 수동 북마크 배열 전체를 진행률 문서에 함께 쓴다. | 수동 북마크별 revision 문서와 tombstone |
| EPUB 실행 경계 | 수용, P0 | publication iframe이 `allow-same-origin allow-scripts`이고 inline script 제거 경계가 없다. | renderer-boundary DOM sanitizer와 CSP, WebKit listener 호환 sandbox, 악성 EPUB 브라우저 테스트 |
| 원격 삭제·리스너 순서·오류 | 수용, P1 | `snapshot.docs`를 비동기 순회해 이전 state와 merge하며 `removed`와 오류 callback이 없다. | `docChanges()`, 직렬 Promise tail, 삭제·오류 처리 |
| 계정별 IndexedDB 분리 | 수용, P1 | DB와 key가 고정이고 로그인 후 전체 로컬 데이터를 복원한다. | owner-scoped v5 병렬 store와 generation guard |
| IndexedDB upgrade 탭 경합 | 보강, P1 | 다른 탭이 v4 연결을 유지하면 v5 open이 blocked될 수 있다. | `blocking`/`blocked`/`terminated` 처리와 migration lease·복구 UI |
| 1.6.6 pending v1 write | 보강, P0 | 운영 Firestore가 persistent cache를 사용해 구버전 offline mutation이 1.7.0 이후 도착할 수 있다. | v1 listener·Rules 유지, server-confirmed snapshot만 import, 후속 변경은 legacy conflict |
| Drive token 영구 저장 | 수용, P1 | access token과 만료 시각을 localStorage에 저장한다. | GIS token client와 memory-only token |
| Firestore Rules 부재 | 수용, P1 | Rules, Firebase emulator 설정과 Rules 테스트가 저장소에 없다. | v1/v2 호환 Rules와 emulator 테스트 |
| Service Worker 광범위 캐시 | 수용, P1 | 대부분의 same-origin GET을 runtime cache에 넣고 즉시 takeover한다. | 정적 allowlist, 민감 요청 우회, 사용자 승인 업데이트 |
| Foliate `kr`와 대입 연산자 | 수용, 즉시 수정 | `view.js`에 잘못된 locale과 `.find(x => x.index = resolved.index)`가 존재한다. | 최소 patch와 회귀 테스트 |
| Drive cache key에 token 사용 | 수용, P2 | folder/registry/in-flight Map이 token 원문을 key로 사용한다. | owner/session 기반 key와 명시적 cache 폐기 |
| 통합 품질 게이트 부재 | 수용, P1 | 테스트가 여러 script로 나뉘고 GitHub Actions가 없다. | `check`, `check:full`, CI job 구성 |

`progressPercent`의 실제 앱 규약은 리뷰 초안의 0~1이 아니라 **0~100**이다. 또한 기존 `useRemoteProgressPrompt`와 `SyncConflictDialog`가 있으므로 새 충돌 UI를 만들지 않고 두 컴포넌트를 확장한다.

## 범위와 비범위

### 1.7.0 필수 범위

- 확인된 Foliate 결함 2건과 회귀 테스트
- Firebase/Drive 조합별 로컬 데이터 격리와 안전한 v4→v5 migration
- 진행률 outbox, revision transaction, reset tombstone, event receipt
- 연속 local event의 예상 revision chain과 멀티탭 leader lease
- 수동 북마크별 문서·revision·tombstone
- v2 listener의 added/modified/removed/error/순서 처리
- v1 `readingHistory`를 보존하는 읽기 전용 전환 bridge
- 1.6.6 pending v1 write와 구버전 탭 공존 처리
- Firestore Rules와 emulator 테스트
- EPUB sanitizer, CSP, publication script 차단과 악성 fixture 검증
- GIS token client, memory-only token, Drive cache 격리
- Service Worker allowlist와 사용자 승인 업데이트
- CI, 통합 회귀, 실기기 검증, 안전한 릴리스 순서

### 1.7.0에서 하지 않는 일

- 별도 백엔드, authorization code 서버 교환, 서버 세션 도입
- EPUB renderer의 별도 origin 전면 이전
- App Check로 Rules 대체
- Foliate 전체 upstream 교체
- 자동 북마크 클라우드 동기화
- v4 IndexedDB store, v1 Firestore 문서·Rules 삭제
- tombstone·event receipt 자동 GC
- 관련 없는 Next.js/React/Firebase 업그레이드

Phase 1의 조기 호환성 게이트 결과 WebKit bug 218086 때문에 `allow-scripts` 없는 same-origin frame에서는 parent-realm listener도 실행되지 않는 C 판정이 확인됐다. raw publication에 `allow-scripts`를 되돌리지 않고, paginator/fixed-layout 진입점에서 모든 HTML/XHTML/SVG를 다시 sanitize하고 `script-src 'none'` CSP를 강제한 문서만 `allow-same-origin allow-scripts` frame으로 넘긴다. 읽기·sanitize에 실패하거나 지원하지 않는 문서 MIME은 iframe navigation 전에 실패 처리한다.

## 고정 설계 결정

### 소유권과 서재 scope

```ts
type AuthOwnerKey = `firebase:${string}` | `guest:${string}`;
type LibraryScopeKey = `drive:${string}` | 'library:local';
type OwnerKey = `${AuthOwnerKey}|${LibraryScopeKey}`;
```

- Firebase 로그인 사용자는 UID를, guest는 설치별 UUID를 사용한다.
- Drive 연결 성공 뒤 Drive `about.get`으로 안정적인 `user.permissionId`를 확인하고 appData registry가 가리키는 canonical folderId도 검증한다. email, 표시 이름, access token과 folderId는 owner key에 쓰지 않는다.
- Drive가 연결된 서재는 `drive:{permissionId}`, Drive를 쓰지 않는 로컬 서재는 `library:local` scope를 사용한다.
- folderId는 owner가 아니라 검증된 binding과 Drive cache 무효화 기준이다. 같은 계정에서 폴더가 복구·교체되면 기존 로컬 namespace는 유지하고 cloud listing, folder cache와 이전 in-flight 요청만 폐기한다.
- **Firebase 로그인 + `library:local`은 Firestore 진행률 동기화를 허용한다.** 수정본의 `drive:none` 동기화 금지는 현재의 로컬 책 진행률 동작을 잃게 하므로 채택하지 않는다.
- guest는 로컬 저장만 사용하고 Firestore를 읽거나 쓰지 않는다.
- 같은 Firebase UID에서 Drive 계정이 바뀌면 owner 전환으로 처리한다. 기존 state, listener, worker를 먼저 정리한 뒤 새 namespace를 연다.
- token 없는 새로고침은 마지막으로 검증된 binding의 로컬 namespace를 열 수 있지만 Drive 요청과 새 scope 확정은 재연결 전까지 금지한다.
- `library:local` 데이터를 Drive scope로 자동 합치지 않는다. 사용자가 귀속을 확인해야 한다.

### 인증 generation

- Firebase user 변경, Drive scope 확정·변경, 로그아웃마다 **먼저** generation을 증가시켜 기존 작업을 무효화한다.
- 그 다음 listener, sync lease/worker, timer, token request와 가능한 fetch를 취소하고 메모리 state를 비운 뒤 새 owner를 복원한다.
- 비동기 작업은 `{ ownerKey, generation }`을 캡처하고 state·IndexedDB·Firestore 반영 직전에 다시 비교한다.
- 값이 달라지면 결과를 폐기하고 가능한 listener, worker, timer, fetch를 취소한다.
- component-level `isActive`만으로 계정 전환 안전성을 대신하지 않는다.

### 원격 경로

```text
artifacts/{APP_ID}/users/{uid}/libraries/{libraryScopeId}/readingHistoryV2/{bookId}
artifacts/{APP_ID}/users/{uid}/libraries/{libraryScopeId}/readingHistoryV2/{bookId}/bookmarks/{bookmarkId}
artifacts/{APP_ID}/users/{uid}/libraries/{libraryScopeId}/readingHistoryV2/{bookId}/eventReceipts/{eventId}
```

- `libraryScopeId`는 `local` 또는 안전하게 인코딩한 Drive permissionId다.
- v2 앱은 v2 경로에만 쓴다.
- 기존 `readingHistory/{bookId}`는 1.7.x 전환 기간 동안 읽기 전용 bridge로 유지한다.
- 진행률 삭제는 문서 물리 삭제가 아니라 revision을 증가시키는 `reset` event다.
- v2 head나 bookmark의 실제 물리 삭제는 정상 reset/delete로 해석하지 않는다. `remote_missing`으로 격리하고 로컬 진행률·북마크를 자동 삭제하지 않는다.

### v1 공존과 전환

- Firestore persistent cache를 임의로 지우거나 v1 pending write를 폐기하지 않는다.
- v1 listener는 `{ includeMetadataChanges: true }`로 구독한다. `fromCache === false`이고 문서의 `hasPendingWrites === false`인 서버 확정 값만 import 또는 legacy conflict 근거로 사용한다.
- v1 데이터에는 library scope가 없으므로 같은 Firebase UID에 여러 scope가 있으면 사용자가 destination을 선택한다.
- 최초 import 뒤 서버에서 확인된 v1 변경은 v2를 자동 덮어쓰지 않고 `legacy_v1` conflict 후보로 보존한다.
- 1.6.6 탭·기기의 후속 write와 기존 progress 문서 delete를 허용하는 v1 listener·Rules를 1.7.x 동안 유지한다. v1 물리 삭제를 v2 reset으로 자동 변환하지 않는다.

### 동기화 불변 조건

- 진행률이 더 높거나 timestamp가 더 최신이라는 이유만으로 자동 승자를 고르지 않는다.
- local progress, outbox event, sequence와 예상 revision은 하나의 IndexedDB transaction으로 저장한다.
- 같은 target은 sequence 순서로만 전송하고 앞 event가 충돌하면 뒤 event를 `blocked`로 멈춘다.
- 연속 event의 `baseRevision`은 현재 known revision과 앞선 unresolved event의 예상 성공을 반영한다. 서버 값을 보고 기존 base revision을 다시 써서 충돌을 숨기지 않는다.
- transaction 성공 후 로컬 ack가 실패해도 같은 event를 중복 적용하지 않아야 한다.
- Firestore transaction callback은 재실행 가능해야 하며 React state, IndexedDB와 외부 log queue를 변경하지 않는다.
- 충돌 중에도 로컬 읽기·저장은 계속하고 해당 책의 원격 flush만 멈춘다.
- 원격 tombstone을 오래된 로컬 수정으로 조용히 되살리지 않는다.
- 기존 저장 debounce와 의미 있는 변경 판정은 유지한다.

### listener 범위

- owner마다 progress head collection listener 하나만 둔다.
- bookmark subcollection은 active book만 최초 fetch 후 구독하고 책 전환 시 이전 listener를 해제한다.
- event receipt는 구독하지 않고 worker transaction에서 필요한 eventId만 조회한다.
- snapshot은 owner/generation별 Promise tail로 직렬화한다.
- pending-write local echo와 cache-only snapshot은 새 원격 충돌이나 확정 revision으로 사용하지 않는다.

## 목표 데이터 모델

### 공통 payload와 원격 head

```ts
type ProgressPositionV2 = {
  cfi: string;
  anchorCfi: string | null;
  progressPercent: number;
};

type ManualBookmarkPayloadV2 = {
  bookmarkId: string;
  cfi: string;
  name: string;
  color: string;
  progressPercent: number | null;
  createdAtClient: number;
  updatedAtClient: number;
};

type ProgressHeadV2 = {
  schemaVersion: 2;
  bookId: string;
  revision: number;
  acceptedEventId: string;
  operation: 'set' | 'reset';
  position: ProgressPositionV2 | null;
  acceptedDeviceId: string;
  occurredAtClient: number;
  updatedAtServer: Timestamp;
  deletedAtServer: Timestamp | null;
};
```

- bookmark head도 `bookId`, `bookmarkId`, `schemaVersion`, `revision`, `acceptedEventId`, `operation`, `ManualBookmarkPayloadV2 | null`, server timestamp와 `deletedAtServer`를 가진다.
- event receipt는 `eventId`, target, 적용 revision, server timestamp를 immutable 문서로 저장한다.
- receipt가 이미 있으면 event는 `already_applied`로 처리하고 revision을 다시 증가시키지 않는다.
- reset/delete는 payload가 null이고 tombstone timestamp가 있으며 set/upsert는 payload가 존재해야 한다. operation·target·payload 조합은 client parser와 Rules가 함께 검증한다.

### 로컬 outbox

```ts
type OutboxEventV5 = {
  ownerKey: OwnerKey;
  eventId: string;
  target: { kind: 'progress'; bookId: string } | { kind: 'bookmark'; bookId: string; bookmarkId: string };
  targetKey: string;
  operation: 'progress.set' | 'progress.reset' | 'bookmark.upsert' | 'bookmark.delete';
  payload: ProgressPositionV2 | ManualBookmarkPayloadV2 | null;
  deviceId: string;
  sessionId: string;
  sequence: number;
  baseRevision: number;
  occurredAtClient: number;
  status: 'pending' | 'in_flight' | 'blocked' | 'conflict' | 'paused';
  attempts: number;
  nextAttemptAt: number | null;
  lastErrorCode: string | null;
  claimedByTabId: string | null;
  claimedLeaseEpoch: number | null;
};
```

- `baseRevision = knownRevision + 같은 target의 앞선 unresolved event 수`로 계산하고 sequence·예상 revision·local progress를 enqueue transaction에서 함께 기록한다.
- 같은 progress target, 같은 reader session의 마지막 `pending progress.set`만 coalesce할 수 있다. 기존 eventId, sequence, baseRevision을 유지하고 payload와 발생 시각만 갱신한다.
- reset, conflict, blocked, in-flight, bookmark event와 다른 탭·reader session event는 coalesce하지 않는다.
- 앱 재시작 시 `in_flight`를 무조건 되돌리지 않고 해당 claim의 lease 만료가 확인된 event만 새 leader가 회수한다.
- receipt 재처리 시 known revision과 remote cache는 `max(기존 revision, receipt revision, 현재 head revision)` 방향으로만 전진시킨다.
- 충돌 상태에서 새 읽기 위치는 outbox를 무한 추가하지 않고 conflict의 `latestLocalPosition`을 갱신한다.

### 충돌 해결 규칙

- revision 불일치 시 충돌 event, 원격 head, 뒤따르는 blocked event와 최신 local payload를 함께 보존한다.
- “이 기기 유지”는 현재 원격 revision을 base로 새 eventId의 event를 만들고 기존 chain을 superseded 처리한다.
- “다른 기기 사용”은 원격 head를 로컬에 적용하고 기존 충돌·blocked chain을 해결 기록 후 제거한다. 불필요한 cloud write는 만들지 않는다.
- “나중에”는 해당 target의 flush만 멈추고 이후 읽기 위치를 conflict의 latest payload에 반영한다.
- 삭제된 bookmark 복원은 명시적 선택 뒤 새 UUID로 만든다.

### IndexedDB v5

DB 이름은 `web-reader-db`를 유지하고 version을 5로 올린다. v4 keyPath를 제자리 변경하지 않고 아래 병렬 store를 추가한다.

| store | key | 용도 |
| --- | --- | --- |
| `books-v5` | `[ownerKey, bookId]` | 책 Blob/ArrayBuffer |
| `metadata-v5` | `[ownerKey, id]` | 책 metadata |
| `progress-v5` | `[ownerKey, bookId]` | 로컬 현재 위치와 자동 북마크 |
| `archive-inspections-v5` | `[ownerKey, bookId]` | archive cache |
| `outbox-v5` | `[ownerKey, eventId]` | 전송 대기 event |
| `remote-heads-v5` | `[ownerKey, targetKey]` | 원격 progress/bookmark head cache |
| `sync-meta-v5` | `[ownerKey, targetKey]` | known revision과 next sequence |
| `sync-conflicts-v5` | `[ownerKey, conflictId]` | 양쪽 payload, blocked chain과 해결 상태 |
| `sync-leases-v5` | `ownerKey` | active tab, epoch, expiry와 heartbeat |
| `owner-bindings-v5` | `[authOwnerKey, libraryScopeKey]` | 검증된 Drive account/folder binding |
| `owner-session-v5` | `authOwnerKey` | 마지막 활성 owner |
| `migration-meta-v5` | `migrationId` | inventory, destination, checkpoint, 검증 결과와 migration lease |

모든 v5 API는 첫 인수로 `ownerKey`를 받는다. owner를 생략하는 overload나 default owner를 만들지 않는다.

### migration과 멀티탭 lease

- IndexedDB `upgrade()`에서는 store/index만 만들고 Blob 복사와 inventory는 DB open 뒤 batch transaction에서 수행한다.
- migration은 store별 last key와 count를 checkpoint하고 source/destination count, key digest, Blob `size`/ArrayBuffer `byteLength`, 필요한 metadata digest를 검증한다. 브라우저가 제공하지 않는 실제 디스크 바이트 동일성을 주장하지 않는다.
- quota나 batch 실패는 현재 batch만 rollback하고 v4를 보존한다. 취소 시 migration 재시도, legacy v4 read-only recovery, 빈 v5 namespace 중 하나를 명시적으로 선택하게 한다.
- DB connection은 `blocking`에서 닫고 `blocked`와 `terminated`를 UI 상태로 노출한다. 무한 대기하지 않고 다른 탭 정리·재시도 방법을 안내한다.
- migration과 sync worker는 각각 IndexedDB transaction으로 lease/epoch를 획득한다.
- 각 탭은 비영속 `tabId`를 사용한다. sync lease holder만 event를 `in_flight`로 claim하며 ack 직전에 owner/generation/lease epoch를 다시 확인한다.
- `BroadcastChannel`은 알림 최적화일 뿐 상호 배제 근거가 아니다. 최종 idempotency는 immutable event receipt가 담당한다.

## Phase 1: 기준선, 직접 결함과 EPUB 호환성 게이트

### 목표

현재 1.6.6 동작을 고정하고 Foliate의 확정 결함 2건을 최소 diff로 수정한다. 데이터 구조 변경 전에 publication script 차단과 WebKit parent listener를 함께 만족하는 경계를 판정한다.

### 작업

- `typecheck`, `test:node`, `test:all`, `check` script를 추가한다. 기존 개별 test script와 CDP 기반 `tests/browserRegression.mjs`는 유지한다.
- 최소 GitHub Actions job에서 production credential 없이 `npm ci`와 `npm run check`를 실행한다.
- `public/foliate-js/view.js`의 `kr`을 `ko`로, media-overlay 대입 연산자를 `===`로 수정한다.
- `ko`, `ko-KR`, `ja`, `zh-CN`, `en-US`와 index 0, 양수, 없음, 원본 배열 불변을 테스트한다.
- vendored 수정 이유와 회귀 테스트를 `public/foliate-js/PATCHES.md`에 기록한다.
- paginator와 fixed-layout 각각에서 무스크립트 sandbox를 먼저 검증하고, WebKit bug 218086 재현 시 renderer-boundary sanitizer/CSP를 통과한 frame에 한해 listener 실행 권한을 허용해 Chromium/WebKit의 page/scroll 이동, click/touch/keyboard, selection, 내부 링크, fixed layout과 media-overlay event를 확인한다.
- 최소 악성 publication fixture로 현재 sandbox의 script·inline handler·parent/storage 접근 여부와 no-script 상태의 차단 여부를 기록한다.
- 결과를 A(제거만으로 동작), B(parent-controlled WebKit event 보완 필요), C(same-origin no-script로 안전성과 핵심 기능을 함께 만족하지 못함)로 판정한다.

### 완료 조건과 검증

- `npm run test:formats`, `npm run check`, `git diff --check`가 통과한다.
- 앱 버전과 Service Worker cache는 계속 `1.6.6`이다.
- Foliate 전체 업데이트나 주변 vendored formatting diff가 없다.
- paginator와 fixed-layout 양쪽의 sandbox 판정과 재현 fixture가 남는다. C 판정이면 renderer-boundary sanitizer/CSP의 fail-closed 보완이 Chromium/WebKit에서 증명되기 전까지 후속 Phase를 진행하지 않는다.

## Phase 2: owner-scoped IndexedDB와 안전한 migration

### 목표

v4 원본을 보존하면서 owner-scoped v5 저장소로 런타임을 전환하고 계정 전환 race를 차단한다.

### 작업

- v5 병렬 store와 필요한 owner/status/sequence index를 추가한다.
- `upgrade()`는 schema 생성만 수행하고 migration은 post-open batch job으로 분리한다.
- 책 content+metadata, progress+outbox+sync meta처럼 함께 성공해야 하는 쓰기는 단일 transaction API로 제공한다.
- Firebase UID, Drive permissionId 또는 `library:local`로 owner를 확정하고 generation guard를 적용한다.
- owner 변경 순서를 generation 증가 → listener/worker/fetch 취소 → 메모리 state 초기화 → 새 owner 복원으로 고정한다.
- v4 inventory, idempotent batch copy, checkpoint, count/key/size·digest 검증과 migration lease를 구현한다.
- v4 데이터가 있으면 현재 owner 귀속을 확인한다. 취소하거나 실패하면 v4를 보존하고 migration 재시도, legacy read-only recovery, 빈 v5 namespace를 구분해 제공한다.
- `blocking`/`blocked`/`terminated`를 처리하고 다른 탭이 v4 DB를 열고 있을 때 무한 대기하지 않는다.
- 현재 owner의 로컬 데이터 삭제는 다른 owner와 v4를 건드리지 않는다.

### 완료 조건과 검증

- 같은 bookId를 가진 owner A/B가 저장·조회·삭제에서 완전히 격리된다.
- 빠른 A→B 전환 뒤 A의 늦은 Promise가 B state를 갱신하지 않는다.
- migration 중단·재시작이 idempotent하고 count/key/size·digest 불일치에서는 완료 처리되지 않는다.
- quota 실패는 현재 batch만 rollback하며 다른 탭의 v4 연결이 정리된 뒤 안전하게 재개된다.
- fake IndexedDB 테스트, storage/shelf/browser 회귀, typecheck, build가 통과한다.

## Phase 3: Firestore v2 schema와 Rules

### 목표

동기화 구현 전에 원격 경로, 허용 schema와 접근 제어를 코드·Rules·emulator 테스트로 고정한다.

### 작업

- v1/v2 path helper와 v2 serialize/parse/validate 함수를 만든다.
- production에 배포된 현재 Rules를 Console/CLI로 확인해 project, 날짜와 hash를 별도 기준선으로 보존한다. 조회 권한이 없으면 production Rules 배포를 차단하는 선행 조건으로 남긴다.
- Rules에서 UID 일치, library scope, 허용 필드, 타입·길이, `progressPercent` 0~100, create revision 1, update revision +1을 검증한다.
- set/reset payload와 tombstone 조합, bookmark path/bookId 일치, server timestamp를 검증한다.
- head 변경과 matching receipt 생성을 같은 atomic write로 강제하고 receipt overwrite/delete를 금지한다.
- v1 path는 1.6.x 전환을 위해 현재 payload만 허용하는 호환 규칙을 유지한다.
- v1 path는 현재 optional field, server timestamp와 구버전 progress 문서 delete까지 호환하되 다른 UID 접근은 금지한다.
- Firebase emulator는 demo project만 사용하고 production credential·endpoint를 사용하지 않는다.

### 완료 조건과 검증

- 본인 valid v1/v2 요청은 허용되고 다른 UID, revision jump, unknown field, 잘못된 범위·타입·크기, orphan receipt는 거부된다.
- schema parser와 Rules의 필드·범위가 일치한다.
- `npm run test:rules`, schema 단위 테스트, `npm run check`가 통과한다.
- Rules는 아직 production에 배포하지 않는다.

## Phase 4: 진행률 outbox와 revision worker

### 목표

진행률을 네트워크와 독립적으로 저장하고 v2 Firestore에 idempotent하게 전송하는 sync core를 구현한다.

### 작업

- progress save/reset과 outbox/sync meta 갱신을 한 IndexedDB transaction으로 처리한다.
- operation별 payload 검증, owner+target별 단조 sequence, 예상 base revision chain과 같은-session pending set coalescing을 구현한다.
- `sync-leases-v5`로 브라우저 전체 owner당 leader 하나를 선출한다. leader만 event를 claim하고 target별 직렬 전송하며 logout/owner 변경 시 dispose한다.
- Firestore transaction은 receipt 확인 → head revision 확인 → full head와 receipt atomic write 순서로 처리한다.
- transaction 성공 또는 `already_applied` 후 remote cache, known revision, outbox 삭제를 한 로컬 transaction으로 처리한다.
- `already_applied`는 현재 head도 읽고 revision/cache를 과거로 되돌리지 않는다. ack 전 lease epoch와 generation을 재검증한다.
- revision 불일치는 local/remote payload를 conflict store에 보존하고 해당 target만 중지한다.
- retryable 오류만 1초~60초 exponential backoff+jitter로 재시도한다. auth, permission, schema 오류는 상태를 노출하고 자동 반복하지 않는다.
- leader 종료·sleep·lease 만료 뒤 새 leader는 stale in-flight event를 receipt 기반으로 회수한다.

### 완료 조건과 검증

- A/B가 base 0을 동시에 보내면 하나만 revision 1이 되고 다른 event는 보존된 conflict가 된다.
- A 30% offline → B 70% → A reconnect에서 30%가 자동 덮어쓰지 않는다.
- 원격 성공 후 local ack 실패와 재시도에서도 receipt로 중복 revision을 막는다.
- reset 뒤 stale set, strict sequence, 앞 event conflict, owner 변경 중 응답 시나리오가 emulator에서 통과한다.
- offline set→set→reset이 자기 자신과 충돌하지 않고, 두 탭 동시 시작·leader 종료·sleep 복구가 테스트로 고정된다.
- 이 Phase 끝에서는 sync core와 테스트를 완료하되 기존 runtime cutover는 Phase 5에서 한 번에 수행한다.

## Phase 5: listener, 북마크, 충돌 UI와 원자적 runtime 전환

### 목표

수동 북마크 동기화와 listener를 완성하고 준비된 v2 sync를 앱에 한 번에 연결한다.

### 작업

- 수동 북마크 add/update/delete를 bookmark별 outbox event로 만들고 자동 북마크는 로컬에만 유지한다.
- bookmark delete는 tombstone과 revision을 사용한다. stale update가 tombstone을 자동 해제하지 않으며 복원은 새 UUID로 만든다.
- owner별 progress head listener와 active-book bookmark listener를 분리하고 `docChanges()`와 owner/generation별 Promise tail로 직렬 처리한다.
- pending-write local echo와 cache-only snapshot은 remote truth로 확정하지 않는다. server-confirmed change만 remote cache와 known revision에 반영한다.
- added/modified/error를 처리한다. v2 physical removal은 정상 reset/delete가 아닌 `remote_missing`으로 격리하고 로컬 데이터를 자동 삭제하지 않는다.
- invalid timestamp는 `Date.now()`로 승격하지 않고 null/0과 오류 상태로 격리한다.
- 기존 충돌 dialog를 일반 원격 이어읽기와 실제 revision 충돌 모드로 확장한다.
- 충돌 선택은 “이 기기 유지”, “다른 기기 사용”, “나중에”로 제공한다. 리더 사용 중 자동 jump하지 않는다.
- v1은 서버 확정 snapshot만 사용자 확인 후 최초 한 번 v2 event로 import하고 fingerprint로 중복 import를 막는다. 여러 library scope가 있으면 destination을 선택하게 한다.
- 1.6.6 pending v1 write가 나중에 도착하거나 구버전 탭이 계속 쓰면 v2를 덮지 않고 legacy conflict 후보로 보존한다.
- 기존 direct `setDoc`/`deleteDoc` v1 write를 제거하고 v2 outbox, worker, listener를 같은 runtime 전환에서 활성화한다.

### 완료 조건과 검증

- 서로 다른 북마크 동시 추가는 모두 남고 같은 ID edit/edit는 conflict가 된다.
- remote tombstone과 stale update, reset과 stale progress가 자동 부활하지 않는다.
- rapid snapshot 순서, removed, listener error, stale generation, invalid timestamp가 테스트로 고정된다.
- active book 전환 때 bookmark listener가 교체되고 닫힌 책마다 listener를 남기지 않는다.
- 앱 재시작 후 outbox가 재개되고 계정 A event가 계정 B worker로 전송되지 않는다.
- v2만 쓰고 v1은 read bridge로만 사용한다.
- 1.6.6 pending mutation과 1.6.6/1.7.0 탭 공존이 v2를 자동 overwrite하지 않는다.
- sync integration, Rules/emulator, 기존 browser regression, `npm run check`가 통과한다.

## Phase 6: EPUB 콘텐츠 실행 경계

### 목표

외부 EPUB이 parent DOM, storage, navigation과 network에 접근하지 못하도록 publication script를 차단한다.

### 작업

- `DOMParser`와 DOM traversal을 사용하는 공통 sanitizer를 publication document 직렬화 직전에 적용한다. regex-only sanitizer는 사용하지 않는다.
- Phase 1의 판정을 구현 기준으로 사용한다. C 판정에서는 renderer-boundary sanitizer/CSP와 WebKit listener 권한을 결합한 fail-closed 경계를 먼저 증명한다.
- script, inline `on*`, object/embed/iframe/srcdoc, meta refresh, SVG `foreignObject`, 위험한 URL과 form navigation을 제거한다.
- package resource는 resolver가 만든 안전한 blob/data URL만 허용하고 원격 subresource는 차단한다. 외부 anchor는 사용자 click에서 http/https만 `noopener,noreferrer`로 연다.
- `<style>`과 inline `style`은 CSS parser/tokenizer로 검사해 `url()`, `@import`, `@font-face src`, 위험한 data/SVG URL과 원격 stylesheet를 차단한다. 단순 정규식 하나로 CSS를 정화하지 않는다.
- `href`, `xlink:href`, `src`, `srcset`, `poster`, preload/prefetch와 SVG URL도 동일한 protocol·package 경계에서 검증한다.
- generated document에 `default-src 'none'`, `script-src 'none'`, `connect-src 'none'`, `object-src 'none'`, `form-action 'none'`을 포함한 CSP를 넣는다.
- renderer가 받은 HTML/XHTML/SVG URL을 iframe navigation 직전에 다시 읽고 공통 sanitizer/CSP를 적용한다. 지원하지 않는 MIME과 읽기 실패는 fail-closed 처리한다.
- WebKit bug 218086 때문에 parent listener 실행에 필요한 `allow-scripts`는 renderer-boundary `script-src 'none'` CSP가 주입된 문서에만 허용하며 이유와 위협 경계를 PATCHES 문서에 남긴다.
- 악성 EPUB에서 parent/storage/top navigation/fetch/beacon/popup/sandbox 제거/inline handler/SVG/meta refresh를 각각 검증한다.
- 기존 CDP 회귀는 유지하고 Playwright Chromium/WebKit 보안·호환성 테스트를 추가한다.

### 완료 조건과 검증

- 악성 fixture의 script, storage, navigation, popup, CSS/URL 우회와 외부 요청이 모두 차단된다.
- 일반·세로쓰기·fixed layout·media overlay·SVG/MathML·내부 링크·package 미디어가 Chromium/WebKit에서 동작한다.
- raw publication script 실행 없이 기존 `test:formats`, sanitizer 단위 테스트, Chromium/WebKit EPUB e2e, typecheck, build가 통과한다.
- WebKit에서 안전성을 증명할 수 없거나 핵심 기능이 깨지면 sandbox를 되돌리지 않고 릴리스를 중단한다.

## Phase 7: GIS token과 Drive cache 격리

### 목표

Drive bearer token을 영구 저장소와 cache key에서 제거하고 명시적인 재연결 흐름으로 전환한다.

### 작업

- 기존 implicit redirect를 `google.accounts.oauth2.initTokenClient` 기반 GIS 흐름으로 교체한다.
- token manager를 한 곳에 두고 동시 token 요청을 single-flight로 합친다.
- token 요청은 사용자 gesture에서만 시작하고 access token과 expiry는 React memory/ref에만 둔다.
- 새로고침 후 로컬 서재를 먼저 열고 Drive는 재연결 필요 상태로 표시한다. 자동 popup·무한 silent retry는 만들지 않는다.
- token 성공 뒤 permissionId와 appData registry의 folderId를 검증한다. permissionId가 다르면 owner를 전환하고, permissionId는 같고 folderId만 바뀌면 owner는 유지한 채 cloud listing/cache와 이전 in-flight 요청을 폐기한다.
- 모든 Drive request는 dispatch 시점의 token, ownerKey, driveSessionId와 generation을 명시적으로 받아 stale closure가 새 owner state를 갱신하지 못하게 한다.
- 기존 token/expiry/OAuth state key와 URL fragment는 정확한 key만 1회 정리한다. `localStorage.clear()`는 사용하지 않는다.
- Drive cache key를 `ownerKey + driveSessionId + resource`로 바꾸고 token 교체, 401, logout, owner 변경에서 폐기한다.
- 명시적 Drive 연결 해제에서는 GIS revoke를 best-effort로 호출하되 revoke 실패가 로컬 logout·cache 정리를 막지 않게 한다.
- registry 비인증 오류는 제한된 sync status로 노출하고 backoff를 적용한다.

### 완료 조건과 검증

- token 원문이 localStorage, sessionStorage, IndexedDB, Cache Storage, URL, 로그와 Map key에 남지 않는다.
- permissionId 검증 전 다른 namespace를 열지 않는다.
- reload, token 성공/오류, expiry, 401, cache purge, owner 변경과 늦은 응답이 테스트로 고정된다.
- 동시 token 요청과 동일 계정의 canonical folder 교체가 테스트로 고정되며 기존 오프라인 서재는 숨거나 삭제되지 않는다.
- Drive 단위 테스트, 기존 browser regression, `npm run check`가 통과한다.

## Phase 8: Service Worker 캐시와 업데이트 생명주기

### 목표

민감한 응답을 cache하지 않고 읽는 중인 앱을 새 worker가 자동 교체하지 않게 한다.

### 작업

- cache 판정을 pure helper로 만들고 runtime과 테스트가 같은 정책을 사용하게 한다.
- non-GET, cross-origin, Authorization, Range, `/__/auth/`, `/__/firebase/`, `/api/`, private/no-store, non-200/opaque 응답을 우회한다.
- 앱 shell, `/_next/static/`, Foliate runtime, font, 7z/zip, manifest와 icon만 allowlist로 cache한다.
- navigation은 network-first와 `/` fallback만 사용하고 임의 HTML을 runtime cache에 추가하지 않는다.
- precache는 필수 shell과 선택 asset을 구분해 선택 자산 하나의 실패가 설치 전체를 막지 않게 한다.
- 자동 `skipWaiting()`과 update 시 자동 takeover를 제거하고 `SKIP_WAITING` message에서만 waiting worker를 활성화한다. 첫 설치와 update의 `clients.claim()` 정책을 구분한다.
- waiting worker 감지와 사용자 적용 UI를 추가한다. 리더가 열려 있으면 자동 reload하지 않고 **현재 로컬 IndexedDB 저장 transaction** 완료까지만 기다린 뒤 한 번 reload한다. offline에서 끝나지 않을 수 있는 원격 outbox flush는 기다리지 않는다.

### 완료 조건과 검증

- 민감 경로·header·response가 Cache Storage에 들어가지 않는다.
- 정적 asset은 offline에서 열리고 arbitrary same-origin GET catch-all cache는 없다.
- 새 worker는 사용자 승인 전 기존 session을 takeover하지 않는다.
- offline 상태에서도 local progress commit 뒤 update를 적용하고 outbox는 재시작 후 계속 처리한다.
- Node cache 정책 테스트, 기존 browser regression, Chromium/WebKit Cache Storage e2e와 `npm run check`가 통과한다.
- cache version은 아직 `1.6.6`이다.

## Phase 9: 전체 품질 게이트와 1.7.0 릴리스

### 목표

모든 검증을 clean checkout과 CI에서 재현하고 Rules를 앱보다 먼저 배포한 뒤 version surface를 한 번에 변경한다.

### 작업

- `test:node`, `test:rules`, 기존 CDP `test:browser`, Playwright `test:e2e`, `check`, `check:full`의 역할을 중복 없이 정리한다.
- CI를 static/node/build, Firestore emulator, CDP browser, Playwright Chromium/WebKit job으로 나눈다. production secret은 사용하지 않는다.
- v4 migration, v1 bridge, 2 owner/2 device sync, 악성 EPUB, private/no-store response fixture를 고정한다.
- 동일 release candidate commit으로 iPad Safari/PWA, Android Chrome/PWA, desktop Chromium을 검증한다.
- production v1 데이터와 Rules, 이전 web deployment를 백업·기록한다.
- 현재 production Rules의 project/date/hash를 확인하지 못하면 Rules 배포를 진행하지 않는다.
- v1/v2 호환 Rules를 먼저 배포하고 본인 v1/v2 허용·다른 UID 거부 smoke test를 실행한다.
- Rules 검증 뒤 package, lockfile, Service Worker cache, release/browser 기대값을 `1.7.0`으로 한 번에 맞춘다.
- 최종 `check:full`, release test와 production smoke test가 통과한 동일 commit을 배포한다.

### 완료 조건과 검증

- clean checkout에서 `npm ci && npm run check:full`이 통과하고 CI required job이 모두 green이다.
- security/sync test skip이 없고 실기기 blocker가 없다.
- 실행 코드·현재 테스트·cache의 version surface가 모두 `1.7.0`이다.
- Rules가 앱보다 먼저 배포되며 backup, deployment ID, rollback 절차가 기록된다.
- 롤백 시 v1/v2 Rules와 v4/v5 데이터를 삭제하지 않는다. 1.6.6 UI에는 v2-only 변경이 보이지 않는 한계를 릴리스 노트에 명시한다.

## 핵심 검증 시나리오

| ID | 시나리오 | 기대 결과 |
| --- | --- | --- |
| V01 | A 30% offline → B 70% → A reconnect | 자동 덮어쓰기 없이 conflict 표시 |
| V02 | 한 기기에서 offline set→set→reset | 예상 revision chain대로 반영, 자기 충돌 없음 |
| V03 | 두 기기에서 서로 다른 북마크 추가 | 둘 다 유지 |
| V04 | bookmark delete와 stale edit | tombstone 자동 부활 없음 |
| V05 | progress reset과 stale set | reset 자동 부활 없음 |
| V06 | transaction 성공 후 local ack 실패·재시도 | receipt로 중복 revision 없음 |
| V07 | 같은 owner를 연 두 탭에서 worker 시작 | lease holder 하나만 전송 |
| V08 | leader 탭 종료·sleep 후 lease 만료 | 새 leader가 receipt 확인 후 안전하게 재개 |
| V09 | Firebase/Drive owner A→B 빠른 전환 | A 데이터·Promise·worker가 B에 미노출 |
| V10 | v4 migration 중단·quota 실패·재시작 | 원본 보존, idempotent resume, 검증 후 완료 |
| V11 | 다른 탭이 v4 DB 연결 유지 | blocked 안내 후 연결 종료·재시도 가능 |
| V12 | 1.6.6 offline v1 write → 1.7.0 update → reconnect | v2 자동 overwrite 없이 legacy conflict 후보 |
| V13 | 1.6.6 탭과 1.7.0 탭 동시 사용 | v1 변경이 v2를 조용히 덮지 않음 |
| V14 | v2 progress/bookmark 물리 삭제 | 로컬 자동 삭제 없이 `remote_missing` 격리 |
| V15 | malicious EPUB | script/storage/network/navigation/CSS remote URL 모두 차단 |
| V16 | token 만료·401·새로고침 | token/cache 정리, 로컬 서재 유지, Drive 재연결 |
| V17 | 동일 Drive 계정에서 canonical folder 교체 | stale cache 폐기, owner local data 보존 |
| V18 | auth/Firebase/API/Authorization/private/Range 응답 | Cache Storage에 없음 |
| V19 | 리더를 연 상태에서 새 worker 설치 | local commit 뒤 prompt 적용·reload 1회 |
| V20 | TXT/EPUB/PDF/ZIP/CBZ/7z 기본 열기 | 기존 포맷 회귀 없음 |
| V21 | Chromium/WebKit 통과 후 실제 iPad Safari | 일반·fixed layout·media-overlay 유지 |

## 릴리스 차단 조건

- 오래된 offline event가 경고 없이 최신 progress를 덮어쓴다.
- 정상적인 연속 local event가 잘못된 base revision 때문에 자기 자신과 충돌한다.
- 두 탭이 같은 owner outbox를 독립 worker로 전송한다.
- 동시 북마크나 reset/delete가 유실·자동 부활한다.
- event 성공 후 local ack 실패가 중복 revision을 만든다.
- v4 migration이 원본을 변경하거나 검증 실패를 완료로 처리한다.
- 다른 탭 때문에 IndexedDB upgrade가 무한 대기하거나 복구 경로가 없다.
- 1.6.6 pending/후속 v1 변경이 사용자 선택 없이 v2를 덮어쓴다.
- 다른 Firebase/Drive owner의 데이터나 비동기 결과가 현재 owner에 노출된다.
- publication script, parent/storage 접근, top navigation, popup, 외부 request가 성공한다.
- CSS/URL 경로로 sanitizer를 우회해 외부 요청이나 script 실행이 가능하다.
- bearer token이 memory 밖에 지속되거나 token 원문이 cache key·로그에 남는다.
- 민감한 응답이 Cache Storage에 들어가거나 Service Worker가 사용자 승인 없이 takeover한다.
- 다른 UID가 Rules test에서 접근하거나 v1 호환 Rules가 실패한다.
- production Rules 기준선을 확인하지 않은 채 새 Rules를 배포한다.
- security/sync test가 skip되거나 clean checkout의 `check:full`이 실패한다.
- 기존 포맷 또는 iPad Safari 핵심 EPUB 회귀가 실패한다.

## 구현 상태

| Phase | 상태 | 핵심 증거 | 비고 |
| --- | --- | --- | --- |
| 1. 기준선·직접 결함·EPUB 게이트 | 자동 검증 완료 | `test:formats` 42개, lint/typecheck/Node 전체, production build, Chromium/WebKit sandbox fixture와 CDP 회귀 통과; WebKit bug 218086 대응 renderer sanitizer/CSP 경계 확정 | 없음 |
| 2. owner storage·migration·auth lifecycle | 자동 검증 완료 | v5 schema/CRUD, v4 보존 migration·lease·검증, generation guard, 선택 dialog와 loading 가시성; fake IndexedDB 테스트와 1100권 v4→v5 CDP migration 회귀 통과 | 실기기 저장공간/quota 확인은 실기기 단계 |
| 3. Firestore schema와 Rules | 자동 검증 완료 | v1/v2 strict schema와 호환 Rules, progress/bookmark atomic receipt·revision·tombstone·권한 거부, 실제 transaction 동시 conflict/replay를 demo emulator 8개 테스트로 통과 | production Rules 기준선 확인·백업·배포는 push 전에 별도 승인 필요 |
| 4. 진행률 sync core·멀티탭 lease | 자동 검증 완료 | 원자 enqueue, revision chain/coalescing, conflict, retry, IndexedDB lease/epoch, stale claim 회수, receipt idempotency, generation guard와 실제 emulator transaction 통과 | 실제 다중 기기 네트워크 전환은 실기기 단계 |
| 5. listener·bookmark·v1 bridge·runtime | 자동 검증 완료 | bookmark별 revision/tombstone, active-book listener, `docChanges()` 직렬 처리·`remote_missing`, v1 fingerprint bridge, 충돌 3선택 UI; storage/sync 44개와 emulator/CDP 회귀 통과 | production의 1.6.6/1.7.0 실제 동시 탭은 배포 후 실기기 단계 |
| 6. EPUB 실행 경계 | 자동 검증 완료 | DOM sanitizer/CSP와 renderer fail-closed 재검증, script·handler·nested document·위험 URL·CSS escape 차단; format 42개 및 Chromium/WebKit 보안·입력 E2E 통과 | 다양한 실제 EPUB 호환성은 실기기 단계 |
| 7. GIS token과 Drive cache | 자동 검증 완료 | GIS single-flight, memory-only token/expiry, legacy key·fragment 정리, permissionId+canonical folder owner 전환, owner/session cache 폐기와 reload offline namespace; Drive 41개 및 CDP 회귀 통과 | 실제 Google consent·계정 교체는 Vercel 배포 후 실기기 단계 |
| 8. Service Worker | 자동 검증 완료 | 정적 allowlist, 인증·Range·API·private/no-store 우회, WebKit-safe `waitUntil`, 사용자 승인 update와 local commit 대기; 정책 6개, Chromium/WebKit Cache Storage·waiting-worker E2E, CDP 회귀 통과 | 실제 PWA update UX는 실기기 단계 |
| 9. CI와 릴리스 | 실기기 전 자동 검증 완료 | `check:full`, 분리 CI, Node/build, Rules emulator 8개, Playwright Chromium/WebKit 10개, CDP production 회귀 모두 통과 | production Rules 기준선·배포, 1.7.0 version 일괄 변경, commit push/Vercel/실기기 테스트는 사용자 호출 후 진행 |

각 Phase를 완료할 때 실제 변경 파일, 실행한 명령과 결과, 미실행 검증, 남은 문제를 해당 Phase 아래 또는 구현 상태 표에 기록한다.
