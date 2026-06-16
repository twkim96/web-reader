# 업데이트 1.6.4 계획

## 상태

- 1.6.3 작업은 구현과 배포 검증까지 완료된 상태로 닫는다.
- 2026-06-16 기준 1.6.4 기능 구현과 로컬 검증을 완료했다.

## 목표

- 리더에서 스페이스바로 다음 위치로 이동할 수 있게 한다.
- 탭 모드와 스크롤 모드 모두에서 스페이스바가 아래 화살표와 같은 다음 이동 감각을 제공한다.
- 마지막으로 읽던 책을 로컬 기기 기준으로 자동 재개할 수 있게 한다.
- 설정 모달이 기능 추가로 계속 길어지지 않도록 고정된 크기와 내부 스크롤 구조로 정리한다.
- 앱과 서비스워커 버전을 1.6.4로 올린다.

## Phase 1: 리더 스페이스바 다음 이동

### 대상

- `src/lib/readerNavigation.ts`
- `src/components/EpubReader.tsx`
- `tests/readerNavigation.test.mjs`
- `package.json`
- `package-lock.json`
- `public/sw.js`
- `tests/releaseVersion.test.mjs`
- `tests/browserRegression.mjs`

### 변경

- 리더 키보드 입력 판정을 공용 `getReaderKeyboardAction()`으로 분리한다.
- `Space`, `Spacebar`, 실제 공백 키 값을 모두 다음 이동으로 처리한다.
- 스크롤 모드에서는 스페이스바가 `ArrowDown`처럼 현재 키보드 스크롤 거리만큼 아래로 이동한다.
- 탭 모드에서는 스페이스바가 다음 페이지 이동을 실행한다.
- 입력창, 선택 상자, contenteditable, 리더 모달이 열려 있는 동안은 기존처럼 키 이동을 무시한다.

### 상태

- 구현 완료.
- 로컬 단위 테스트, release 버전 검사, TypeScript, 변경 파일 ESLint를 통과했다.

### 완료 조건

- 스크롤 모드에서 스페이스바를 누르면 아래 화살표와 같은 거리 기반 다음 이동이 실행된다.
- `T/B Tap`, `L/R Tap`, `4-Way`에서 스페이스바를 누르면 다음 이동이 실행된다.
- 반복 입력 방지는 기존 탭 모드 키보드 정책을 유지한다.
- 앱, lockfile, 서비스워커 캐시 버전이 모두 1.6.4다.

### 검증

- `npm run test:formats`: 36개 통과.
- `npm run test:release`: 1개 통과.
- `npx tsc --noEmit`: 통과.
- 변경 파일 ESLint: 통과.
- `git diff --check`: 통과.

## Phase 2: 마지막으로 읽던 책 자동 열기

### 목표

- 여러 기기 공유 없이 현재 기기에서만 마지막으로 읽던 책을 자동으로 다시 연다.
- 앱을 새로 열 때와 새로고침할 때 모두 마지막 리더 세션으로 복귀한다.
- 사용자가 끝까지 읽은 책은 자동 열기 대상에서 제외한다.

### 대상

- `src/types.ts`
- `src/hooks/useViewerSettings.ts`
- `src/app/page.tsx`
- 새 로컬 세션 helper 또는 hook
- `src/components/SettingsModal.tsx`
- 관련 자동 테스트

### 설정

- 설정 모달 하단에 구분선을 추가하고 그 아래에 `마지막으로 읽던 책 자동 열기` 체크박스를 배치한다.
- 기본값은 활성화한다.
- 설정값은 기존 `viewer_settings`에 병합해 저장한다.
- 기존 사용자 설정에 새 값이 없으면 `true`로 자동 보정한다.

### 상태

- 구현 완료.
- 로컬 세션 helper, 설정 기본값 병합, production 브라우저 회귀를 통과했다.

### 로컬 세션 정책

