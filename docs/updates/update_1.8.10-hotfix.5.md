# Web Reader 1.8.10 hotfix.5 — 통계 즉시 서버 조회

작성일: 2026-08-12

기준 커밋: `a9f3275`

상위 문서: [update_1.8.10.md](./update_1.8.10.md), [update_1.8.10-hotfix.4.md](./update_1.8.10-hotfix.4.md)

상태: 구현·전체 자동 gate 완료. iPad/Android 실기기 확인 대기

## 실사용 finding

Android에서 읽은 시간을 iPad 책장의 통계 모달에서 확인할 때 바로 갱신되지 않았고, iPad에서 리더에 들어갔다 책장으로 돌아오면 그제야 최신 기록이 보였다.

통계 sync는 앱 시작·foreground 복귀·local change와 60초 주기에 서버 증분 조회를 수행했지만 **통계 모달을 여는 동작 자체는 서버 조회를 요청하지 않았다.** 따라서 직전 주기 직후 상대 기기가 새 session을 올리면 iPad 책장에서는 다음 주기까지 최대 약 60초 기다릴 수 있었다.

## UX 판단

- 모달을 열 때 자동으로 서버 기록을 확인하는 것을 기본 동작으로 한다.
- 사용자가 상대 기기의 업로드 직후 다시 확인하고 싶을 때를 위해 수동 새로고침도 제공한다.
- 버튼은 헤더 닫기 `X`의 바로 왼쪽에 44×44px `RefreshCw` 아이콘만 표시한다.
- 조회 중에는 아이콘을 회전시키고 중복 요청을 막는다.
- “최신”이라는 표현은 사용하지 않는다. 조회 순간 서버에 올라온 기록까지만 확인할 수 있고, 다른 기기에서 아직 진행 중인 1분 session은 서버에 존재하지 않을 수 있다.
- 대신 실제 서버 증분 조회가 성공한 시각을 `마지막 서버 확인`으로 표시한다.
- iPad portrait에서 도서 목록이 모달 본문보다 넓어져 왼쪽이 잘리는 문제를 함께 수정한다. 본문 가로 overflow를 차단하고 도서 카드의 padding·행 간격·모바일 글자 크기를 줄인다.
- 모바일 모달은 최대 높이를 78dvh, 태블릿 이상은 82dvh로 제한하고 폭은 `min(90vw, 36rem)`으로 줄인다. 내용이 많으면 모달 자체가 커지지 않고 본문만 세로 스크롤한다.
- 오늘·이번 주·이번 달 합계, 40px 기간 탭, 화면/TTS 요약, 도서 목록 header·row의 여백과 글자 크기를 모바일 기준으로 조밀하게 조정한다. 새로고침·닫기·내보내기 같은 주요 동작은 44px touch target을 유지한다.
- 서버 시각이 확인되지 않은 record 개수와 기기 간 겹침 제거 안내는 통계 계산에는 유지하되 상시 경고 UI에서는 제거한다.

## 수정 계약

- 통계 모달이 책장에서 visible 상태로 열릴 때 로컬 기록을 먼저 표시하고 서버 증분 조회를 즉시 요청한다.
- 새로고침 아이콘은 같은 증분 조회 경로를 호출하며 기존 hydration cursor·leader lease·schema 격리를 우회하지 않는다.
- 이미 동기화가 실행 중이면 새 요청을 coalesce하고, 현재 실행 뒤 최신 cursor에서 한 번 더 확인한다.
- 같은 브라우저의 다른 탭이 owner별 sync lease를 보유한 경우 `BroadcastChannel`로 새로고침 의도를 전달해 현재 leader가 서버를 조회한다.
- leader가 새 record 0개를 확인한 경우에도 owner별 완료 시각을 요청 탭에 전달해 회전 상태와 `마지막 서버 확인` 표시를 정확히 끝낸다.
- 서버 조회가 실패하면 마지막 성공 시각은 바꾸지 않고 모든 요청 탭의 회전 상태만 종료한다.
- 서버에 새 record가 있으면 IndexedDB 반영 notification으로 열린 모달을 다시 집계한다.
- 새 record가 없어도 성공한 서버 확인 시각은 갱신한다.
- guest/local-only 상태에서는 아이콘을 비활성화하고 로컬 기록임을 표시한다.
- hotfix.3의 1분 session 확정과 hotfix.4의 연속 활동 보존 정책은 변경하지 않는다.
- 긴 도서명은 카드 폭을 키우지 않고 한 줄 말줄임하며, 도서 목록과 본문 `scrollWidth`는 모달 본문 폭을 넘지 않는다.
- 서비스 워커 script를 갱신해 설치형 PWA도 hotfix.5 배포를 감지한다.

## 정확성 경계

수동 새로고침은 **서버에 이미 업로드된 record를 즉시 조회**한다. 상대 기기에서 현재 진행 중인 최대 1분 조각, offline 상태의 pending record, 네트워크 전송 중 record까지 존재한다고 추정하지 않는다. 따라서 버튼 직후 표시되는 시각은 `데이터 생성 시각`이나 `완전한 최신성 보장`이 아니라 `이 기기가 서버 조회를 완료한 시각`이다.

## 자동검증

- 헤더의 새로고침 아이콘이 닫기 버튼 왼쪽에 존재하고 44×44px touch target을 유지하는지 확인
- iPad·320px 폭에서 도서 카드가 모달 본문보다 넓어지지 않고 제목이 안전하게 말줄임되는지 확인
- 모달 open과 수동 아이콘이 server refresh request를 발생시키는지 확인
- 조회 중 중복 클릭 방지·회전 상태·성공 시각 갱신 확인
- local session notification이 열린 모달을 재집계하는 기존 계약 확인
- 기존 cursor pagination·multi-tab lease·1분 기록·TTS·Android focus 회귀 확인
- 320×640 production Chrome 실측: 모달 288×484.5px, 본문 가로 overflow 0, 기간 탭 40px, 주요 action 44px 이상
- `npm run check:full`: 통과
- ESLint: 오류 0, 기존 Foliate vendor 경고 2
- TypeScript·production build: 통과
- Node: formats 63/63, drive 49/49, archives 33/33, storage 261/261, shelf 66/66, Service Worker 9/9, release 3/3 — 합계 484/484
- Firestore Rules: 27/27
- Chromium/WebKit Playwright: 14/14
- production Chrome regression: 통과
- `git diff --check`: 통과

## 실기기 확인

- Android에서 70초 이상 읽은 뒤 iPad 통계 모달을 열어 자동 조회로 기록이 반영되는지 확인한다.
- Android session 확정 직후 iPad 새로고침 아이콘을 눌러 60초 주기를 기다리지 않고 반영되는지 확인한다.
- Android가 offline이거나 아직 1분 session 진행 중일 때는 iPad 새로고침으로 미확정 시간이 생기지 않는지 확인한다.
- iPad에서 표시한 `마지막 서버 확인` 시각이 버튼 완료 때마다 바뀌는지 확인한다.
