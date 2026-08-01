# Web Reader 1.8.1-hotfix.2 동시 읽기 근접 위치 경합 안정화

작성일: 2026-08-01

기준 커밋: `383fcca`

상위 계획: `update_1.8.x_plan.md`

구현 커밋: `1740956 fix(sync): settle negligible cross-device conflicts`

상태: 구현·전체 자동검증·commit·push 완료, 실기기 검증 대기

## 목표

두 기기에서 같은 책을 동시에 읽을 때 발생하는 strict revision 경합은 그대로 감지하되, 일반 원격 이동 안내에서도 무시하는 `0.03% 이하`의 근접 위치는 로컬 저장이 완전히 끝난 경우에만 조용히 원격 값으로 정리한다.

## 리뷰 판정

| 항목 | 판정 | 처리 |
| --- | --- | --- |
| 일반 이동 안내 임계값 이하인데 global conflict 모달이 표시됨 | 수용 | 두 정책이 같은 진행률 거리 기준을 공유 |
| 한 번 이동한 활성 리더가 저장 완료 후에도 자동 해결 불가 | 수용 | 시작 무조작과 저장 완료 조건을 분리 |
| 리비전 불일치를 무시하거나 stale event의 base를 재작성 | 기각 | strict transaction과 conflict record 유지 |
| 의미 있는 거리의 다른-device 위치까지 자동 채택 | 기각 | 기존 사용자 선택 모달 유지 |

## 원인과 판정

- 일반 원격 위치 안내는 진행률 차이가 `0.03%`보다 클 때만 사용자에게 이동 여부를 묻는다.
- 진행률 저장은 CFI 또는 stable anchor가 바뀌면 퍼센트 차이가 작아도 outbox event를 만든다.
- 두 기기의 event가 같은 `baseRevision`에서 생성되면 먼저 도착한 event만 server head를 갱신하고 다른 event는 의도대로 conflict가 된다.
- hotfix.1의 자동 해결은 stable anchor 완전 동등, 같은 device의 더 최신 event, 이전 session의 무조작 재개만 처리했다. 서로 다른 device의 근접 CFI는 빠져 있었다.
- 활성 리더 자동 해결도 “이번 mount에서 한 번도 조작하지 않음” 조건을 재사용했으므로, 사용자가 한 페이지라도 넘긴 뒤에는 저장이 끝났어도 자동 해결할 수 없었다.

## 보존 계약

- Firestore transaction의 `remoteRevision === baseRevision` 검사는 변경하지 않는다.
- event receipt, revision chain, lease epoch, IndexedDB outbox와 conflict record를 변경하지 않는다.
- `progress.reset`, remote reset/missing, 수동 책갈피 upsert/delete와 뒤따르는 blocked event는 계속 사용자 선택을 요구한다.
- 진행률 차이가 `0.03%`보다 큰 서로 다른 기기의 현재-session 위치는 계속 모달로 남긴다.
- 자동 원격 채택 전 conflict의 로컬 위치를 기존 자동 책갈피로 보존한다.

## 명시적 제외

- Firestore schema·Rules, IndexedDB schema version과 outbox transaction 변경
- client timestamp만 이용한 다른-device last-write-wins
- reset·책갈피 충돌 자동 해결
- 1.8.2 메모·팔레트 또는 1.8.3 annotation 동기화

## Phase 1 — 거리 정책 통합

상태: 완료

- 일반 원격 이동 안내와 global conflict 정책이 하나의 `hasMeaningfulProgressDelta()` 기준을 공유한다.
- 현재-session·서로 다른 device라도 진행률 차이가 `0.03% 이하`면 `nearby-position` 자동 해결 후보로 분류한다.

## Phase 2 — 활성 리더 저장 완료 판정

상태: 완료

