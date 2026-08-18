# Web Reader 1.8.18 — 원격 conflict navigation transaction 안정화

작성일: 2026-08-18

이전 버전: [update_1.8.17.md](./update_1.8.17.md)

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: 코드 수정·전체 `npm run check`·집중 Chromium/WebKit 회귀 완료, Android Chrome/PWA 실기기 재검증 대기

## 배경

1.8.17은 Android foreground 직후 paginator page-turn lock을 `goTo()` 성공으로 오인하던 직접 원인을 막고 ordinary remote head adoption 전에 readiness barrier를 추가했다. 후속 정적 리뷰에서 동일한 canonical/viewport invariant가 실제 revision conflict command, readiness 대기 중 사용자 입력, rollback 실패와 cross-section target pagination에는 아직 완전히 적용되지 않은 경로가 확인됐다.

## 리뷰 수용 범위

수용:

1. active-book automatic remote winner가 commit-first resolver를 사용해 1.8.17 readiness/finalize 경계를 우회하던 경로.
2. durable remote conflict commit 뒤 runtime eligibility를 검사하던 순서.
3. readiness 대기 중 사용자 page input이 automatic remote resume/conflict attempt를 무효화하지 못하던 경합.
4. readiness가 현재 section만 안정화하고 cross-section 목적지의 font/image/layout을 기다리지 않던 경계.
5. finalize 실패 rollback의 `goTo()` 성공 여부를 확인하지 않던 계약.
6. paginator page-turn 예외 시 `#locked` 해제가 보장되지 않던 cleanup.

별도 정책 변경으로 보류:

- active-book conflict를 `Resume only` 또는 `Live Follow` 중 하나로 재정의하는 제안은 correctness bug와 분리한다. 1.8.18은 기존 정책을 유지한다. `previous-session` 자동 승자는 quiet-resume eligibility가 필요하고, 그 외 기존 automatic winner는 reader persistence가 settled일 때만 stage한다.

## 수정

### 1. active-book remote conflict를 preview -> navigation -> CAS finalize로 통일

- active book의 automatic remote winner는 더 이상 `resolveSyncConflictUseRemoteV5()`를 먼저 commit하지 않는다.
- `previewSyncConflictUseRemoteProgressV5()`로 conflict, expected local state, expected remote head를 읽고 uncommitted runtime command를 stage한다.
- 실제 reader는 readiness와 stable navigation을 통과한 뒤에만 existing CAS resolver를 finalize한다.
- inactive book은 viewport 이동이 없으므로 기존 durable remote resolution을 유지한다.
- automatic command는 `quiet` / `settled`, 사용자 명시 선택은 `explicit` runtime mode로 구분해 기존 policy를 보존한다.

### 2. reader interaction attempt token과 transaction abort

- remote navigation attempt는 현재 reader interaction generation과 `AbortController`를 캡처한다.
- 사용자가 page/slider 등 progress-changing input을 발생시키면 진행 중 remote attempt를 abort하고 interaction generation을 증가시킨다.
- ordinary remote adoption transaction도 `AbortSignal`을 받아 IndexedDB write 중 사용자 intent가 바뀌면 transaction 전체를 abort한다.
- active conflict CAS finalize는 기존 resolver의 `AbortSignal` 지원을 재사용하며 command cancellation signal과 reader attempt signal을 결합한다.
- durable canonical commit이 끝난 뒤의 극히 짧은 window에서는 viewport가 canonical 위치까지 마무리되도록 하여 반대 방향 mismatch를 만들지 않는다.

### 3. target-aware stable navigation

- Foliate view에 remote-only `goToStable()` / `goToFractionStable()`을 추가한다.
- paginator stable navigation은 목적지 section을 staging 상태에서 load한 뒤 target document의 fonts/images와 3회 layout expansion을 기다린다.
- anchor를 적용한 후 추가 2 frame render까지 확인하고 navigation success를 반환한다.
- pre-adoption readiness 직후 새 page-turn이 시작되는 post-commit 경합도 stable request 자체가 bounded lock wait를 수행해 false failure로 끝나지 않게 한다.
- ordinary TOC/search/manual navigation은 기존 빠른 `goTo()` 계약을 유지한다.

### 4. rollback과 paginator cleanup

- remote jump rollback은 boolean success 계약으로 변경한다.
- rollback은 원래 range CFI, anchor CFI, 원래 progress fraction 순서로 복구 경로를 시도한다.
- 첫 rollback 실패 시 readiness를 기다리고 제한된 횟수만 재시도한 뒤 local pending state를 복원한다. 반복 실패 시 command/conflict는 해결된 것으로 소비하지 않고 blocking feedback을 유지한다.
- 더 새로운 user navigation이 remote jump를 supersede한 경우 오래된 rollback CFI를 강제로 덮어쓰지 않는다.
- paginator `#turnPage()`의 lock release를 `finally`로 옮겨 section load/renderer 예외 뒤에도 후속 navigation이 가능하게 한다.

## 버전/캐시

- app/service-worker cache version: `1.8.18`
- Foliate runtime revision: `1.8.18.1`
- metadata crawler version은 이번 변경과 무관하므로 유지한다.

## 자동검증

집중 검증 완료:

- `npm run typecheck`
- `npm run test:storage`: 305건 통과
  - readiness 중 user input이 adoption 전 attempt를 취소
  - remote adoption IndexedDB transaction 중 signal abort 시 atomic rollback
  - 기존 preview/finalize CAS 및 command abort 회귀 포함
- remote progress policy/adoption 집중 28건 통과
  - conflict jump readiness 선행
  - rollback 첫 실패 -> readiness -> 재시도 성공
  - superseded navigation이 오래된 rollback으로 덮이지 않음
- Playwright Chromium/WebKit 6건 통과
  - locked programmatic navigation rejection/recovery
  - page-turn section load 예외 뒤 lock cleanup 및 후속 goTo
  - cross-section stable target pagination이 commit 전에 settle되고 후속 layout이 동일함

- 최종 `npm run check` 통과: lint(기존 vendored Foliate warning 2건), typecheck, 전체 Node/publisher 테스트, release 정합성, production build 포함.

## 실기기 재검증

1. Android와 Mac에서 같은 도서를 열고 Android를 background로 보낸다.
2. Mac에서 앞으로 읽어 remote head를 만든다.
3. Android를 foreground로 복귀해 모달 직후 `이동하기`를 누른다.
4. local pending outbox가 있는 실제 revision conflict에서도 동일하게 목표 위치로 한 번만 이동하는지 확인한다.
5. readiness 대기 중 Android에서 먼저 한 페이지를 넘기면 automatic remote 이동이 그 입력을 삼키지 않는지 확인한다.
6. remote target이 다른 chapter인 책에서 이동 직후와 2~3초 뒤 위치가 동일한지 확인한다.
7. finalize 경합을 유발한 뒤 rollback 또는 최신 conflict 재제시가 viewport/canonical을 일치시키는지 확인한다.
8. Android Chrome과 설치형 PWA에서 각각 반복한다.
