# 업데이트 1.6.5 계획

## 상태

- 2026-07-06 기준 1.6.5 구현, 실기기 피드백 반영, 자동 검증, Vercel 배포 확인을 완료했다.
- Vercel 고정 배포 URL `https://twreader.vercel.app`에서 서비스워커 캐시명 `pc-reader-v1.6.5`를 확인했다.

## 목표

- PDF와 ZIP/CBZ/7z 이미지 리더에서 작은 이미지를 일시적으로 확대해 볼 수 있게 한다.
- 확대/축소는 별도 버튼 UI 없이 모바일 pinch, PC `Ctrl`+위/아래 방향키로 처리한다.
- PC `Ctrl`+휠은 Windows/브라우저 기본 확대와 맞물릴 수 있으므로 앱 확대 입력으로 쓰지 않고 리더 안에서는 기본 동작만 차단한다.
- 확대 후 한 화면에 이미지가 다 들어오지 않는 경우 모바일 한 손가락 드래그로 확대된 이미지를 이동할 수 있게 한다.
- 확대/축소 값은 저장하지 않고 페이지가 바뀌면 기본 맞춤 보기로 되돌린다.
- 마지막 도서 자동 열기는 `last_reader_session` 포인터가 남아 있는 경우에만 실행한다.
- 책장, 로그인, 인증 리다이렉트, 일반 새로고침 흐름에서 사용자를 원치 않게 리더로 보내지 않는다.
- 앱과 서비스워커 버전을 1.6.5로 올린다.

## 확정 결정

- 확대 기능은 fixed-layout 도서인 PDF와 압축 이미지 도서에만 적용한다.
- EPUB reflow 본문 확대는 기존 `Size` 설정의 책임으로 두고 이번 범위에 포함하지 않는다.
- 확대 상태는 React state 또는 fixed-layout 런타임 상태로만 유지하고 `localStorage`, IndexedDB, Firestore, Drive에는 저장하지 않는다.
- 페이지 이동, 도서 전환, 리더 종료 시 확대 상태를 기본값으로 초기화한다.
- 자동 열기 옵션의 설정명과 기본값은 유지하되, 자동 열기 intent는 `last_reader_session` 포인터의 존재 여부로만 판단한다.
- 사용자가 리더에서 책장으로 나오면 `last_reader_session`을 삭제한다.
- 부팅 과정에서 자동 열기를 판정하기 위해 임시로 `view === 'shelf'`가 되는 것은 사용자 책장 복귀로 보지 않는다.
- 나중에 도서별 확대 상태 저장 옵션을 추가할 수 있도록 확대 로직은 저장 계층과 분리한다.

## Phase 1: PDF/압축 이미지 일시 확대

### 대상

- `public/foliate-js/fixed-layout.js`
- `src/components/EpubReader.tsx`
- `src/hooks/useEpubReader.ts`
- `src/hooks/foliate/types.ts`
- 필요 시 `src/lib/readerZoom.ts`
- `tests/browserRegression.mjs`
- 필요 시 새 단위 테스트

### 변경

- fixed-layout 뷰의 현재 기본 맞춤 배율과 사용자 확대 배율을 분리한다.
- 사용자 확대 배율은 기본 맞춤 상태를 `1x`로 보고 상대 배율로 관리한다.
- 모바일에서는 두 손가락 pinch 거리 변화로 확대/축소한다.
- 모바일 pinch 입력은 `requestAnimationFrame` 단위로 합쳐 적용해 확대 중 깜빡임을 완화한다.
- 현재 React 리더에는 fixed-layout 위에 투명 탭 오버레이가 있으므로 pinch 입력은 `EpubReader` 오버레이 경로에서 먼저 처리한다.
- 확대 제스처로 판정된 터치/포인터 입력은 탭 이동, 컨트롤 토글, fixed-layout 내부 iframe 입력으로 중복 전달하지 않는다.
- 모바일 브라우저의 기본 pinch zoom, pull scroll, viewport scroll로 빠지지 않도록 오버레이와 관련 handler에 `touch-action` 정책과 non-passive `preventDefault()` 경계를 둔다.
- 확대 상태에서는 모바일 한 손가락 드래그로 fixed-layout 스크롤 위치를 이동해 이미지를 팬한다.
- 핀치 후 손가락 하나를 화면에 남긴 채 바로 움직이는 실제 사용 경로에서도 pan 상태로 이어지게 한다.
- PC `Ctrl`+마우스 휠은 확대/축소로 사용하지 않고, 브라우저 기본 페이지 zoom과 리더 페이지 넘김으로 새지 않게 막는다.
- PC에서는 `Ctrl`+`ArrowUp`을 확대, `Ctrl`+`ArrowDown`을 축소로 처리한다.
- 확대 중에는 현재 터치/마우스 포인터 주변이 화면에 유지되도록 scroll offset을 보정한다.
- 최소 배율은 기본 맞춤 배율, 최대 배율은 실제 이미지와 PDF canvas 보호 한도를 고려해 정한다.
- PDF는 기존 `onZoom` 렌더 경로와 canvas 8MP/8192px 제한을 유지한다.
- PDF 확대 중 깜빡임은 canvas 재렌더 구조상 완전히 제거하지 않고 입력 coalescing으로 완화한다. 완전 제거는 CSS 임시 확대와 지연 고품질 재렌더를 분리하는 별도 렌더 전략이 필요하다.
- 압축 이미지는 기존 이미지 blob/cache 수명 정책을 유지하고 CSS 배율만 조정한다.
- 확대 상태에서 일반 탭, 스페이스바, 화살표 이동, 휠 페이지 넘김의 기존 동작이 깨지지 않게 입력 우선순위를 정리한다.

