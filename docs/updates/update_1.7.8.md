# Web Reader 1.7.8 개발 계획

## 목표

1.7.7 리뷰에서 현재 코드로 재현 가능한 동기화·삭제·북마크 생명주기 결함을 닫는다. Drive는 도서 원본, Firebase는 진행률·북마크라는 경계를 유지하며 새 마이그레이션이나 계정 종속성은 추가하지 않는다.

## 리뷰 판정

| 항목 | 판정 | 1.7.8 처리 |
| --- | --- | --- |
| 만료된 동일 탭 lease의 epoch 재사용 | 수용 | 살아 있는 lease 연장만 epoch 유지, 만료·해제 후 재획득은 새 epoch 발급 |
| quiet resume의 영속 outbox/conflict 미확인 | 수용 | 원격 채택 transaction에서 해당 progress target의 활성 작업을 원자적으로 검사하고 화면 이동 전에 채택 |
| progress reset 후 Drive 삭제 실패 | 수용 | Drive 삭제를 먼저 수행하고 404를 멱등 성공으로 처리한 뒤 reset·로컬 제거 진행 |
| 실행 중 worker wake 유실·health 오류로 polling 정지 | 수용 | wake 요청을 coalesce하고 health 오류와 다음 fallback 예약을 격리 |
| 북마크의 `currentCfi` 선행 guard | 수용 | Foliate `lastLocation`을 먼저 읽고 CFI·퍼센트를 같은 relocation frame에서 저장 |
| GitHub Actions Node 20 경고 | 수용 | 공식 Node 24 runtime 기반 action major로 갱신 |
| target 단위 ready queue | 보류 | 개인용 정상 outbox 규모에서는 이득보다 DB schema·transaction 복잡도와 회귀 위험이 큼 |
| 대형 TXT·iPad ZIP worker | 보류 | 실제 iPad/대형 fixture 계측 후 별도 버전에서 결정 |
| app-level CSP | 보류 | Google·Firebase·Drive origin 수집과 report-only 실기기 검증이 선행되어야 함 |
| 구 DB 추가 migration | 제외 | 개인용 정책상 v6/v7 active data 보존 원칙을 유지 |

## Phase 1 — lease generation 복구

상태: 완료

- 만료되지 않은 동일 탭 lease만 기존 epoch를 연장한다.
- 동일 탭이라도 만료되거나 release된 lease는 새 epoch를 발급한다.
- 장시간 transport 뒤 `stale_lease`가 발생해도 다음 flush에서 in-flight event를 복구하고 receipt 재처리로 제거한다.

완료 조건: L01·L02 회귀 테스트 통과.

## Phase 2 — quiet resume의 local intent 보호

상태: 완료

- progress target의 `pending`, `in_flight`, `blocked`, `conflict`, `paused` event와 open/deferred conflict를 검사한다.
- remote head 검증, local intent 검사, progress 채택을 하나의 IndexedDB transaction으로 묶는다.
- quiet resume은 채택 성공 후에만 `goTo()`하고, 차단되면 기존 이어읽기 prompt로 전환한다.

완료 조건: local 30% outbox가 있을 때 remote 70%로 조용히 이동하지 않고, outbox가 없을 때만 기존 quiet resume이 유지됨.

## Phase 3 — 재시도 가능한 도서 삭제

상태: 완료

- Drive 도서는 Drive 삭제 성공 또는 404 확인 전에는 progress reset을 만들지 않는다.
- Drive 삭제 뒤 reset이 실패하면 local content·progress·책장 항목을 보존한다.
- 재시도 시 Drive 404를 이미 완료된 단계로 보고 reset과 local cleanup을 계속한다.
- local-only 도서는 기존 Firebase reset 경계를 유지한다.

완료 조건: Drive 401/403/timeout에서 progress reset 미호출, Drive 성공 후 reset 실패에서 local cleanup 미호출, 재시도 가능한 순서 테스트 통과.

## Phase 4 — worker wake와 북마크 frame 정합성

상태: 완료

- pump 실행 중 wake는 1회로 합쳐 현재 pump 직후 즉시 실행한다.
- health 조회 실패는 기록하되 fallback timer를 끊지 않는다.
- 북마크 생성은 live CFI 존재 여부로 판단하고 live relocation의 percent를 함께 저장한다.

완료 조건: W01·W02·B01 회귀 테스트 통과.

## Phase 5 — 릴리스 정리와 검증

상태: 완료

- 앱·lockfile·Service Worker cache·릴리스 테스트 버전을 1.7.8로 통일한다.
- GitHub Actions의 checkout/setup-node/setup-java를 공식 Node 24 runtime 기반 major로 갱신한다.
- lint, typecheck, Node 전체 테스트, production build, Firestore Rules, Playwright, production browser regression을 실행한다.

## 보류 가이드

- outbox ready queue는 실제 수천 건 fixture에서 claim 비용이 문제가 될 때 새 DB version과 함께 설계한다.
- TXT/CBZ worker는 10/50/150MB TXT와 100/1,000/5,000장 archive의 시간·메모리·취소 반응을 실기기에서 측정한 뒤 적용한다.
- app CSP는 report-only 위반 로그를 먼저 모으고 OAuth·Firestore·Drive·blob worker 경로를 확정한 뒤 강제한다.

## 구현 결과

- 만료되지 않은 동일 탭 lease만 기존 epoch를 유지하고, 만료 뒤 같은 탭이 재획득해도 새 epoch로 stale in-flight event를 복구한다.
- quiet resume은 progress target의 활성 outbox와 open/deferred conflict를 preflight하고, 같은 조건을 remote head 검증·local adoption transaction 안에서 다시 검사한다. adoption이 차단되면 화면을 이동하지 않고 이어읽기 prompt를 표시한다.
- Drive 도서 삭제는 Drive 삭제 또는 404 확인 뒤 progress reset과 local cleanup을 수행한다. Drive 오류에서는 progress를 유지하고, reset 실패에서는 local content와 책장 항목을 유지해 재시도할 수 있다.
- sync pump 실행 중 wake는 1회로 합쳐 즉시 후속 실행하며, health 조회 실패가 있어도 fallback polling을 계속한다.
- 북마크는 React `currentCfi`보다 Foliate live location을 먼저 검사하고, CFI와 progressPercent를 같은 relocation frame에서 저장한다.
- GitHub-hosted runner 호환 범위에서 checkout/setup-node를 v6, setup-java를 v5로 올려 action runtime을 Node 24 기반으로 전환했다.

## 자동검증 결과

- ESLint: 앱 코드 오류 0건, 기존 Foliate vendor 경고 2건
- TypeScript typecheck 통과
- Node 회귀 테스트 232개 통과
- Next.js 1.7.8 production build 통과
- Firestore Emulator Rules/transaction 테스트 9개 통과
- Playwright Chromium/WebKit 보안·Service Worker 테스트 10개 통과
- production Chrome browser regression 통과
- Service Worker `pc-reader-v1.7.8` cache 생성과 이전 cache 제거 확인
