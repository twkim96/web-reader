# Web Reader 1.8.9 hotfix.2 — 원격 command·주석 generation·TTS 계측 안정화

작성일: 2026-08-10

기준: 1.8.9 Phase A + [hotfix.1](./update_1.8.9-hotfix.1.md) working tree 외부 재리뷰

상위 문서: [update_1.8.9.md](./update_1.8.9.md), [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: 리뷰 finding 구현·전체 자동검증 완료. 후속 재리뷰 P1 3건은 [hotfix.3](./update_1.8.9-hotfix.3.md)에서 보강

## 목표

Phase B 결과를 왜곡할 수 있는 원격 진행률 snapshot 불일치, 도서 삭제 이전 주석 부활, TTS 중복 발화와 시간 오차를 닫는다. retention 삭제는 계속 비활성으로 두고 실기기 표본을 안전하게 내보낼 진단 경로만 추가한다.

## 수용한 finding

### 1. staged 원격 진행률 command의 exact-head 결합

> 후속 보강: 이 단계의 write 직전 취소 확인은 transaction commit 자체를 막는 fence가 아니었다. hotfix.3에서 command별 AbortSignal을 IndexedDB transaction에 연결했다.

- preview가 IndexedDB에서 읽은 실제 conflict snapshot과 remote revision·accepted event·operation·position을 함께 반환한다.
- command는 React closure의 오래된 conflict가 아니라 preview snapshot으로 생성한다.
- finalize transaction은 preview 당시 remote identity와 현재 conflict가 정확히 같을 때만 commit한다.
- command 취소 여부도 transaction write 직전에 확인해 reader 종료 뒤 conflict가 확정되는 경로를 차단한다.
- finalize가 반환한 authoritative bookmark를 reader state와 persisted baseline에 함께 반영한다.

### 2. obsolete remote navigation rollback·취소 fence

- renderer navigation 자체가 실패하거나 사용자 이동에 밀린 경우에는 기존처럼 pending preparation만 취소한다.
- remote navigation이 실제 commit된 뒤 command가 교체·취소된 경우에는 이전 viewport로 rollback한 후 preparation을 취소한다.
- command ID 변경·제거와 reader unmount는 child navigation generation을 폐기한다.
- Back은 shelf 전환 effect를 기다리지 않고 parent staged command를 먼저 명시적으로 취소한다.

### 3. annotation book-deletion generation

> 후속 보강: 이 단계는 conflict resolver 경로를 막았지만 일반 hydration 경로가 남았다. hotfix.3에서 marker authoritative readiness와 hydration transaction의 generation 검사를 추가했다.

- keep-local replacement generation은 conflict snapshot과 현재 book-delete marker revision의 최댓값을 사용한다.
- use-remote의 annotation upsert가 현재 marker revision보다 오래되면 local annotation을 복원하지 않고 논리적 삭제로 처리한다.
- generation 9 conflict 뒤 marker 10 도착 시 keep-local은 generation 10을 사용하고, remote generation 9 annotation은 되살아나지 않는 회귀 테스트를 추가했다.

### 4. TTS pause/resume lifecycle

- resume 확인 timer를 별도 ref로 관리하고 generation, queue identity, utterance index, 현재 `loading` 상태를 모두 확인한다.
- start/end/error/stop/advance/finished/unmount에서 timer를 제거한다.
- resume 직후 기존 utterance가 자연 종료돼도 120ms timer가 같은 문장을 다시 시작하지 않는다.

### 5. 실제 playing 시간 기반 TTS 통계

> 후속 교체: monotonic origin 이동은 duration에서 gap을 제외했지만 session wall-clock 끝도 압축했다. hotfix.3의 실제 wall-clock `activeIntervals` 모델로 교체했다.

- 고정 400ms grace를 제거했다.
- 문장 사이 `starting/loading` 동안 logical TTS session은 유지하되 monotonic origin을 gap 길이만큼 이동해 침묵을 duration에서 제외한다.
- pause, stop, finished, error, hidden, unmount에서는 마지막 실제 playing 경계에서 닫는다.
- 여러 500ms 발화는 한 logical session의 실제 재생 시간으로 누적되고, 짧거나 긴 문장 사이 gap은 통계에 포함되지 않는다.

### 6. hydration query 계측

- 각 `getDocsFromServer()` 직전에 attempt, 성공 직후 successful read를 기록한다.
- malformed timestamp 때문에 한 logical page 안에서 추가 query가 발생해도 `committed page <= successful read <= attempted read` 관계를 유지한다.
- 후속 query가 실패하더라도 앞선 성공 read가 durable metrics에서 사라지지 않는다.

### 7. 손상 내성 retention diagnostics와 실기기 export

- raw reading session을 record별로 검증하고 손상 record를 집계에서 제외한다.
- `malformedRecordCount`를 별도로 보고해 local DB 손상 상황에서도 전체 진단 snapshot을 생성한다.
- 독서 통계 modal에 사용자 명시 동작인 `진단` JSON 다운로드를 추가했다.
- 진단 파일은 저장소 개수·대략적 byte·age·hydration·quota만 포함하며 도서 원문과 주석 메모는 포함하지 않는다.

## 보류

- trailing malformed `uploadedAtServer`의 durable document-name cursor는 기존과 같이 P3 관찰 항목이다. 공식 client·Rules로 생성할 수 없는 손상 데이터이며 자동 삭제·repair는 이번 hotfix에 넣지 않는다.
- retention migration과 archive는 Phase B의 실제 표본, offline 복귀, snapshot·통계 동등성, rollback 증거 전까지 observe-only다.

## 자동검증

- `npm run check:full`: 통과
- ESLint: 제품 오류 0, 기존 Foliate vendor 경고 2
- TypeScript·production build: 통과
- Node: formats 59/59, drive 49/49, archives 33/33, storage 244/244, shelf 63/63, Service Worker 9/9, release 3/3
- Firestore Rules: 26/26
- Chromium/WebKit Playwright: 14/14
- production Chrome: 같은 수정 production build에서 3/3 통과
- `git diff --check`: 통과

## 완료 조건

- exact remote head가 바뀐 command는 commit되지 않고 rollback 뒤 최신 command로 교체된다.
- commit된 뒤 obsolete가 된 viewport가 원래 위치로 복구된다.
- 도서 삭제 generation보다 오래된 annotation이 conflict resolver로 부활하지 않는다.
- pause/resume 자연 종료가 같은 문장을 중복 발화하지 않는다.
- TTS logical session은 짧은 발화를 합산하면서 gap을 duration에서 제외한다.
- 손상 local session이 있어도 진단 JSON을 내려받을 수 있다.
- `npm run check:full`, production Chrome 반복, `git diff --check` 통과 후 외부 재리뷰를 받는다.
