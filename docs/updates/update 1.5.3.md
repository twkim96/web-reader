# 업데이트 1.5.3 Phase Plan

## 목표

서재 모바일 헤더 메뉴를 다시 하나의 가로 dock으로 정리하고, 기본 4개 테마는 유지하면서 커스텀 테마를 추가/편집/삭제할 수 있게 한다. 앱 버전과 서비스워커 캐시는 `1.5.3`으로 갱신한다.

## 구현 상태

- Status: 구현 완료, 로컬 검증 완료.
- 모바일 서재 헤더의 검색 버튼과 메뉴 버튼은 같은 가로 dock 안에 배치한다. dock 높이는 기존 메뉴 버튼 높이 기준을 넘기지 않는다.
- `LOCAL LIBRARY` 브랜드 영역은 blur 박스로 감싸지 않고, 요소 자체의 그림자로만 가시성을 보강한다.
- shelf의 `LOCAL LIBRARY`/와이파이 아이콘 브랜드 영역은 스크롤 시 따라 내려오지 않는다.
- PC shelf 메뉴 dock도 모바일 dock과 같은 반투명 blur surface를 사용한다.
- 기본 테마 `light`, `dark`, `sepia`, `blue`는 수정/삭제 대상이 아닌 고정 테마로 유지한다.
- 테마 설정 모달의 X 버튼 옆에 커스텀 테마 추가 버튼과 편집 버튼을 둔다.
- 커스텀 테마는 제목, 배경색, 글자색, 가벼운 CSS 질감 옵션을 저장한다.
- 색상은 직접 hex 입력과 색상표 입력을 모두 지원한다.
- 리더 상단 제목, X 버튼, 하단 메뉴 surface도 커스텀 테마 배경색에서 파생된 색을 사용한다.
- 앱 버전과 서비스워커 캐시는 `1.5.3`으로 갱신한다.

## Phase 1: 모바일 서재 헤더 dock 재정리

### 목적

모바일 헤더에서 돋보기만 dock 밖에 빠져 보여 어색한 상태를 없앤다. 검색과 메뉴 버튼을 하나의 가로 dock으로 감싸되 높이는 키우지 않는다.

### 구현 방향

- `src/components/shelf/ShelfHeader.tsx`
  - 모바일 검색 버튼과 메뉴 버튼을 같은 rounded dock surface 안에 둔다.
  - `LOCAL LIBRARY` 영역은 배경/보더/blur surface 없이 표시한다.
  - 스크롤 중 뒤 콘텐츠와 겹쳐도 읽히도록 브랜드 영역에는 drop shadow만 적용한다.
  - header 전체 sticky를 제거하고, 오른쪽 메뉴 dock만 fixed 위치로 분리한다.
  - PC/모바일 메뉴 dock은 공통 반투명 blur surface를 사용한다.
  - dock은 `h-16` 기준으로 유지하고 내부 메뉴 버튼은 더 작은 슬롯으로 둔다.
  - 모바일 오른쪽 세로 메뉴 dock 위치와 크기는 유지한다.

### 완료 기준

- 모바일 헤더에서 검색 아이콘과 메뉴 아이콘이 하나의 가로 dock 안에 보인다.
- `LOCAL LIBRARY`는 별도 blur 박스 안에 갇혀 보이지 않는다.
- 스크롤 시 `LOCAL LIBRARY`/와이파이 아이콘 영역은 화면 상단에 따라 내려오지 않는다.
- PC 메뉴 dock은 단색 불투명 박스가 아니라 모바일처럼 뒤 배경이 비치는 blur surface로 보인다.
- 모바일 헤더 dock 높이는 이전 메뉴 버튼보다 커지지 않는다.
- 메뉴를 누르면 기존처럼 오른쪽 중앙 세로 dock이 열린다.

## Phase 2: 커스텀 테마 데이터 구조 추가

### 목적

기본 4개 테마는 불변으로 유지하고, 사용자가 만든 커스텀 테마를 설정에 저장한다.

### 구현 방향

- `src/types.ts`
  - `CustomTheme` 타입과 `ViewerSettings.customThemes`를 추가한다.
- `src/lib/themeUtils.ts`
  - 기본 테마와 커스텀 테마를 공통으로 읽는 helper를 둔다.
  - 커스텀 테마 색상은 Tailwind 동적 클래스 대신 CSS 변수로 적용한다.
  - 리더 floating surface용 CSS 변수도 커스텀 테마 배경색에서 계산한다.
  - 질감은 성능 부담이 낮은 CSS gradient 패턴만 지원한다.
- `src/components/reader/ReaderToolbar.tsx`
  - 커스텀 테마의 CSS 변수 기반 배경 클래스는 흰색 fallback으로 보내지 않고 `--viewer-reader-surface`를 사용한다.
- `src/hooks/useViewerSettings.ts`
  - 기본 설정에 빈 `customThemes` 배열을 추가한다.

### 완료 기준

- 기존 기본 테마 4개는 그대로 남는다.
- 커스텀 테마는 localStorage 설정에 저장된다.
- 커스텀 테마 선택 시 shelf와 reader에 배경색/글자색이 적용된다.
- 커스텀 테마 선택 시 리더 메뉴/상단 제목/X 버튼 surface가 흰색 fallback으로 변하지 않는다.

## Phase 3: 테마 모달 커스텀 CRUD

### 목적

테마 설정 모달에서 커스텀 테마를 추가, 선택, 편집, 삭제할 수 있게 한다.

### 구현 방향

- `src/components/ThemeModal.tsx`
  - 헤더의 X 버튼 옆에 `+`와 연필 아이콘을 추가한다.
  - `+` 클릭 시 커스텀 테마 생성 화면을 연다.
  - 생성/편집 화면은 제목, 배경색, 글자색, 질감 옵션을 제공한다.
  - 배경색/글자색은 color picker와 hex 직접 입력을 모두 제공한다.
  - 연필 클릭 시 커스텀 테마 선택 목록을 보여주고, 선택하면 편집 화면을 연다.
  - 편집 화면에서 취소, 삭제, 저장을 제공한다.

### 완료 기준

- `+`로 새 커스텀 테마를 만들 수 있다.
- 새 테마는 테마 목록에 추가되어 보이고 선택된다.
- 연필 버튼으로 커스텀 테마를 선택해 편집할 수 있다.
- 커스텀 테마 삭제 시 현재 선택된 테마라면 기본 sepia로 돌아간다.

## Phase 4: 버전/캐시 및 검증

### 구현 방향

- `package.json`과 `package-lock.json` 버전을 `1.5.3`으로 올린다.
- `public/sw.js` 캐시 이름을 `pc-reader-v1.5.3`으로 올린다.

### 자동 검증

- `npx tsc --noEmit` 통과.
- `npx eslint src` 통과.
- `npm run build` 통과.
- `git diff --check` 통과.

### 수동 검증

- 모바일 서재 헤더에서 검색과 메뉴가 하나의 dock 안에 보이는지 확인한다.
- 커스텀 테마 추가/선택/편집/삭제 흐름을 확인한다.
- 커스텀 테마 색상이 shelf와 reader에 적용되는지 확인한다.
