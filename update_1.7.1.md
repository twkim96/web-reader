# Web Reader 1.7.1 안정화 계획

> 2026-07-13: 1.7.0 호환 migration과 v1 bridge는 1.7.2에서 제거됐다. 현재 원칙과 구현 상태는 [update_1.7.2.md](./update_1.7.2.md)를 따른다.

기준: 외부 리뷰는 `fe62fcb`를 대상으로 했으며, 현재 구현 기준은 `dbeee99`다. 1.7.1은 1.7.0의 Firebase canonical sync 전환을 유지하면서 시간차·중단·부분 실패 결함을 보완한다.

## 리뷰 판정

| 항목 | 판정 | 1.7.1 처리 |
| --- | --- | --- |
| 과거 receipt replay가 진전된 head에서 실패 | 수용, P0 | receipt identity와 revision 단조성만 검증하고 최신 head로 ack |
| `syncLocalAndCloud`가 v1을 v5에 직접 저장 | 수용, P0 | 직접 진행률 reconciliation 제거, v1 listener 단일 경로 유지 |
| lease 삭제 뒤 epoch 재사용 | 수용, P0 | lease token을 claim에 포함하고 현재 claim은 token·tab·epoch 모두 비교 |
| progress와 여러 bookmark enqueue 부분 성공 | 수용, P1 | 한 IndexedDB transaction의 mutation batch로 통합 |
| 원격 충돌 선택 후 known revision 미갱신 | 수용, P1 | progress·meta·remote head·conflict를 같은 transaction으로 갱신 |
| bookmark snapshot 사이 누적 상태 유실 | 수용, P1 | owner/book별 remote head accumulator 유지 |
| lease/claim IndexedDB 오류 뒤 polling 정지 | 수용, P1 | pump 오류 backoff 후 항상 재예약 |
| migration의 전체 Blob `getAll()` | 타당하지만 현재 범위 제외 | 사용자 1인의 v4→v5 migration이 이미 완료돼 실행 경로가 다시 열리지 않는다. 미사용 범용 migration 재설계는 1.7.1에 넣지 않음 |
| 최초 v4가 local owner에 잘못 귀속 | 타당하지만 현재 범위 제외 | 같은 이유로 이미 확정된 owner 데이터를 다시 이동하지 않는다. 기존 원본과 1.7.0 transition record는 보존 |
| EPUB sandbox 실기기 증명 | 실기기 보류 | 자동 보안 검증은 유지하고 iPad Safari/PWA를 릴리스 게이트로 둠 |
| README OAuth 설명과 hook 명칭 | 수용 | GIS popup·memory-only token·재연결 동작으로 문서와 명칭 정리 |
| 진행 상태가 Drive scope에 종속 | 이미 해결 | `dbeee99`의 Firebase canonical sync scope를 유지 |

## Phase 1: receipt·v1·worker 생명주기

- 과거 receipt와 최신 head를 함께 허용하고 `knownRevision`을 최신 head까지 단조 증가시킨다.
- v1 진행률의 직접 IndexedDB 저장 경로를 제거한다.
- lease UUID token과 stale claim 복구를 추가한다.
- worker의 local 오류는 backoff 후 다음 poll에서 복구한다.

완료 조건: R01, R02, R03, R07 회귀와 기존 storage/Rules 테스트 통과.

## Phase 2: 로컬 mutation 원자성·충돌 해결

- 한 사용자 저장의 progress와 모든 bookmark change를 단일 IndexedDB transaction으로 enqueue한다.
- 오류 주입 시 local progress, outbox, sequence/meta가 전부 rollback되는 테스트를 둔다.
- 원격 선택 시 selected head, known revision과 local progress를 atomic하게 저장한다.

완료 조건: R04, R05 및 기존 conflict/sequence 회귀 통과.

## Phase 3: bookmark listener 누적 상태

- active owner/book별 remote bookmark head map을 초기 snapshot부터 누적한다.
- 별도 snapshot의 X 추가, Y 추가, X tombstone 순서를 검증한다.
- owner/book 변경과 listener 해제 시 accumulator를 폐기한다.

완료 조건: R06과 active-book listener 회귀 통과.

## Phase 4: 범위 판정·문서·릴리스

- v4 migration의 대형 Blob 읽기와 최초 owner 귀속은 이미 migration을 완료한 단일 사용자 조건에 따라 코드 변경 대상에서 제외하고 근거를 기록한다.
- README와 Drive hook 명칭을 GIS token client 기준으로 정리한다.
- package/lockfile/Service Worker/브라우저 기대 버전을 1.7.1로 일괄 변경한다.
- `check:full`과 CI를 통과한 동일 commit만 배포 후보로 삼는다.

실기기 게이트: 기존 기기의 canonical 전환 완료 후 신규 기기 sync, Drive 미연결·만료 상태, iPad Safari/PWA 악성 실제 ZIP EPUB.

## 구현 상태

| Phase | 상태 | 증거 |
| --- | --- | --- |
| 1. receipt·v1·worker 생명주기 | 자동 검증 완료 | 진전된 head의 과거 progress/bookmark receipt replay, v1 단일 진입 경계, lease generation 보존, polling 재개 회귀 통과 |
| 2. mutation 원자성·충돌 해결 | 자동 검증 완료 | progress+북마크 3개 batch 전체 commit/rollback, progress·bookmark 원격 선택 known revision 회귀 통과 |
| 3. bookmark listener 누적 상태 | 자동 검증 완료 | X 추가 → Y 추가 → X tombstone accumulator 회귀 통과 |
| 4. 범위 판정·문서·릴리스 | 실기기 전 자동 검증 완료 | 1.7.1 version surface, README GIS 설명, storage 59개, Rules 8개, Chromium/WebKit 10개, production build와 CDP browser 회귀 통과 |