- 마지막 책 기록은 `localStorage`에만 저장한다.
- 저장 값은 최소한 `bookId`, `updatedAt`만 둔다.
- 책의 전체 metadata나 파일 content는 세션 기록에 복제하지 않는다.
- 실제 책 열기는 부팅 후 복구된 `books` 배열에서 `bookId`를 다시 찾아 실행한다.
- 자동 진입 여부는 서버 진행률을 기다리지 않고 로컬 세션 포인터와 현재 책 목록만으로 판단한다.
- 읽던 위치는 리더 진입 시점에 이미 있는 `progress[bookId]`의 `anchorCfi`, `cfi`, `progressPercent`를 사용한다.
- 리더가 열린 뒤 로컬 또는 원격 진행률이 `99.9%` 이상으로 들어오면 마지막 책 기록을 삭제해 다음 새로고침부터 책장을 연다.
- 진행률 저장 시 `99.9%` 이상이면 마지막 책 기록을 삭제하고 새로 저장하지 않는다.
- 책이 삭제됐거나 현재 책장에 없으면 마지막 책 기록을 삭제하고 책장에 머문다.
- 로그아웃, 클라우드 연결 해제, 도서 삭제 시 현재 마지막 책 기록이 영향을 받으면 삭제한다.

### 자동 열기 시점

- 인증과 로컬/Drive 책장 복구가 끝난 뒤 한 번만 자동 열기를 시도한다.
- 사용자가 앱 안에서 리더 뒤로가기로 책장에 나온 직후에는 즉시 재진입하지 않는다.
- 브라우저 새로고침 또는 앱 재시작처럼 React state가 초기화된 진입에서만 자동 열기를 수행한다.
- 자동 열기 설정이 꺼져 있으면 기록은 사용하지 않고 책장에 머문다.

### 완료 조건

- 기본 설정에서 읽던 책을 연 뒤 새로고침하면 같은 책의 리더로 복귀한다.
- 설정을 끄면 새로고침 후 책장에 머문다.
- 자동 진입은 서버 진행률 수신을 기다리지 않는다.
- 자동 진입 후 로컬 또는 원격 진행률이 `99.9%` 이상으로 확인되면 마지막 책 기록이 삭제되고 다음 새로고침은 책장을 연다.
- 마지막 책이 삭제되었거나 현재 계정/모드의 책장에 없으면 기록을 정리하고 오류 없이 책장을 표시한다.
- 로컬 기기 기록만 사용하며 Firestore나 Drive에 마지막 책 포인터를 저장하지 않는다.

### 검증

- `tests/viewerSettings.test.mjs`에서 기존 설정에 `autoOpenLastBook`이 없으면 기본 `true`로 병합되고, 명시적 `false`는 유지됨을 검증했다.
- `tests/lastReaderSession.test.mjs`에서 마지막 책 세션 저장, 선택적 삭제, 100% 저장 제외, 누락 책 정리를 검증했다.
- production Chromium 회귀에서 설정 체크박스 기본 활성화, 비활성화 저장, 재활성화 저장을 확인했다.
- `npm run test:shelf`: 11개 통과.

## Phase 3: 설정 모달 구조 정리

### 목표

- 기능이 늘어나도 설정 모달의 외부 크기가 더 커지지 않게 한다.
- 자주 쓰는 `Size`는 바로 접근 가능하게 유지한다.
- 덜 자주 쓰는 세부 수치 조절은 접을 수 있는 확장 영역으로 묶는다.

### 대상

- `src/components/SettingsModal.tsx`
- 필요 시 설정 모달 상태 helper
- 브라우저 회귀 테스트 또는 컴포넌트 동작 테스트

### 레이아웃 결정

- 모달 프레임은 최대 높이를 고정하고, 헤더와 닫기 버튼은 항상 보이게 둔다.
- 스크롤은 모달 전체가 아니라 본문 영역에서만 발생하게 한다.
- 현재 `max-h-[85vh] overflow-y-auto` 구조는 본문 스크롤 구조로 정리한다.
- `justify-center`처럼 내용 높이에 따라 스크롤 체감을 흐릴 수 있는 배치는 제거한다.
- 작은 화면에서도 첫 화면에 제목, 닫기, 주요 설정이 안정적으로 보이게 한다.

### 상태

- 구현 완료.
- fixed-layout 설정 모달에서 탭 영역과 자동 열기 체크박스 접근을 production Chromium 회귀로 확인했다.

### 확장형 수치 조절 영역

