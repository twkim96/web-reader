# Web Reader 1.8.3 하이라이트·메모·팔레트 동기화

상위 계획: [1.8.x 전체 개발 계획](./update_1.8.x_plan.md)

시작일: 2026-08-03

자동검증 완료일: 2026-08-08

기준 커밋: `9b29568` (`fix(reader): finalize annotation records UI for 1.8.2`)

상태: 개발·2차 재리뷰·전체 자동 gate 완료, 통합 실기기 검증 대기

후속 UI 조정: annotation 생성·변경·삭제 뒤 실행 취소 버튼의 노출 시간을 6초에서 1초로 단축했다. 저장·충돌 검증·inverse transaction 계약은 변경하지 않는다.

## 목표

1.8.1~1.8.2에서 만든 로컬 annotation과 owner별 팔레트를 기존 progress/bookmark v2와 분리된 Firestore 경로에서 오프라인 우선 방식으로 동기화한다. 기존 진행률·manual/auto bookmark·복구 계약은 변경하지 않는다.

## 범위

### 포함

- annotation 전용 payload·head·receipt schema와 Firestore Rules
- annotation ID별 revision chain과 upsert/delete tombstone
- 팔레트 전체를 하나의 작은 원자 설정 문서로 동기화
- annotation·palette outbox enqueue·claim·acknowledge·conflict
- active-book annotation listener와 authoritative snapshot hydration
- owner generation·active-book 변경 뒤 stale callback 차단
- 로컬 annotation 최초 멱등 업로드
- sync health·재시도와 기존 worker wake 경로 통합

### 제외

- 기존 bookmark를 annotation으로 변환
- 서로 다른 메모 문자열 자동 병합
- 모든 책의 annotation listener 상시 실행
- 라이브러리 전체 검색·내보내기
- 번역·사전·TTS

## 동기화 경계

### Firestore 경로

- annotation head: `.../libraries/local/annotationSyncV1/{bookId}/annotations/{annotationId}`
- annotation receipt: `.../annotationSyncV1/{bookId}/eventReceipts/{eventId}`
- 책 단위 aggregate: `.../libraries/local/annotationSyncV1/{bookId}`
- palette head: `.../libraries/local/annotationSettingsV1/palette`
- palette receipt: `.../annotationSettingsV1/palette/eventReceipts/{eventId}`

progress/bookmark의 `readingHistoryV2` 문서와 Rules는 그대로 유지한다.

### Annotation payload

- 동기화: ID, book ID, section index, range CFI, 원문·문맥, 색상, 메모, 진행 위치, 장, 생성·수정 client time
- 제외: `anchorState`

`anchorState`는 각 기기 renderer의 CFI 복원 결과이므로 원격 기기의 `unresolved` 상태를 다른 기기에 전파하지 않는다. 원격 payload를 로컬에 적용할 때는 `active`에서 시작하고 각 기기가 실제 범위를 복원하며 다시 판정한다.

### Palette payload

다섯 색의 표시명·의미를 고정 순서 배열 하나로 저장한다. 팔레트는 작고 항상 함께 표시되므로 색상별 문서보다 단일 revision chain이 원자성·read 비용·충돌 설명에 유리하다.

## 충돌·삭제 정책

- annotation ID마다 독립 revision을 사용한다.
- 책 단위 aggregate revision으로 서로 다른 annotation ID의 원본 range CFI 소유권·색상별 개수·전체 개수도 같은 transaction에서 직렬화한다.
- base revision이 원격 head와 다르면 자동 덮어쓰지 않고 conflict로 전환한다.
- delete는 문서를 제거하지 않고 revisioned tombstone을 남긴다.
- immutable receipt가 있으면 같은 event 재전송은 `already_applied`로 처리한다.
- palette 동시 변경도 자동 field merge 없이 한 문서의 revision conflict로 처리한다.
- authoritative server snapshot 전에는 원격 삭제나 빈 collection을 최종 상태로 간주하지 않는다.

## 구현 단계

### Phase 1 — Protocol·Rules·transaction

상태: 구현·집중검증 완료

- 정확한 annotation·palette payload/head/receipt validator
- target key와 Firestore 경로
- revision·receipt replay·tombstone transaction
- ownership·필드·revision·atomic receipt Rules
- schema·transaction·Rules 집중 테스트

검증 결과:

- annotation·palette schema/transaction 집중 검증 통과
- Firestore Rules·실 transaction: 기존 progress/bookmark 포함 15/15 통과
- `npm run check`: lint 오류 0(기존 Foliate vendor 경고 2), TypeScript, Node 전체 suite, production build 통과
- storage suite: 기존 동기화 회귀와 신규 protocol 테스트 포함 153/153 통과
- `git diff --check` 통과
- Rules에서 다른 사용자·비정규 scope·orphan receipt·revision jump·payload extra field를 차단

### Phase 2 — Local outbox·worker

상태: 구현·집중 검증 완료

- 기존 outbox store에 annotation·palette target 추가
- 로컬 mutation과 outbox event의 동일 IndexedDB transaction
- claim·lease·retry·acknowledge·conflict 연결
- progress/bookmark worker 계약 회귀

