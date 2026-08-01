# Web Reader 1.7.6 저장 내구성과 경합 방어

작성일: 2026-07-13

기준 커밋: `e80cd10`

## 목표

1.7.5.2 전체 코드 리뷰를 현재 코드와 대조해 재현 가능하거나 실패 경로가 명확한 결함을 수정한다. 이미 삭제된 로컬 도서를 복원하는 일은 범위에서 제외하지만, 남은 구버전 기기와 이후 스키마 변경에서 같은 손실이 반복되지 않도록 마이그레이션 원칙과 회귀 검증을 강화한다.

## 리뷰 판정

| 항목 | 판정 | 1.7.6 처리 |
| --- | --- | --- |
| v6→v7에서 현재 도서 store 삭제 | 수용 | `oldVersion` 조건부 마이그레이션으로 v6 이상 active store 보존, v6 보존 회귀 테스트 추가 |
| 다음 DB 버전에서도 active store 재삭제 가능 | 수용 | active store 삭제는 해당 전환 구간에만 허용하고 미래 mock upgrade 테스트·가이드라인 추가 |
| 진행률 IndexedDB 실패를 성공으로 처리 | 수용 | 저장 callback을 비동기 commit 결과 계약으로 변경하고 실패 시 dirty·persisted marker 유지 및 사용자 오류 표시 |
| reset outbox 실패 전 UI부터 초기화 | 수용 | reset commit 성공 후에만 화면 상태를 변경 |
| 첫 원격 위치가 사용자 조작을 덮어씀 | 수용 | 사용자 interaction·dirty·commit 중 상태에서는 조용한 이동 금지, jump generation과 실패 처리 추가 |
| 기기 시계 오차를 timestamp로 비교 | 보류 | 서버 동기화 충돌은 revision으로 판정하지만 리더 UI의 로컬 progress에는 대응 revision이 없어, 스키마 계약을 먼저 확장해야 함 |
| Service Worker가 최초 commit 집합만 대기 | 수용 | 대기 중 추가된 commit까지 0개가 될 때까지 drain |
| Drive 취소 직후 같은 세션 재시도 실패 | 수용 | 취소 시 stale single-flight 제거, 현재 context만 Promise 공유 |
| BroadcastChannel 매 알림 생성·hidden 탭 wake | 부분 수용 | 탭당 공유 channel과 hidden subscriber 무시 적용 |
| paused outbox가 사용자에게 보이지 않음 | 보류 | 로컬 commit 실패 표시는 이번에 추가하되 transport paused 진단·dead-letter UI는 안정적인 오류 분류 계약과 함께 별도 설계 |
| outbox·conflict 이력 무제한 증가 | 보류 | receipt·tombstone의 최대 오프라인 보존 기간과 로컬 진단 보존 정책을 먼저 확정해야 함 |
| 전체 progress collection listener 비용 | 보류 | 개인 서재 규모에서는 합리적이며 실제 문서 수·read·수화 시간 측정 후 최적화 |
| TXT·iPad ZIP worker 전환 | 보류 | 50~150MB TXT와 1,000장 이상 CBZ의 실기기 profile을 먼저 확보 |
| OAuth memory-only 전환·CSP 재설계 | 보류 | 현재 redirect/session 복구는 설치형 Edge 호환을 위한 의도된 결정이며 별도 보안 호환성 검증 필요 |

## 개발 단계

### Phase 1. 파괴 없는 IndexedDB 업그레이드

- [x] upgrader에 `oldVersion`을 전달한다.
- [x] v5 이하의 계정 종속 도서 cache만 한 번 폐기하고 v6 이상의 device-global 도서는 보존한다.
- [x] v6 Blob·metadata·inspection 보존과 신규 인덱스 추가를 검증한다.
- [x] 현재 스키마 이후 mock upgrade에서 active store가 삭제되지 않는 계약을 검증한다.

### Phase 2. 진행률 commit 계약

- [x] 로컬 저장·outbox 생성 실패를 호출자에게 반환한다.
- [x] 실제 commit 성공 전에는 리더의 persisted marker를 갱신하지 않는다.
- [x] 실패 시 dirty 상태를 유지하고 사용자에게 재시도 가능한 저장 오류를 알린다.
- [x] 진행률 reset은 outbox/local commit 성공 후 UI에 반영한다.

### Phase 3. 첫 원격 이어읽기 경합 방어

- [x] 책을 연 뒤 사용자 조작이 있었거나 로컬 저장이 pending이면 자동 이동하지 않는다.
- [x] `goTo()` 실패 시 원격 위치를 처리 완료로 기록하지 않는다.
- [x] 여러 원격 jump가 겹치면 최신 generation만 완료 처리한다.

