# Web Reader 1.7.5 동기화 경쟁 조건 및 1.7.5.1 이어읽기 UX

작성일: 2026-07-13

기준 커밋: `4539257a2706898c09e5e3757031d1704a71010`

## 목표

1.7.4 코드 리뷰에서 재현 가능하거나 코드 경로로 입증된 동기화 경쟁 조건을 제거한다. Drive는 도서 목록만, Firebase는 진행률·북마크만 담당한다는 1.7.2 이후의 경계를 유지한다.

## 리뷰 판정

| 항목 | 판정 | 1.7.5 처리 |
| --- | --- | --- |
| lease 인계 후 늦은 worker가 새 claim을 변경 | 수용 | claim마다 난수 토큰을 발급하고 ack/retry/pause/conflict를 lease epoch·tab·token CAS로 제한 |
| 네트워크 완료 후에도 과거 시각으로 lease 검사 | 수용 | transport 완료 시각을 다시 읽어 lease를 검증 |
| 이전 Drive 세션 응답·401이 현재 세션을 덮음 | 수용 | 세션 generation, AbortController, 동일 세션 single-flight 및 모든 부작용 가드 적용 |
| Firestore warm cache 뒤 최초 서버 상태 누락 | 수용 | 최초 non-cache snapshot은 전체 docs, 이후 snapshot은 docChanges 적용 |
| activeBook 변경 시 전체 진행률 리스너 재구독 | 수용 | 진행률과 활성 도서 북마크 리스너를 별도 effect·직렬 큐로 분리 |
| 원격 head마다 IndexedDB transaction 생성 | 수용 | snapshot 단위 batch transaction 및 동일 revision/event 쓰기 생략 |
| 2초 outbox·1.5초 conflict 상시 polling | 수용 | local event + BroadcastChannel 즉시 wake, visible 30초 fallback, hidden idle 정지 |
| outbox/conflict 전체 store scan | 수용 | DB v7 인덱스로 due pending, in-flight, open/deferred 범위 조회 |
| lease 회수 scan을 매 poll마다 실행 | 수용 | 새 lease epoch당 한 번만 실행 |
| 로컬 superseded/conflict 기록 장기 GC | 보류 | 진단·복구 참조 보존 기간 정책이 먼저 필요하며 서버 receipt 불변성은 유지해야 함 |
| 대용량 ZIP/TXT 메인 스레드 처리 | 보류 | 실제 기기 profile과 병목 수치 없이 worker 전환 범위를 결정하지 않음 |
| 공유 기기의 계정별 도서 캐시 격리 | 미수용 | 개인용·device-global 도서 캐시는 현재 제품 원칙이며 Firebase 진행률 경계와 분리되어 있음 |
| Foliate vendor ESLint 경고 | 보류 | 앱 코드 오류가 아닌 vendored 코드 2건이며 이번 동기화 수정과 무관 |
| GitHub Actions Node runtime 경고 | 보류 | 런타임 결함이 아니며 workflow 수정은 push 권한 범위를 다시 요구하므로 별도 CI 정리로 분리 |

## 구현

### 1.7.5.1 첫 원격 이어읽기 복원

- 1.6.x와 같이 도서를 연 뒤 처음 확인된 최신 원격 진행률은 확인창 없이 해당 위치로 이동한다.
- 첫 동기화가 끝난 뒤 읽는 중에 더 최신 원격 진행률이 들어오면 기존 확인창을 유지한다.
- 같은 위치, 오래된 원격 기록, 진행률 차이가 0.03% 이하인 후속 변경은 무시한다.
- 로컬 `initialCfi`를 Foliate `lastLocation`으로 전달하는 기존 조용한 복원 경로는 변경하지 않는다.
- Service Worker cache를 `pc-reader-v1.7.5.1`로 올려 기존 1.7.5 설치본도 새 UX를 확실히 받게 한다.

### 1. Outbox claim 소유권

