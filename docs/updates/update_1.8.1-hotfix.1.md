# Web Reader 1.8.1-hotfix.1 읽기 위치 충돌 알림 안정화

작성일: 2026-08-01

기준 커밋: `ed5e297`

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: 구현·전체 자동검증 완료, 실기기 검증 대기

## 목표

1.7.x에서 도입한 revision·receipt·IndexedDB outbox의 오래된 쓰기 차단 계약을 유지하면서, 데이터 손실 가능성이 없는 일반 `progress.set` 경합은 조용히 원격 상태로 정리해 반복되는 전역 충돌 모달을 줄인다.

이 패치는 서버 revision 불일치를 무시하거나 기존 event의 `baseRevision`을 뒤늦게 바꾸지 않는다. 충돌 event와 원격 head를 보존한 뒤, 안전 조건을 만족하는 경우에만 기존의 “원격 값 사용” transaction을 자동 실행한다.

## 원래 안전장치에서 유지할 이유

- 오프라인에서 늦게 도착한 위치가 다른 기기의 최신 위치를 무조건 덮어쓰지 못하게 한다.
- reset, 수동 책갈피 수정·삭제와 뒤따르는 로컬 event는 사용자 선택 없이 폐기하지 않는다.
- event receipt, target별 revision chain, lease epoch와 owner generation 검증을 유지한다.
- 모호한 경합은 local event, remote head와 최신 local position을 IndexedDB에 보존하고 해당 target의 전송만 멈춘다.

## 자동 해결 경계

| 상황 | 처리 | 근거 |
| --- | --- | --- |
| 이전 앱 실행의 `progress.set`, 현재 활성 책, 리더 무조작 | 원격 값 조용히 채택 | 1.7.10의 기존 안전 정책 유지 |
| 양쪽 CFI의 안정 anchor가 동일 | 원격 값 조용히 채택 | 레이아웃별 퍼센트 차이만 있고 읽기 위치 의미는 동일 |
| 같은 device ID이고 원격 event client time이 현재 event보다 엄격히 최신 | 원격 값 조용히 채택 | 같은 설치의 탭·PWA 세션 중 최신 기록이 명확함 |
| 현재 실행의 서로 다른 device·서로 다른 위치 | 모달 유지 | 어느 읽기 의도가 최신인지 revision만으로 판단 불가 |
| 같은 device지만 로컬 event가 더 최신 | 모달 유지 | 자동 rebase로 원격 위치를 덮어쓰지 않음 |
| progress reset, remote reset/missing | 모달 유지 | 파괴적 변경 또는 복구 의도 모호 |
| 수동 책갈피 upsert/delete | 모달 유지 | 위치 저장보다 데이터 유실 비용이 큼 |
| 뒤따르는 local event 또는 최신 local position 변경 | 모달 유지 | 최초 충돌 뒤 사용자 의도가 갱신됨 |

자동 해결 전후에 활성 리더의 무조작 상태를 다시 검사한다. 정책 판정 뒤 IndexedDB transaction이 시작되기 전에 로컬 위치가 바뀌면 expected position 검증으로 자동 해결을 중단한다.

## 구현 범위

- `syncConflictPolicy`가 안전한 자동 해결 사유를 `previous-session`, `equivalent-position`, `newer-same-device`로 구분한다.
- 자동 해결은 기존 `resolveSyncConflictUseRemoteV5()`를 재사용해 충돌 전 로컬 위치를 자동 책갈피로 보존한다.
- quiet resolve에만 expected local position을 전달해 TOCTOU 경합에서 새 위치를 덮어쓰지 않는다.
- 실제 다른 기기뿐 아니라 동일 기기의 탭·브라우저·PWA 세션도 충돌 원인이 될 수 있도록 모달 문구를 정확히 바꾼다.
- progress/bookmark v2 schema, Firestore Rules, IndexedDB schema version과 서버 transaction은 변경하지 않는다.

## 제외

