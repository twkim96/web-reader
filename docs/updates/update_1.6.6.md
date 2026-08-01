# 업데이트 1.6.6 계획

## 상태

- 2026-07-11 기준 iPad Safari에서 ZIP/CBZ 이미지 도서를 열 때 `압축 파일 확인 중...` 상태가 끝나지 않는 문제를 수정했다.
- 정상 ZIP이 Android와 데스크톱 브라우저에서는 열렸지만, iPad WebKit의 ZIP Worker/스트림 전송 경로와 대용량 로컬 캐시 저장이 첫 페이지 표시를 막을 수 있었다.
- 앱과 서비스워커 캐시 버전을 `1.6.6`으로 일치시켜 설치형 iPad 앱도 새 ZIP 처리 자산을 받게 한다.

## 목표

- iPad Safari에서 정상 ZIP/CBZ 이미지 도서를 첫 페이지까지 연다.
- iPad의 ZIP 해제는 Worker/스트림 전송 대신 호환 가능한 같은 스레드 경로를 사용한다.
- 원격 ZIP을 연 뒤 IndexedDB 캐시와 이미지 인덱스를 저장하느라 첫 페이지 표시가 지연되지 않게 한다.
- 열기 작업이 응답하지 않아도 자동 열기와 맞물려 리더에 영구히 갇히지 않게 한다.
- 앱과 서비스워커 버전을 `1.6.6`으로 올린다.

## Phase 1: iPad ZIP 열기 안정화

### 대상

- `src/lib/archiveImages.ts`
- `src/hooks/reader/useReaderBookSource.ts`
- `src/lib/readerLoadLifecycle.ts`
- `src/components/EpubReader.tsx`
- `tests/archiveImages.test.mjs`
- `tests/readerLoadLifecycle.test.mjs`

### 변경

- iPhone/iPad user agent와 데스크톱 모드 iPad의 `MacIntel` + touch points 조합을 iPad WebKit으로 판별한다.
- iPad에서는 `zip.js` Web Worker를 끄고 같은 스레드 해제 경로로 첫 이미지 데이터를 읽는다.
- 로컬 메타데이터, 원격 원본 Blob, 압축 이미지 인덱스의 IndexedDB 저장은 리더가 첫 페이지를 연 뒤에 백그라운드 작업으로 미룬다.
- ZIP 준비와 첫 페이지 열기에 90초 제한을 둔다. 제한 시간 초과는 캐시 인덱스 손상으로 재시도하지 않고 오류로 처리한다.
- 로딩 오버레이에 `서재로 돌아가기` 버튼을 둔다. 이 경로는 리더 요청을 abort하고 마지막 도서 자동 열기 세션도 정리한다.

### 상태

- 구현 완료.
- iPad에서만 ZIP Worker를 우회하고, Android/데스크톱 브라우저는 기존 Worker 경로를 유지한다.
- 원격 ZIP의 대용량 로컬 저장은 첫 페이지가 열린 뒤에 시작한다.
- 90초 안에 준비 또는 첫 이미지 표시가 끝나지 않으면 오류 처리와 서재 복귀가 실행되므로 자동 열기 반복에 갇히지 않는다.

### 완료 조건

- iPad Safari에서 정상 ZIP/CBZ 이미지 도서가 첫 페이지까지 열린다.
- iPad 데스크톱 모드도 Worker 우회 대상에 포함된다.
- 원격 ZIP의 IndexedDB 저장이 완료되기 전에도 리더가 먼저 표시된다.
- 로딩 중 사용자가 `서재로 돌아가기`를 누르면 자동 열기 세션이 정리되고 책장에 머문다.
- ZIP 처리 Promise가 끝나지 않으면 90초 뒤 오류를 표시하고 책장으로 돌아간다.
- Android와 데스크톱의 기존 ZIP Worker 경로는 유지된다.

### 검증

- `tests/archiveImages.test.mjs`에 일반 Mac과 데스크톱 모드 iPad를 구분하는 ZIP Worker 선택 테스트를 추가했다.
- `tests/readerLoadLifecycle.test.mjs`에 끝나지 않는 로딩 작업의 timeout 테스트를 추가했다.
- `npm run test:archives`: 통과.
- `npm run test:formats`: 통과.
- `npm run test:shelf`: 통과.
- 변경 파일 ESLint: 통과.
- `npm run build`: 통과.
- 실제 iPad Safari에서 동일 ZIP을 열어 보는 배포 후 확인은 남는다.

## Phase 2: 버전 bump와 배포 캐시 교체

### 대상

- `package.json`
- `package-lock.json`
- `public/sw.js`
- `tests/releaseVersion.test.mjs`
- `tests/browserRegression.mjs`

### 변경

- 앱과 lockfile 버전을 `1.6.6`으로 맞춘다.
- 서비스워커 캐시 이름을 `pc-reader-v1.6.6`으로 갱신한다.
- release 검사와 브라우저 회귀의 서비스워커 기대값·등록 URL을 `1.6.6`으로 맞춘다.

### 완료 조건

- 앱, lockfile, 서비스워커 캐시, release 검사, 브라우저 회귀의 캐시 기대값이 모두 `1.6.6`이다.
- 새 배포를 받은 iPad PWA가 이전 캐시를 삭제하고 `pc-reader-v1.6.6` 캐시를 사용한다.

### 검증

- `npm run test:release`: 통과.
- `npm run test:browser`: 배포 전 로컬 Chrome 회귀에서 확인한다.
- `git diff --check`: 통과.

## 배포 후 수동 확인

- iPad Safari와 설치형 PWA를 완전히 종료한 뒤 다시 열어 새 서비스워커를 받는다.
- 문제가 난 동일 ZIP/CBZ를 열어 첫 이미지가 표시되는지 확인한다.
- 로딩 중 `서재로 돌아가기`를 눌러 자동 열기 반복 없이 책장에 머무는지 확인한다.
- iPad Safari와 Android/데스크톱에서 각각 ZIP 첫 페이지와 다음 페이지 이동을 확인한다.
