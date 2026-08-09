# Web Reader 1.8.8-hotfix.3 원격 이동·TTS 통계 경계 안정화

작성일: 2026-08-10

기준: [update_1.8.8-hotfix.2.md](./update_1.8.8-hotfix.2.md)

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: 추가 전체 리뷰 finding 구현·`npm run check`·Rules·Playwright 완료. production Chrome 장기 회귀 P3는 1.8.9 Phase A에서 마감

## 목표

원격 진행률 충돌 해결을 실제 화면 이동과 영속 상태 확정의 2단계 commit으로 만들고, 연속 TTS와 고정 레이아웃 입력을 독서 통계에 정확히 연결한다.

## 수용한 finding

- 활성 도서에서 `원격 값 사용`이 persistence를 먼저 바꾼 뒤 화면 이동을 시도해 실패 시 DB·viewport가 갈라질 수 있던 P1
- 원격 이동 준비가 기존 pending 진행률 저장을 지우고 실패 뒤 복원하지 않던 P1
- 연속 장 TTS의 utterance 사이 `starting/loading` 전이가 세션을 잘게 나누거나 screen 시간으로 오인될 수 있던 P1
- PDF·이미지·압축책의 overlay 입력이 activity tracker까지 도달하지 않아 화면 독서가 기록되지 않던 P1

## 구현

- 활성 도서 충돌은 먼저 readonly preview command만 만들고, renderer 이동이 성공한 뒤 같은 local intent인지 재검사하며 conflict·progress·event를 한 transaction에서 확정한다.
- 확정 실패나 navigation 예외에서는 이전 CFI로 viewport를 되돌린 뒤 준비 이전 pending save를 복구한다. 준비 이후 사용자의 새 이동이 있으면 이전 snapshot 대신 최신 위치를 저장 대상으로 유지한다.
- 충돌 command가 staged된 동안 전역 충돌 모달을 숨기고 리더 내부 이동 UI에서 재시도·취소할 수 있게 했다.
- TTS tracking phase를 `inactive`, `awaiting-first-start`, `active-run`, `paused`로 분리했다. 실제 재생을 한 번 시작한 연속 TTS는 utterance 준비 구간을 같은 run으로 유지하고 pause·finish·error에서 닫는다.
- TTS 종료 시 오래된 화면 입력 시각을 초기화해 듣기 종료가 즉시 화면 독서로 바뀌지 않게 했다.
- 고정 레이아웃 tap·wheel·keyboard·pinch·pan의 실제 navigation/zoom 동작을 activity tracker에 연결했다.

## 검증

- 원격 progress preview가 persistence를 바꾸지 않고 같은 local intent에서만 finalize되는 회귀 테스트
- finalize 실패 시 viewport rollback 후 pending save 복원 순서 테스트
- 연속 TTS utterance 전이·pause·finish 통계 정책 테스트
- TypeScript 및 관련 progress/sync/statistics 집중 테스트 통과
- 누적 `npm run check` 통과: ESLint 오류 0(기존 Foliate 경고 2), TypeScript, Node 58/49/33/216/58/9/3, production build
- Firestore Rules 26/26, Chromium/WebKit Playwright 14/14 통과
- production Chrome은 guest shelf와 1,100권 두 번째 page를 통과한 뒤 기존 장기 selection 구간에서 headless compositor/`requestAnimationFrame` 정지가 재현되어 full gate 전체 green은 보류한다.

## 실기기 이관

- 양기기에서 같은 도서를 연 상태로 원격 위치 채택 중 탭 이동·취소·앱 background를 섞어 DB와 화면이 같은지 확인
- 현재 장 TTS 20~30분 재생에서 문장 사이 준비 시간이 screen으로 집계되지 않는지 확인
- PDF·CBZ tap·wheel·pinch 입력 뒤 화면 독서 통계가 시작되는지 확인
