# Web Reader 1.7.9 기기간 동기화 복구 안정화

작성일: 2026-07-23

기준 커밋: `e687a27`

## 목표

1.7.8의 revision·receipt·outbox 계약은 유지하면서, iPad와 PC 사이에서 한 기기만 한동안 오래된 진행률을 표시할 수 있는 수신 리스너 종료·백그라운드 복귀·lease 만료 복구 경로를 닫는다. Drive는 도서 원본, Firebase는 진행률·북마크라는 경계를 유지하며 DB schema와 Firestore 문서 형식은 변경하지 않는다.

## 리뷰 판정

| 항목 | 판정 | 1.7.9 처리 |
| --- | --- | --- |
| `onSnapshot` 오류 뒤 progress/bookmark 수신 영구 종료 | 수용 | 세대 격리된 재구독 controller와 capped backoff 추가 |
| 수신 오류가 콘솔에만 남고 화면에는 정상으로 표시 | 수용 | 송신·수신 health를 하나의 상태 배너로 통합 |
| rules 배포·token 갱신 뒤 송수신 재개 시점 부족 | 수용 | online·foreground·ID token 변경에서 실패한 수신과 paused 송신 재개 |
| `stale_lease` 뒤 기본 30초 poll 대기 | 수용 | 100ms active poll로 새 epoch·receipt 복구를 즉시 유도 |
| Firestore warm cache를 즉시 화면에 채택 | 유지 | stale cache가 로컬 intent를 덮지 않도록 첫 authoritative server snapshot 대기 |
| 백그라운드 저장을 별도 localStorage journal로 이중화 | 보류 | 현재 1초 debounce·5초 상한·hidden flush를 유지하고 실기기 재현 계측 후 판단 |
| 영속 동기화 감사 로그·관리 화면 | 보류 | 개인정보·보존 정책과 실제 진단 필요성을 먼저 확정 |
| DB migration·Firestore schema 변경 | 제외 | 1.7.9는 lifecycle 복구만 수행 |

## Phase 1 — snapshot listener 복구

상태: 완료

- progress와 active-book bookmark listener를 동일한 복구 controller로 관리한다.
- 종료된 listener만 재구독하고, 이전 세대 callback과 timer는 새 구독에 영향을 주지 못하게 한다.
- listener callback의 IndexedDB 처리 실패도 같은 세대를 종료하고 authoritative snapshot부터 다시 수화한다.
- auth·permission·일시 오류는 1/5/15/30/60초 capped backoff로 복구하고, schema 계열 오류는 무한 재시도하지 않는다.
- 재구독마다 server hydrator와 bookmark accumulator를 새로 시작해 authoritative snapshot을 다시 수화한다.

완료 조건: terminal error → retry → authoritative snapshot 복구, stale callback 무시, dispose 정리 회귀 테스트 통과.

## Phase 2 — 송수신 health와 복귀 wake 통합

상태: 완료

- 수신 상태를 `healthy`, `retrying-receive`, `paused-auth`, `blocked-permission`, `blocked-schema`로 분류한다.
- 기존 송신 outbox health와 수신 health를 우선순위에 따라 하나의 배너로 합친다.
- online·visible·Firebase ID token 변경에서 실패한 listener와 paused auth/permission event를 즉시 재시도한다.

완료 조건: 수신 오류가 사용자에게 보이고, 복구 snapshot 뒤 배너가 자동으로 사라지는 테스트 통과.

## Phase 3 — stale lease 빠른 복구

상태: 완료

- transport가 15초 lease를 넘겨 `stale_lease`를 반환하면 idle 30초가 아니라 active 100ms poll을 예약한다.
- 기존 새 epoch 발급, in-flight 회수, immutable receipt replay 계약은 변경하지 않는다.

완료 조건: `stale_lease` poll delay와 기존 idle/apply/error 정책 회귀 테스트 통과.

## Phase 4 — 1.7.9 릴리스 정리와 검증

상태: 완료

- package/lockfile/Service Worker/browser regression/release test를 1.7.9로 통일한다.
- lint, typecheck, 전체 Node 테스트, production build, Firestore Rules, Playwright, production browser regression을 실행한다.
- 검증 완료 전에는 이 문서의 phase를 완료로 표시하지 않는다.

## 보류 가이드

- iPad background suspension에서 IndexedDB commit 자체가 중단되는 재현이 확보되면 local recovery journal을 별도 schema와 함께 설계한다.
- 수신 오류의 장기 이력은 현재 상태 배너로 원인이 부족하다는 실제 사례가 다시 생길 때 최소 보존 필드부터 추가한다.
- outbox ready queue, TXT/CBZ worker, app CSP는 1.7.8의 보류 결정을 유지한다.

## 구현 결과

- progress와 active-book bookmark listener를 `SnapshotListenerRecovery`로 통합했다. terminal listener error와 비동기 snapshot 처리 실패는 현재 세대를 폐기하고, 1/5/15/30/60초 capped backoff로 새 listener를 붙인다.
- controller가 snapshot 처리를 세대별로 직렬화한다. 실패한 snapshot 뒤에 이미 대기하던 이전 세대 callback은 실행 전에 폐기되며, 재구독마다 server hydrator와 bookmark accumulator를 초기화한다.
- authoritative server snapshot이 정상 처리된 뒤에만 수신 health를 `healthy`로 되돌린다. warm cache는 기존처럼 로컬 intent를 덮지 않는다.
- 앱 재실행 직후 네트워크·인증 복원 과정에서 발생하는 첫 recoverable listener 오류는 조용히 한 번 재시도한다. 재시도도 실패한 지속 장애만 상태 배너에 표시하며, 자동 복구 불가능한 schema 오류는 즉시 표시한다.
- progress·bookmark 수신 health와 기존 outbox 송신 health를 하나의 우선순위 상태로 합치고, 재연결·인증·권한·schema 오류를 하단 배너에 표시한다.
- online·foreground·Firebase ID token 변경에서 실패한 수신 listener와 paused auth/permission event를 즉시 재시도한다. `unauthenticated`와 두 Firebase token-expired 코드를 같은 인증 health로 처리하며, owner가 바뀐 뒤의 늦은 callback은 기존 owner outbox를 깨우지 않는다.
- `stale_lease`는 100ms active poll로 새 epoch 획득과 immutable receipt replay를 빠르게 이어간다.
- package, lockfile, Service Worker, release/browser tests를 1.7.9로 통일했다. DB version과 Firestore schema/rules는 변경하지 않았다.

## 자동검증 결과

- ESLint: 앱 코드 오류 0건, 기존 Foliate vendor 경고 2건
- TypeScript typecheck 통과
- Node 회귀 테스트 241개 통과
- Next.js 1.7.9 production build 통과
- Firestore Emulator Rules/transaction 테스트 9개 통과
- Playwright Chromium/WebKit 보안·Service Worker 테스트 10개 통과
- production Chrome browser regression 통과
- Service Worker `pc-reader-v1.7.9` cache 생성, 이전 `pc-reader-*` cache 제거, precache 8개 적중 확인

검증 메모: production Chrome 회귀의 첫 새 프로필 실행은 기능 fixture 진입 전 게스트 Firebase Auth bootstrap이 30초 안에 끝나지 않아 중단됐다. 동일 빌드의 두 번째 독립 새 프로필 실행은 runtime error 없이 전체 통과했으며, 구현 경로에서 반복 실패는 재현되지 않았다.