### Phase 4. 업데이트·Drive·wake 경합 보강

- [x] Service Worker 적용 전 새로 생긴 local commit까지 모두 drain한다.
- [x] Drive cancel 직후 같은 session 재시도가 새 요청을 시작한다.
- [x] progress wake 채널을 탭 단위로 공유하고 hidden 탭은 broadcast wake를 건너뛴다.

### Phase 5. 릴리스 검증

- [x] package/lock/Service Worker cache를 1.7.6으로 맞춘다.
- [x] lint, typecheck, 전체 Node 테스트, production build를 통과한다.
- [x] Firestore Rules, Playwright, production browser regression을 통과한다.

## 구현 결과

- 로컬 DB upgrader는 `oldVersion`을 받고, v5 이전의 호환되지 않는 계정 종속 도서 cache만 폐기한다. v6 이후 active store는 인덱스만 추가하고 데이터를 보존한다.
- 진행률 화면 상태와 실제 commit 기준선을 계정·도서별로 분리했다. 실패한 낙관적 화면 값을 성공으로 오인하지 않으며, 같은 위치 재시도도 원래 bookmark·progress mutation을 다시 계산해 outbox에 기록한다.
- 리더 저장 callback은 `Promise<boolean>`을 반환한다. 성공 전에는 persisted marker와 마지막 reader session을 갱신하지 않고, 실패하면 dirty 상태와 pending 위치를 유지하면서 하단 오류 안내를 표시한다.
- reset은 로컬 progress와 outbox의 원자적 commit이 끝난 다음 화면을 0%로 바꾼다.
- 첫 원격 이어읽기는 사용자 조작·dirty·commit 중 상태에서 자동 이동하지 않는다. 원격 jump는 직렬화하고 generation을 검사해 느린 과거 요청이 최신 요청 뒤에 최종 위치가 되지 않게 한다.
- Service Worker update drain, Drive 동일 세션 취소 재시도, BroadcastChannel 탭 공유와 hidden wake 억제를 적용했다.

## 자동검증 결과

- lint: 앱 코드 오류 0건, 기존 Foliate vendor 경고 2건
- TypeScript typecheck 통과
- 전체 Node 테스트 212개 통과
- v6→v7 도서 Blob·metadata·inspection·progress 보존 및 mock v7→v8 보존 테스트 통과
- Drive cancel→same-session retry 및 update drain 중 follow-up commit 테스트 통과
- Next.js 1.7.6 production build 통과
- Firestore Emulator Rules/transaction 테스트 9개 통과
- Playwright Chromium/WebKit 테스트 10개 통과
- production Chrome browser regression 통과, `pc-reader-v1.7.6` cache와 이전 cache 제거 확인

## IndexedDB 개발 가이드라인

1. `deleteObjectStore()`는 “현재 store 정리”가 아니라 `oldVersion < N`처럼 정확한 전환 구간에만 둔다.
2. active store의 인덱스 추가는 store를 삭제·재생성하지 않고 versionchange transaction 안에서 누락된 인덱스만 만든다.
3. DB 버전을 올리는 변경은 최소한 empty→current, 직전 버전→current, 가장 오래 지원하는 버전→current, current→future mock 보존 테스트를 동반한다.
4. 도서 Blob, metadata, archive inspection, Firebase 진행률 중 무엇을 폐기하는지 계획 문서에 각각 명시한다. 명시되지 않은 데이터는 보존이 기본값이다.
5. migration 완료 표식은 데이터 변환 transaction과 분리하지 않는다. 예외·중단 시 일부 삭제만 완료된 상태를 성공으로 간주해서는 안 된다.
6. 로컬 원본을 삭제하는 마이그레이션은 Drive 사본 존재를 추정하지 않는다. 복구 경로 또는 사용자의 명시적 동의가 없으면 배포하지 않는다.

## 실기기 확인

자동검증과 커밋 완료 후 사용자가 Vercel 배포본에서 수행한다.

- v6 상태가 남은 브라우저가 있다면 업데이트 후 오프라인 도서와 archive index가 유지되는지 확인
- 책을 열자마자 페이지를 넘긴 뒤 늦게 Firebase 진행률이 도착해도 위치가 되돌아가지 않는지 확인
- 저장소 차단·용량 오류 시 저장 실패 안내가 보이고 다음 조작에서 저장을 다시 시도할 수 있는지 확인
- Drive 연결을 취소한 직후 같은 계정으로 다시 연결해 정상적으로 도서 목록이 로드되는지 확인
