# Web Reader 1.8.9 실기기 전 선행 안정화·누적 실사용 검증

작성일: 2026-08-10

기준: 1.8.8 + [hotfix.1](./update_1.8.8-hotfix.1.md)~[hotfix.7](./update_1.8.8-hotfix.7.md) working tree

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: 문서 작성 완료. Phase A 선행 안정화 TODO가 끝나기 전에는 실기기 검증을 시작하지 않음

## 목표

1.8.x의 알려진 코드·운영 위험을 먼저 닫은 뒤 feature freeze 상태에서 PC, iPad Safari와 홈 화면 PWA의 누적 실사용 검증을 수행한다. 새 사용자 기능은 추가하지 않는다.

## Phase A — 실기기 전 선행 안정화 TODO

### A1. 다중 탭 독서 통계 sync 단일 실행자

상태: TODO

- owner별 통계 hydration/upload에 하나의 active leader만 두는 lease 또는 Web Locks protocol을 설계한다.
- tab 종료·background·lease 만료·same-tab reacquire·owner 전환을 구분하고 늦은 continuation을 폐기한다.
- follower는 IndexedDB change wake만 전달하고, leader 변경 후 pending upload와 exact hydration cursor에서 멱등 재개한다.
- 두 탭 동시 시작, leader 강제 종료, offline→online, token refresh, 500개 multi-page hydration을 자동 테스트한다.
- 구현 전후 Firestore read/write 수를 계측해 비용 감소를 확인한다.

### A2. retention·compaction 계측과 migration 설계

상태: TODO — hotfix.2에서 수용 후 안전상 보류한 항목

임의 TTL 삭제는 offline 복귀, tombstone 삭제 부활 방지, receipt 멱등성과 cloud recovery 계약을 깨뜨릴 수 있으므로 계측·정책·migration·rollback을 한 묶음으로 진행한다.

계측 대상:

- owner별 outbox 상태별 개수·대략적 byte와 가장 오래된 event age
- open/deferred/resolved conflict 개수와 age
- annotation active/tombstone/receipt/remote-head 개수와 byte
- 통계 raw segment 수, 월 증가량, hydration page/read 수와 집계 시간
- IndexedDB 전체/도메인별 사용량과 quota 비율
- 7일·30일·90일 offline 기기의 재접속 결과

정책 결정 항목:

- acked/superseded outbox와 resolved conflict의 local compaction watermark
- tombstone·receipt 최소 보존 기간, stale device watermark와 삭제 부활 차단 방식
- 통계 raw segment의 월별 immutable archive 또는 검증 가능한 aggregate 전환
- export, 사용자 전체 삭제, 계정 전환, 복구, rollback 계약
- emulator migration과 구버전 client 재접속 호환성

완료 증거:

- 실제 계측 표본과 용량/비용 기준선
- migration 전후 동일한 authoritative snapshot·통계 합계
- 7/30/90일 offline 복귀 fixture
- 중단·재시작·rollback 자동 테스트

### A3. 추가 리뷰·자동 gate 마감

상태: TODO

- hotfix.3~7 외부 재리뷰에서 P0~P2가 남지 않아야 한다.
- `npm run check:full`과 `git diff --check`를 clean checkout에서 통과한다.
- production guest bootstrap을 여러 번 반복해 callback 지연에도 local shelf가 열리는지 확인한다.
- production Chrome 장기 회귀가 reader selection 구간에서 headless compositor와 `requestAnimationFrame` 응답을 잃는 P3를 마감한다. command context, `visibilityState`, focus, live Foliate Document 목록과 `window.__regressionErrors`를 timeout 증거에 함께 남기고, 제품 hang인지 CDP 입력/foreground 인프라 문제인지 분리한다.
- 대량 책장 자동 pagination과 명시적 `더 보기` fallback을 각각 검증하되, observer 누락이 뒤의 reader 회귀를 가리지 않게 한다.
- 알려진 P3는 재현 조건, 사용자 영향, 보류 사유와 실기기 관찰 항목을 명시한다.

## Phase B — 누적 실기기 검증

상태: Phase A 완료 후 시작

- PC Chrome, iPad Safari 브라우저 탭, iPad 홈 화면 PWA를 사용한다.
- EPUB·TXT·PDF·CBZ에서 선택, 하이라이트, 메모, 팔레트, 책갈피, 이동, 검색, 내보내기를 한 흐름으로 반복한다.
- 양기기 동시 로그인, offline 편집, background, 강제 종료, PWA update 뒤 progress·bookmark·annotation·palette·statistics를 비교한다.
- 선택·현재 위치·현재 장 TTS를 20~30분 이상 재생하고 pause/resume/chapter transition과 통계 분리를 확인한다.
- 자정·시간대·시계 차이가 있는 양기기에서 오늘·주·월·책별 합계를 수기로 비교한다.
- 최소 2~3일 실제 독서에서 데이터 손실, 삭제 부활, 이유 없는 자동 이동, 반복 충돌 모달이 재현되지 않아야 한다.

## Phase C — 안정화 patch와 출시 판정

- 실기기 결함은 원인·영향 범위가 같은 것만 묶고 각 patch마다 자동 회귀와 필요 시 외부 재리뷰를 수행한다.
- 편의성 제안과 새 기능은 1.9.x 후보로 분리한다.
- 모든 이관 항목을 통과·보류·제외 중 하나로 판정하고 알려진 제한과 데이터 정책을 release note에 남긴다.
- 마지막 patch의 전체 gate, 실기기 증거, clean worktree와 배포 상태를 확인한 뒤 1.8.x 안정화 완료를 선언한다.

## 현재 보류 판정

- 다중 탭 단일 실행자: 타당하지만 새 lease protocol이므로 1.8.8 hotfix에 즉시 구현하지 않음. Phase A에서 구현한다.
- retention/compaction: 타당하지만 삭제 정책을 먼저 넣을 수 없음. Phase A에서 계측·migration 설계를 완료하고 별도 구현 범위를 확정한다.
- production Chrome 장기 회귀: guest bootstrap 문제는 수정됐지만 headless selection 단계 정지가 남아 `check:full` 전체 green을 선언하지 않음. Phase A에서 검증 인프라와 제품 수명을 분리해 해결한다.
