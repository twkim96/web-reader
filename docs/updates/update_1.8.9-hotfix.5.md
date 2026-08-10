# Web Reader 1.8.9 hotfix.5 — marker transaction linearization·TTS pending progress durability

작성일: 2026-08-10

기준: 1.8.9 Phase A + [hotfix.1](./update_1.8.9-hotfix.1.md)~[hotfix.4](./update_1.8.9-hotfix.4.md) working tree 외부 재리뷰

상위 문서: [update_1.8.9.md](./update_1.8.9.md), [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: 신규 P2 2건 구현·전체 자동검증 완료, 외부 재리뷰 대기

## 목표

book deletion marker 적용과 구세대 주석 정리를 하나의 IndexedDB linearization point로 만들고, TTS 시작 직전에 저장 대기 중이던 마지막 사용자 위치의 crash durability를 기존 1초 수준보다 악화시키지 않는다.

## 수용한 finding

### 1. marker head·sync meta·stale annotation 원자 적용

hotfix.4는 authoritative marker head를 remote cache에 저장한 뒤 별도 transaction에서 stale annotation을 정리했다. 이 두 transaction 사이에 다른 탭의 메모 편집이 시작되면 삭제 전 annotation이 새 generation의 pending upsert로 다시 보존될 수 있었다.

수정 결과:

- marker head와 sync meta의 `knownRevision` 갱신, local annotation generation 검사, active outbox·conflict 검사, stale annotation 삭제를 하나의 readwrite transaction으로 합쳤다.
- 기존 cache가 더 높은 revision이면 낮은 marker snapshot으로 되돌리지 않고 기존 head를 기준으로 reconcile한다.
- local edit transaction이 먼저 확정되면 pending local intent를 보존한다.
- marker transaction이 먼저 확정되면 stale annotation이 이미 삭제되므로 뒤의 메모 편집은 `null`로 끝나고 generation 10 부활 event를 만들지 않는다.
- owner/book dispose 또는 AbortSignal은 marker cache와 annotation 정리를 함께 rollback한다.

회귀 테스트는 generation 9 annotation이 있는 상태에서 marker 10 적용과 실제 note-update API를 동시에 시작한다. marker가 먼저 linearize된 표본에서 annotation·outbox가 모두 비어 있고 note update가 실패하는 결과를 반복 확인한다. 기존 pending local work 보존 테스트도 같은 원자 API를 사용한다.

### 2. TTS fence 진입 전 pending 사용자 위치 즉시 저장

hotfix.4는 TTS fence를 켤 때 기존 1초 relocate timer를 취소했지만 pending 위치는 정상 flush까지 메모리에만 남겼다. 장시간 TTS 중 PWA나 브라우저가 강제 종료되면 마지막 사용자 위치의 durability window가 TTS 전체 재생 시간으로 늘어날 수 있었다.

수정 결과:

- TTS fence와 timer 취소를 먼저 동기 적용한다.
- 그 시점에 이미 캡처된 pending user relocate의 CFI·anchor·percent·bookmarks snapshot만 즉시 저장한다.
- 이후 TTS transient navigation은 fence에 막혀 snapshot이나 persistable baseline을 바꾸지 못한다.
- 같은 사용자 interaction generation에서 TTS utterance가 연속 시작돼도 동일 commit을 중복 생성하지 않는다.
- 이전 commit 중 새 사용자 이동이 발생하면 새 generation의 pending 위치는 이전 commit에 가로막히지 않고 별도로 저장할 수 있다.

pure regression은 `B pending → fence ON → C/D TTS 위치`에서 저장 callback이 B snapshot으로 한 번만 시작되는지와 pending이 없을 때 write를 만들지 않는지를 검증한다. 기존 production regression의 TTS lifecycle `progress-v5` no-write 검증은 TTS 자체 위치 오염 방어로 계속 유지한다.

## Phase B gate 분리

외부 재리뷰 결과 hotfix.4까지의 이전 핵심 finding은 닫혔고 production Chrome도 같은 working tree에서 3회 연속 완주했다. 따라서 다음 단일기기 검증은 hotfix.5 재리뷰와 병행할 수 있다.

- iPhone·iPad·Android 단일기기 UX·성능
- TTS 장시간 재생, background/foreground, 강제 종료 뒤 읽기 위치
- 장기 `activeIntervals`의 iPad/PWA 통계 modal·export 응답성

다음 항목은 hotfix.5 전체 gate와 외부 재리뷰 전에는 최종 합격 판정을 내리지 않는다.

- 다중 탭 marker/edit 경합
- 다중기기 annotation·palette·progress·statistics sync acceptance
- 1.8.9 release candidate 판정

## 자동검증

- TypeScript: 통과
- marker/edit 동시 회귀: 5회 반복 통과
- annotation sync local: 16/16 통과
- reader progress save policy: 6/6 통과
- Storage 전체: 255/255 통과
- `npm run check:full`: 통과
- ESLint: 제품 오류 0, 기존 Foliate vendor 경고 2
- Node: formats 59/59, drive 49/49, archives 33/33, storage 255/255, shelf 63/63, Service Worker 9/9, release 3/3 — 합계 471/471
- production build: 통과
- Firestore Rules: 27/27
- Chromium/WebKit Playwright: 14/14
- production Chrome regression: 통과
- `git diff --check`: 통과

## 완료 조건

- marker 저장과 stale annotation reconcile 사이에 다른 탭 mutation이 끼어들 수 없다.
- marker보다 먼저 확정된 local intent는 유지되고, marker 뒤의 stale edit는 부활 event를 만들지 않는다.
- TTS 시작 전에 대기 중인 사용자 위치가 즉시 저장되며 TTS 위치는 저장되지 않는다.
- 전체 자동 gate를 통과한다.
- 외부 재리뷰에서 새 코드 레벨 P0~P2가 없음을 확인한 뒤 다중 탭·다중기기 Phase B acceptance로 넘어간다.
