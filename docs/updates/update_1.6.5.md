# 업데이트 1.6.5 계획

## 상태

- 2026-07-06 기준 1.6.5 구현, 실기기 피드백 반영, 자동 검증, Vercel 배포 확인을 완료했다.
- Android PWA가 기존 `pc-reader-v1.6.5` 캐시를 계속 사용할 수 있어 후속 캐시 bust 버전 `1.6.5.1`로 올렸다.
- iPad 실사용에서 확대 후 왼쪽 끝을 볼 수 없는 fixed-layout 중앙 정렬 문제를 수정하고, 후속 캐시 bust 버전 `1.6.5.2`로 올렸다.
- fixed-layout 커스텀 엘리먼트 생성자에서 host style 속성을 만들며 일부 브라우저에서 업그레이드가 실패할 수 있는 문제를 수정하고, 후속 캐시 bust 버전 `1.6.5.3`으로 올린다.
- 확대 상태로 탭/키보드/휠 페이지 넘김을 할 때 다음 페이지에 확대 배율과 화면 위치를 이어받도록 수정하고, 후속 캐시 bust 버전 `1.6.5.4`로 올린다.
- 확대 상태라도 가로 또는 세로로 넘치지 않는 축은 중앙 정렬을 유지하도록 수정하고, 후속 캐시 bust 버전 `1.6.5.5`로 올린다.
- PDF pinch 확대 중에는 기존 layer를 transform으로 preview하고 손을 뗀 뒤 최종 배율을 렌더하도록 수정하고, 후속 캐시 bust 버전 `1.6.5.6`으로 올린다.
- PC에서 확대된 fixed-layout PDF/압축 이미지 페이지를 마우스 좌클릭 드래그로 이동할 수 있게 수정하고, 후속 캐시 bust 버전 `1.6.5.7`로 올린다.
- PC에서는 `Ctrl`+좌클릭 드래그, Mac에서는 `Cmd`+좌클릭 드래그 위/아래 이동으로 fixed-layout 페이지를 확대/축소할 수 있게 수정하고, 후속 캐시 bust 버전 `1.6.5.8`로 올린다.
- PC/Mac 보조키 드래그 확대/축소가 `buttons` lost 또는 `lostpointercapture`로 끝나도 PDF preview가 commit되도록 수정하고, 후속 캐시 bust 버전 `1.6.5.9`로 올린다.

## 목표

- PDF와 ZIP/CBZ/7z 이미지 리더에서 작은 이미지를 일시적으로 확대해 볼 수 있게 한다.
- 확대/축소는 별도 버튼 UI 없이 모바일 pinch, PC `Ctrl`+위/아래 방향키로 처리한다.
- PC `Ctrl`+휠은 Windows/브라우저 기본 확대와 맞물릴 수 있으므로 앱 확대 입력으로 쓰지 않고 리더 안에서는 기본 동작만 차단한다.
- 확대 후 한 화면에 이미지가 다 들어오지 않는 경우 모바일 한 손가락 드래그로 확대된 이미지를 이동할 수 있게 한다.
- PC에서는 확대 상태에서 마우스 좌클릭을 누른 채 드래그해 확대된 이미지를 이동할 수 있게 한다.
- PC에서는 `Ctrl`, Mac에서는 `Cmd`를 누른 채 마우스 좌클릭을 위/아래로 드래그해 확대/축소할 수 있게 한다.
- 확대/축소 값은 저장하지 않되, 일반 페이지 넘김 중에는 현재 확대 배율과 화면 위치를 다음 페이지로 이어받는다.
- 마지막 도서 자동 열기는 `last_reader_session` 포인터가 남아 있는 경우에만 실행한다.
- 책장, 로그인, 인증 리다이렉트, 일반 새로고침 흐름에서 사용자를 원치 않게 리더로 보내지 않는다.
- 앱과 서비스워커 버전을 1.6.5로 올리고, Android PWA 캐시 갱신용 후속 버전은 1.6.5.1로 올린다.

