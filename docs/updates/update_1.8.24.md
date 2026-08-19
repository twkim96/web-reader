# Web Reader 1.8.24

## 목표

테마 설정의 `글래스 / 모던` 메뉴 스타일을 책장에만 적용하던 범위를 리더 chrome까지 확장한다.

- 책장 메뉴 스타일 선택과 리더 메뉴 스타일을 하나의 설정으로 유지한다.
- 기존 리더 메뉴 외형은 `모던` 스타일로 보존한다.
- `글래스` 선택 시 리더 상단/하단 메뉴에 더 투명한 glass surface를 적용한다.
- 리더 본문, pagination, 모달 내용 영역은 변경하지 않는다.

## 수정

- 기존 `ViewerSettings.shelfDockStyle` 저장 키를 그대로 재사용해 설정 마이그레이션 없이 책장과 리더가 같은 값을 읽는다.
- `ReaderToolbar`에 현재 메뉴 스타일을 전달한다.
- 적용 대상:
  - 상단 닫기(X) 버튼
  - 상단 도서 제목 surface
  - 진행률 preview surface
  - 목차/진행률 bar
  - 검색 버튼
  - 책갈피/주석, 테마, 설정 버튼
  - TTS, 독서 통계, 도서 정보 utility 버튼
- `modern`
  - 1.8.23까지의 리더 surface를 그대로 사용한다.
  - `blur(18px) saturate(1.18)`과 기존 `--viewer-reader-surface`를 유지한다.
- `glass`
  - 테마 배경색 기반 `--viewer-reader-glass-surface`를 사용한다.
  - 배경 alpha를 0.48로 낮추고 `blur(28px) saturate(1.32)`를 적용한다.
  - 테마 문자색 기반의 조금 더 선명한 glass border를 사용한다.
- 테마 설정 제목을 `메뉴 스타일 · 책장 / 리더`로 명확히 한다.
- `data-reader-menu-style`을 상단 chrome과 하단 toolbar에 노출해 회귀 테스트가 실제 적용 상태를 확인할 수 있게 한다.

## 호환성

- localStorage 키/값은 변경하지 않는다. 기존 `glass | modern` 값이 그대로 동작한다.
- 기존 리더 UI는 `modern` 선택 시 동일한 surface 값을 유지한다.
- Foliate paginator/runtime 코드는 변경하지 않는다.

## 검증

- `npm run typecheck` 통과
- ReaderToolbar React DOM 회귀 2/2 통과
  - 기존 진행률 pointer 입력 회귀 유지
  - glass가 상단 제목/X 및 하단 목차 surface에 전달되는지 확인
  - modern이 기존 reader surface와 18px blur를 유지하는지 확인
- `npm run test:release` 3/3 통과
- 전체 `npm run check` 통과
  - storage 305건
  - shelf 111건
  - shelf-ui 10건
  - SW/release/publisher 및 production Next.js build 통과

## 버전/캐시

- 앱 버전: `1.8.24`
- Service Worker cache: `pc-reader-v1.8.24`
- Foliate paginator 자체는 변경하지 않아 runtime revision은 `1.8.22.1`을 유지한다.
