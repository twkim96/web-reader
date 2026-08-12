# Web Reader 1.8.9 실기기 전 선행 안정화·누적 실사용 검증

작성일: 2026-08-10

기준: 1.8.8 + [hotfix.1](./update_1.8.8-hotfix.1.md)~[hotfix.7](./update_1.8.8-hotfix.7.md) working tree

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: Phase A 외부 리뷰 finding을 [hotfix.1](./update_1.8.9-hotfix.1.md)~[hotfix.5](./update_1.8.9-hotfix.5.md)로 보강하고, 실사용 UI·로그아웃 finding을 [hotfix.6](./update_1.8.9-hotfix.6.md), 태블릿 가로 탭·선택형 2페이지 보기를 [hotfix.7](./update_1.8.9-hotfix.7.md)로 수정했다. hotfix.7 전체 자동 gate 완료, 태블릿 실기기 확인 대기

## 목표

1.8.x의 알려진 코드·운영 위험을 먼저 닫은 뒤 feature freeze 상태에서 PC, iPad Safari와 홈 화면 PWA의 누적 실사용 검증을 수행한다. 새 사용자 기능은 추가하지 않는다.

## Phase A — 실기기 전 선행 안정화 TODO

### A1. 다중 탭 독서 통계 sync 단일 실행자

상태: 초기 구현 뒤 외부 리뷰 finding을 hotfix.1~5로 보강. 단일기기 Phase B 진행 중이며 다중 탭·다중기기 최종 acceptance는 누적 실기기 판정 대기

- owner별 통계 hydration/upload에 하나의 active leader만 두는 lease 또는 Web Locks protocol을 설계한다.
- tab 종료·background·lease 만료·same-tab reacquire·owner 전환을 구분하고 늦은 continuation을 폐기한다.
- follower는 IndexedDB change wake만 전달하고, leader 변경 후 pending upload와 exact hydration cursor에서 멱등 재개한다.
- 두 탭 동시 시작, leader 강제 종료, offline→online, token refresh, 500개 multi-page hydration을 자동 테스트한다.
- 구현 전후 Firestore read/write 수를 계측해 비용 감소를 확인한다.

구현 결과:

- IndexedDB v13에 reading-statistics 전용 owner lease store를 추가했다. progress/annotation worker lease와 key 공간을 공유하지 않는다.
- 15초 lease와 5초 heartbeat를 사용하며 같은 tab의 live renewal은 epoch를 유지하고, 만료·release 뒤 reacquire는 epoch를 증가시킨다.
- hidden tab은 즉시 release하고 visible·online·token refresh·local wake에서 follower도 leader 획득을 다시 시도한다.
- 원격 page fetch와 upload 뒤 lease epoch를 다시 확인한다. hotfix.1에서는 hydration cursor commit과 session sync acknowledgement transaction 자체가 v13 holder·epoch를 검사해 check/commit 사이 takeover도 차단한다.
- release 뒤 늦게 완료된 acquire는 lifecycle generation으로 폐기하고, lifecycle별 holder ID로 같은 tab의 새 lease를 이전 정리가 만료시키지 못하게 한다.
- hydration coordinator를 별도 pure boundary로 분리해 500 + 500 + 1 session page와 page 사이 leader takeover를 테스트했다.
- device clock sample single-flight는 leader 내부에서만 시작하며 lease 상실 뒤 표본을 저장하지 않는다.

자동 증거:

- 동일 owner 두 tab 동시 acquire 시 leader 1개
- 다른 owner lease 독립성
- 만료·명시 release·same-tab reacquire epoch
- 이전 epoch continuation 차단
- 1,001개 multi-page hydration exact cursor 연속성
- 두 번째 page fetch 직후 takeover 시 미확정 page local commit 차단

### A2. retention·compaction 계측과 migration 설계

상태: 계측·migration gate 설계 및 자동 fixture 완료. 실제 삭제는 observe-only로 비활성