## 확정 결정

- 확대 기능은 fixed-layout 도서인 PDF와 압축 이미지 도서에만 적용한다.
- EPUB reflow 본문 확대는 기존 `Size` 설정의 책임으로 두고 이번 범위에 포함하지 않는다.
- 확대 상태는 React state 또는 fixed-layout 런타임 상태로만 유지하고 `localStorage`, IndexedDB, Firestore, Drive에는 저장하지 않는다.
- 도서 전환, 리더 종료, 명시적 reset 시 확대 상태를 기본값으로 초기화한다.
- 일반 이전/다음 페이지 이동은 현재 fixed-layout 런타임의 확대 배율과 스크롤 위치 비율을 이어받는다.
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
- 리더 컨트롤이 표시되어 z-40 컨트롤 오버레이가 떠 있는 상태에서도 같은 터치 pan 경로가 동작하게 한다.
- PC 마우스 드래그 pan은 `pointerType === 'mouse'`, 좌클릭, fixed-layout 확대 상태, `panBy` 지원 조건을 모두 만족할 때만 시작한다.
- PC/Mac 마우스 드래그 확대/축소는 `pointerType === 'mouse'`, 좌클릭, fixed-layout, 플랫폼별 보조키(Windows/Linux `Ctrl`, macOS 계열 `Cmd`) 조건을 모두 만족할 때만 시작한다.
- 보조키 드래그 확대/축소는 시작 위치를 focal point로 고정하고, 위로 끌면 확대, 아래로 끌면 축소한다.
- 마우스 이동량이 pan 임계값을 넘기 전에는 기존 클릭/페이지 넘김/컨트롤 토글 동작을 유지한다.
- 마우스 드래그 pan으로 판정된 뒤에는 후속 click을 한 번 억제해 의도치 않은 페이지 이동이나 컨트롤 토글을 막는다.
- 보조키 드래그 확대/축소 경로에서는 movement가 없더라도 후속 click을 억제해 `Cmd`/`Ctrl` 클릭이 페이지 넘김이나 컨트롤 토글로 새지 않게 한다.
- 리더 컨트롤이 표시되어 z-40 컨트롤 오버레이가 떠 있는 상태에서도 확대된 페이지의 마우스 드래그 pan이 동작하게 한다.
- 확대 상태에서는 화면보다 넘치는 축만 좌상단 기준으로 바꿔 왼쪽/위쪽 끝까지 스크롤 접근 가능하게 하고, 넘치지 않는 축은 중앙 정렬을 유지한다.
- PC `Ctrl`+마우스 휠은 확대/축소로 사용하지 않고, 브라우저 기본 페이지 zoom과 리더 페이지 넘김으로 새지 않게 막는다.
- PC에서는 `Ctrl`+`ArrowUp`을 확대, `Ctrl`+`ArrowDown`을 축소로 처리한다.
- 확대 중에는 현재 터치/마우스 포인터 주변이 화면에 유지되도록 scroll offset을 보정한다.
- 최소 배율은 기본 맞춤 배율, 최대 배율은 실제 이미지와 PDF canvas 보호 한도를 고려해 정한다.
- PDF는 기존 `onZoom` 렌더 경로와 canvas 8MP/8192px 제한을 유지한다.
- PDF 확대 중 깜빡임은 입력 coalescing과 기존 canvas/text/annotation 레이어 유지 후 완성된 새 렌더로 교체하는 방식으로 완화한다.
- PDF pinch 제스처가 진행 중일 때는 새 canvas 렌더를 반복하지 않고 기존 canvas/text/annotation layer를 transform으로 preview한 뒤, 제스처 종료 시 최종 배율을 한 번 commit 렌더한다.
- 압축 이미지는 기존 이미지 blob/cache 수명 정책을 유지하고 CSS 배율만 조정한다.
- 확대 상태에서 일반 탭, 스페이스바, 화살표 이동, 휠 페이지 넘김의 기존 동작이 깨지지 않게 입력 우선순위를 정리한다.

