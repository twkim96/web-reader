# Web Reader 1.8.8-hotfix.1 리더 이동·충돌 모달 안전성

작성일: 2026-08-09

기준: 1.8.8 working tree 전체 리뷰

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

후속 패치: [update_1.8.8-hotfix.2.md](./update_1.8.8-hotfix.2.md)

상태: 구현·전체 자동검증 완료, 외부 재리뷰 대기

## 목표

원격 읽기 위치 이동이 실제 renderer에 반영된 뒤에만 로컬 진행률을 확정하고, 충돌 모달이 열린 동안 뒤쪽 리더가 계속 동작하지 않게 한다. EPUB 외부 링크는 새 탭에서 원본 리더를 제어할 수 없도록 연다.

## 수용한 전체 리뷰 finding

- 취소되거나 더 최신 이동에 밀린 `goTo()` 결과를 성공처럼 처리해 원격 위치가 최신 사용자 이동을 덮을 수 있던 P1
- 활성 책의 북마크·주석 충돌까지 즉시 전체 화면 모달로 열면서 뒤쪽 리더 탭·휠·TTS·독서 시간은 계속 동작하던 P1 UX
- 충돌 모달의 dialog semantics, 포커스 진입·순환·복원과 Escape 처리가 빠져 있던 접근성 문제
- EPUB 외부 링크를 `_blank`로 열면서 `noopener`가 보장되지 않아 `window.opener`가 남을 수 있던 P1 보안 문제

## 구현

### 이동 commit 계약

- Foliate `goTo()`는 navigation sequence가 더 최신 이동에 밀리거나 renderer 이동이 실패하면 `false`, 실제 반영되면 resolved location을 반환한다.
- `goToFraction()`도 실제 반영 여부를 boolean으로 반환한다.
- 원격 진행률 적용 순서는 `prepare → renderer navigation → current generation 확인 → local/remote progress 확정`으로 고정했다.
- navigation이 취소되면 remote completion을 실행하지 않고 preparation을 취소한다.
- preparation 중 사용자 이동이 발생했다면 마지막 persistable location을 다시 save queue에 넣어, remote 이동용 `skipNextSave`가 사용자 이동을 삼키지 않게 했다.
- explicit remote reset도 별도 성공 가정 경로를 쓰지 않고 같은 commit 계약을 거친다.

### 충돌 표시 정책과 reader 차단

- 자동 전체 화면 충돌 모달은 현재 열어 둔 책의 `progress` 충돌에만 사용한다.
- 북마크·주석·팔레트 충돌과 다른 책의 충돌은 `동기화 확인 필요` 배지에 남기고 사용자가 명시적으로 연다.
- 모달이 열린 동안 reader 탭·마우스·휠·키보드 이동, 선택·하이라이트 메뉴, TTS와 독서 session tracker를 중단한다.
- 충돌 대상, 감지 시각, 확인 가능한 원격 변경 시각과 읽기 위치 비율을 모달에 표시한다.
- 두 충돌 모달에 `role="dialog"`, `aria-modal`, 제목·설명 연결, 최초 포커스, Tab 순환, 포커스 복원과 Escape 처리를 추가했다.

### 외부 링크

- publication 기준으로 URL을 절대 경로로 해석하고 `http:`·`https:`만 외부 탭으로 연다.
- `noopener,noreferrer` feature를 지정하고 반환된 창의 `opener`를 한 번 더 `null`로 만든다.
- publication sanitizer의 기존 `target="_blank"`, `rel="noopener noreferrer"` 계약은 유지한다.

## 호환성 경계

- progress·bookmark·annotation의 revision, receipt, tombstone과 IndexedDB outbox 구조는 변경하지 않았다.
- 자동 충돌 해결 조건은 유지하고 표시 계층만 progress와 비-progress로 나눴다.
- remote navigation이 성공한 경우의 기존 자동 책갈피와 device claim 동작은 유지한다.

## 자동검증

- TypeScript: 통과
- remote progress·sync conflict 집중 Node 테스트: 통과
- ESLint: hotfix 신규 오류 0, 기존 Foliate vendor 경고 2개
- Node: formats 58, drive 49, archives 33, storage 211, shelf 57, Service Worker 9, release 3 통과
- production build: 통과
- Firestore Rules: 26/26 통과
- Chromium/WebKit Playwright: 14/14 통과
- production Chrome regression: 통과
- 전체 `check:full`: 통과
- `git diff --check`: 통과

## 실기기 이관

- iPad Safari·Android Chrome에서 원격 위치 모달을 연 채 탭·스와이프·키보드 입력이 뒤쪽 reader를 움직이지 않는지 확인
- 원격 이동 직후 빠르게 반대 방향을 탭했을 때 최신 사용자 위치가 보존되는지 확인
- 외부 링크가 새 탭에서 열리고 뒤로 돌아온 reader 상태가 변하지 않는지 확인
