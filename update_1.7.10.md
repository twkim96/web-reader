# Web Reader 1.7.10 최초 읽기 위치 충돌 조용한 복구

작성일: 2026-07-27

기준 커밋: `033a7e2`

## 목표

1.7.9의 revision·receipt·IndexedDB outbox 계약을 유지하면서, 앱 재실행 시 이전 세션의 읽기 위치 이벤트와 더 앞선 원격 위치가 만나는 안전한 경우에는 충돌 모달과 이동 모달을 연속으로 표시하지 않는다. 외부 위치를 조용히 채택하되 기존 로컬 위치는 자동 책갈피로 남겨 사용자가 되돌아갈 수 있게 한다.

## 리뷰 판정

| 항목 | 판정 | 1.7.10 처리 |
| --- | --- | --- |
| 이전 세션의 일반 읽기 위치 충돌에도 전역 모달 표시 | 수용 | 활성 책·무조작·원격 revision 우위 조건에서만 조용히 원격 해결 |
| 조용한 채택 실패 뒤 별도 이동 모달 중복 표시 | 수용 | 초기 로컬 intent 차단은 전역 충돌 해결에 맡기고 두 번째 모달을 만들지 않음 |
| 외부값 선택 뒤 실제 리더 위치는 그대로 유지 | 수용 | 해결된 원격 progress를 리더에 전달해 검증·채택 후 한 번만 이동 |
| 조용한 이동 전 로컬 위치 복구 수단 없음 | 수용 | `충돌 전 위치` 자동 책갈피를 로컬 progress에 보존 |
| 외부값 선택 시 `lastRead`를 선택 시각으로 변경 | 수용 | 원격 head의 실제 `occurredAtClient` 유지 |
| 현재 세션 변경·reset·수동 책갈피 충돌 자동 해결 | 제외 | 파괴적이거나 사용자 의도가 모호하므로 기존 모달 유지 |
| DB schema·Firestore 문서·rules 변경 | 제외 | 기존 v5 IndexedDB와 v2 progress/bookmark schema 유지 |

## Phase 1 — 자동 해결 정책 경계

상태: 완료

- 이전 세션의 `progress.set` 이벤트만 후보로 삼는다.
- 활성 책과 일치하고 리더에 사용자 조작, 미저장 relocate, 진행 중 커밋이 없을 때만 허용한다.
- 원격 head가 정상 `set` 위치이고 원격 revision이 이벤트의 `baseRevision`보다 클 때만 자동 해결한다.
- 뒤따르는 로컬 이벤트나 갱신된 local position이 있으면 모달을 유지한다.
- progress reset, remote reset/missing, 수동 책갈피 edit/delete와 현재 세션 이벤트는 자동 해결하지 않는다.

## Phase 2 — 단일 조용한 이동과 복구 책갈피

상태: 완료

- 원격 해결 transaction에서 충돌 이벤트의 로컬 위치를 `충돌 전 위치` 자동 책갈피로 보존한다.
- 자동 책갈피는 기존 정책대로 기기 로컬에만 남고 수동 책갈피 동기화 대상에는 포함하지 않는다.
- 해결된 progress를 리더에 별도 신호로 전달해 원격 head 채택을 다시 검증한 뒤 한 번만 이동한다.
- 초기 조용한 채택이 local intent 때문에 차단된 경우 별도 이동 확인 모달을 미리 생성하지 않는다.
- 사용자가 전역 충돌 모달에서 외부값을 직접 선택한 경우에도 같은 단일 이동 경로를 사용한다.

## Phase 3 — 1.7.10 릴리스 정리와 검증

상태: 완료

- package/lockfile/Service Worker/browser regression/release test를 1.7.10으로 통일한다.
- lint, typecheck, 전체 Node 테스트, production build, Firestore Rules, Playwright, production browser regression을 실행한다.
- 검증 결과를 아래에 기록하고 커밋·푸시한다.

## 구현 결과

- 안전한 최초 progress 충돌만 조용히 해소하며, 현재 세션 또는 파괴적 충돌의 사용자 선택권은 유지한다.
- 외부값 채택과 리더 이동을 하나의 resolved-progress 흐름으로 연결해 충돌 모달 뒤 이동 모달이 다시 뜨지 않게 했다.
- 충돌 전 로컬 CFI와 진행률을 자동 책갈피로 최대 3개 정책 안에 보존한다.
- 외부 progress의 `lastRead`는 원격 head에 기록된 실제 발생 시각을 유지한다.
- IndexedDB version, Firestore schema/rules, Drive/Firebase 역할 경계는 변경하지 않았다.

## 자동검증 결과

- ESLint: 앱 코드 오류 0건, 기존 Foliate vendor 경고 2건
- TypeScript typecheck 통과
- Node 회귀 테스트 243개 통과
- Next.js 1.7.10 production build 통과
- Firestore Emulator Rules/transaction 테스트 9개 통과
- Playwright Chromium/WebKit 보안·Service Worker 테스트 10개 통과
- production Chrome browser regression 통과
- Service Worker `pc-reader-v1.7.10` cache 생성, 이전 `pc-reader-*` cache 제거, precache 8개 적중 확인

검증 메모: production Chrome 회귀는 새 프로필의 게스트 Firebase Auth bootstrap이 기능 fixture 전에 간헐적으로 시간 초과되는 기존 환경 문제가 재현됐다. 별도 새 프로필 실행은 전체 앱·리더·PDF·archive·Service Worker 회귀를 통과했다. 버전 변경 중 남은 Service Worker URL 정규식 1곳은 회귀 실행이 검출했고 1.7.10으로 수정한 뒤 최종 실행에서 확인했다. 샌드박스 안의 마지막 Turbopack build는 CSS worker 로컬 포트 바인딩이 거부되어 실패했으며, 같은 checkout을 샌드박스 밖에서 재실행한 production build는 통과했다.