### 상태

- 구현 완료.
- fixed-layout 상대 확대 API, pan API, React 오버레이 pinch/한 손가락 pan/`Ctrl` 입력 처리, 페이지 이동 초기화를 반영했다.
- 실기기 피드백에 따라 `Ctrl`+휠 확대를 제거하고, 확대 중 한 손가락 pan, pinch 입력 coalescing, pinch 후 남은 손가락의 pan 승계를 추가했다.
- 로컬 자동 검증과 production 브라우저 회귀를 통과했다.

### 완료 조건

- PDF 페이지에서 pinch, `Ctrl`+위/아래 방향키로 확대/축소할 수 있다.
- ZIP/CBZ/7z 이미지 페이지에서 같은 입력으로 확대/축소할 수 있다.
- 탭 이동용 투명 오버레이가 켜진 상태에서도 모바일 pinch가 실제 사용자 경로에서 동작한다.
- 확대 상태에서 모바일 한 손가락 드래그로 확대된 페이지를 이동할 수 있다.
- 핀치 직후 손가락 하나를 떼지 않고 움직여도 확대된 페이지를 이동할 수 있다.
- 모바일 pinch 중 브라우저 자체 페이지 확대, body scroll, pull-to-refresh가 발생하지 않는다.
- 확대된 상태에서 페이지를 넘기면 다음 페이지는 기본 맞춤 보기로 열린다.
- 리더를 닫았다가 같은 책을 다시 열어도 확대 값은 유지되지 않는다.
- `Ctrl`+휠은 앱 확대를 바꾸지 않고 브라우저 자체 페이지 zoom이나 의도치 않은 다음/이전 페이지 이동도 발생시키지 않는다.
- PDF 고배율 렌더에서도 기존 canvas 크기 보호 한도가 유지된다.

### 검증

- `tests/browserRegression.mjs`에 fixed-layout 확대 API, pan API, 페이지 이동 초기화, `Ctrl`+휠 확대 차단 회귀를 추가했다.
- `npm run test:formats`: 36개 통과.
- `npm run test:archives`: 32개 통과.
- `npm run test:browser`: 통과.
- 실사용 모바일 테스트에서 pinch 확대 후 한 손가락 pan 필요성을 확인했고, 후속 변경에 반영했다.

## Phase 2: 마지막 도서 자동 열기 조건 수정

### 대상

- `src/app/page.tsx`
- `src/lib/lastReaderSession.ts`
- `tests/lastReaderSession.test.mjs`
- `tests/browserRegression.mjs`

### 변경

- 별도의 `마지막 앱 상태` 키를 만들지 않는다.
- `last_reader_session` 자체를 다음 부팅 자동 열기 intent로 사용한다.
- 리더에서 진행률을 저장할 때 현재 책이 완료 상태가 아니면 `last_reader_session`을 저장한다.
- 리더의 뒤로가기 버튼으로 책장에 나오면 `last_reader_session`을 삭제한 뒤 `view`를 `shelf`로 바꾼다.
- 이때 리더 unmount cleanup의 `saveCurrentProgress()`가 다시 `last_reader_session`을 만들지 않도록 사용자 의도 닫기 경로에는 suppression flag 또는 `SaveProgressOptions` 확장을 적용한다.
- suppression은 자동 열기 intent 저장만 막고, 일반 진행률 저장 자체는 유지한다.
- 자동 열기 판정을 위해 부팅 중 `view === 'shelf'`가 된 순간에는 `last_reader_session`을 삭제하지 않는다.
- 책장 상태에서 앱을 새로고침하거나 종료한 경우에는 이미 포인터가 없으므로 자동 열기를 실행하지 않는다.
- 리더에서 새로고침, 탭 종료, PWA 종료 후 다시 열면 포인터가 남아 있으므로 기존 자동 열기 설정에 따라 마지막 책을 연다.
- 로그인, 로그아웃, Drive 연결, 인증 리다이렉트, 게스트/로컬 모드 전환 중에는 포인터가 없으면 리더 자동 진입을 하지 않는다.
- 기존 1.6.4의 `{ bookId, updatedAt }` 값은 리더/책장 상태를 알 수 없는 legacy 값이므로 1.6.5에서는 자동 열기 후보로 사용하지 않고 정리한다.
- 1.6.5부터 저장하는 값은 같은 `last_reader_session` 키에 schema version 또는 intent marker를 포함해 legacy 값과 구분한다.
- 도서가 삭제됐거나 현재 책장에 없거나 크기 제한에 걸리면 기존처럼 기록을 정리하고 책장에 머문다.
- 진행률 `99.9%` 이상 도서는 기존처럼 자동 열기 대상에서 제외한다.