임의 TTL 삭제는 offline 복귀, tombstone 삭제 부활 방지, receipt 멱등성과 cloud recovery 계약을 깨뜨릴 수 있으므로 계측·정책·migration·rollback을 한 묶음으로 진행한다.

계측 대상:

- owner별 outbox 상태별 개수·대략적 byte와 가장 오래된 event age
- open/deferred/resolved conflict 개수와 age
- annotation active/tombstone/receipt/remote-head 개수와 byte
- 통계 raw segment 수, 월 증가량, hydration page/read 수와 집계 시간
- IndexedDB 전체/도메인별 사용량과 quota 비율
- 7일·30일·90일 offline 기기의 재접속 결과(Phase B 실데이터 증거)

정책 결정 항목:

- acked/superseded outbox와 resolved conflict의 local compaction watermark
- tombstone·receipt 최소 보존 기간, stale device watermark와 삭제 부활 차단 방식
- 통계 raw segment의 월별 immutable archive 또는 검증 가능한 aggregate 전환
- export, 사용자 전체 삭제, 계정 전환, 복구, rollback 계약
- emulator migration과 구버전 client 재접속 호환성

migration 활성화 전 필요한 Phase B 증거:

- 실제 계측 표본과 용량/비용 기준선
- migration 전후 동일한 authoritative snapshot·통계 합계
- 7/30/90일 offline 복귀 실기기·복원 fixture
- 중단·재시작·rollback 자동 테스트

구현 결과:

- owner별 local outbox 상태·대략적 byte·oldest age·30일 superseded 후보를 읽기 전용으로 수집한다.
- conflict state·byte·age·30일 resolved 후보, annotation unresolved·book deletion marker, remote head tombstone을 함께 수집한다.
- remote receipt는 local DB에 없으므로 `server-only`로 명시해 가짜 0으로 보고하지 않는다.
- raw 통계 session 수·월별 증가·sync state·byte·oldest age·aggregation 소요시간을 수집한다.
- hydration read attempt/성공 read/commit page와 completed/lost-leadership/failed run, 마지막 duration을 durable meta에 누적한다. malformed timestamp 때문에 document cursor로 추가 page를 읽은 비용도 실제 read 수에 포함한다.
- `navigator.storage.estimate()`의 usage/quota/ratio를 같은 snapshot에 포함한다.
- 손상된 local session은 record별로 제외하고 `malformedRecordCount`로 보고하며, 통계 modal의 사용자 명시 동작으로 진단 JSON을 내려받을 수 있다.
- migration planner 단위 테스트는 90일 offline, authoritative snapshot 동등성, 통계 합계 동등성, rollback, 구버전 재접속 증거가 모두 true여야 `migration-ready`가 되는 gate 계약만 검증한다. 실제 증거는 Phase B에서 별도로 수집하며 자동 삭제는 별도 migration release 전까지 false다.
- 7일·30일·90일 정책은 최소 90일 tombstone/receipt 보존과 server watermark를 하한으로 고정했다. raw 통계는 검증된 full audit 뒤 월별 immutable archive 후보로만 설계했다.

현재 판정:

- synthetic IndexedDB fixture로 각 계측값, quota 25%, hydration 2 page/3 read, 30일 후보가 검출되면서 원본 record가 삭제되지 않음을 확인했다.
- 실제 사용자 데이터 표본과 7/30/90일 장기 재접속 결과는 Phase B에서 수집한다. 그 전에는 migration 실행 함수를 제공하지 않는다.

### A3. 추가 리뷰·자동 gate 마감

상태: progress sentinel·TTS pause/resume·원격 command·annotation generation·통계 시간축 경합을 hotfix.1~5에서 보강하고 hotfix.6~7 전체 gate까지 통과. 누적 실기기·외부 최종 리뷰 대기