### 상태

- 구현 완료.
- fixed-layout 상대 확대 API, pan API, React 오버레이 pinch/한 손가락 pan/`Ctrl` 입력 처리, 페이지 이동 중 확대 상태 전달을 반영했다.
- 실기기 피드백에 따라 `Ctrl`+휠 확대를 제거하고, 확대 중 한 손가락 pan, 컨트롤 오버레이 터치 pan, pinch 입력 coalescing, pinch 후 남은 손가락의 pan 승계를 추가했다.
- PDF 확대 렌더는 새 canvas가 준비되기 전까지 기존 레이어를 비우지 않도록 바꿔 빈 화면 깜빡임을 줄였다.
- fixed-layout 확대 중 overflow 중앙 정렬 때문에 왼쪽 끝을 볼 수 없는 문제를 `flex-start` 정렬 전환으로 수정했다.
- fixed-layout 확대 중 실제로 넘치지 않는 축까지 `flex-start`가 되어 가로 화면에서 페이지가 왼쪽에 붙는 문제를 축별 overflow 정렬로 수정했다.
- PDF pinch 확대 중에는 transform preview를 사용하고, 손을 떼면 최종 배율로 고해상도 렌더를 한 번 수행하도록 바꿨다.
- PC 확대 상태에서는 투명 리더 오버레이와 컨트롤 오버레이에서 마우스 좌클릭 드래그로 fixed-layout `panBy`를 호출하도록 추가했다.
- PC/Mac 보조키 드래그 확대/축소는 같은 투명 오버레이에서 처리하되, Windows/Linux는 `Ctrl`, macOS 계열은 `Cmd`만 확대 드래그 modifier로 사용하도록 분기했다.
- 보조키 드래그 확대/축소 종료 처리를 공통화해 `pointerup`, `buttons` lost, `lostpointercapture` 경로 모두 pending preview flush 또는 최종 commit을 실행하게 했다.
- 확대/축소 감각은 transform preview, transform compositing 힌트, 모바일 overflow 안정화로 개선했다. 사진 앱 수준의 관성/고무줄 물리는 별도 제스처 엔진 범위로 남긴다.
- 로컬 자동 검증과 production 브라우저 회귀를 통과했다.

### 완료 조건

- PDF 페이지에서 pinch, `Ctrl`+위/아래 방향키로 확대/축소할 수 있다.
- ZIP/CBZ/7z 이미지 페이지에서 같은 입력으로 확대/축소할 수 있다.
- 탭 이동용 투명 오버레이가 켜진 상태에서도 모바일 pinch가 실제 사용자 경로에서 동작한다.
- 확대 상태에서 모바일 한 손가락 드래그로 확대된 페이지를 이동할 수 있다.
- 핀치 직후 손가락 하나를 떼지 않고 움직여도 확대된 페이지를 이동할 수 있다.
- 리더 컨트롤이 표시된 상태에서도 확대된 페이지를 한 손가락으로 이동할 수 있다.
- PC에서 확대된 PDF 페이지를 마우스 좌클릭 드래그로 이동할 수 있다.
- PC에서 확대된 ZIP/CBZ/7z 이미지 페이지를 마우스 좌클릭 드래그로 이동할 수 있다.
- PC 마우스 드래그 이동이 아닌 일반 클릭은 기존 페이지 넘김/컨트롤 토글 동작을 유지한다.
- 리더 컨트롤이 표시된 상태에서도 확대된 페이지를 마우스 좌클릭 드래그로 이동할 수 있다.
- Windows/Linux PC에서 `Ctrl`+좌클릭 위/아래 드래그로 fixed-layout PDF/압축 이미지 페이지를 확대/축소할 수 있다.
- Mac에서 `Cmd`+좌클릭 위/아래 드래그로 fixed-layout PDF/압축 이미지 페이지를 확대/축소할 수 있다.
- 보조키 확대/축소 드래그가 일반 클릭, 기존 pan, 모바일 pinch/pan과 충돌하지 않는다.
- 보조키 확대/축소 드래그가 비정상 pointer 종료로 끝나도 PDF preview가 저해상도 transform 상태로 남지 않는다.
- 확대 상태라도 화면보다 넘치지 않는 가로/세로 축은 중앙에 놓인다.
- 확대 상태에서 왼쪽/위쪽 끝과 오른쪽/아래쪽 끝을 모두 볼 수 있다.
- 모바일 pinch 중 브라우저 자체 페이지 확대, body scroll, pull-to-refresh가 발생하지 않는다.
- 확대된 상태에서 이전/다음 페이지를 넘기면 다음 페이지도 같은 확대 배율과 화면 위치 비율로 열린다.
- 리더를 닫았다가 같은 책을 다시 열어도 확대 값은 유지되지 않는다.
- `Ctrl`+휠은 앱 확대를 바꾸지 않고 브라우저 자체 페이지 zoom이나 의도치 않은 다음/이전 페이지 이동도 발생시키지 않는다.
- PDF 고배율 렌더에서도 기존 canvas 크기 보호 한도가 유지된다.

