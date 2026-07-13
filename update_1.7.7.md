# Web Reader 1.7.7 동기화 생명주기 보강

작성일: 2026-07-13

기준 커밋: `c859dd6`

## 목표

1.7.6 전체 리뷰를 현재 코드와 대조해 저장 자체가 아니라 저장 전후의 생명주기에서 발생하는 부분 실패와 멀티탭 경합을 줄인다. Drive는 도서 원본, Firebase는 진행률·북마크라는 경계를 유지한다.

## 리뷰 판정

| 항목 | 판정 | 1.7.7 처리 |
| --- | --- | --- |
| 업데이트 직전 debounce 위치 누락 | 수용 | reader 강제 flush 등록, commit 실패·flush 중 추가 조작 시 update 중단 |
| local commit rejection을 drain 성공으로 처리 | 수용 | drain 결과에 rejection 수를 반환하고 실패 시 `SKIP_WAITING` 금지 |
| 책 삭제 중 progress reset 실패가 숨겨짐 | 수용 | reset 결과를 반환하고 성공 전에는 Drive·로컬 원본·UI를 삭제하지 않음 |
| quiet remote 위치가 로컬에 남지 않음 | 수용 | 원격 outbox를 만들지 않는 local adoption API로 이동 성공 후 저장 |
| 같은 브라우저 탭을 device 하나로 echo 무시 | 수용 | head에 session 식별자를 추가하고 현재 session의 정확한 echo만 무시 |
| timestamp가 revision보다 우선 | 부분 수용 | UI progress에 revision/event ID를 전달하고 양쪽 revision이 있을 때 우선 비교; legacy는 timestamp fallback |
| 원격 충돌 적용 후 committed baseline 불일치 | 수용 | owner/book 공유 baseline rebase API를 save·adoption·conflict 경로에서 사용 |
| 물리 삭제된 remote candidate 잔존 | 수용 | remote cache/candidate 제거와 remote-missing conflict 기록 |
| paused event 무음 정지 | 부분 수용 | paused 요약과 작은 상태 표시를 추가하고 auth 오류는 재로그인 세션에서 재개; 폐기 UI는 보류 |
| outbox due 후보 무제한 배열 조회 | 보류 | 단순 64개 제한은 앞의 blocked target이 뒤 target을 영구 starvation시킬 수 있어, 회전 cursor/target head 없이 적용하지 않음 |
| v4/v5 direct upgrade 데이터 폐기 | 보류 | 개인 사용자의 기존 손실 복구는 범위 밖이며 안전한 병렬 migration·export UI 없이 자동 귀속하지 않음 |
| 삭제 saga | 보류 | reset을 먼저 확정해 local-only 반쪽 삭제는 막되 Drive·IndexedDB 분산 saga는 영속 job schema가 필요 |
| 북마크별 pending/rollback UI | 보류 | commit 실패 dirty 재시도와 전역 오류는 유지하고 bookmark별 상태 모델은 별도 UX 작업 |
| TXT/ZIP worker·CSP/OAuth 재설계 | 보류 | 실기기 profile과 Google/Firebase 호환성 검증이 먼저 필요 |

## 개발 단계

### Phase 1. 업데이트 적용 전 강제 저장

- [x] reader가 현재 debounce 위치를 즉시 저장하는 flush callback을 등록한다.
- [x] flush 중 새 조작이 생기면 최신 위치까지 다시 저장하거나 update를 중단한다.
- [x] rejected commit이 하나라도 있으면 update를 적용하지 않는다.

### Phase 2. 결과 기반 도서 삭제

- [x] progress reset과 bookmark tombstone commit 결과를 상위 호출자에 반환한다.
- [x] reset 실패 시 Drive·로컬 도서와 책장 UI를 보존한다.
- [x] 성공한 reset 뒤에만 원본 삭제를 진행한다.

### Phase 3. 원격 위치 local adoption과 baseline

- [x] quiet resume 성공 위치를 outbox 없이 `progress-v5`에 저장한다.
- [x] 공유 committed baseline을 adoption·conflict remote·reset에서 rebase한다.
- [x] 원격 물리 삭제 시 stale candidate와 remote cache를 제거한다.

### Phase 4. 멀티탭 session과 revision