- `claimToken`을 in-flight event에 저장한다.
- 후속 mutation은 저장된 event가 정확히 같은 `tabId`, `leaseEpoch`, `claimToken`을 가진 경우에만 수행한다.
- lease가 인계되어 새 worker가 event를 회수·재claim하면 이전 worker의 성공·실패 응답은 모두 무시한다.
- recovery, retry, pause, conflict, supersede 시 claim 정보를 제거한다.

### 2. Drive 요청 세대

- 동일 Drive session의 중복 load는 하나의 Promise를 공유한다.
- 다른 session load가 시작되면 기존 요청을 abort하고 generation을 올린다.
- permission, folder, file list, local merge 각 await 뒤 현재 generation과 Firebase runtime owner를 함께 검사한다.
- 오래된 요청의 401은 현재 Drive token을 지우지 않으며 책장·cache key·offline mode도 바꾸지 않는다.
- online 재연결도 암묵적 session 대신 현재 `driveSessionId`를 전달한다.

### 3. Firestore listener 수화

- cache snapshot은 UI 정본으로 확정하지 않는다.
- 첫 server snapshot은 `snapshot.docs` 전체를 수화하여 metadata-only server 전환에서도 상태를 잃지 않는다.
- 이후 snapshot부터 변경분만 반영한다.
- 진행률 collection과 활성 도서 bookmark subcollection의 생명주기를 분리한다.
- remote head cache와 sync meta는 snapshot당 하나의 IndexedDB transaction으로 저장한다.

### 4. 저장소 조회와 wake-up

- IndexedDB schema를 v7로 올리고 owner/status 및 owner/state/createdAt 인덱스를 추가한다.
- worker는 due pending 범위만 조회하고 target의 앞선 active event만 확인한다.
- 새 작업·충돌 생성은 같은 탭 event와 다른 탭 BroadcastChannel 신호를 보낸다.
- 신호를 놓친 경우를 위해 보이는 탭에서만 30초 fallback을 유지한다.
- retry는 저장된 `nextAttemptAt` 시각에 별도 wake를 예약해 30초 fallback 때문에 늦어지지 않는다.
- conflict refresh는 generation으로 늦은 조회 결과를 폐기한다.

## 자동검증

- [x] 늦은 lease 소유자의 ack/retry/pause/conflict 거부 회귀 테스트
- [x] 동일 Drive session single-flight 및 이전 session abort/generation 테스트
- [x] warm cache 뒤 최초 server full hydration 테스트
- [x] 첫 원격 진행률 자동 이동과 후속 확인창 정책 테스트
- [x] IndexedDB v7 인덱스 기반 claim/recovery/conflict 기존 회귀 테스트
- [x] TypeScript typecheck
- [x] ESLint 오류 0건(기존 Foliate vendor 경고 2건)
- [x] 전체 Node 테스트
- [x] production build
- [x] Firestore rules 테스트
- [x] Playwright 및 production browser regression

## 자동검증 결과

- 전체 Node 테스트 204개 통과(저장소·동기화 56개, 이어읽기 정책 4개 포함)
- Next.js 1.7.5.1 production build 통과
- Firestore Emulator rules/transaction 테스트 9개 통과
- Playwright Chromium/WebKit 10개 통과
- production Chrome browser regression 최종 통과 및 `pc-reader-v1.7.5.1` service worker cache 확인
- 샌드박스 내부에서는 로컬 포트 제한으로 build helper·emulator·browser server가 차단되어, 동일 명령을 권한 확장 환경에서 재실행해 통과 확인

## 실기기 확인

자동검증과 커밋 완료 후 사용자가 Vercel 배포본에서 수행한다.

- Android에서 읽은 진행률이 다른 기기의 shelf에 reader 진입 없이 반영되는지 확인
- Drive A 요청 직후 Drive B로 전환해도 B 책장이 유지되는지 확인
- 새로고침·online 복귀 후 Drive session과 Firebase 진행률이 서로 독립적으로 복구되는지 확인
- 두 탭에서 같은 도서를 연속 조작해도 새 진행률이 오래된 응답으로 되돌아가지 않는지 확인
