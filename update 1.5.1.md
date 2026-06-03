# 업데이트 1.5.1 Phase Plan

## 목표

리더 페이지의 진행률 이동과 하단/상단 UI를 iPad 도서앱에 가까운 형태로 정리한다. 이번 계획의 핵심은 진행률 바를 드래그하는 동안에는 미리보기만 보여주고, 손을 뗀 뒤 확인 모달에서 승인한 경우에만 실제 위치 이동과 진행 저장이 일어나게 만드는 것이다.

## 구현 상태

- Status: 구현 완료, 로컬 검증 완료.
- 슬라이더는 드래그 중 미리보기만 갱신하고, 릴리즈 후 확인 모달에서 승인한 경우에만 실제 이동한다.
- 리더 상단 나가기 버튼은 모든 환경에서 오른쪽 `X` 버튼으로 통일했다.
- 리더 하단에는 항상 보이는 `Chapter / percent / #` 상태줄을 추가했다.
- 화면 탭 메뉴는 큰 하단 카드 대신 우하단 compact action cluster로 재구성했다.
- `목차 · percent` row와 진행률 슬라이더를 하나의 pill row로 통합하고, 원형 thumb 대신 색상 채움과 얇은 위치 표시만 사용한다.
- 진행률 드래그 프리뷰와 확인 모달의 글자 크기는 리더 설정 메뉴와 비슷한 밀도로 낮췄다.
- 메뉴는 빈 화면 탭에서만 닫힌다. 검색/목차/테마/설정/북마크 모달을 열어도 메뉴 상태는 유지된다.
- 메뉴가 닫힌 상태에서는 같은 위치에 남은 투명 터치 영역이 없도록 포인터 이벤트를 비활성화했다.
- 최하단 `Chapter / percent / #` 상태줄은 배경 캡슐 없이 텍스트만 표시하고 위치를 더 아래로 내렸다.
- 리더 모달 기본 위치는 화면 중앙보다 위쪽으로 올렸고, 목차 모달 높이는 약 8개 항목만 보이도록 줄였다.
- 진행률 이동 프리뷰/확인 모달은 현재 챕터를 재사용하지 않고 TOC progress 기준으로 목표 퍼센트의 챕터를 계산한다. 계산할 수 없으면 챕터를 숨기고 퍼센트만 표시한다.
- 메뉴 구성은 1줄 `목차`, 2줄 `책 검색`, 3줄 `설정 / 테마 / 북마크`로 정리했다.
- 진행률 이동 확인 모달은 중앙 배치를 유지하고, 설정/테마/목차 같은 패널형 모달만 위쪽 배치를 사용한다.
- 앱 버전과 서비스워커 캐시는 `1.5.1`로 갱신했다.

## 현재 확인된 구조

- 리더 화면 조립은 `src/components/EpubReader.tsx`가 담당한다.
- 상단/하단 리더 컨트롤은 `src/components/reader/ReaderToolbar.tsx`에 있다.
- 진행률 슬라이더 동작은 `src/hooks/reader/useReaderProgressSlider.ts`에 분리되어 있다.
- 위치 이동 확인/입력 모달은 현재 `src/components/reader/JumpDialog.tsx`가 퍼센트/CFI 직접 입력용으로만 쓰인다.
- 리더 메뉴 표시/닫기와 브라우저 뒤로가기 처리는 `src/hooks/reader/useReaderChrome.ts`가 담당한다.

## 비범위

- Foliate 엔진, EPUB 파싱, 검색 인덱스, Drive 동기화, Firestore 저장 정책 자체는 변경하지 않는다.
- Android와 PC에서도 상단 나가기 버튼은 오른쪽 `X`로 통일한다. 그 외 리더 이동, 검색, 목차, 설정, 북마크 기능은 기존 사용성을 유지한다.
- 기존 퍼센트 직접 이동과 CFI 직접 이동 기능은 제거하지 않는다. 다만 슬라이더 확정 흐름과 UI는 별도 컴포넌트로 분리할 수 있다.

## Phase 1: 슬라이더 이동을 확인 후 적용

### 목적

진행률 바를 드래그해도 즉시 `goToFraction`을 호출하지 않는다. 드래그 중에는 목표 챕터/퍼센트/페이지 정보를 담은 프리뷰만 보여주고, 릴리즈 후 확인 모달에서 "확인"을 누른 경우에만 실제 이동한다.

### 구현 후보

- `src/hooks/reader/useReaderProgressSlider.ts`
  - `commitSliderMove`가 즉시 이동하지 않고 `pendingTargetPercent`를 반환하거나 상태로 보관하도록 변경한다.
  - `confirmSliderMove`와 `cancelSliderMove`를 추가한다.
  - 확인 전 취소 시 `draftProgress`와 `pendingTargetPercent`를 정리하고 실제 위치/저장은 건드리지 않는다.
  - 확인 시에만 기존 정책대로 auto bookmark 후보를 만들고 `markUserProgressChange({ forceNextRelocateSave: true, expectedPercent, bookmarks })` 후 `goToFraction`을 실행한다.
