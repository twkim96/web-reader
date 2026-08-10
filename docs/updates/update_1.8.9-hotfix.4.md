# Web Reader 1.8.9 hotfix.4 — live generation reconcile·TTS progress fence·crash journal

작성일: 2026-08-10

기준: 1.8.9 Phase A + [hotfix.1](./update_1.8.9-hotfix.1.md)~[hotfix.3](./update_1.8.9-hotfix.3.md) working tree 외부 재리뷰

상위 문서: [update_1.8.9.md](./update_1.8.9.md), [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: P1 2건·P2 1건 수정·전체 자동검증·외부 재리뷰 완료. 기존 finding은 닫혔고 신규 P2 2건은 [hotfix.5](./update_1.8.9-hotfix.5.md)로 후속

## 목표

열린 reader에서 book deletion marker만 상승해도 삭제 전 주석이 남지 않게 한다. TTS 이동은 metadata 유실이나 기존 timer와 무관하게 읽기 위치를 저장하지 않게 하고, active-gap 강제 종료 복구에서도 마지막 실제 발화 구간을 보존한다.

## 수용한 finding

### 1. marker-only live generation reconciliation

- authoritative marker listener가 새 delete head를 remote cache에 저장한 직후 같은 owner·book partition을 별도 IndexedDB transaction에서 재검사한다.
- local annotation마다 cached remote upsert의 `bookGeneration`을 현재 marker revision과 비교한다.
- pending/in-flight/blocked/conflict/paused outbox 또는 open/deferred conflict가 있으면 local intent를 보존한다.
- local work가 없고 cached generation이 marker보다 오래된 annotation만 제거한다.
- owner/book dispose와 AbortSignal은 transaction 전체를 중단하며 stale 결과로 반환한다.
- 실제 제거가 있으면 `notifyAnnotationSyncChange()`를 발생시켜 열린 reader overlay와 관리 UI를 즉시 다시 읽는다.

회귀 테스트는 generation 9 annotation을 hydrate한 뒤 annotation snapshot 재발행 없이 marker만 10으로 올려 즉시 제거되는지, pending local work는 보존되는지를 각각 검증한다.

### 2. TTS progress persistence fence

production artifact를 추가해 다음을 함께 기록했다.

- relocate reason·navigation source·CFI와 fence 상태
- user-change, pending relocate schedule, save-current, save-attempt
- 실제 `progress-v5.put()` CFI·progress·호출 stack

재현 결과, TTS metadata가 없는 새 relocate만의 문제가 아니라 TTS 시작 전에 예약된 relocate timer가 나중에 실행될 수 있는 경로도 확인됐다.

수정 결과:

- TTS utterance 시작 전에 progress fence를 동기적으로 활성화한다.
- fence 중에는 reason/source가 없더라도 모든 relocate가 persistable baseline을 바꾸지 못한다.
- fence 진입 시 기존 relocate timer를 취소하되 pending 사용자 위치 자체는 보존한다.
- visibility·강제 flush는 TTS viewport를 새 위치로 저장하지 않는다. 기존 pending 사용자 위치가 있으면 그 위치만 저장할 수 있다.
- TTS 정지 뒤 Foliate의 늦은 anchor/page event를 막기 위해 350ms tail fence를 둔다.
- 실제 탭·휠·키보드 입력의 `markUserProgressChange()`는 tail을 즉시 해제해 다음 사용자 이동을 정상 저장한다.

production regression은 55문장 이동, network retry/skip, visibility recovery, 취침 타이머, 이어듣기 전체에서 sentinel 동등성과 `progress-v5` write 0건을 함께 확인한다.

### 3. active-gap crash journal end

- `active-run → active-gap`에서 실제 interval end를 추가할 때 `lastHeartbeatAt`도 그 시각 이상으로 갱신한다.
- 복구 end는 `closedAtClient` 또는 `lastHeartbeatAt`만 사용하지 않고 마지막 journaled interval end와의 최댓값을 사용한다.
- 마지막 heartbeat 뒤 종료된 실제 발화가 draft에 기록돼 있다면 PWA 강제 종료 뒤에도 잘리지 않는다.

## Phase B 관찰로 이관

`activeIntervals` 장기 이력 성능은 현재 정확성 결함이 아니다. 합성 5,000 session × 50 interval 표본은 개발 Mac Node에서 약 731ms·heap 78MB였으므로 다음을 Phase B iPad/PWA 관찰 항목으로 추가한다.

- 전체·기간별 통계 modal 첫 표시 시간
- 장기 JSON/Markdown export 시간과 메모리 압박
- background 복귀 뒤 재집계 시간
- 필요 시 worker, 월별 aggregate cache, interval chunking, lazy all-history 계산 순서로 후속 설계

## 자동검증

- `npm run check:full`: 통과
- ESLint: 제품 오류 0, 기존 Foliate vendor 경고 2
- TypeScript·production build: 통과
- Node: formats 59/59, drive 49/49, archives 33/33, storage 252/252, shelf 63/63, Service Worker 9/9, release 3/3 — 합계 468/468
- Firestore Rules: 27/27
- Chromium/WebKit Playwright: 14/14
- `git diff --check`: 통과

### production Chrome 반복 판정

- 최종 product build에서 full regression 완주: 3회
- TTS progress no-write assertion에 도달한 실행: 4/4 통과
- 후속 반복 1회는 TTS assertion 통과 뒤 long-PDF canvas timeout
- 나머지 빠른 연속 반복은 TTS 전에 기존 selection 장기 evaluate의 detached iframe realm에서 중단

따라서 hotfix.3의 단순 `3/3` 표현은 폐기한다. TTS 제품 finding은 현재 도달 표본에서 재현되지 않았지만, full production regression 10/10은 기존 harness P3 때문에 아직 증명되지 않았다.

## 완료 조건

- marker만 상승해도 local work 없는 구세대 annotation이 즉시 제거된다.
- TTS 전체 lifecycle에서 persistable baseline과 `progress-v5`가 바뀌지 않는다.
- active-gap crash journal이 마지막 닫힌 interval end를 복구한다.
- 외부 재리뷰에서 P0~P2가 없음을 확인한다.
- production 장기 harness P3는 제품 gate와 분리해 안정화한 뒤 Phase B 시작 여부를 최종 판정한다.

## 외부 재리뷰 후속 판정

- marker-only 정리, pending local intent 보존, TTS progress fence, crash journal은 의도대로 수정된 것을 확인했다.
- 같은 working tree에서 production Chrome `check:full`과 추가 2회가 연속 완주했다.
- 단일기기 Phase B는 시작 가능하다.
- marker 저장과 reconcile 사이의 다중 탭 race, TTS fence 진입 전 pending 위치의 crash durability는 신규 P2로 확인되어 hotfix.5에서 원자화·즉시 저장한다.
- hotfix.5 재리뷰 전에는 다중 탭·다중기기 acceptance와 release-ready 판정을 보류한다.
