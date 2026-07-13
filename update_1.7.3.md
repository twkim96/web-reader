# Web Reader 1.7.3 실기기 회귀 수정

> 2026-07-13: Drive redirect 복귀 시 중간 offline shelf가 노출되는 bootstrap 경쟁은 [update_1.7.4.md](./update_1.7.4.md)에서 수정했다.

작성일: 2026-07-13

## 확인된 원인

1. Firebase progress listener는 shelf에서도 정상 동작했지만, 수신값을 `remoteProgress`에만 저장했다. shelf는 로컬 `progress`만 받아 다른 기기의 진행 상태를 표시하지 못했고 리더의 remote 이동 확인창만 새 값을 사용했다.
2. Drive access token을 메모리에만 저장해 정상 token도 새로고침과 동시에 사라졌다.
3. 1.7.0에서 도입한 GIS popup은 설치형 Edge와 팝업 차단 환경에서 창을 열지 못했다. 1.6.0의 same-page OAuth redirect는 이 제약을 받지 않았다.

## 수정 원칙

- shelf 표시값은 로컬과 Firebase remote 진행 상태 중 `lastRead`가 최신인 값을 사용한다.
- 표시용 병합은 local progress, outbox, conflict 원본을 덮어쓰지 않는다.
- Drive token은 현재 탭의 `sessionStorage`에만 보관해 새로고침을 복구한다.
- Drive 로그인 진입은 1.6.0의 same-page OAuth redirect 방식으로 복원한다.
- token을 `localStorage`나 IndexedDB에는 저장하지 않는다.
- 복구된 token이 유효할 때 Drive 도서 목록을 자동으로 다시 불러온다.
- token 만료, 401, 명시적 연결 해제와 Firebase 로그아웃에서는 저장된 Drive session도 삭제한다.

## 구현 단계

- [x] shelf용 최신 progress 병합 함수와 회귀 테스트 추가
- [x] Drive token snapshot 검증·복구 구현
- [x] 복구된 Drive session의 library 자동 로드 구현
- [x] GIS popup·script·COOP 의존성을 제거하고 state 검증 redirect를 복원
- [x] 1.7.3 package/service worker 버전 갱신
- [x] 전체 Node 테스트, lint, typecheck, production build
- [x] Firestore Rules, Playwright, production browser regression

## 실기기 확인

- Android에서 도서를 읽는 동안 다른 기기의 shelf 진행률과 최근 읽은 순서가 갱신된다.
- 로컬 진행률이 더 최신이면 오래된 remote snapshot 때문에 shelf가 뒤로 가지 않는다.
- Drive 연결 후 같은 탭을 새로고침하면 계정 선택 팝업 없이 Drive 도서 목록이 복구된다.
- macOS 설치형 Edge에서 팝업 없이 Google 페이지로 이동해 Drive 연결을 완료한다.
- 탭을 닫거나 token이 만료된 뒤에는 Drive 재연결을 요구한다.

## 자동검증 결과

- ESLint 오류 0건(기존 Foliate vendor 경고 2건), TypeScript 통과
- 전체 Node 테스트 통과: Drive redirect/session 43개, shelf 표시 15개, storage 53개 포함
- Next.js 1.7.3 production build 통과
- Firestore Rules emulator 9개 통과
- Playwright Chromium/WebKit 10개 통과
- production Chrome browser regression 통과 및 `pc-reader-v1.7.3` service worker cache 확인
