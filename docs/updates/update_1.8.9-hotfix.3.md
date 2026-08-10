# Web Reader 1.8.9 hotfix.3 — 삭제 generation·원격 command 취소·TTS 시간축 정합성

작성일: 2026-08-10

기준: 1.8.9 Phase A + [hotfix.1](./update_1.8.9-hotfix.1.md) + [hotfix.2](./update_1.8.9-hotfix.2.md) working tree 외부 재리뷰

상위 문서: [update_1.8.9.md](./update_1.8.9.md), [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: P1 3건 수정·전체 자동검증 완료. 후속 재리뷰 P1 2건·P2 1건은 [hotfix.4](./update_1.8.9-hotfix.4.md)에서 보강

## 목표

hotfix.2에서 남은 세 경합을 닫는다. 일반 주석 hydration도 도서 삭제 generation을 지키게 하고, 원격 위치 command 취소를 실제 IndexedDB transaction 중단으로 연결하며, TTS 통계는 침묵을 제외하되 실제 wall-clock 위치를 보존한다.

## 수용한 finding

### 1. 일반 annotation hydration의 book-deletion generation fence

- 첫 authoritative annotation snapshot은 delete-marker listener의 첫 authoritative 결과를 기다린 뒤 hydration을 시작한다.
- hydration transaction 안에서 같은 owner·book의 marker remote-head cache를 읽는다.
- upsert의 `bookGeneration`이 현재 marker revision보다 작으면 로컬에 적용하지 않는다.
- 삭제 전 주석이 이미 로컬에 남아 있고 pending event·open/deferred conflict가 없다면 같은 transaction에서 제거한다.
- marker generation과 같은 새 upsert는 정상 적용한다.

이로써 conflict resolver뿐 아니라 로그인·재접속·첫 snapshot을 포함한 공통 hydration 경로도 도서 삭제 이전 주석을 되살리지 않는다.

### 2. staged remote progress command의 transaction-level 취소

- command마다 `AbortController`를 만들고 command ID와 함께 보관한다.
- command 교체, Back, 명시 취소, consume, owner 변경에서 해당 controller를 즉시 abort한다.
- `resolveSyncConflictUseRemoteV5()`는 signal을 IndexedDB readwrite transaction 전체 수명에 연결한다.
- transaction이 진행 중일 때 취소되면 `tx.abort()`로 progress, outbox, conflict, meta, remote-head write 전체를 rollback한다.
- transaction 완료 뒤 발생한 abort는 안전하게 무시하며 listener는 `finally`에서 제거한다.

따라서 마지막 `canCommit()` 한 번과 실제 commit 사이의 틈에서 취소된 command가 원격 값을 확정할 수 없다.

### 3. TTS 실제 wall-clock active interval

- monotonic origin을 침묵 길이만큼 이동하던 hotfix.2 모델을 제거했다.
- logical TTS session에 실제 wall-clock `activeIntervals`와 현재 열린 interval 시작점을 기록한다.
- `playing → starting/loading`에서 실제 재생 interval을 닫고, 다시 `playing`이 되면 실제 재개 시각으로 새 interval을 연다.
- session의 `startedAtClient`·`endedAtClient`는 실제 첫/마지막 재생 시각을 유지하고, `durationMs`만 active interval 합으로 계산한다.
- 집계는 interval 각각에 clock correction, 날짜 경계 split, 기기 간 overlap 제거를 적용한다.
- 기존 interval 없는 screen/TTS record는 기존 `ended-start=duration` 계약으로 그대로 읽는다.
- interval 수는 session당 512개로 제한하며, client parser는 모든 interval의 순서·범위·합계를 검증한다.

Firestore Rules는 owner 전용 immutable write라는 기존 경계 안에서 list 크기와 첫/마지막 interval, session wall span, duration 상한을 검사한다. Rules 언어에서 임의 길이 list 전체를 순회할 수 없으므로 중간 interval의 완전한 순서·합계 검증은 공통 client parser가 담당하고, 손상 record는 hydration·집계에서 격리한다.

## 회귀 테스트

- marker 10 뒤 generation 9 annotation upsert 미적용
- marker 10과 같은 generation 10 upsert 적용
- outbox write 중 command abort 시 progress·conflict·outbox 전체 rollback
- TTS active interval IndexedDB round-trip
- 실제 10분 wall span 중 5분 재생 record와 다른 기기 screen overlap dedup
- Rules에서 정상 active interval 허용과 session 시작점 불일치 거부
- production browser에서 현재 장 TTS logical session과 열린 active interval draft 유지

## 자동검증

- `npm run check:full`: 통과
- ESLint: 제품 오류 0, 기존 Foliate vendor 경고 2
- TypeScript·production build: 통과
- Node: formats 59/59, drive 49/49, archives 33/33, storage 248/248, shelf 63/63, Service Worker 9/9, release 3/3
- Firestore Rules: 27/27
- Chromium/WebKit Playwright: 14/14
- production Chrome: 당시 같은 수정 build 3회 통과. 후속 재리뷰 반복에서 TTS progress 1회 실패가 확인되어 hotfix.4에서 fence와 write artifact를 추가
- `git diff --check`: 통과

## 완료 조건

- 일반 hydration에서 현재 delete marker보다 오래된 주석이 복구되지 않는다.
- 취소된 원격 진행률 command가 transaction 일부 또는 전부를 commit하지 않는다.
- TTS 침묵은 통계 duration에서 빠지지만 실제 시간대·날짜·기기 간 overlap 위치는 유지된다.
- 누적 `check:full`, 같은 build production Chrome 3회, `git diff --check`를 통과한다.
- 외부 재리뷰에서 P0~P2가 없음을 확인한 뒤 Phase B 실기기 검증으로 이동한다.
