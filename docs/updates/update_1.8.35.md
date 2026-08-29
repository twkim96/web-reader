# Web Reader 1.8.35 — 로그인·Drive 연결 수명주기 안정화

작성일: 2026-08-29

상태: 3차 UI 일관성 보정 자동검증 완료 · 인증 실사용 재확인 대기

기준 커밋: `bfea3e7`

이전 버전: [1.8.34 메뉴 모달·모바일 바텀시트 통일](./update_1.8.34.md)

상위 계획: [1.8.x 전체 계획](./update_1.8.x_plan.md)

## 목표

Firebase 로그아웃과 후속 Google Drive OAuth 연결을 하나의 브라우저 실행 컨텍스트에 의존하지 않도록 안정화한다.

- 로그아웃 과정에서 전체 문서 이동뿐 아니라 History API URL 변경도 하지 않는다.
- Firebase 로그인 직후 시작한 첫 Drive 연결에서 OAuth `state` 검증이 실패하지 않게 한다.
- Drive 접근 토큰은 기존대로 메모리와 현재 탭 `sessionStorage`에만 보관한다.
- 공유 저장소에는 접근 토큰이 아니라 짧게 만료되고 한 번만 소비되는 임의의 OAuth `state`만 보관한다.
- 일반 탭, 설치형 PWA, OAuth 복귀로 새로 열린 동일 출처 실행 컨텍스트에서 같은 검증 계약을 사용한다.

## 확인된 증상과 경계

### 로그아웃 로드 오류

- 1.8.34가 적용된 설치형 앱에서도 로그아웃 중 브라우저의 `This page couldn’t load` 화면이 노출됐다.
- 구버전 PWA 잔존을 원인으로 확정하지 않는다.
- 1차 패치 `d3d15b3`에서 `window.history.replaceState()`를 제거했지만 실제 로그아웃에서 같은 화면이 재현됐다. URL 탐색 가설은 직접 원인이 아니었다.
- 실제 화면은 브라우저 네트워크 오류 문서가 아니라 Next.js가 앱 루트에 렌더링한 전역 오류 fallback이었다.
- 콘솔은 `OwnerRuntime` 정리 중 `ProgressSyncPumpController.dispose()`가 `TypeError: Illegal invocation`을 던졌음을 가리켰다.
- pump가 브라우저 `clearTimeout`을 인스턴스 메서드처럼 다시 바인딩했고, owner 정리 뒤 React effect cleanup이 같은 비멱등 disposer를 다시 호출하면서 오류가 전역 경계까지 전파됐다.

### 첫 Drive 연결의 `state` 검증 실패

- Firebase 로그인 뒤 첫 Drive OAuth는 `Google Drive 연결 상태를 확인하지 못했습니다`로 실패하고 두 번째 시도는 성공한다.
- 실제 요청과 Google 콜백의 `state`는 첫 시도에서도 일치했다.
- 1.8.34에서는 기대 `state`를 현재 실행 컨텍스트의 `sessionStorage` 한 곳에만 저장했다.
- 콜백은 반환된 `state`가 현재 세션 또는 동일 출처의 짧은 수명 pending-state 집합 중 하나와 일치할 때만 통과시킨다.

## Phase 1 — 문서·릴리스 경계

상태: 완료

- 1.8.34를 종료 상태로 고정한다.
- 1.8.35를 인증 안정화 전용 버전으로 추가한다.
- 광범위한 UI 개편이나 업로드 전송 로직 변경은 섞지 않는다. 다만 실사용 검수에서 확인된 개인정보 모달과 검색 하단의 공용 메뉴 재질 불일치는 같은 버전에서 좁게 보정한다.

## Phase 2 — Drive OAuth pending-state 복구

상태: 완료

- OAuth 시작 시 현재 탭 `sessionStorage`와 동일 출처 공유 pending-state 저장소에 임의 state를 기록한다.
- 공유 레코드는 생성 시각을 포함하고 10분 뒤 만료하며 최대 개수를 제한한다.
- 콜백에서는 URL fragment를 지우기 전에 반환 state를 동기적으로 검증하고 한 번만 소비한다.
- 다른 값, 만료된 값, 이미 소비된 값은 계속 실패 처리한다.
- 로그아웃과 Drive 연결 해제에서 남은 pending state를 제거한다.

## Phase 3 — 로그아웃 문서 수명주기 분리

상태: 1차 수정 완료 · 직접 원인 아님

- Firebase `signOut()` 전후에 `location`·`history` 기반 이동을 하지 않는다.
- guest owner 활성화와 로컬 책장 복원은 기존 `onAuthStateChanged` 단일 경로가 계속 담당한다.
- sign-out 실패 시 기존 owner와 UI를 복원하는 계약을 보존한다.

## Phase 4 — 버전·회귀 검증

