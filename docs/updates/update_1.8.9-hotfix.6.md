# Web Reader 1.8.9 hotfix.6 — 로그아웃 전환·모바일 책장 액션 안정화

작성일: 2026-08-12

기준 커밋: `adacf72`

제품 코드 커밋: `64ac57c`

상위 문서: [update_1.8.9.md](./update_1.8.9.md), [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: 구현·전체 자동검증·커밋 완료. 배포 뒤 로그인 계정 로그아웃과 모바일 실기기 배치 확인 대기

## 목표

실사용 중 확인된 웹 로그아웃 직후 client-side exception 가능성을 제거하고, 기능 증가로 좁아진 모바일 책장 하단바를 다시 한 화면 안에 배치한다.

## 실기기 finding과 수정

### 1. Firebase 로그아웃과 owner lifecycle 순서

기존 흐름은 `signOut()`이 완료되기 전에 `ownerRuntime.clear()`와 책장 상태 초기화를 먼저 수행했다. 그 짧은 구간에는 React의 인증 사용자는 남아 있지만 활성 owner만 없는 상태가 되어 동기화 훅과 화면 lifecycle이 서로 다른 인증 상태를 관찰할 수 있었다. `signOut()`이 실패하면 예외 복구도 없어 Next.js client-side exception 화면으로 끝날 수 있었다.

수정 결과:

- 확인창을 닫고 로딩 화면으로 전환하되 Firebase가 로그아웃을 확정할 때까지 기존 owner를 유지한다.
- `signOut()` 성공 뒤에만 owner, 책장 state, Drive token과 마지막 reader session을 정리하고 인증 화면으로 이동한다.
- 실패하면 owner와 책장 데이터를 지우지 않고 shelf로 복귀하며 사용자에게 재시도 안내를 표시한다.
- 성공·실패 순서를 pure helper로 분리하고 실패 시 local cleanup이 실행되지 않는 회귀 테스트를 추가했다.

### 2. 모바일 책장 액션 재배치

- 정렬과 그리드/목록 전환을 모바일 하단바에서 제거했다.
- 두 버튼은 헤더와 첫 도서 사이의 빈 공간에 우측 정렬로 배치했다.
- 로그인/로그아웃은 기존 헤더 우측에 유지한다.
- 검색, 전체 주석, 통계, 도서 추가, 테마, 오프라인 관리 6개 액션은 하단바 한 화면 안에 균등 배치한다.
- 데스크톱 상단 dock과 스크롤 뒤 bottom dock은 기존 정렬·보기·인증 액션을 그대로 유지한다.
- 긴 서재 제목과 이메일은 모바일 헤더에서 말줄임 처리한다.

## 자동검증

- `npm run check:full`: 통과
- ESLint: 오류 0, 기존 Foliate vendor 경고 2
- TypeScript·production build: 통과
- Node: formats 59/59, drive 49/49, archives 33/33, storage 255/255, shelf 65/65, Service Worker 9/9, release 3/3 — 합계 473/473
- Firestore Rules: 27/27
- Chromium/WebKit Playwright: 14/14
- production Chrome regression: 통과
- 320px 책장: 전체 가로 overflow 0, 하단 dock 가로 overflow 0, 정렬·보기 버튼의 모바일 하단 노출 0
- `git diff --check`: 통과

## 실기기 검증 대기

- 로그인 계정에서 로그아웃 확인 → 로딩 → 인증 화면 전환 중 client-side exception이 발생하지 않는지 확인한다.
- 네트워크가 불안정한 상태에서 로그아웃 실패 시 기존 책장으로 복귀하고 재시도 안내가 보이는지 확인한다.
- iPhone/iPad/Android에서 정렬·보기 버튼이 헤더 아래 우측에 있고 첫 도서와 겹치지 않는지 확인한다.
- 스크롤 뒤 하단 dock 전환, safe-area, PWA standalone에서도 가로 잘림이 없는지 확인한다.

## 완료 조건

- 자동 gate는 완료했다.
- 배포된 `64ac57c` 이상에서 위 실기기 항목을 확인한다.
- 새 코드 레벨 finding이 있으면 1.8.9의 다음 작은 안정화 patch로 분리한다.