- hotfix.3~7 외부 재리뷰에서 P0~P2가 남지 않아야 한다.
- `npm run check:full`과 `git diff --check`를 clean checkout에서 통과한다.
- production guest bootstrap을 여러 번 반복해 callback 지연에도 local shelf가 열리는지 확인한다.
- production Chrome 장기 회귀가 reader selection 구간에서 headless compositor와 `requestAnimationFrame` 응답을 잃는 P3를 마감한다. command context, `visibilityState`, focus, live Foliate Document 목록과 `window.__regressionErrors`를 timeout 증거에 함께 남기고, 제품 hang인지 CDP 입력/foreground 인프라 문제인지 분리한다.
- 대량 책장 자동 pagination과 명시적 `더 보기` fallback을 각각 검증하되, observer 누락이 뒤의 reader 회귀를 가리지 않게 한다.
- 알려진 P3는 재현 조건, 사용자 영향, 보류 사유와 실기기 관찰 항목을 명시한다.

진단·수정 결과:

- auto-open 전에 빈 books render가 먼저 도착하면 last reader intent를 지우던 bootstrap readiness 경합을 분리했다.
- candidate를 찾은 뒤 `setTimeout(0)` cleanup이 timer만 취소하고 `hasTried`를 남기던 경합을 제거하고 reader state를 effect에서 직접 확정한다.
- eager guest restore 뒤 늦은 Firebase `null` callback이 열린 reader를 shelf로 되돌리지 않도록 현재 reader view를 보존한다.
- production timeout에 app view, bootstrap readiness, last reader intent, visibility/focus, live Foliate document, `window.__regressionErrors`를 포함한다.
- 기존 selection P3는 제품 rAF가 아니라 하나의 장기 `Runtime.evaluate` 안에서 테스트 settle용 rAF가 오지 않아 전체 CDP command가 정지한 경로로 분리됐다.
- browser regression의 settle helper에 100ms timer fallback을 두었다. 제품 reader의 animation/navigation 코드는 바꾸지 않으며 실제 selection·TTS·번역·하이라이트·빠른 탭 결과는 그대로 assertion한다.
- 수정 후 같은 production build의 전체 Chrome regression이 3회 연속 통과했다.
- hotfix.1은 TTS sentinel 주입 전에 reader progress flush를 완료했다.
- hotfix.2는 resume validation timer를 generation에 결합하고, logical TTS session을 유지하면서 문장 사이 gap을 재생 시간에서 제외했다.
- hotfix.3은 일반 주석 hydration의 book-deletion generation을 transaction에서 검사하고, 원격 command 취소를 IndexedDB transaction abort에 연결했다.
- hotfix.3은 TTS session의 실제 wall-clock active interval을 저장해 gap을 제외하면서 날짜·기기 간 overlap 위치를 보존한다.
- hotfix.4는 marker-only live advancement에서도 stale annotation partition을 즉시 reconcile하고 열린 reader를 갱신한다.
- hotfix.4는 TTS lifecycle 전체에 progress fence를 두고 기존 relocate timer까지 중지하며, active-gap crash journal의 마지막 interval end를 보존한다.
- hotfix.5는 marker head·sync meta 저장과 stale annotation 정리를 하나의 IndexedDB transaction으로 합쳐 다중 탭 resurrection window를 제거한다.
- hotfix.5는 TTS fence 직전에 대기 중인 사용자 위치 snapshot을 즉시 저장해 장시간 TTS·강제 종료의 durability gap을 제거한다.
- hotfix.6는 Firebase 로그아웃 성공 전에는 owner를 유지하고, 실패 시 기존 책장으로 복구해 client-side exception 전환을 막는다.
- hotfix.6는 모바일 정렬·보기 버튼을 헤더와 첫 도서 사이로 옮기고 하단 dock을 320px 한 화면 안에 배치한다.
- hotfix.7은 넓은 화면에서 reflowable EPUB iframe 바깥의 좌우 여백 탭도 기존 페이지 이동 판정으로 연결한다.
- hotfix.7은 기본 OFF인 `가로 모드 2페이지 보기`를 추가하고 탭 모드의 가로 컨테이너에서만 2열, 세로·스크롤 모드에서 1열을 유지한다.

## Phase B — 누적 실기기 검증