상태: 자동검증 완료

- package, lockfile, service worker, Foliate runtime과 관련 회귀 기대값을 `1.8.35`로 맞춘다.
- OAuth state의 현재 컨텍스트 성공, 새 컨텍스트 fallback, 일회 소비, TTL 만료, 다중 pending state를 검증한다.
- 로그아웃 경로에 `window.location`과 `window.history` 이동이 없음을 검증한다.
- `npm run test:drive`, `npm run test:shelf`, `npm run test:release`, `npm run check`를 통과한다.

## Phase 5 — owner cleanup disposer 안정화

상태: 2차 수정 자동검증 완료

- sync pump의 timer adapter를 closure로 호출해 브라우저 함수에 잘못된 receiver를 전달하지 않는다.
- pump dispose는 첫 호출에서 timer handle을 먼저 비우고, 이후 호출은 아무 작업 없이 끝나는 멱등 연산으로 만든다.
- 같은 timer adapter 패턴을 쓰는 snapshot listener recovery도 동일하게 보정한다.
- receiver 재바인딩 금지와 pending timer 일회 해제를 집중 회귀로 고정한다.
- 같은 1.8.35 안에서 서비스워커 script 내용도 갱신해 설치형 앱이 2차 수정 배포를 감지하게 한다.

## 완료 조건

- Firebase 로그인 뒤 첫 Drive 연결이 별도 재시도 없이 완료된다.
- Google 콜백의 state가 앱이 발급한 유효 pending state와 일치하지 않으면 계속 거부된다.
- 접근 토큰은 `localStorage`에 기록되지 않는다.
- 로그아웃은 현재 React 문서를 유지하고 guest 책장으로 전환된다.
- 1.8.35 버전·캐시 정합성과 자동 회귀가 통과한다.

## Phase 6 — 모달 헤더·검색 하단 재질 일관성

상태: 자동검증·로컬 브라우저 확인 완료

- 개인정보 처리방침 모달은 공용 `MenuSheetHeader`를 사용해 닫기 X를 왼쪽에 두고, 표준·글래스·모던 닫기 표면을 그대로 따른다.
- 기존 방패 표시는 정보 맥락을 유지하되 헤더 우측 보조 아이콘으로 이동한다.
- 책장 검색의 `전체 검색 결과 화면 보기` 하단은 단색 보조 배경 대신 검색 본체와 같은 메뉴 재질을 사용한다.
- 검색 결과 미리보기와 구분되도록 하단 재질은 본체보다 한 단계 어둡게 조정한다.
- 동일 버전의 설치형 PWA도 후속 UI를 감지하도록 Service Worker script 내용을 갱신한다.

## 검증 결과

상태: 3차 UI 일관성 보정 자동검증 완료 · 인증 실사용 재확인 대기

- 1차 실사용 검증: 실패. `d3d15b3` 적용 뒤에도 로그아웃 시 같은 오류 화면 재현.
- 브라우저 실측: URL은 `/`에 유지됐고 Next.js 오류 fallback과 `ProgressSyncPumpController.dispose()`의 `TypeError: Illegal invocation` 스택 확인.
- timer receiver·멱등 disposer·로그아웃 집중 회귀: 16개 통과
- `npm run test:drive`: 56개 통과
- `npm run test:shelf`: 121개 통과
- `npm run test:release`: 3개 통과
- 2차 수정 `npm run check`: lint 오류 0건(기존 경고 4건), TypeScript, 전체 Node/Python 회귀, Next.js production build 통과
- 코드·테스트 런타임 영역에 남은 `1.8.34` 버전 참조 없음
- 3차 UI 집중 회귀 `npm run test:shelf-ui`: 개인정보 헤더의 왼쪽 공용 닫기 버튼과 검색 하단의 표준·글래스·모던 전용 재질을 포함해 48개 통과
- 3차 UI 수정 뒤 `npm run check`: lint 오류 0건(기존 경고 4건), TypeScript, 전체 Node/Python 회귀, Next.js production build 통과
- 로컬 브라우저 글래스 실측: 개인정보 닫기 버튼이 헤더 첫 요소이자 제목 왼쪽에 위치하고 `blur(4.2px)` 재질 적용. 검색 하단과 CTA도 `blur(4.2px)`를 유지하면서 본체보다 진한 반투명 배경으로 분리됨
- `npm run test:browser:ci`: 이번 개인정보·검색 하단 실브라우저 assertion은 통과. 이후 기존 테마 미리보기의 `모던` 접근성 이름 fixture가 빈 문자열을 반환하는 기존 불일치에서 중단됨
- 배포 뒤 실제 계정의 로그아웃 → Firebase 재로그인 → 첫 Drive 연결을 다시 확인하고 완료 조건을 최종 승인한다.