구현 결과:

- 기존 `outbox-v5`·lease·claim·retry worker에 annotation·palette target을 확장했다.
- annotation 생성·수정·메모·색상·일괄 변경·삭제와 outbox enqueue를 같은 IndexedDB transaction으로 묶었다.
- sync payload는 local put/delete 전에 검증해 동기 예외도 local/outbox 부분 커밋을 만들지 않는다.
- 팔레트 canonical 값을 IndexedDB v9 store로 옮기고 palette put과 outbox enqueue를 같은 transaction으로 묶었다. localStorage는 커밋 후 mirror로만 갱신한다.
- 도서 삭제도 로컬 콘텐츠·annotation 삭제·tombstone event를 하나의 transaction으로 처리한다.
- 같은 세션의 아직 claim되지 않은 변경은 target별로 coalesce하고, 충돌 중 추가 편집은 `latestLocalPosition`에 보존한다.
- 기존 progress/bookmark 충돌 resolver는 annotation/palette를 받지 않도록 경계를 유지했다.

### Phase 3 — Listener·hydration·최초 업로드

상태: 구현·집중 검증 완료

- active-book annotation snapshot listener
- authoritative full snapshot과 incremental change 구분
- remote upsert/tombstone의 로컬 원자 반영
- local-only annotation 최초 멱등 업로드
- palette listener와 owner별 localStorage 적용
- owner·book generation stale callback 차단

구현 결과:

- 현재 열린 책의 annotation collection만 구독하고, server authoritative snapshot 이전 cache 결과는 최종 상태로 적용하지 않는다.
- 원격 upsert·tombstone을 책 단위 제한·중복 범위까지 검증한 뒤 하나의 local transaction으로 적용한다.
- 첫 authoritative snapshot에서 서버에 없는 local ID만 최초 업로드하며, tombstone ID는 다시 살리지 않는다. 다른 앱 session이 만든 active event·conflict가 있으면 중복 bootstrap event를 추가하지 않는다.
- exact session echo는 기기 로컬 `anchorState`를 보존한다.
- owner generation이나 active-book effect가 바뀌면 hydration·최초 업로드 transaction을 중단한다.
- palette는 하나의 document listener로 수화하며 local pending/conflict가 있으면 원격 값으로 덮지 않는다.

### Phase 4 — 통합·리뷰·실기기 준비

상태: 구현·2차 재리뷰·전체 자동 gate 완료, 통합 실기기 검증 대기

- sync health와 재시도 trigger 통합
- 100개 annotation read/write 관찰
- 전체 `check:full`과 반복 Web GPT 리뷰
- 1.8.0~1.8.3 누적 Android/iPad/PWA 통합 실기기 검증표 확정

통합 결과:

- 기존 send/receive health와 annotation listener health를 하나의 상태 표시에 통합했다.
- annotation·palette 충돌은 기존 모달을 공유하되 전용 resolver로 분리했다.
- 원격 값 사용은 검증된 head를 로컬에 원자 반영하고, 현재 기기 값 유지는 원격 revision을 base로 새 event를 만든다.
- 원격 head가 명시적으로 없는 충돌은 annotation 삭제, palette 기본값으로 해석한다.
- 충돌 해소 결과는 현재 탭과 다른 탭의 주석 UI에 즉시 알린다.
- 로컬 mutation은 다른 탭에만 broadcast하고 원격 hydration은 현재 탭과 다른 탭 모두에 알린다. 숨김 탭의 책·팔레트 변경은 보류했다가 visible 전환 시 모두 재조회한다.
- 열린 페이지에서 원격 tombstone이 적용되면 기존 Foliate overlay를 제거하고, 원격 upsert는 현재 DB 목록을 다시 그린다.
- 인증 도서 삭제는 로컬 콘텐츠·주석 제거, 확인 가능한 annotation tombstone, 책 삭제 마커와 영속 삭제 의도를 한 IndexedDB transaction에 기록한다. worker가 재연결 뒤 서버의 최신 head revision을 읽어 remote-only 및 늦게 도착한 오프라인 upsert까지 강제 tombstone으로 재조정한다.
- 원격 head 없음은 annotation 삭제·palette 초기화로 명시하고, 중복 범위·20/100개 aggregate 제한 충돌은 재전송 대신 이 기기의 추가 항목 삭제만 안내한다.

## 재리뷰 반영

기준 커밋 `9b29568` 이후 working tree 재리뷰에서 보고된 P1 1건, P2 6건, P3 2건을 모두 재현 가능하거나 계약상 타당한 finding으로 수용했다.

- 책 단위 aggregate로 동일 범위·색상당 20개·책당 100개를 서버 transaction과 Rules에서 보장
- local annotation/outbox와 palette/outbox의 crash-atomic 저장
- session 변경 뒤 최초 업로드 중복 방지
- 도서 삭제 시 remote-only annotation tombstone 포함
- current tab·다른 tab·hidden tab overlay 갱신 경계 분리
- Rules의 CFI·비공백 quote·safe integer 제한을 공식 parser와 정렬
- remote missing 및 aggregate 제한 충돌의 실제 파괴 동작을 모달 문구에 명시
- owner뿐 아니라 active-book effect cleanup도 stale hydration을 차단