### 상태

- 구현 완료.
- `last_reader_session` schema version을 도입하고, legacy 값 정리와 사용자 의도 닫기 suppression을 반영했다.
- 로컬 단위 테스트와 production 브라우저 회귀를 통과했다.

### 완료 조건

- 리더 화면에서 새로고침하면 같은 책의 리더로 복귀한다.
- 리더 화면에서 앱을 종료했다가 다시 켜면 같은 책의 리더로 복귀한다.
- 책장 화면에서 새로고침하면 책장에 그대로 머문다.
- 책장 화면에서 로그인 또는 인증 리다이렉트가 발생해도 자동으로 리더에 진입하지 않는다.
- 리더에서 뒤로가기로 책장에 나온 뒤 새로고침하면 책장에 머문다.
- 리더에서 뒤로가기로 책장에 나온 뒤 unmount cleanup 진행률 저장이 실행되어도 `last_reader_session`은 재생성되지 않는다.
- 자동 열기 설정을 끄면 `last_reader_session` 포인터가 있어도 자동으로 열지 않는다.
- 1.6.4 legacy 포인터만 남아 있는 사용자는 1.6.5 첫 부팅에서 자동으로 리더에 진입하지 않는다.
- 기존 마지막 책 진행률 저장, 완료 도서 제외, 삭제 도서 정리 정책은 유지된다.

### 검증

- `tests/lastReaderSession.test.mjs`에 새 schema 값은 후보로 읽고 legacy 값은 정리하는 테스트를 추가했다.
- 브라우저 회귀에서 리더 새로고침 복귀, 리더 닫기 후 포인터 삭제, 닫기 후 새로고침 시 책장 유지 시나리오를 확인했다.
- `npm run test:shelf`: 13개 통과.
- `npm run test:browser`: 통과.

## Phase 3: 버전 bump와 통합 검증

### 대상

- `package.json`
- `package-lock.json`
- `public/sw.js`
- `tests/releaseVersion.test.mjs`
- `tests/browserRegression.mjs`
- 변경 파일 ESLint 대상

### 변경

- 앱 버전을 `1.6.5`로 올린다.
- 서비스워커 캐시 이름을 `pc-reader-v1.6.5`로 올린다.
- release 버전 검사가 새 버전을 기대하도록 맞춘다.
- browser regression의 서비스워커 캐시명, stale 캐시명, `/sw.js?browser-regression=...` 리터럴을 1.6.5 기준으로 갱신한다.

### 상태

- 구현 완료.
- 앱, lockfile, 서비스워커 캐시명, release 검사, browser regression 리터럴을 1.6.5로 갱신했다.

### 완료 조건

- 앱, lockfile, 서비스워커 캐시 버전이 모두 1.6.5다.
- 기존 EPUB, PDF, 압축 이미지, 책장, 자동 열기 회귀가 통과한다.
- 확대 기능과 자동 열기 조건 변경이 서로 간섭하지 않는다.

### 검증

- `npm run test:formats`: 36개 통과.
- `npm run test:archives`: 32개 통과.
- `npm run test:shelf`: 13개 통과.
- `npm run test:release`: 1개 통과.
- `npx tsc --noEmit`: 통과.
- 변경 파일 ESLint: 통과.
- `npm run build`: 통과.
- `npm run test:browser`: 통과.
- `git diff --check`: 통과.

## 1.6.5 실사용 테스트 전 상태

- 자동 검증과 1차 실기기 피드백 반영 기준으로 배포 직전 상태까지 준비됐다.
- production 서버 `http://localhost:3000`에서 브라우저 회귀를 통과했다.
- 고정 배포 URL `https://twreader.vercel.app`에서 Vercel 응답과 `pc-reader-v1.6.5` 서비스워커를 확인했다.
- Superloopy visual QA evidence: `.superloopy/evidence/frontend/20260706-165-reader-zoom/VISUAL_QA.md`.
- 남은 항목은 실제 모바일/트랙패드/마우스 환경에서 pinch와 한 손가락 pan 감각을 추가로 확인하는 실사용 테스트다.

## 보류 항목

- 도서별 확대/축소 값을 `localStorage`에 저장하는 옵션은 이번 버전에서 구현하지 않는다.
- 확대 버튼, 축소 버튼, 배율 표시 UI는 이번 버전에서 추가하지 않는다.
- EPUB reflow 본문의 pinch zoom은 이번 버전에서 다루지 않는다.
- PDF 확대 중 canvas 재렌더 깜빡임을 완전히 없애는 렌더 전략 변경은 이번 버전에서 다루지 않는다.