- 시작 재개용 `isQuietResumeEligible()`와 활성 리더 저장 완료용 `isProgressConflictAutoResolveEligible()`를 분리한다.
- 활성 리더 저장 완료는 미저장 사용자 변경, 예약 relocate 저장, in-flight commit이 모두 없을 때만 참이다.
- 이전 session 복구는 기존의 무조작 조건을 유지하고, 동등 위치·같은 device 최신 위치·근접 위치에만 새 저장 완료 조건을 사용한다.
- 정책 판정 뒤 사용자가 다시 이동하면 expected local position과 runtime eligibility 재검사로 React 위치 적용을 중단한다.

## Phase 3 — 릴리스 버전·회귀 검증

상태: 완료

- package, Service Worker와 Foliate runtime cache를 `1.8.1-hotfix.2`로 맞춘다.
- 기존 sync transaction·outbox·bookmark·reader·PWA 회귀를 전체 실행한다.

## 완료 조건

- 근접 current-session 다른-device 경합은 저장 완료 후 모달 없이 해소된다.
- 미저장·예약 저장·전송 중에는 자동 해소하지 않는다.
- 의미 있는 거리, reset, 책갈피와 blocked chain은 기존 모달과 conflict record를 유지한다.
- 전체 자동검증을 통과하고 실기기 검증 항목은 결과 확인 전까지 대기로 남긴다.

## 자동검증 계획

- 근접한 다른-device current-session 충돌과 의미 있는 거리 충돌의 정책 경계를 단위 테스트로 고정한다.
- 한 번 조작했더라도 저장 완료 상태는 자동 해결 가능하고, 미저장·예약·전송 중 상태는 불가능함을 검증한다.
- 기존 previous-session, stable anchor, same-device, reset, bookmark, blocked event 테스트를 유지한다.
- release version, Foliate runtime cache와 Service Worker cache를 `1.8.1-hotfix.2`로 맞춘다.
- `npm run check:full`과 `git diff --check`를 실행한다.

## 실기기 검증 대기

- PC와 휴대폰에서 같은 책을 같은 위치로 연 뒤 양쪽에서 짧게 번갈아 페이지를 넘겨 근접 경합 모달이 사라지는지 확인한다.
- 한 기기에서 미저장 이동 중 다른 기기 값이 도착하면 자동으로 위치가 바뀌지 않는지 확인한다.
- 충분히 떨어진 위치에서 동시에 읽으면 기존 `[현재 기기 값 유지] / [원격 값 사용]` 모달이 유지되는지 확인한다.
- reset과 수동 책갈피 충돌은 계속 사용자 선택을 요구하는지 확인한다.
- 충돌 전 로컬 위치가 자동 책갈피로 남아 복구 가능한지 확인한다.

## 자동검증 결과

- `npm run check:full`: 통과
- ESLint: 오류 0, 기존 Foliate vendor 경고 2개
- TypeScript: 통과
- Node 전체 테스트: 통과
  - formats 57/57
  - storage 100/100 — 근접 current-session 다른-device 경합과 저장 완료 상태 분리 테스트 포함
  - shelf 32/32 — 일반 원격 위치 `0.03%` 기준 공유 확인
  - Service Worker 9/9, release 2/2와 기존 drive·archive suite 통과
- production build: 통과
- Firestore Rules·transaction: 9/9 통과
  - 동시 progress transaction은 기존대로 한 event만 적용하고 다른 event를 conflict로 보존
  - receipt replay, reset tombstone, stale progress와 bookmark 충돌 보호 유지
- Playwright Chromium/WebKit 직렬 실행: 12/12 통과
- production Chrome regression: 통과
  - `pc-reader-v1.8.1-hotfix.2` cache와 versioned Foliate entry 확인
- `git diff --check`: 통과

첫 sandbox 실행은 제품 테스트와 typecheck까지 통과한 뒤 Turbopack PostCSS 보조 프로세스의 port bind가 차단되어 build에서 중단됐다. 같은 소스를 정상 로컬 권한으로 `check:full` 전체 재실행해 마지막 production Chrome까지 통과했으며 제품 실패로 판정하지 않는다.

구현 커밋 `1740956`을 `origin/main`에 push했고, push 직후 local HEAD와 `origin/main`이 `174095691ae73bc74523ba1c4992a1e6754205d4`로 일치함을 확인했다.
