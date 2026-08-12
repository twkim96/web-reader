# Web Reader 1.8.10 hotfix.7 — 라이브러리 주석 모달 축소

작성일: 2026-08-12

기준 커밋: `d5c46bf`

상위 문서: [update_1.8.10.md](./update_1.8.10.md)

상태: 구현·전체 자동 gate 완료. 모바일·iPad·PC 실기기 확인 대기

## 실사용 finding

라이브러리 전체 주석 창은 모바일에서 높이 `92dvh`, 폭은 거의 화면 전체를 사용하고 PC에서는 최대 `5xl`까지 넓어졌다. 통계 창을 축소한 뒤에도 이 창만 화면을 과도하게 차지하고, 주석 관리에 필요한 정보량보다 외곽과 내부 여백이 컸다.

## 변경

- 통계 모달과 동일하게 모바일 최대 높이 `78dvh`, 넓은 화면 `82dvh`를 사용한다.
- 폭은 `min(90vw, 36rem)`으로 제한한다.
- 주석이 많아도 모달 외곽은 커지지 않고 결과 목록만 세로 스크롤한다.
- 헤더, 검색·필터, 내보내기 영역의 세로 여백을 줄인다.
- 주석 행의 위아래 padding을 줄이고 긴 내용이 본문 폭을 늘리지 않도록 가로 overflow를 차단한다.
- 닫기 버튼은 44×44px touch target을 유지한다.
- 검색, 도서·색상·메모·정렬 필터, 내보내기, 공유, 주석 이동 동작은 변경하지 않는다.
- 서비스 워커 script를 갱신해 설치형 PWA도 변경을 감지한다.

## 자동검증

- 320×640 production Chrome에서 모달 폭이 viewport의 92% 이하인지 확인한다.
- 모달 높이가 viewport의 80% 이하인지 확인한다.
- 모달 본문과 document의 가로 overflow가 0인지 확인한다.
- 닫기 버튼이 44×44px 이상인지 확인한다.
- 검색·JSON 다운로드·Markdown 공유·fallback 다운로드·리더 이동·복귀 상태 보존 회귀를 유지한다.
- production Chrome 실측: 320×640에서 검색 결과 1개 기준 모달 288×428.25px, 본문·document 가로 overflow 0, 닫기 44×44px
- `npm run check:full`: 통과
- ESLint: 오류 0, 기존 Foliate vendor 경고 2
- TypeScript·production build: 통과
- Node: formats 63/63, drive 49/49, archives 33/33, storage 261/261, shelf 66/66, Service Worker 9/9, release 3/3 — 합계 484/484
- Firestore Rules: 27/27
- Chromium/WebKit Playwright: 14/14
- production Chrome regression: 통과
- `git diff --check`: 통과

## 실기기 확인

- Android와 iPhone에서 주석 창이 화면을 가득 채우지 않고 목록만 자연스럽게 스크롤되는지 확인한다.
- iPad portrait·landscape와 PC에서 폭이 과도하게 넓지 않으면서 필터와 긴 원문·메모를 읽을 수 있는지 확인한다.