- [x] progress/bookmark head에 backward-compatible `acceptedSessionId`를 추가한다.
- [x] 같은 device라도 다른 session의 변경은 listener가 반영한다.
- [x] revision이 존재하면 timestamp보다 먼저 remote 후보를 판정한다.

### Phase 5. 동기화 가시성과 bounded work

- [x] paused event 요약을 UI에 표시하고 auth pause를 새 로그인 세션에서 재개한다.
- [x] paused 상태 가시성과 auth 재개 회귀 테스트를 추가한다.

### Phase 6. 릴리스 검증

- [x] package/lock/Service Worker cache를 1.7.7로 맞춘다.
- [x] lint, typecheck, 전체 Node 테스트를 통과한다.
- [x] production build를 통과한다.
- [ ] Firestore Rules를 통과한다.
- [x] Playwright와 production browser regression을 통과한다.

## 구현 결과

- 업데이트 적용 버튼은 활성 reader의 debounce timer를 취소하고 현재 위치를 최대 3회까지 안정적으로 flush한다. 저장 실패 또는 flush 도중 계속된 조작이 있으면 업데이트를 적용하지 않는다.
- local commit drain은 rejection 수를 반환하며 실패가 하나라도 있으면 `SKIP_WAITING`을 보내지 않는다.
- 도서 삭제는 진행률 reset과 bookmark tombstone outbox가 성공한 뒤에만 Drive·로컬 원본과 UI를 삭제한다. 유효하지 않은 Drive 세션은 reset 전에 차단한다.
- quiet resume은 listener가 먼저 저장한 remote head revision/event를 다시 검증한 뒤, 새 outbox 없이 로컬 진행률로 원자적으로 채택한다.
- committed baseline을 owner/book 공유 저장소로 분리해 local restore, remote adoption, conflict remote 선택, reset이 같은 기준으로 rebase한다.
- 새 head는 `acceptedSessionId`를 기록하고 legacy head도 계속 읽는다. 같은 device의 다른 탭/PWA session은 원격 변경으로 처리하고 현재 session echo만 무시한다.
- 양쪽 revision을 알 수 있으면 shelf와 reader 판정에서 timestamp보다 revision을 우선한다. legacy 데이터는 기존 timestamp fallback을 유지한다.
- paused auth event는 새 로그인/online 복귀 시 pending으로 되돌리고, permission/schema 정지는 작은 상태 배너로 표시한다.
- Rules 배포 시차로 발생한 `permission-denied` paused event도 새 앱 세션에서 한 번 재시도해, 규칙 배포 후 자동 복구할 수 있게 한다.
- 물리 삭제된 remote head는 로컬 remote cache와 UI candidate에서 제거한다.
- 북마크는 React relocation state 대신 생성 순간 Foliate `lastLocation.cfi`를 사용하고, 이름도 현재 visible range에서 추출한다. 북마크 이동에는 접힌 `anchorCfi`가 아니라 화면 범위를 포함한 CFI를 저장해 Chromium에서 같은 챕터의 첫 페이지로 수렴하는 문제를 막고, 진행률 동기화용 앵커는 별도로 유지한다.

## 자동검증 결과

- lint: 앱 코드 오류 0건, 기존 Foliate vendor 경고 2건
- TypeScript typecheck 통과
- 전체 Node 테스트 221개 통과
- update flush 실패 차단, local commit rejection, session echo, revision 우선, quiet local adoption, paused auth 재개 회귀 테스트 통과
- Next.js 1.7.7 production build 통과
- Playwright Chromium/WebKit 10개 통과
- production Chrome browser regression 통과, `pc-reader-v1.7.7` cache와 이전 cache 제거 확인
- Firestore Emulator Rules/transaction 테스트 9개 통과
- `acceptedSessionId`를 허용하는 `firestore.rules` 변경은 1.7.7 앱 배포와 함께 배포해야 한다.

## 실기기 확인

- 페이지를 넘긴 직후 업데이트를 적용해도 재실행 위치가 유지되는지 확인
- 온라인 quiet resume 직후 앱을 종료하고 오프라인 재실행해도 원격 위치에서 열리는지 확인
- 브라우저 탭과 설치형 PWA에서 같은 책을 번갈아 읽을 때 다른 session 변경이 감지되는지 확인
- 도서 삭제 중 네트워크·저장 실패가 발생하면 원본과 책장 항목이 남아 재시도 가능한지 확인
