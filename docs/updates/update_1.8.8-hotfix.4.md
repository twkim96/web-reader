# Web Reader 1.8.8-hotfix.4 수동 이동·날짜 집계 안정화

작성일: 2026-08-10

기준: [update_1.8.8-hotfix.3.md](./update_1.8.8-hotfix.3.md)

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: 추가 전체 리뷰 finding 구현·`npm run check`·Rules·Playwright 완료. production Chrome 장기 회귀 P3는 1.8.9 Phase A에서 마감

## 목표

사용자 이동도 renderer commit 이후에만 진행률·자동 책갈피를 확정하고, 보정된 통계 구간과 reader activity listener의 수명 경계를 정확히 맞춘다.

## 수용한 finding

- 퍼센트·CFI·TOC·검색·책갈피·주석 이동이 renderer 성공 전에 자동 책갈피와 dirty progress를 바꾸던 P2
- 원격 진행률 확인 경로의 복구 자동 책갈피도 navigation 전 React state를 바꾸던 같은 계열 finding
- 시계 보정된 canonical slice가 자정을 가로지를 때 하루 합계가 시작일에 몰리던 P2
- reflow 중 교체된 iframe Document를 activity target Map에 계속 보존하던 P2
- 진행률 슬라이더 확인 모달이 reader/TTS/statistics를 막지 않고 focus trap·busy 상태가 없던 P2

## 구현

- 자동 책갈피 계산을 side effect 없는 stage와 명시적 commit으로 분리했다.
- 모든 수동 jump는 target을 stage하고 renderer가 `true`를 반환한 뒤에만 bookmark React state, dirty progress, immediate save와 모달 close를 수행한다.
- 슬라이더 확인 중 reader를 suspended 상태로 두고 TTS를 정지한다. 이동 중 재확인·취소·Escape를 막고 dialog focus trap, focus 복귀, `aria-busy`를 추가했다.
- remote prompt의 로컬 복구 책갈피도 target bookmarks에 stage해 navigation·persistence 성공 뒤에만 채택한다.
- canonical winner slice를 session 시작 timezone의 현지 자정마다 나눈 뒤 day/week/month 범위와 상세·상단 합계에 같은 조각을 사용한다.
- activity polling마다 현재 view와 현재 content Document 집합을 만들고, 사라진 Document의 listener를 제거해 Map에서도 삭제한다.

## 검증

- 보정 구간이 23:59~00:01을 통과할 때 양일에 1분씩 배분되고 하루 상세도 1분만 집계되는 테스트
- 원격 이동 commit/rollback 및 통계 집중 테스트 통과
- TypeScript 통과
- Node 누적 216개 storage·58개 shelf를 포함한 `npm run check`, Rules 26/26, Chromium/WebKit 14/14 통과
- production Chrome 장기 회귀의 별도 headless 정지 때문에 `check:full` 전체 green은 아직 선언하지 않는다.

## 실기기 이관

- 이동 확인 중 TTS가 즉시 멈추고 배경 tap·keyboard가 reader를 움직이지 않는지 확인
- 잘못된 CFI, 닫히는 iframe, 빠른 연속 TOC·검색 이동에서 자동 책갈피가 실패한 위치를 기록하지 않는지 확인
- 기기 시각 보정으로 자정을 넘는 기록의 오늘·일별·도서별 합계 비교
