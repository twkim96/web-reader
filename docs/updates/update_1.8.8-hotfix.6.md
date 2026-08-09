# Web Reader 1.8.8-hotfix.6 충돌 확정 시점 동시성 방어

작성일: 2026-08-10

기준: [update_1.8.8-hotfix.5.md](./update_1.8.8-hotfix.5.md)

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: 추가 리뷰의 동기화 P1 2건 구현, `npm run check`·Rules 26/26·Chromium/WebKit 14/14 통과. 외부 재리뷰와 실기기 검증 대기

## 목표

충돌 미리보기와 실제 확정 사이에 로컬 intent 또는 원격 head가 바뀌어도 이전 상태를 덮거나 revision을 역행시키지 않는다.

## 수용한 finding

- 빈 상태 또는 reset 상태의 progress 미리보기가 `null`로 표현되어 확정 시 로컬 변경 검사가 생략되던 P1
- progress, bookmark, annotation, palette 충돌 resolver가 미리보기 당시 remote head를 그대로 사용해 더 최신 cache/meta를 덮을 수 있던 P1

## 구현

- progress 확정 조건을 nullable 위치 대신 `empty` 또는 `position`인 명시적 예상 로컬 상태로 바꿨다.
- 빈 상태도 현재 canonical progress와 비교하고, 충돌에 포함되지 않은 active outbox intent가 하나라도 생기면 원격 확정을 중단한다.
- 원격/로컬 충돌 해결 직전에 같은 IndexedDB transaction에서 현재 remote head cache와 sync meta를 다시 읽는다.
- cache revision이 더 높거나 같은 revision의 `acceptedEventId`가 다르면 기존 충돌을 해결하지 않는다. cache가 가진 최신 head로 open conflict를 갱신해 다음 시도에서 최신 값을 다시 보여준다.
- 이 단조성 검사를 progress·bookmark 공통 resolver와 annotation·palette 공통 resolver의 `원격 값 사용`, `현재 기기 값 유지` 양쪽에 적용했다.
- stale 충돌은 canonical local record, outbox 상태, remote cache와 known revision을 변경하지 않는다.

## 자동검증

- empty progress preview 뒤 새 읽기 intent가 생긴 경우 확정을 거부하고 새 위치를 보존
- progress preview 뒤 더 최신 remote revision이 도착한 경우 적용을 거부하고 conflict head만 최신 revision으로 갱신
- bookmark, annotation, palette의 stale remote head도 같은 방식으로 거부
- 기존 keep-local, use-remote, reset, 삭제 복원과 owner 격리 회귀 유지
- `npm run check`: 통과
  - ESLint 오류 0, 기존 Foliate vendor 경고 2
  - formats 59/59, drive 49/49, archives 33/33, storage 225/225, shelf 58/58, Service Worker 9/9, release 3/3
  - TypeScript·production build 통과
- Firestore Rules: 26/26 통과
- Chromium/WebKit Playwright: 14/14 통과

## 실기기 검증 대기

- 두 기기에서 같은 책의 reset·재열기·진행률 이동을 교차한 뒤 이전 충돌 모달을 확정해도 새 위치가 유지되는지 확인한다.
- 주석·팔레트·책갈피를 두 기기에서 연속 변경한 뒤 모달이 최신 원격 revision으로 갱신되는지 확인한다.
- 실기기 검증은 [update_1.8.9.md](./update_1.8.9.md)의 누적 검증에 포함한다.

## 보류

- production Chrome 장기 selection 회귀 P3는 이 동기화 변경과 독립적이며 1.8.9 Phase A에 유지한다.