- 중간 수치 조절 단락의 맨 위에 `Size` 행을 배치한다.
- `Size` 왼쪽에 아래로 펼쳐지는 chevron 아이콘을 둔다.
- `Size` 행의 `-`, `+`는 접힌 상태에서도 항상 노출한다.
- `Size` 행을 누르면 아래 네 개 항목이 펼쳐지고 다시 누르면 닫힌다.
- 접히는 네 항목은 `Paragraph Gap`, `Line`, `Top/Bottom`, `Left/Right`로 둔다.
- `Top/Bottom`, `Left/Right`는 고정 레이아웃 도서에서도 필요하므로 fixed-layout에서 숨기지 않는다.
- fixed-layout에서는 `Size`, `Paragraph Gap`, `Line` 같은 텍스트 전용 조절은 표시하지 않고, 탭 영역 조절만 접근 가능하게 별도 fallback 구조를 둔다.

### 직관성 판단

- `Size`는 자주 바꾸는 값이라 접힌 상태에서도 조절 가능하게 두는 것이 직관적이다.
- `Size` 아래에 나머지 수치 조절을 접는 구조는 설정을 한 그룹으로 이해하기 쉽다.
- 다만 `Size` 행 전체가 펼침 토글이면서 동시에 `-`, `+` 버튼을 가지므로, 버튼 클릭은 값 조절만 하고 행 배경 또는 chevron 클릭은 펼침 토글만 하도록 이벤트 경계를 분리한다.
- chevron에는 열림/닫힘 상태를 시각적으로 회전시켜 현재 상태를 명확히 표시한다.

### 하단 자동 열기 설정

- 설정 모달 하단에 구분선을 추가한다.
- 구분선 아래에 `마지막으로 읽던 책 자동 열기` 체크박스를 둔다.
- 체크박스는 일반 버튼처럼 보이지 않게 실제 체크 상태가 명확한 binary control로 만든다.
- 체크박스 주변 문구는 짧게 유지하고, 상세 설명 텍스트로 모달을 더 키우지 않는다.

### 완료 조건

- 설정 모달이 작은 화면에서도 지정된 최대 높이를 넘지 않고 본문만 스크롤된다.
- `Size`는 접힌 상태에서도 바로 변경 가능하다.
- `Size` 확장 영역을 열고 닫아도 모달 외부 크기가 변하지 않는다.
- 확장 영역 안의 네 항목은 기존 범위와 저장 정책을 그대로 유지한다.
- 하단 자동 열기 체크박스가 기본 활성화 상태로 표시되고 설정 변경이 저장된다.
- 고정 레이아웃 도서에서도 탭 영역 조절과 자동 열기 설정에 접근할 수 있다.

### 검증

- production Chromium 회귀에서 설정 모달 열기, 자동 열기 체크박스 토글, fixed-layout 탭 영역 스테퍼 조절을 확인했다.
- production Chromium 회귀에서 `Top/Bottom 33% → 35%`, `Left/Right 30% → 29%` 저장을 확인했다.
- production Chromium 회귀에서 fixed-layout 도서에서도 탭 영역 설정과 자동 열기 체크박스가 표시됨을 확인했다.
- `npx eslint src/app/page.tsx src/components/SettingsModal.tsx src/hooks/useViewerSettings.ts src/lib/lastReaderSession.ts tests/lastReaderSession.test.mjs tests/viewerSettings.test.mjs tests/browserRegression.mjs`: 통과.
- `npm run build`: 통과.
- `npm run test:browser`: 통과.

## 1.6.4 통합 검증

- `npm run test:formats`: 36개 통과.
- `npm run test:shelf`: 11개 통과.
- `npm run test:release`: 1개 통과.
- `npx tsc --noEmit`: 통과.
- 변경 파일 ESLint: 통과.
- `npm run build`: 통과.
- `npm run test:browser`: 통과.
- `git diff --check`: 통과.

## 추가 수정: 테마 저장과 설정 모달 섹션 정리

### 변경

- 기본 테마 선택이 `viewer_settings.theme`에 즉시 저장되도록 `ThemeModal`의 선택 경로를 단일화했다.
- 테마 선택 후 새로고침해도 기본 테마로 되돌아가지 않도록 production Chromium 회귀에 저장 검증을 추가했다.
- `Size` 행과 펼쳐지는 네 개 수치 항목이 같은 설정 섹션으로 보이도록 내부 구분선을 제거하고 행 레이아웃을 정리했다.

### 검증

- `npx tsc --noEmit`: 통과.
- 변경 파일 ESLint: 통과.
- `npm run test:formats`: 36개 통과.
- `npm run test:shelf`: 11개 통과.
- `npm run test:release`: 1개 통과.
- `npm run build`: 통과.
- `npm run test:browser`: 통과.
