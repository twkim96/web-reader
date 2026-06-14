# 업데이트 1.6.3 계획

## 상태

- 로컬 구현과 검증 완료.
- production 배포 전.

## 목표

- 리더의 상하·좌우 탭 이동 영역을 사용자 설정으로 제공한다.
- 기존 탭 감각과 저장된 설정의 호환성을 유지한다.
- 앱과 서비스워커 버전을 1.6.3으로 올린다.

## 기존 동작

- `T/B Tap`과 `4-Way`의 위·아래 이동 영역은 각각 화면 높이의 33%다.
- `L/R Tap`과 `4-Way`의 왼쪽·오른쪽 이동 영역은 각각 화면 너비의 30%다.
- 나머지 중앙 영역을 탭하면 리더 컨트롤을 표시하거나 숨긴다.

## 확정 결정

- 리더 설정의 `LINE` 아래에 `TOP/BOTTOM`, `LEFT/RIGHT` 스테퍼를 추가한다.
- 기본값은 기존 동작과 같은 `33%`, `30%`다.
- 각 값은 1% 단위로 조절하고 10~45% 범위로 제한한다.
- 최대값에서도 중앙 컨트롤 영역을 최소 10% 유지한다.
- EPUB뿐 아니라 PDF와 압축 이미지 도서의 탭 모드에도 같은 값을 적용한다.
- 기존 `viewer_settings`에 새 값이 없으면 기본값을 자동 병합한다.

## 대상

- `src/types.ts`
- `src/hooks/useViewerSettings.ts`
- `src/lib/readerNavigation.ts`
- `src/components/EpubReader.tsx`
- `src/components/SettingsModal.tsx`
- `tests/readerNavigation.test.mjs`
- `package.json`
- `package-lock.json`
- `public/sw.js`
- `tests/releaseVersion.test.mjs`
- `tests/browserRegression.mjs`

## 완료 조건

- 설정 변경 직후 해당 방향의 탭 경계가 바뀐다.
- 새로고침 후에도 두 설정값이 유지된다.
- 기본값에서 기존 33%·30% 판정이 동일하다.
- 중앙 탭으로 리더 컨트롤을 열 수 있는 영역이 항상 남는다.
- 앱, lockfile, 서비스워커 캐시 버전이 모두 1.6.3이다.

## 검증

- `npm run test:formats`: 34개 통과.
- 전체 자동 회귀: 107개 통과.
- `npx tsc --noEmit`: 통과.
- 변경 파일 ESLint와 `git diff --check`: 통과.
- `npm run build`: 통과.
- production 서버 `npm run test:browser`: 통과.
- 설정 모달에서 기본 `TOP/BOTTOM 33%`, `LEFT/RIGHT 30%` 표시 확인.
- 스테퍼 변경 후 `35%`, `29%` 표시와 `viewer_settings` 저장값 일치 확인.
- `LEFT/RIGHT 29%`에서 화면 너비 29.5% 탭은 중앙 컨트롤을 열고, 28% 탭은 이전 이동 영역으로 처리됨을 확인.
- 서비스워커가 `pc-reader-v1.6.3` 캐시를 생성하고 기존 `pc-reader-v1.6.2` 캐시를 제거함을 확인.