수정 뒤 production Chrome 회귀에서 로컬 색상 변경 broadcast가 같은 탭 메뉴를 닫는 경합을 추가로 발견했다. 로컬 커밋은 BroadcastChannel로 다른 탭에만 보내고, 원격 hydration·conflict resolution만 현재 탭 CustomEvent까지 발생시키도록 producer 경계를 분리해 해결했다.

### 2차 재리뷰 반영

후속 재리뷰의 P1 2건, P2 2건, P3 2건도 제품 계약에 맞는 finding으로 수용했다.

- 온라인 선조회에 의존하던 remote-only 도서 삭제를 영속 삭제 의도와 후속 reconciliation으로 바꿔 오프라인 삭제를 복구 가능하게 했다.
- 모든 인증 도서 삭제에 서버-visible 삭제 마커를 남기고, 마커보다 오래된 annotation upsert를 Rules에서 거부해 삭제 직후 늦게 도착하는 오프라인 변경의 부활을 막았다.
- 강제 삭제 event는 서버 최신 revision을 base로 tombstone을 만들며, 원격에 늦게 추가된 annotation도 다음 reconciliation에서 다시 수집한다.
- 서버 삭제 마커 commit과 빈 authoritative aggregate가 확인되면 영속 삭제 의도를 제거해 삭제된 책마다 주기적인 Firestore read가 계속 남지 않게 했다.
- multiline quote를 허용하도록 Rules의 비공백 문자열 검증을 parser 계약과 맞췄다.
- 클라이언트가 임의 값을 제공할 수 있던 range hash를 protocol에서 제거하고 aggregate에 원본 range CFI 집합을 저장한다. Rules는 accepted annotation head와 aggregate의 ID·range·색상·개수 변화가 정확히 대응하는지 검사한다.
- palette 문서가 없을 때도 기존 active target work를 먼저 확인해 앱 session 재시작 뒤 bootstrap event가 중복되지 않게 했다.
- active book cleanup은 진행 중 hydration IndexedDB transaction을 AbortSignal로 중단한다.
- aggregate 제한 충돌 문구는 원격 head가 실제로 없는 경우에만 삭제를 안내하고, 기존 annotation이면 원격 색상 유지 또는 원격 상태 복원을 안내한다.

## 완료 조건

- offline 생성·수정·삭제가 재연결 후 정확히 한 번 반영된다.
- receipt replay가 중복 revision을 만들지 않는다.
- 오래된 기기 재접속 후 삭제된 annotation이 부활하지 않는다.
- progress와 manual/auto bookmark 문서·로컬 상태가 annotation hydration으로 변경되지 않는다.
- active book·owner 전환 뒤 stale callback이 현재 UI나 저장소를 변경하지 않는다.
- 최초 업로드가 중단·재개돼도 ID별 중복 head를 만들지 않는다.
- 팔레트 변경이 양방향 반영되고 다른 owner와 섞이지 않는다.

## 검증 계획

- schema: exact field, 크기 제한, identity, `anchorState` 제외
- transaction: 최초 apply, receipt replay, stale conflict, tombstone, palette conflict
- Rules: owner/scope, atomic head+receipt, revision +1, immutable receipt, invalid payload 차단
- outbox: enqueue·coalesce 여부, sequence, lease, retry, ack, conflict
- hydration: authoritative empty snapshot, incremental upsert/delete, stale generation, 최초 업로드
- 전체 자동 gate 후 PC↔Android/iPad 통합 실기기 검증

## 현재 검증 결과

- schema·transaction·Rules 집중 검증 통과
- local annotation/outbox 원자성, coalesce, rollback, guest local-only 회귀 통과
- authoritative hydration, tombstone, pending local 보존, exact-session echo, 최초 업로드, stale owner 차단 통과
- annotation/palette 원격·로컬 충돌 해소와 검증 실패 rollback 통과
- 인증 도서 삭제의 annotation tombstone 원자 enqueue 통과
- 5색 각 20개, 총 100개 authoritative hydration과 색상 그룹 보존 통과
- ESLint 오류 0(기존 Foliate vendor 경고 2), TypeScript 통과
- Node: formats 58/58, drive 49/49, archives 33/33, storage 158/158, shelf 32/32, Service Worker 9/9, release 2/2 통과
- production build 통과
- Firestore Rules·실 transaction 22/22 통과. 초기 aggregate 색상 불일치와 잘못된 색상 증감, 강제 최신 revision tombstone, 삭제 마커 이후 stale upsert, multiline quote를 포함한다.
- Chromium/WebKit Playwright 12/12 통과
- production Chrome regression 통과. 원격 annotation tombstone/upsert의 live overlay 제거·복원과 1.8.3 Service Worker cache를 포함한다.
- `git diff --check` 통과
- 최신 2차 수정본에서 `npm run check:full` 전체가 한 번에 통과했다.
- PC↔Android/iPad/PWA 통합 실기기 결과는 아직 완료로 기록하지 않는다.
