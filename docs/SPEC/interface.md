# 화면과 디자인

독서 내용을 중심에 두는 조용한 인터페이스를 유지합니다. 작은 컨트롤과 고정 overlay를 사용하고 제스처만 처리하는 영역에 장식 표면을 추가하지 않습니다.

## 테마·설정·재질

첫 화면 기본값은 midnight·rose·glass이며 읽기는 스크롤·RIDIBatang을 기본으로 합니다. 설정은 `viewer_settings`에 기기별로 저장합니다. 폰트·크기·줄/문단 간격·본문 정렬·여백·탭 영역·가로 두 페이지·마지막 도서 자동 열기·언어/음성 설정을 제공합니다. 정확한 기본값과 정규화는 [useViewerSettings.ts](../../src/hooks/useViewerSettings.ts)가 담당합니다.

색 테마(midnight/dark/sepia/light 및 사용자 테마), 메뉴 재질(standard/glass/modern), 배경 질감은 독립 축입니다. 재질은 책장 도크, 리더 상·하단 바, 모달·팝오버·닫기 버튼·액션·푸터에 일관되게 적용합니다. glass의 도크/리더 바와 모달 표면은 다른 레시피입니다. 값은 [globals.css](../../src/app/globals.css), `themeUtils`, `constants`가 기준이며 독립 키트에는 추출 결과를 동기화합니다.

`--viewer-theme-bg/text/border`는 현재 테마, `--viewer-reader-surface`는 리더 바의 표면을 나타냅니다. `--accent-400/500/600`은 `ACCENT_PALETTE`에서 가져오는 앱 포인트색이며 투명 interaction overlay에는 visible color를 추가하지 않습니다.

UI 폰트는 Pretendard, 본문은 선택된 reader font를 사용합니다. 첫 페인트와 hydration에서 테마가 튀지 않게 `layout.tsx`와 `BUILT_IN_THEME_COLORS`를 함께 유지합니다. 긴 도서 제목과 모바일 검색 결과에서 읽을 수 있는 폭·줄바꿈을 확보합니다.

간격은 기존 Tailwind scale을 사용합니다. 작은 컨트롤에 이미 적용된 uppercase label 패턴은 유지하되 모든 화면 문구를 대문자로 바꾸는 규칙으로 확대하지 않습니다.

## 메뉴·모달·모바일

일반 목록·설정·확인 창은 공통 `ReaderModalFrame`/`MenuSheetHeader`와 시트 스타일을 사용합니다. 데스크톱 중앙 배치와 모바일 하단 시트, safe-area, 내부 스크롤, 헤더/푸터 고정 규칙을 함께 유지합니다. 검색은 별도 Spotlight 배치를 사용합니다. Escape·backdrop·포커스 복귀·브라우저 back의 동작은 각 컴포넌트의 dismiss/처리 중 계약을 따릅니다.

진행률 임시 이동 확인은 비모달 패널이며 공통 포커스 차단 모달로 바꾸면 안 됩니다. 기능 계약은 [리더 사양](reader-and-progress.md#진행률-슬라이더의-임시-이동)에 있습니다. 작은 이동 안내가 닫혀도 필요한 원격 후보를 버리지 않습니다.

## 고정 레이아웃 제스처

PDF·이미지 도서 확대·pan은 투명 interaction overlay를 사용합니다. 전체 화면 overlay의 `inset-0` 배치를 유지합니다. overlay는 콘텐츠 위·리더 chrome 아래에 있으며 레이아웃을 밀거나 색/여백/그림자/설명 문구를 추가하지 않습니다. 확대 제스처를 위해 새 버튼이나 지속적인 표시·저장 설정을 만들지 않는 기존 계약을 유지합니다. pointer 종료·capture 상실·취소 때 pending frame과 제스처 상태를 정리하고 뒤따르는 클릭이 페이지를 넘기지 않도록 합니다.

제스처 조작에는 즉시 scale을 반영할 수 있습니다. 장식적인 이동은 transform/opacity/filter 범위와 reduced-motion을 고려합니다. 기존 tonal surface와 modal shadow를 사용합니다.

## 독립 디자인 키트

[ui-kit/README.md](../../ui-kit/README.md)가 키트 사용법의 유일한 유지 위치입니다. [ADOPT.md](../../ui-kit/ADOPT.md)와 [COVERAGE.md](../../ui-kit/COVERAGE.md)는 다른 프로젝트에 전달할 시각 적용 범위와 누락 점검을 담당합니다. 키트는 도메인/API/계정/저장 동작을 포함하지 않습니다. 대상 앱의 기존 기능과 수명·접근성 계약을 유지합니다.

`node --import tsx ui-kit/scripts/sync-tokens.mjs`는 원본의 토큰을 추출합니다. `components.css` 레시피와 coverage는 자동 갱신되지 않습니다. 복사 가능한 키트의 상대 경로와 라이선스는 유지합니다. 네이티브 `<dialog>` 카탈로그의 blur 결과와 앱 portal 모달의 결과는 다를 수 있으므로 Safari 실기기 확인은 [TODO](../TODO.md)에 보존합니다.

## 코드와 검증

- 공통 스타일: `src/app/globals.css`, `src/lib/themeUtils.ts`, `src/lib/constants.ts`, `src/app/layout.tsx`
- UI: `ReaderModalFrame`, `MenuSheetHeader`, `ShelfSearchModal`, `ReaderToolbar`, `src/components/EpubReader.tsx`의 interaction overlay
- 검증: `npm run test:shelf-ui`, `npm run test:browser:ci` 및 기기별 시각 확인. 순수 문구/스타일 변경에는 값을 복사한 새 테스트를 추가하지 않습니다.