- client timestamp만으로 서로 다른 기기의 divergent 위치를 last-write-wins 처리
- 기존 event의 `baseRevision` 재작성 또는 무제한 자동 재시도
- reset·책갈피 충돌 자동 해결
- `나중에 결정`을 장기간 영속 보류해 동기화를 숨기는 변경
- annotation 동기화와 1.8.2 이후 기능

## Phase 1 — 정책 경계와 저장 경합 방어

상태: 완료

- 안전한 일반 위치 충돌과 수동 판단이 필요한 충돌을 분리한다.
- stable anchor 동등성, same-device 최신성, 이전 session 조건을 단위 테스트로 고정한다.
- 정책 판정 이후 local position이 바뀐 경우 remote adoption transaction을 abort한다.

## Phase 2 — 런타임·모달 연결

상태: 완료

- 활성 책은 리더가 무조작일 때만 자동 해결한다.
- transaction 대기 중 새 조작이 생기면 React progress와 reader 위치를 원격 값으로 바꾸지 않는다.
- 모달 문구와 버튼을 기기·앱 세션·원격 값 의미에 맞게 수정한다.

## Phase 3 — 릴리스 검증

상태: 완료

- 버전을 `1.8.1-hotfix.1`로 맞추고 app shell·Foliate runtime cache를 갱신한다.
- lint, typecheck, Node 전체, production build, Firestore Rules, Playwright와 production Chrome을 검증한다.
- 전체 diff에서 revision·receipt·reset·bookmark 계약이 바뀌지 않았는지 재검토한다.
- 검증 완료 후 commit·push하고 실기기 확인 항목을 남긴다.

## 자동검증 계획

- 정책 사유별 단위 테스트와 파괴적 충돌 음성 테스트
- policy snapshot 이후 local position 변경 시 transaction abort 테스트
- 기존 outbox chain, receipt replay, lease/owner, reset·bookmark 테스트 전체
- release version·Service Worker·Foliate cache 테스트
- `npm run check:full`
- `git diff --check`

## 실기기 확인

- 같은 책을 브라우저 탭과 PWA에서 같은 위치로 열었을 때 불필요한 충돌 모달이 사라지는지 확인
- 같은 설치의 더 최신 원격 위치가 조용히 채택되고 충돌 전 위치 자동 책갈피가 남는지 확인
- PC와 휴대폰이 서로 다른 위치에서 현재 읽는 경우에는 기존 모달이 유지되는지 확인
- reset과 수동 책갈피 충돌은 계속 사용자 선택을 요구하는지 확인
- 빠른 탭 이동 또는 미저장 relocate 중 자동 원격 이동이 발생하지 않는지 확인

## 자동검증 결과

- `npm run check:full`: 통과
- ESLint: 오류 0, 기존 Foliate vendor 경고 2개
- TypeScript: 통과
- Node 전체 테스트: 통과
  - formats 57/57
  - storage 98/98 — 자동 해결 사유 3종, 파괴적 충돌 유지, policy snapshot 뒤 local position 변경 abort 포함
  - shelf 32/32
  - Service Worker 9/9, release 2/2와 기존 drive·archive suite 통과
- production build: 통과
- Firestore Rules·transaction: 9/9 통과
  - 동시 progress transaction은 기존대로 한 event만 적용하고 다른 event를 conflict로 보존
  - receipt replay, reset tombstone, stale progress와 bookmark 충돌 보호 유지
- Playwright Chromium/WebKit 직렬 실행: 12/12 통과
- production Chrome regression: 통과
  - `pc-reader-v1.8.1-hotfix.1` cache 생성과 이전 release cache 제거 확인
- `git diff --check`: 통과

첫 샌드박스 `npm run check`는 모든 Node 테스트 통과 후 기존 Turbopack/PostCSS 보조 프로세스의 port bind 제한으로 build에서 중단됐다. 동일 checkout의 production build와 최종 `npm run check:full`을 정상 로컬 권한으로 실행해 모두 통과했으며 제품 코드 실패로 판정하지 않는다.

## 실기기 검증 결과

검증 대기.
