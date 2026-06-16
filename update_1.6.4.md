# 업데이트 1.6.4 계획

## 상태

- 1.6.3 작업은 구현과 배포 검증까지 완료된 상태로 닫는다.
- 2026-06-16 기준 1.6.4 첫 변경 구현과 로컬 검증을 완료했다.

## 목표

- 리더에서 스페이스바로 다음 위치로 이동할 수 있게 한다.
- 탭 모드와 스크롤 모드 모두에서 스페이스바가 아래 화살표와 같은 다음 이동 감각을 제공한다.
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