### 검증

- `tests/browserRegression.mjs`에 fixed-layout 확대 API, pan API, 컨트롤 오버레이 pan, 확대 중 축별 overflow 정렬, PDF preview/commit 렌더 분리, 페이지 이동 중 확대 상태 전달, `Ctrl`+휠 확대 차단 회귀를 추가했다.
- `npm run test:formats`: 36개 통과.
- `npm run test:archives`: 32개 통과.
- `npm run test:browser`: 통과.
- 실사용 모바일 테스트에서 pinch 확대 후 한 손가락 pan 필요성을 확인했고, 후속 변경에 반영했다.
- 1.6.5.2 fixed-layout 정렬 보정 후에는 `npx tsc --noEmit`, 변경 파일 ESLint, `npm run test:release`, `npm run build`, `npm run test:formats`를 통과했다.
- 같은 변경의 `npm run test:browser`는 로컬 Chrome CDP target의 early theme bootstrap 주입 대기에서 반복 실패해 이번 턴의 통과 증거로 사용하지 않는다.
- 1.6.5.3에서는 fixed-layout host scroll style을 생성자 inline style 대신 `:host` CSS로 옮기고, `foliate-fxl`/`foliate-paginator` 등록 중복 방어와 렌더러 초기화 검증을 추가한다.
- 1.6.5.3 fixed-layout 커스텀 엘리먼트 보정 후에는 `npx tsc --noEmit`, 변경 파일 ESLint, `npm run test:release`, `npm run build`, `npm run test:formats`를 통과했고, Chrome CDP에서 `document.createElement('foliate-fxl').open`이 `function`임을 확인했다.
- 1.6.5.4에서는 fixed-layout 페이지 넘김 직전에 확대 배율과 스크롤 위치 비율을 캡처하고, 새 페이지 렌더 직후 같은 런타임 상태를 복원한다.
- 1.6.5.4 fixed-layout 페이지 넘김 상태 전달 후에는 `npx tsc --noEmit`, 변경 파일 ESLint, `npm run test:release`, `npm run build`, `npm run test:formats`, `npm run test:browser`를 통과했고, Chrome CDP에서 `next()` 후 `userScale`, `scrollLeft`, `scrollTop`이 유지됨을 확인했다.
- 1.6.5.5에서는 fixed-layout 확대 정렬을 축별 overflow 기준으로 바꿔, 가로로 넘치지 않는 확대 페이지가 왼쪽에 붙지 않고 중앙에 놓이게 한다.
- 1.6.5.5 fixed-layout 축별 overflow 정렬 후에는 `npx tsc --noEmit`, 변경 파일 ESLint, `npm run test:release`, `npm run build`, `npm run test:formats`, `npm run test:browser`를 통과했고, Chrome 회귀에서 가로로 넘치지 않는 확대 페이지의 `justifyContent`가 `center`임을 확인했다.
- 1.6.5.6에서는 PDF 확대 중 preview 호출이 canvas 크기를 바꾸지 않고 transform만 바꾸며, `commitUserScale()` 후에만 최종 canvas 크기가 바뀌도록 한다.
- 1.6.5.6 PDF transform preview 후에는 `npx tsc --noEmit`, 변경 파일 ESLint, `npm run test:release`, `npm run build`, `npm run test:formats`, `npm run test:browser`를 통과했고, Chrome 회귀에서 preview 중 canvas 크기 유지와 commit 후 최종 canvas 교체를 확인했다.
- 1.6.5.7에서는 PC 마우스 좌클릭 드래그로 확대된 fixed-layout PDF/압축 이미지 페이지를 이동할 수 있게 한다.
- 1.6.5.7 PC 마우스 드래그 pan 후에는 `npx tsc --noEmit`, 변경 파일 ESLint, `npm run test:release`, `npm run build`, `npm run test:formats`, `npm run test:archives`, `npm run test:browser`, `git diff --check`를 통과했고, Chrome 회귀에서 서비스워커 캐시가 `pc-reader-v1.6.5.7`임을 확인했다.
- 1.6.5.8에서는 PC/Mac 보조키 좌클릭 위/아래 드래그로 fixed-layout PDF/압축 이미지 페이지를 확대/축소할 수 있게 한다.
- 1.6.5.8 PC/Mac 보조키 드래그 확대/축소 후에는 `npx tsc --noEmit`, 변경 파일 ESLint, `npm run test:release`, `npm run build`, `npm run test:formats`, `npm run test:archives`, `npm run test:browser`, `git diff --check`를 통과했고, Chrome 회귀에서 Mac `Cmd` 드래그 확대와 후속 click 억제를 확인했다.
- 1.6.5.9에서는 보조키 드래그 확대/축소의 비정상 pointer 종료 경로도 최종 commit을 실행하도록 보정한다.
- 1.6.5.9 보조키 드래그 비정상 종료 보정 후에는 `npx tsc --noEmit`, 변경 파일 ESLint, `npm run test:release`, `npm run build`, `npm run test:formats`, `npm run test:archives`, `npm run test:browser`, `git diff --check`를 통과했고, Chrome 회귀에서 `lostpointercapture` 종료 후에도 확대 배율이 유지됨을 확인했다.

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
- Android PWA 캐시 갱신을 강제하기 위해 후속 버전 `1.6.5.1`에서는 앱/lockfile 버전과 서비스워커 캐시명을 `1.6.5.1`, `pc-reader-v1.6.5.1`로 올린다.
- fixed-layout pan 보정 후속 버전 `1.6.5.2`에서는 앱/lockfile 버전과 서비스워커 캐시명을 `1.6.5.2`, `pc-reader-v1.6.5.2`로 올린다.
- fixed-layout 커스텀 엘리먼트 업그레이드 보정 후속 버전 `1.6.5.3`에서는 앱/lockfile 버전과 서비스워커 캐시명을 `1.6.5.3`, `pc-reader-v1.6.5.3`으로 올린다.
- fixed-layout 페이지 넘김 상태 전달 후속 버전 `1.6.5.4`에서는 앱/lockfile 버전과 서비스워커 캐시명을 `1.6.5.4`, `pc-reader-v1.6.5.4`로 올린다.
- fixed-layout 축별 overflow 정렬 후속 버전 `1.6.5.5`에서는 앱/lockfile 버전과 서비스워커 캐시명을 `1.6.5.5`, `pc-reader-v1.6.5.5`로 올린다.
- PDF transform preview 후속 버전 `1.6.5.6`에서는 앱/lockfile 버전과 서비스워커 캐시명을 `1.6.5.6`, `pc-reader-v1.6.5.6`으로 올린다.
- PC 마우스 드래그 pan 후속 버전 `1.6.5.7`에서는 앱/lockfile 버전과 서비스워커 캐시명을 `1.6.5.7`, `pc-reader-v1.6.5.7`로 올린다.
- PC/Mac 보조키 드래그 확대/축소 후속 버전 `1.6.5.8`에서는 앱/lockfile 버전과 서비스워커 캐시명을 `1.6.5.8`, `pc-reader-v1.6.5.8`로 올린다.
- 보조키 드래그 확대/축소 비정상 종료 보정 후속 버전 `1.6.5.9`에서는 앱/lockfile 버전과 서비스워커 캐시명을 `1.6.5.9`, `pc-reader-v1.6.5.9`로 올린다.

