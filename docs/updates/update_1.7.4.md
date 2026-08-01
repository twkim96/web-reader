# Web Reader 1.7.4 Drive bootstrap 화면 전환 수정

작성일: 2026-07-13

후속 안정화: 동기화 경쟁 조건과 Firestore 최초 수화 문제는 `update_1.7.5.md`에서 처리한다.

## 원인

Drive OAuth redirect 또는 저장된 Drive session 복구 중에도 Firebase bootstrap이 로컬 복구 완료만 보고 `isOfflineMode=true`, `view=shelf`를 먼저 적용했다. 이후 Drive session loader가 다시 `view=loading`을 거쳐 cloud shelf를 열어 중간 offline shelf와 화면 깜빡임이 발생했다.

## 수정

- OAuth state 또는 만료되지 않은 Drive session이 있으면 Firebase bootstrap이 shelf 공개를 보류한다.
- 보류 중에는 하나의 loading 화면을 유지한다.
- Firebase user, Drive token, Drive sessionId가 모두 준비된 공통 loader만 Drive 목록을 불러온다.
- Drive 성공 또는 실패가 확정된 뒤 한 번만 shelf로 전환한다.
- 만료되거나 손상된 session은 보류 조건으로 인정하지 않아 로컬 shelf 진입을 막지 않는다.
- OAuth state만 남고 결과 fragment가 없는 취소·뒤로 가기는 보류하지 않는다.

## 검증

- [x] OAuth pending state gate 단위 테스트
- [x] 유효/만료 Drive session gate 단위 테스트
- [x] Firebase bootstrap에서 offline shelf 전환 전 gate 확인 회귀 테스트
- [x] lint, typecheck, 전체 Node 테스트, production build
- [x] Playwright 및 production browser regression

## 실기기 확인

- `클라우드 연결 → Google 로그인/계정 선택 → loading → cloud shelf` 순서로 한 번만 전환한다.
- OAuth 실패나 Drive API 실패에서는 loading이 종료되고 로컬 shelf가 열린다.
- 유효한 Drive session으로 새로고침해도 중간 offline shelf가 나타나지 않는다.

## 자동검증 결과

- ESLint 오류 0건(기존 Foliate vendor 경고 2건), TypeScript 통과
- 전체 Node 테스트 통과: Drive bootstrap/redirect/session 45개 포함
- Next.js 1.7.4 production build 통과
- Playwright Chromium/WebKit 10개 통과
- production Chrome browser regression 통과 및 `pc-reader-v1.7.4` service worker cache 확인
