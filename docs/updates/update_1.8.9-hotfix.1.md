# Web Reader 1.8.9 hotfix.1 — Phase A 경합 후속 안정화

작성일: 2026-08-10

기준: 1.8.9 Phase A working tree 외부 리뷰

상위 문서: [update_1.8.9.md](./update_1.8.9.md), [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: 리뷰 finding 구현·전체 자동검증 완료 기록. 외부 재리뷰 신규 finding은 [hotfix.2](./update_1.8.9-hotfix.2.md)에서 후속 처리

## 목표

Phase B 실기기 테스트의 결과를 왜곡할 수 있는 원격 진행률 command, 통계 leader lease와 짧은 문장 TTS 경합을 먼저 닫는다. 새 기능이나 retention 삭제는 추가하지 않는다.

## 수용한 finding

### 1. 원격 진행률 command와 최신 remote head 결합

- command finalize는 boolean 대신 `committed`, `stale`, `local-changed`, `cancelled`를 구분한다.
- stale head가 확인되면 이전 화면 이동을 먼저 rollback한 뒤 최신 conflict preview로 새 command를 만든다. rollback과 최신 command navigation이 서로 덮지 않게 `afterRollback` 경계를 추가했다.
- commit된 progress를 reader의 persisted/persistable ref에 반영해 화면 위치와 IndexedDB 기준이 같은 remote head를 가리키게 한다.
- reader를 닫거나 다른 책으로 전환하면 parent가 staged command를 취소한다. conflict 자체는 unresolved로 남아 서재 badge에서 다시 검토할 수 있다.

### 2. stale resolver UI 처리

- progress·bookmark와 annotation·palette resolver가 stale remote head 때문에 `null`을 반환하면 성공으로 모달을 닫지 않는다.
- 최신 conflict를 다시 읽고 “원격 상태가 변경됨”을 표시한 채 사용자의 선택을 다시 받는다.

### 3. 독서 통계 lease lifecycle과 transaction fencing

- runtime lifecycle generation을 추가해 hidden, unmount, owner 전환 뒤 늦게 끝난 acquire가 lease를 되살리지 못하게 한다.
- lifecycle별 holder ID를 분리해 이전 acquire의 정리가 같은 tab의 새 lease epoch를 만료시키지 못하게 한다.
- acquire 직후 visibility와 owner를 다시 검사한다.
- hydration page commit과 upload acknowledgement/defer transaction에 v13 lease store를 포함하고 holder·epoch·expiry를 같은 IndexedDB transaction 안에서 검증한다.
- 한 run은 시작 당시 claim에 고정된다. heartbeat 도중 다른 epoch를 얻더라도 이전 run continuation은 폐기된다.

### 4. hydration 계측

- remote read attempt, 성공한 remote read, commit page, completed/lost-leadership/failed run을 구분해 durable meta에 누적한다.
- fetch 또는 commit 뒤 leadership을 잃어도 이미 발생한 read와 commit 수는 0으로 사라지지 않는다.
- 결과 기록은 성공 run에만 한정하지 않고 `finally`에서 수행한다.

### 5. 짧은 문장 TTS 통계 — hotfix.2에서 대체

- `playing -> starting/loading -> playing` 사이에 400ms bounded grace를 둔다.
- grace 안의 문장 전환은 동일한 logical TTS session을 유지해 1초 미만 문장이 각각 삭제되거나 session 문서가 문장 수만큼 늘지 않게 한다.
- grace를 넘긴 gap, pause, stop, finished, error, hidden과 unmount는 마지막 실제 playing 경계에서 닫는다.
- browser regression은 연속 문장 이동 전후 active TTS draft의 session ID가 같은지 확인한다.

재리뷰에서 400ms 안의 침묵이 duration에 포함되고 긴 gap 사이 1초 미만 발화가 유실되는 것을 확인했다. hotfix.2는 고정 grace 대신 logical session과 실제 playing 누적을 분리한다.

### 6. production Chrome progress sentinel fixture

- regression query에서만 현재 reader의 공개 flush callback을 노출한다.
- TTS progression sentinel을 IndexedDB에 주입하기 전에 pending progress save를 flush해 늦은 정상 save가 sentinel을 덮는 harness race를 제거한다.

## 문서 정정

- A2의 자동 fixture는 migration 승인 gate의 입력 계약을 검증한 것이며 실제 7·30·90일 offline 복귀 증거가 아니다.
- 실제 사용자 표본, 장기 offline 재접속, authoritative snapshot·합계 동등성, rollback과 구버전 재접속은 Phase B 증거로 남긴다.
- 자동 deletion/archive는 계속 비활성이다.

## 보류

### trailing malformed `uploadedAtServer` 반복 조회

공식 client와 Rules로 만들 수 없는 손상 문서의 마지막 구간은 다음 incremental hydration에서 다시 quarantine될 수 있다. document snapshot cursor를 durable schema에 추가하면 query와 migration 범위가 커지고 정상 데이터 안전성 이득이 작으므로 이번 hotfix에는 넣지 않는다.

Phase B에서 실제 발생 여부를 관찰하고, 발견되면 관리자 repair/delete 또는 별도 document-name cursor migration으로 처리한다.

## 자동검증

- `npm run check:full`: 통과
- ESLint: 제품 오류 0, 기존 Foliate vendor 경고 2
- TypeScript·production build: 통과
- Node: formats 59/59, drive 49/49, archives 33/33, storage 237/237, shelf 62/62, Service Worker 9/9, release 3/3
- Firestore Rules: 26/26
- Chromium/WebKit Playwright: 14/14
- production Chrome: 같은 production build에서 `check:full` 포함 3/3 통과
- `git diff --check`: 통과

## 완료 조건

- lease late acquire, old epoch hydration/ack 차단, leadership 상실 직전 계측 테스트 통과
- remote jump rollback 뒤 최신 command 시작 순서 테스트 통과
- production Chrome에서 TTS logical draft 연속성과 progress sentinel 유지
- `npm run check:full`과 `git diff --check` 통과
- 외부 재리뷰 P0~P2 없음 뒤 Phase B 시작