상태: 단일기기 UX·성능·장시간 TTS·통계 관찰 진행 중. hotfix.6 로그아웃·모바일 배치와 hotfix.7 태블릿 가로 탭·2페이지 회전을 재확인하고 다중 탭·다중기기 sync acceptance를 이어간다.

- PC Chrome, iPad Safari 브라우저 탭, iPad 홈 화면 PWA를 사용한다.
- EPUB·TXT·PDF·CBZ에서 선택, 하이라이트, 메모, 팔레트, 책갈피, 이동, 검색, 내보내기를 한 흐름으로 반복한다.
- 양기기 동시 로그인, offline 편집, background, 강제 종료, PWA update 뒤 progress·bookmark·annotation·palette·statistics를 비교한다.
- 선택·현재 위치·현재 장 TTS를 20~30분 이상 재생하고 pause/resume/chapter transition과 통계 분리를 확인한다.
- 장기 `activeIntervals` 이력에서 iPad/PWA 통계 modal·기간 변경·export의 시간과 메모리 압박을 측정한다.
- 자정·시간대·시계 차이가 있는 양기기에서 오늘·주·월·책별 합계를 수기로 비교한다.
- 최소 2~3일 실제 독서에서 데이터 손실, 삭제 부활, 이유 없는 자동 이동, 반복 충돌 모달이 재현되지 않아야 한다.
- 로그인 계정 로그아웃 성공·실패 전환에서 client-side exception이 없고, 320px 모바일 책장 액션이 겹치거나 잘리지 않아야 한다.
- 태블릿 가로 화면에서 본문 바깥 여백 탭이 한 번만 이동하고, 선택형 2페이지 보기가 회전 전후 위치·순서를 보존해야 한다.

## Phase C — 안정화 patch와 출시 판정

- 실기기 결함은 원인·영향 범위가 같은 것만 묶고 각 patch마다 자동 회귀와 필요 시 외부 재리뷰를 수행한다.
- 편의성 제안과 새 기능은 1.9.x 후보로 분리한다.
- 모든 이관 항목을 통과·보류·제외 중 하나로 판정하고 알려진 제한과 데이터 정책을 release note에 남긴다.
- 마지막 patch의 전체 gate, 실기기 증거, clean worktree와 배포 상태를 확인한 뒤 1.8.x 안정화 완료를 선언한다.

## 현재 보류 판정

- 다중 탭 단일 실행자: transaction lease fencing, late acquire lifecycle, marker/edit linearization까지 자동검증 완료. 최종 판정은 누적 다중 탭·다중기기 실기기 acceptance 대기.
- retention/compaction: 계측과 migration 승인 gate는 완료. 실제 deletion/archive migration은 사용자 실데이터와 90일 offline 증거 전까지 observe-only.
- production Chrome 장기 회귀: hotfix.4 재리뷰 working tree 반복과 hotfix.5·hotfix.6 전체 gate에서 완주했다.

## Phase A handoff 조건

- 누적 `npm run check:full`과 `git diff --check` 통과
- production Chrome 같은 build 3회 연속 통과
- 외부 최종 코드리뷰 P0~P2 없음
- 단일기기 Phase B는 hotfix.4 재리뷰 결과로 먼저 시작할 수 있다.
- 위 세 조건 뒤 다중 탭·다중기기 Phase B acceptance와 release candidate 판정을 시작한다.

## Phase A 자동검증 결과

- `npm run check:full`: exit 0
- ESLint: 오류 0, 기존 Foliate vendor 경고 2
- TypeScript·production build: 통과
- Node: formats 60/60, drive 49/49, archives 33/33, storage 255/255, shelf 66/66, Service Worker 9/9, release 3/3 — 합계 475/475
- Firestore Rules: 27/27
- Chromium/WebKit Playwright: 14/14
- production Chrome full regression: hotfix.4 재리뷰 build 3회 연속 완주, hotfix.5~7 build 전체 gate 완주
- `git diff --check`: 통과

현재 남은 gate는 hotfix.6~7 배포 실기기 확인, 외부 최종 코드 리뷰, 다중 탭·다중기기 Phase B acceptance와 누적 실기기 테스트다.
