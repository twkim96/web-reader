# Web Reader 1.8.10 hotfix.8 — 일반 동기화와 revision 충돌의 분리

작성일: 2026-08-13

기준 커밋: `692bef8`

상위 문서: [update_1.8.10.md](./update_1.8.10.md)

상태: 구현·전체 자동 gate 완료. Android·iPad 동시 독서 확인 대기

## 실사용 finding

hotfix.7에서 진행률이 높은 위치를 택하는 규칙이 일반 원격 위치 수신에도 확장됐다. 이 규칙은 이미 `현재 기기 값 / 원격 값` 선택 대상이 된 실제 revision 충돌을 정리하는 데는 유효하지만, 충돌이 아닌 다른 기기의 의도적인 이전 페이지 이동까지 오래된 값으로 오인했다.

그 결과 iPad에서 뒤로 넘긴 위치는 Android에 반영되지 않고 Android의 더 높은 진행률이 다시 저장됐으며, iPad에는 충돌 또는 원격 위치가 재등장했다. 반대로 iPad가 Android보다 높은 진행률까지 앞으로 이동한 뒤에야 Android가 갱신되는 단방향 동기화가 발생했다.

## 변경

- 퍼센트 차이로 revision 경합의 성격을 추정하지 않는다. `0.03%p` 근접 여부는 원격 위치 안내가 필요한지 판단하는 기존 UX 기준일 뿐, 충돌 승자 판정의 진입 조건이 아니다.
- 평상시 원격 head 수신은 진행률이 현재 화면보다 낮아도 거부하지 않는다. 앞·뒤 어느 방향이든 서버가 수락한 새 기기 이동으로 처리한다.
- 높은 진행률 우선 규칙은 IndexedDB outbox에 실제 revision conflict가 생성되어 기존 `현재 기기 값 / 원격 값` 모달의 대상이 되는 `progress.set ↔ progress.set` 경로 안에서만 사용한다.
- 실제 revision conflict 안에서는 로컬 진행률이 높으면 로컬 intent를 원격 revision 위에 rebase하고, 원격 진행률이 높거나 같으면 원격 revision을 채택한다.
- 안정 anchor가 같은 위치, 활성 도서의 이전 앱 세션 이벤트, 동일 기기에서 명확히 더 늦게 발생한 원격 이벤트는 실제 conflict 안에서 기존 안전 규칙대로 원격값을 채택한다.
- 일반 원격 head를 단순히 진행률이 낮다는 이유만으로 거부하고 현재 위치를 강제 재전송하던 `keep-local` 경로를 제거한다. 최신 원격 revision은 초기 quiet resume에서는 한 번만 이동하고, 독서 중 의미 있는 변경은 기존 원격 위치 확인 UI를 사용한다.
- 일반 `클라우드 동기화 → 이동하기`는 원격 위치를 현재 기기의 IndexedDB에 채택만 한다. 수락한 동일 위치를 현재 기기의 새 outbox event로 다시 전송하지 않아, 원래 기기에 같은 위치 알림이 되돌아오는 echo를 막는다.
- 실제 revision 충돌의 `원격 값 사용`은 기존 conflict finalize transaction을 사용하므로 일반 위치 알림의 로컬 채택 경로와 섞이지 않는다.
- 책장에서 실제 revision 충돌의 `현재 기기 값 유지`를 누르면 replacement event 생성과 같은 IndexedDB transaction에서 충돌 당시 원격 revision을 `ignoredRemoteRevision`으로 기록한다.
- keep-local 성공 직후 React의 canonical progress에도 같은 revision을 반영하고, 그 이하의 충돌 당시 `remoteProgress` 캐시는 제거한다. 따라서 리더를 열 때 원격 위치로 먼저 이동했다가 replacement 위치로 돌아오는 왕복 이동을 만들지 않는다.
- 원격 승자는 hotfix.7에서 추가한 원자적 선확정 후 단일 이동을 유지한다. 같은 충돌을 화면에 먼저 적용했다가 롤백·재적용하지 않는다.
- reset, bookmark, annotation, blocked chain, 최신 로컬 위치가 달라진 CAS 실패는 자동 승자 판정 범위에 포함하지 않는다.

## 자동검증

- materialized revision conflict에서 `로컬 30% ↔ 원격 70%`는 원격, `로컬 80% ↔ 원격 70%`는 로컬을 선택하는지 확인한다.
- `30.00% ↔ 30.02%`와 `30.00% ↔ 30.04%` conflict 모두 동일한 높은 진행률 규칙을 사용하고, 퍼센트 근접 여부로 conflict 종류를 추정하지 않는지 확인한다.
- 이전 세션·동일 anchor·동일 기기의 더 최신 원격 이벤트는 기존 원격 우선 규칙을 유지하는지 확인한다.
- 낮지만 더 최신인 원격 위치가 초기 quiet resume에서는 단일 jump, 독서 중에는 prompt가 되고 강제 로컬 재저장을 만들지 않는지 확인한다.
- 일반 위치 알림의 `이동하기`가 `onAdoptRemoteProgress`만 호출하고 `onSaveProgress` outbox event를 만들지 않는지 확인한다.
- shelf에서 `현재 기기 값 유지`를 선택한 뒤 로컬 progress의 `ignoredRemoteRevision`과 React remote cache가 즉시 정리되는지 확인한다.
- 원격 자동 확정 뒤 navigation·rollback·finalize가 한 번씩만 실행되는 기존 회귀를 유지한다.
- `npm run check:full`: 통과
- ESLint: 오류 0, 기존 Foliate vendor 경고 2
- TypeScript·production build: 통과
- Node: formats 63/63, drive 49/49, archives 33/33, storage 267/267, shelf 69/69, Service Worker 9/9, release 3/3 — 합계 493/493
- Firestore Rules: 27/27
- Chromium/WebKit Playwright: 14/14
- production Chrome regression: 통과
- `git diff --check`: 통과

## 실기기 확인

- 두 기기 사이에 실제 outbox conflict가 없는 상태에서 iPad에서 여러 페이지 뒤로 이동하면 약 1초 idle 저장 뒤 Android에 낮아진 위치가 도착하는지 확인한다.
- Android에서 다시 앞·뒤로 이동했을 때 iPad에도 방향과 무관하게 최신 이동이 도착하는지 확인한다.
- Android에서 iPad 위치 알림의 `이동하기`만 누른 뒤 아무 페이지도 넘기지 않으면 iPad에 같은 위치의 새 알림이 되돌아오지 않는지 확인한다.
- shelf의 `동기화 확인 필요`에서 `현재 기기 값 유지`를 선택한 직후 리더를 열어도 충돌 당시 원격 위치와 현재 위치 사이를 왕복하지 않는지 확인한다.
- 두 기기를 동시에 연 상태에서 화면이 앞뒤로 번갈아 깜빡이지 않고, 다음 페이지 터치를 해야만 수렴하는 상태가 남지 않는지 확인한다.
- `0.3%` 이동이 필수 조건이 아님을 확인한다. 위치 저장 debounce는 1초, 의미 있는 원격 안내 기준은 `0.03%p`, percent-only 저장 비교는 `0.05%p`이며 CFI·anchor가 바뀐 페이지 이동은 percent-only 기준과 무관하게 저장된다. 이 수치들은 실제 revision conflict의 진입 조건이 아니다.