- `src/components/reader/ProgressJumpConfirmDialog.tsx` 신규 후보
  - 문구: `XX.X%로 이동할까요?`
  - 버튼: `취소`, `확인`
  - 확인 전에는 현재 위치가 유지된다는 점을 UI 상태로 명확히 한다.
- `src/components/EpubReader.tsx`
  - 슬라이더 훅의 pending 상태를 받아 확인 모달을 렌더링한다.
  - 기존 `performJumpFraction`은 직접 입력 이동용으로 유지한다.

### UI 요구사항

- 드래그 중 슬라이더 위에 둥근 캡슐형 프리뷰를 표시한다.
- 프리뷰에는 가능한 경우 `Chapter N`, `XX.X%`, 페이지/위치 힌트를 표시한다.
- Foliate에서 정확한 페이지 수를 바로 얻기 어렵다면 1차 구현은 `Chapter`와 `percent`를 필수로 표시하고, 페이지 표기는 `위치 미리보기` 또는 현재 확보 가능한 section/page 값으로 제한한다.
- 슬라이더는 단순 input range처럼 보이지 않게, 채워진 트랙/남은 트랙/큰 thumb/중앙 인디케이터가 분명한 pill 형태로 만든다.

### 완료 기준

- 드래그 중 본문 위치가 이동하지 않는다.
- 드래그를 놓으면 확인 모달이 열린다.
- 모달에서 취소하면 본문 위치, 저장된 진행률, auto bookmark가 변하지 않는다.
- 모달에서 확인하면 그때 한 번만 이동한다.
- 기존 auto bookmark 정책은 유지된다: 시작 위치와 목표 위치 차이가 5%를 넘을 때만 이전 위치 auto bookmark를 만든다.
- post-move relocate 이벤트 기준으로 최신 진행률이 저장된다.

## Phase 2: iPad Stage Manager 상단 충돌 회피

### 문제

iPad를 Stage Manager로 좁게 띄우면 좌측 뒤로가기 버튼과 상단 제목/컨트롤이 겹친다. Android나 PC의 넓은 화면 배치를 흔들지 않고 좁은 iPad류 터치 화면에서만 안전한 배치가 필요하다.

### 권장 방향

왼쪽 뒤로가기 버튼을 제거하고 모든 환경에서 우측 상단 X 버튼을 닫기/나가기 버튼으로 사용한다. 도서앱 예시처럼 상단 중앙에는 책 제목 또는 짧은 상태만 두고, 버튼이 제목 영역을 침범하지 않도록 오른쪽 safe zone을 둔다.

### 구현 후보

- `src/components/reader/ReaderToolbar.tsx`
  - `ChevronLeft` 뒤로가기 버튼을 제거하고 `X` 닫기 버튼을 항상 렌더링한다.
  - 제목 캡슐은 `max-width: calc(100vw - reserved controls width)` 규칙을 유지한다.
- CSS/Tailwind 조건
  - viewport width 기반: 예시 `max-[640px]` 또는 `max-[720px]`.
  - iPad Stage Manager 특성을 직접 UA로 판별하기보다, 실제 문제인 "좁은 안전 폭" 기준으로 대응한다.
  - `env(safe-area-inset-top/right/left)`를 버튼 위치 계산에 반영한다.

### 완료 기준

- 좁은 iPad Stage Manager 폭에서 뒤로가기/닫기 버튼과 제목 캡슐이 겹치지 않는다.
- PC와 Android 일반 폭에서도 오른쪽 `X` 닫기 UX가 동일하게 제공된다.
- 브라우저 뒤로가기 처리(`useReaderChrome`)와 버튼 나가기 동작이 서로 충돌하지 않는다.

## Phase 3: 리더 하단 고정 상태줄 추가

### 목적

화면을 탭해 메뉴를 열지 않아도 현재 `Chapter`, 진행률, `#` 이동 버튼을 최하단에서 항상 확인할 수 있게 한다. 이 정보는 메뉴 패널 안에서는 제거한다.

### 구현 후보

- `src/components/reader/ReaderStatusBar.tsx` 신규 후보
  - 항상 보이는 하단 상태줄을 만든다.
  - 표시: `Chapter N`, `XX.X%`, `#` 버튼.
  - `#` 버튼은 기존 퍼센트/CFI 직접 이동 모달을 연다.
  - 본문 가독성을 해치지 않도록 safe-area 위에 낮은 대비/반투명 pill 형태로 배치한다.
- `src/components/EpubReader.tsx`
  - `ReaderStatusBar`를 `ReaderToolbar`와 분리해 렌더링한다.
  - 메뉴가 열렸을 때 상태줄을 숨길지 유지할지는 화면 겹침 기준으로 결정한다. 기본은 항상 유지, 메뉴 패널과 겹치는 폭에서는 메뉴 위로 올리거나 숨긴다.