### 상태

- 구현 완료.
- 앱, lockfile, 서비스워커 캐시명, release 검사, browser regression 리터럴을 1.6.5로 갱신했다.
- Android PWA 캐시 bust를 위해 후속 변경에서 앱, lockfile, 서비스워커 캐시명, release 검사, browser regression 리터럴을 1.6.5.1로 갱신했다.
- fixed-layout pan 보정 후속 변경에서 앱, lockfile, 서비스워커 캐시명, release 검사, browser regression 리터럴을 1.6.5.2로 갱신했다.
- fixed-layout 커스텀 엘리먼트 업그레이드 보정 후속 변경에서 앱, lockfile, 서비스워커 캐시명, release 검사, browser regression 리터럴을 1.6.5.3으로 갱신했다.
- fixed-layout 페이지 넘김 상태 전달 후속 변경에서 앱, lockfile, 서비스워커 캐시명, release 검사, browser regression 리터럴을 1.6.5.4로 갱신했다.
- fixed-layout 축별 overflow 정렬 후속 변경에서 앱, lockfile, 서비스워커 캐시명, release 검사, browser regression 리터럴을 1.6.5.5로 갱신했다.
- PDF transform preview 후속 변경에서 앱, lockfile, 서비스워커 캐시명, release 검사, browser regression 리터럴을 1.6.5.6으로 갱신했다.
- PC 마우스 드래그 pan 후속 변경에서 앱, lockfile, 서비스워커 캐시명, release 검사, browser regression 리터럴을 1.6.5.7로 갱신했다.
- PC/Mac 보조키 드래그 확대/축소 후속 변경에서 앱, lockfile, 서비스워커 캐시명, release 검사, browser regression 리터럴을 1.6.5.8로 갱신했다.
- 보조키 드래그 확대/축소 비정상 종료 보정 후속 변경에서 앱, lockfile, 서비스워커 캐시명, release 검사, browser regression 리터럴을 1.6.5.9로 갱신했다.

### 완료 조건

- 앱, lockfile, 서비스워커 캐시 버전이 모두 1.6.5.9이다.
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
- 고정 배포 URL `https://twreader.vercel.app`에서 Vercel 응답과 서비스워커 캐시 버전을 확인한다.
- Superloopy visual QA evidence: `.superloopy/evidence/frontend/20260706-165-reader-zoom/VISUAL_QA.md`.
- 남은 항목은 배포 후 실제 Android/iPad/트랙패드/마우스 환경에서 pinch, 한 손가락 pan, 왼쪽 끝 접근, PDF 확대 깜빡임 완화 정도를 추가로 확인하는 실사용 테스트다.

## 보류 항목

- 도서별 확대/축소 값을 `localStorage`에 저장하는 옵션은 이번 버전에서 구현하지 않는다.
- 확대 버튼, 축소 버튼, 배율 표시 UI는 이번 버전에서 추가하지 않는다.
- EPUB reflow 본문의 pinch zoom은 이번 버전에서 다루지 않는다.
