# Web Reader 1.8.3-hotfix.2 충돌 해결 일관성 보강

작성일: 2026-08-08

기준 커밋: `f6d5780` 위의 미커밋 `1.8.3-hotfix.1` working tree

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: 코드·전체 자동검증·커밋 완료, push·Rules 배포·실기기 검증 대기

## 목표

1.8.3-hotfix.1의 데이터 안전성 보강을 유지하면서, 충돌 해결이 최신 canonical local 상태를 사용하고 원격 위치 적용이 한 번만 실행되며 동기화 확인 UI가 앱 시작과 독서를 불필요하게 중단하지 않도록 한다.

## 리뷰 판정

| finding | 판정 | 처리 |
| --- | --- | --- |
| blocked chain보다 오래된 payload로 충돌 해결 | 수용 | resolver에서 canonical local store 재조회 |
| resolved remote progress가 재마운트 때 재실행됨 | 수용 | 소비 확인이 있는 일회성 command로 전환 |
| remote reset이 활성 reader viewport에 적용되지 않음 | 수용 | 첫 위치 이동과 save baseline 정리 |
| reader prompt와 전역 conflict modal 중복 | 수용 | outbox conflict revision으로 passive prompt 억제 |
| shelf·startup에서 전역 modal이 자동 표시됨 | 수용 | 비차단 동기화 확인 진입점과 active-book gating |
| defer가 메모리에만 남아 즉시 재등장 | 수용 | IndexedDB deferred state와 만료 시각 저장 |
| pending marker 직후 새 annotation이 옛 generation 사용 | 수용 | 취소 가능한 marker 폐기와 in-flight generation barrier |
| remote cache 없는 local annotation이 tombstone을 놓침 | 수용 | 최초 active snapshot에서 누락 local ID authoritative 확인 |
| 동일 기기 변경도 다른 기기로 표시 | 수용 | source가 확인되기 전까지 중립 문구 사용 |
| 의미 있는 이동 기준 0.03% 상향 | 보류 | stable anchor·section 증거 없이 수치만 바꾸면 정상 동기화가 누락될 수 있음 |

## 완료 조건

- 충돌 전 30% 이벤트 뒤 canonical local 35%가 있으면 keep-local과 복구 책갈피가 35%를 사용한다.
- 원격 progress command는 처리 후 제거되어 같은 책 재오픈 시 재실행되지 않는다.
- 원격 reset을 선택하면 활성 reader가 첫 위치로 이동하고 이전 위치를 다시 저장하지 않는다.
- 동일 target의 passive progress prompt와 outbox modal이 동시에 표시되지 않는다.
- shelf와 startup은 자동 full-screen conflict modal로 차단되지 않는다.
- defer는 책 전환과 앱 재실행을 넘어 정해진 기간 유지된다.
- pending/in-flight marker와 새 annotation이 불필요한 generation conflict를 만들지 않는다.
- cache가 없는 원격 tombstone도 bootstrap upload 전에 확인된다.

## 구현 결과

- progress·bookmark·annotation·palette의 `현재 기기 값 유지`는 conflict 생성 당시 payload가 아니라 선택 시점의 IndexedDB canonical record를 다시 읽는다.
- blocked chain의 표시용 latest payload도 마지막 active event를 사용하며, 원격 적용 시 복구 책갈피는 현재 canonical 읽기 위치에서 만든다.
- 원격 progress 적용은 `commandId`가 있는 `jump`·`reset` 일회성 command로 전달하고 reader 처리 뒤 즉시 소비한다.
- reset command는 활성 reader를 첫 위치로 이동시키며 기존 remote-jump save gating과 bookmark adoption을 함께 사용한다.
- outbox conflict revision과 사용자가 무시한 revision을 progress에 기록해 같은 원격 head의 reader prompt 재등장을 막는다.
- shelf·startup에서는 modal을 자동 표시하지 않고 `동기화 확인 필요` 진입점만 표시한다. reader 자동 표시는 현재 연 책과 일치하는 conflict로 제한한다.
- `나중에 결정`은 IndexedDB에 한 시간 동안 저장하며, 만료되거나 같은 target에 새 로컬 변경이 생길 때 다시 연다.
- 새 annotation이 아직 claim되지 않은 삭제 marker를 취소한다. marker가 in-flight이면 ack revision까지 기다린 뒤 실제 generation으로 전송한다.
- marker가 원격에 없다는 선택으로 끝난 경우 generation waiter는 0에서 안전하게 재개한다.
- 최초 active annotation snapshot에서 active query에 없는 모든 local annotation ID를 authoritative 단건 조회해 uncached tombstone을 bootstrap upload보다 먼저 수화한다.
- 충돌 source를 확정할 수 없는 문구는 `다른 기기` 대신 `클라우드` 기준의 중립 표현으로 바꿨다.

## 검증 계획

- canonical progress·bookmark·annotation·palette conflict resolver 테스트
- resolved jump 소비·재마운트·reset runtime 테스트
- active-book modal gating·defer persistence 테스트
- marker pending 취소·in-flight barrier·ack generation 테스트
- uncached tombstone bootstrap 테스트
- `npm run check:full`
- `git diff --check`

## 자동검증 결과

| 검증 | 결과 |
| --- | ---: |
| ESLint | 오류 0, 기존 Foliate vendor 경고 2 |
| TypeScript | 통과 |
| Node formats | 58/58 |
| Node drive | 49/49 |
| Node archives | 33/33 |
| Node storage | 176/176 |
| Node shelf | 32/32 |
| Service Worker | 9/9 |
| release metadata | 2/2 |
| production build | 통과 |
| Firestore Rules emulator | 22/22 |
| Chromium/WebKit Playwright | 12/12 |
| production Chrome regression | 통과 |
| `git diff --check` | 통과 |

집중 회귀에는 30% 전송 중 35% local blocked chain, canonical 복구 책갈피, defer 만료·재개, ignored revision, annotation·palette canonical resolver, pending·in-flight·remote-missing marker generation, uncached tombstone bootstrap, startup·shelf·active-reader 표시 조건을 포함했다.

## 남은 확인

- 외부 코드 재리뷰
- Android/iPad에서 두 기기 동시 읽기, defer 후 재실행, 원격 jump·reset, 주석 삭제 marker 뒤 새 highlight 생성 실기기 검증
- 변경된 Firestore Rules 배포와 push는 사용자 요청 시 별도로 진행

## 제외

- 별도 대형 sync center 화면
- tombstone·receipt 서버 물리 compaction
- progress distance 정책 수치 변경
- 실제 기기별 source metadata 표시