- `src/components/reader/ReaderToolbar.tsx`
  - 현재 하단 메뉴 안의 `currentChapter`, `totalProgress`, `Hash` 표시를 제거한다.

### 완료 기준

- 컨트롤 메뉴를 닫은 상태에서도 최하단에 챕터/퍼센트/#가 보인다.
- 컨트롤 메뉴 내부에는 챕터/퍼센트/# 중복 표시가 없다.
- 하단 상태줄이 Foliate 본문 클릭/페이지 넘김 영역을 과도하게 막지 않는다.

## Phase 4: 도서앱형 팝업 메뉴로 리더 메뉴 재구성

### 목적

화면 탭 시 현재의 큰 하단 카드형 컨트롤 대신 iPad 도서앱 예시처럼 우하단에 compact action cluster를 띄운다.

### 구현 후보

- `src/components/reader/ReaderToolbar.tsx`를 유지하되 내부 구조를 재설계하거나, `ReaderActionMenu.tsx`로 분리한다.
- 메뉴 항목
  - `목차 · XX%` + `List` 아이콘
  - `책 검색` + `Search` 아이콘
  - `테마 및 설정` + `가가` 또는 설정 아이콘
  - 하단 icon row: 공유 후보, 보기/정렬 후보, 북마크
- 현재 앱 기능에 없는 공유/보기 기능은 실제 동작 없는 장식 버튼으로 만들지 않는다. 기능이 없으면 숨기거나 기존 기능에 매핑한다.
- 설정과 테마가 현재 별도 모달이라면 `테마 및 설정` row를 눌렀을 때 1차로 설정 모달을 열고, 설정 모달 안에서 테마 접근을 유지하거나 별도 row를 둔다.

### 레이아웃 요구사항

- 메뉴는 본문 위 우하단에 floating cluster로 뜬다.
- 모바일/좁은 폭에서는 화면 오른쪽 safe-area를 기준으로 최대 폭을 제한한다.
- 큰 하단 카드 안에 카드가 또 들어가는 구조는 피한다.
- 각 row는 8px 이하 radius 또는 pill형 버튼으로 통일하고, 텍스트가 좁은 폭에서 잘리지 않도록 최소/최대 폭을 정한다.

### 완료 기준

- 화면 탭 시 도서앱 예시에 가까운 compact 메뉴가 나타난다.
- 기존 기능인 목차, 검색, 설정, 테마, 북마크 접근이 모두 가능하다.
- 메뉴가 iPad Stage Manager 좁은 폭에서 뒤로가기/닫기 버튼, 상태줄, 본문 텍스트와 겹치지 않는다.

## Phase 5: 버전/캐시 및 검증

### 구현 후보

- `package.json` 버전을 `1.5.1`로 올린다.
- `public/sw.js` 캐시 이름을 `pc-reader-v1.5.1`로 올린다.
- 필요하면 README 또는 업데이트 문서에 변경 요약을 반영한다.

### 자동 검증

- `npx tsc --noEmit` 통과.
- `npx eslint src` 통과.
- `npm run build` 통과.
- `git diff --check` 통과.
- Browser smoke: `http://127.0.0.1:3000` 로드, 인증 화면과 게스트 서재 진입 확인, 콘솔 error 로그 없음.
- 제한: 로컬 게스트 서재가 비어 있어 실제 리더 화면의 책 열기/슬라이더 조작은 브라우저에서 수행하지 못했다.

### 수동 검증

- iPad Safari 일반 전체화면
  - 슬라이더 드래그 중 본문이 움직이지 않는지 확인한다.
  - 릴리즈 후 확인 모달이 뜨고, 확인 시에만 이동하는지 확인한다.
  - 하단 상태줄이 항상 보이는지 확인한다.
- iPad Stage Manager 좁은 창
  - 상단 닫기/뒤로가기 버튼과 제목 캡슐이 겹치지 않는지 확인한다.
  - compact 메뉴가 우하단에서 안전하게 열리는지 확인한다.
- Android
  - 기존 탭/페이지 이동, 검색, 목차, 설정, 북마크 접근이 유지되는지 확인한다.
- PC 브라우저
  - 키보드 이동, 슬라이더 키보드 조작, 모달 확인/취소 흐름이 정상인지 확인한다.
- 진행 저장
  - 슬라이더 취소 후 shelf 진행률이 변하지 않는지 확인한다.
  - 슬라이더 확인 후 shelf 진행률이 목표 위치 근처로 저장되는지 확인한다.
  - 5% 초과 이동 시 auto bookmark가 이전 위치로 생성되는지 확인한다.

## 권장 커밋 분리

1. 슬라이더 확인 이동과 프리뷰 UI.
2. 상단 Stage Manager 충돌 회피와 하단 고정 상태줄.
3. 도서앱형 compact 메뉴 재구성.
4. 버전/캐시/문서 업데이트와 최종 검증.
