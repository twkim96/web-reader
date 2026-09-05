# Web Reader UI kit coverage map

## 현재 키트에 구현된 실제 클래스/레시피

아래 표의 **실제 selector**는 현재 `ui-kit/components.css`와 `ui-kit/index.html`에서 사용할 수 있다. 이 표 뒤의 `wr-*` 항목은 소스 화면을 빠짐없이 점검하기 위한 **coverage ID**이며, 같은 이름의 실제 selector가 있다는 뜻은 아니다. 키트의 적용 범위는 시각 재료·geometry·상태·반응형 배치다. 동등한 화면이 target 앱에 있을 때만 해당 레시피를 입히고, Web Reader의 책/동기화/업로드/번역/TTS 도메인 기능은 추가하지 않는다.

| 실제 selector / 계약 | 구현 위치 | 용도 |
| --- | --- | --- |
| `.wr-kit` + `data-theme`, `data-material`, `data-texture`, `data-accent` | `ui-kit/components.css`, `ui-kit/tokens.css`, `ui-kit/index.html`, `ui-kit/preview.js` | 키트 범위, midnight/light/dark/sepia theme, standard/glass/modern material, texture와 accent palette를 지정한다. |
| `.wr-texture`, `.wr-muted`, `.wr-label`, `.wr-stack`, `.wr-row`, `.wr-spread` | `ui-kit/components.css` | 표면 질감 및 typography/간격/행 유틸리티다. |
| `.wr-panel`, `.wr-dialog`, `.wr-search`, `.wr-menu` | `ui-kit/components.css` | 공통 표면, panel padding, border, shadow, backdrop filter다. |
| `.wr-button`, `.wr-icon-button`, `.wr-close`, `.wr-choice`, `.wr-button--primary`, `--danger`, `--ghost` | `ui-kit/components.css` | 44px control, icon/close button, selected choice, accent/danger/ghost 상태다. |
| `.wr-chip`, `.wr-chip--accent`, `--success`, `--warning` | `ui-kit/components.css` | semantic tag/status와 pressed 상태다. |
| `.wr-field`, `.wr-input`, `.wr-error`, `.wr-toggle`, `.wr-range`, `.wr-progress` | `ui-kit/components.css` | input/select/textarea, validation, toggle, range/progress control이다. |
| `.wr-list`, `.wr-list-button`, `.wr-notice`, `.wr-skeleton` | `ui-kit/components.css` | 분리된 list row, feedback notice, loading placeholder다. |
| `.wr-dock`, `.wr-reader-bar` | `ui-kit/components.css` | dock와 reader chrome 표면 (고정 위치는 대상 앱에서 지정)이다. `.wr-menu` width/list action도 이 구간에 있다. |
| native `<dialog>`, `::backdrop`, `.wr-dialog-header`, `.wr-dialog-body`, `.wr-dialog-footer`, `.wr-dialog--compact`, `.wr-sheet` | `ui-kit/components.css`, `ui-kit/index.html` | dialog frame, header/body/footer, compact dialog와 640px 미만 bottom sheet다. `showModal()`/Escape/backdrop close는 `ui-kit/preview.js`의 예시 동작이다. |
| `@font-face: "WR Pretendard"` | `ui-kit/components.css`, `ui-kit/assets/PretendardVariable.woff2` | 키트가 제공하는 UI font다. `RIDIBatang`은 원본 Reader의 읽기 콘텐츠용 font이며 키트 UI font으로 번들하지 않는다. |

`ui-kit/index.html`의 preview가 실제 조합 예시다. 다른 앱은 `tokens.css`와 `components.css`를 로드한 뒤 `.wr-kit` wrapper와 data 속성을 자기 화면에 붙여 필요한 실제 selector만 사용하면 된다. `data-transparency="reduced"`와 `prefers-reduced-motion` 처리도 `ui-kit/components.css`에 포함된다.

## 소스 coverage ID와 전역 시각 계약

다음 항목의 체크박스 이름은 **conceptual inventory ID**다. 실제 키트 selector로 이미 구현된 항목(`wr-panel`, `wr-button` 등)도 있고, 여러 selector를 조합하거나 target 앱에서 새로 매핑해야 하는 항목(`wr-shelf-shell`, `wr-glass-ring` 등)도 있다. 채택 시 먼저 위 실제 표의 class를 사용하고, 이 목록은 빠진 화면과 변형을 확인하는 데 사용한다.

- [ ] `wr-theme`: 기본 배경/전경, UI용 Pretendard와 읽기 콘텐츠용 RIDIBatang의 분리, accent 400/500/600, 테마 질감을 점검한다. 원본은 `src/app/globals.css:3-60`, 런타임 색상·질감 변수는 `src/lib/themeUtils.ts:82-198`, 내장 테마와 accent 팔레트는 `src/lib/constants.ts:6-74`다. 키트 theme/accent/texture 계약은 `ui-kit/tokens.css`다.
- [ ] `wr-radius`: `app-panel-radius` 14px, `app-search-modal-radius` 20px, tag `--app-radius-md` 7px과 optical radius/control scale을 점검한다 (`src/app/globals.css:62-75`, `src/app/globals.css:331-366`).
- [ ] `wr-material`: `standard`, `glass`, `modern`의 surface/ink/border/filter/panel shadow/control shadow/footer/dock/reader 재료를 비교한다 (`src/app/globals.css:77-166`, `ui-kit/tokens.css`). 원본의 `data-menu-style-material` 및 `html[data-viewer-menu-style]` 선택 구조는 target 앱의 대응 state가 있을 때만 매핑한다.
- [ ] `wr-glass-ring`: glass의 `isolation`, `position: relative`, pseudo-element mask, 164deg highlight border를 참고한다 (`src/app/globals.css:393-415`, `src/app/globals.css:505-540`).
- [ ] `wr-tag` / `wr-filter-chip`: semantic tag 색상 혼합, hover, pressed, 필터 칩 반투명 재료를 점검한다 (`src/app/globals.css:431-470`, `src/app/globals.css:498-503`). 선택 choice/primary CTA의 accent 12% tint와 일반 choice pressed의 accent 600 예외도 참고한다 (`src/app/globals.css:472-496`).
- [ ] `wr-modal-occlusion`: 시트/확인창/검색창이 열렸을 때 dock이 감춰지는 surface/state를 점검한다 (`src/app/globals.css:224-243`). reduced-motion 규칙은 `src/app/globals.css:315-329`다.
- [ ] `wr-modal-backdrop`: 공용 backdrop rgba(0,0,0,.20), backdrop blur 처리, 640px 미만 bottom-sheet geometry/safe-area/radius/enter animation을 점검한다 (`src/app/globals.css:245-250`, `src/app/globals.css:292-313`). 현재 native dialog 대응은 `ui-kit/components.css`다.
- [ ] `wr-scroll`: WebKit/Firefox/Edge scrollbar 처리와 reader paged navigation overscroll을 참고한다 (`src/app/globals.css:542-556`). target 앱에 같은 스크롤 surface가 있을 때만 적용한다.

## 포터블 레시피 매핑

이 표는 소스 시각 계약을 현재 키트 class로 옮기는 **의도된 recipe mapping**이다. 키트가 Web Reader 화면의 동작까지 패키징했다는 뜻은 아니다.

| coverage ID | 현재 키트 mapping | 소스 시각 계약 / 적용 조건 |
| --- | --- | --- |
| `wr-panel` | `.wr-panel` | `app-panel-radius`, theme bg/text/border, shadow, overflow. 동등한 카드/모달 표면에 적용한다. |
| `wr-sheet` | `.wr-dialog.wr-sheet` | dialog header/body/footer, menu material, mobile bottom-sheet geometry. 동등한 sheet 화면에 적용한다. |
| `wr-search` | `.wr-search` | Spotlight radius/배치/height/max-height와 result footer/action. 동등한 search 화면에 적용한다. |
| `wr-dialog` | `.wr-dialog` + native `<dialog>` | dialog/alertdialog surface, backdrop, Escape/focus 계약. target의 동등한 dialog semantics에 맞춰 연결한다. |
| `wr-button` | `.wr-button`, modifiers | 44px touch target, rounded control, hover/active/disabled, solid 또는 tint CTA. |
| `wr-field` | `.wr-field`, `.wr-input`, `.wr-toggle`, `.wr-range` | theme border/secondary surface, radius, accent focus ring. |
| `wr-chip` | `.wr-chip` + semantic modifiers | 장르·태그·출처·상태처럼 짧은 선택/상태 label이 있는 화면. |
| `wr-menu` | `.wr-menu`, `.wr-list-button`, `.wr-choice` | section/action/selected choice/danger/info surface가 있는 menu. |
| `wr-dock` | `.wr-dock` | bottom dock surface, safe area, icon control. |
| `wr-reader-bar` | `.wr-reader-bar` | reader-like top/bottom chrome와 progress rail이 있는 target 화면. |
| `wr-notice` | `.wr-notice` | role status/alert, compact border/surface, semantic feedback. |

## 공용 모달 골격

- [ ] `wr-sheet-header`: `MenuSheetHeader`의 close button 40px circular `app-modal-close`, title/subtitle truncate, optional trailing action, bottom border를 시각 참고로 삼는다 (`src/components/MenuSheetHeader.tsx:17-51`). target에 대응 header가 있으면 적용한다.
- [ ] `wr-modal-frame`: `ReaderModalFrame`의 body scroll lock, initial focus, Escape, Tab loop, focus restore, backdrop dismiss와 `upper` 18vh/`high` 7vh/center placement를 참고한다 (`src/components/reader/ReaderModalFrame.tsx:24-121`). `menuSheet`와 `noBlur`가 재료를 바꾸는 구조도 동등 state가 있을 때 매핑한다.
- [ ] `wr-confirm`: `ConfirmDialog`의 danger/info 의미, cancel 숨김/non-dismissible 상태, backdrop 판정, focus trap, icon section, 2열 action을 시각 상태 참고로 삼는다 (`src/components/ConfirmDialog.tsx:19-164`). danger/info material은 `src/app/globals.css:417-429`다.
- [ ] `wr-focus-dialog`: 모든 소스 dialog가 공용 frame semantics를 공유하지 않으므로 아래 standalone 목록도 동등 화면이 있을 때 각각 점검한다.

## 책장 표면

### Shell, header, dock

- [ ] `wr-shelf-shell`: theme surface, `pb-36`, max-width content, 결과 요약/main/load-more geometry를 참고한다 (`src/components/shelf/index.tsx:359-498`, 결과 요약 `src/components/shelf/index.tsx:400-440`). 동등한 collection/library 화면이 있을 때만 적용한다.
- [ ] `wr-shelf-header`: Guest/Local/Cloud brand state, sync progress/cancel notice, mobile auth/layout control의 배치와 40px icon, 21px→22px title을 참고한다 (`src/components/shelf/ShelfHeader.tsx:248-330`, `src/components/shelf/ShelfHeader.tsx:250-281`, `src/components/shelf/ShelfHeader.tsx:305-326`).
- [ ] `wr-dock`: mobile h 4.25rem/`calc(100vw - 1rem)`/max-sm와 desktop h 4.5rem/overflow, mobile 44px·desktop 56px icon control, active/add-local/icon surface 차이를 참고한다 (`src/components/shelf/ShelfHeader.tsx:81-95`, `src/components/shelf/ShelfHeader.tsx:90-94`, `src/components/shelf/ShelfHeader.tsx:171-228`, `src/components/shelf/ShelfHeader.tsx:232-245`).
- [ ] `wr-layout-control`: filter count badge와 simple→grid→list view cycle의 responsive slot 차이를 참고한다 (`src/components/shelf/ShelfHeader.tsx:96-150`, `src/components/shelf/ShelfHeader.tsx:207-242`).

### Book cards and empty state

- [ ] `wr-card-simple`: 2열 mobile→3/4/5열, 2:3 cover, 5px metadata row, two-line title, progress/date row geometry를 참고한다 (`src/components/shelf/index.tsx:442-467`, `src/components/shelf/BookCard.tsx:321-422`).
- [ ] `wr-card-grid`: 1열 mobile→2열, 120/136px cover, min-height 12/13rem, format/source/title/tags/progress block, hover cover/progress rail을 참고한다 (`src/components/shelf/index.tsx:444-450`, `src/components/shelf/BookCard.tsx:534-646`).
- [ ] `wr-card-list`: border-bottom row, mobile 44×64px→sm 48×68px cover, title/time/progress/format responsive grid을 참고한다 (`src/components/shelf/BookCard.tsx:425-531`). 작은 폭 tags와 `+N` 계산의 측정 지점도 참고한다 (`src/components/shelf/BookCard.tsx:119-176`, `src/components/shelf/BookCard.tsx:178-245`).
- [ ] `wr-card-gesture`: short tap/Enter/Space primary entry와 650ms hold/context-menu secondary action의 visual affordance와 hit area를 참고한다 (`src/components/shelf/BookCard.tsx:266-319`, `src/components/shelf/BookCard.tsx:321-549`). target에 같은 interaction이 있을 때만 적용한다.
- [ ] `wr-cover`: real/fallback cover frame, id-hash palette, contrast 우선, simple/grid/list/info별 text size를 참고한다 (`src/components/shelf/GeneratedBookCover.tsx:5-20`, `src/components/shelf/GeneratedBookCover.tsx:64-110`, `src/components/shelf/GeneratedBookCover.tsx:112-140`).
- [ ] `wr-empty`: filtered-empty와 true-empty의 layout/CTA surface를 구분한다 (`src/components/shelf/EmptyState.tsx:34-121`). target의 empty state에 동등한 variant가 있을 때만 적용한다.

### 책장 검색·필터·책 정보

- [ ] `wr-search-shelf`: `ShelfSearchModal`의 search geometry, title/#tag mode, suggestion chip, result row/cover fallback/download badge/progress/date/genre/tag preview를 참고한다 (`src/components/ShelfSearchModal.tsx:105-222`). 동등한 collection search가 있을 때 `.wr-search`를 적용한다.
- [ ] `wr-filter-sheet`: `ShelfFilterModal`의 max-xl/82dvh, sort 3열, source/genre/tag chip, selected block, more row, loading/error notice, reset/apply footer와 pressed/disabled state를 참고한다 (`src/components/shelf/ShelfFilterModal.tsx:138-319`).
- [ ] `wr-book-info`: `BookInfoModal`의 90vw/36rem, 78dvh→82dvh, header/cover/title/tags, 2열 metadata, progress, scroll body, footer action geometry를 참고한다 (`src/components/shelf/BookInfoModal.tsx:354-619`). target에 동등한 detail 화면이 있을 때만 적용한다.
- [ ] `wr-book-delete`: `BookInfoModal` 내부의 별도 `role=alertdialog` surface와 destructive action 상태를 참고한다 (`src/components/shelf/BookInfoModal.tsx:622-690`).
- [ ] `wr-import-sheet`: `ImportBookModal`의 max-sm, file disclosure, 8.25rem dashed target, 11.25rem scroll list, remove action, cancel/add footer geometry를 참고한다 (`src/components/shelf/ImportBookModal.tsx:101-185`, `src/components/shelf/ImportBookModal.tsx:188-267`). 상태별 문구/inline action은 target의 동등 화면에만 연결한다 (`src/components/shelf/ImportBookModal.tsx:141-161`).
- [ ] `wr-offline-list`: `ManageModal`의 max-md/80vh, Offline Storage header, empty state, file row, delete icon과 nested confirm surface를 참고한다 (`src/components/ManageModal.tsx:61-115`).

## Reader 표면

### Reader shell, bars, menus

- [ ] `wr-reader-shell`: reader root h-screen/w-screen, theme texture, select-none/overflow-hidden, loading overlay와 fixed-layout interaction overlay를 참고한다 (`src/components/EpubReader.tsx:1534-1610`). target에 reader-like viewport가 있을 때만 적용한다.
- [ ] `wr-reader-bar`: top nav safe-area/show-hide translate, close/title surface와 긴 title/fixed/two-page/landscape layout을 참고한다 (`src/components/reader/ReaderToolbar.tsx:103-262`). bottom menu의 safe-area, 17.1875rem→18.90625rem width, preview card, utility row, TOC/progress rail, search/records/theme/settings action geometry도 참고한다 (`src/components/reader/ReaderToolbar.tsx:264-440`).
- [ ] `wr-progress-rail`: pointer capture touch/mouse preview/commit/cancel과 keyboard range의 accessible geometry를 참고한다 (`src/components/reader/ReaderToolbar.tsx:120-171`, `src/components/reader/ReaderToolbar.tsx:322-371`). 동등한 progress control이 있을 때만 적용한다.
- [ ] `wr-reader-status`: chapter max-width 42vw truncate, accent percent, 24px `#` control, serif reading-time layout을 참고한다 (`src/components/reader/ReaderStatusBar.tsx:20-55`).
- [ ] `wr-reader-menu`: TTS-like bottom panel의 safe-area/max 28rem/max-height, status header, 4열 transport, disclosure/control grouping, loading/error/voice-list state를 참고한다 (`src/components/reader/ReaderTtsControls.tsx:83-176`, `src/components/reader/ReaderTtsControls.tsx:172-269`). target에 동등한 media/control panel이 있을 때만 적용한다.
- [ ] `wr-selection-menu`: visualViewport 12px margin, below-first/above-fallback placement, color row, action row geometry를 참고한다 (`src/components/reader/TextSelectionMenu.tsx:25-83`, `src/components/reader/TextSelectionMenu.tsx:89-177`).
- [ ] `wr-highlight-menu`: 같은 viewport 배치 안에서 color pressed ring과 note/delete/close action row가 다른 변형을 참고한다 (`src/components/reader/HighlightActionMenu.tsx:39-69`, `src/components/reader/HighlightActionMenu.tsx:71-128`).

### Reader sheet와 특수 대화상자

- [ ] `wr-records-sheet`: `BookmarkModal`의 h 34rem/max 85vh, tabs, grouped rows, limit/delete surface와 `AnnotationPanel`의 search/sort/note filter/batch/status/collapsible group/unresolved state를 참고한다 (`src/components/BookmarkModal.tsx:74-224`, `src/components/AnnotationModal.tsx:136-311`).
- [ ] `wr-toc-sheet`: `TocModal`의 max 30rem/32rem, subtitle, nested rows, current accent/dot, percentage와 empty state를 참고한다 (`src/components/TocModal.tsx:27-69`).
- [ ] `wr-settings-sheet`: `SettingsModal`의 h 34rem/max 85vh, stepper/disclosure/toggle/accordion/palette editor geometry를 참고한다 (`src/components/SettingsModal.tsx:164-181`, `src/components/SettingsModal.tsx:182-319`, `src/components/SettingsModal.tsx:321-475`). fixed-layout에 따른 control visibility도 동등 화면이 있을 때 참고한다.
- [ ] `wr-theme-sheet`: `ThemeModal`의 list/create/edit-select/edit modes, built-in/custom card 4열, 3 material preview, color picker, 6 texture, live preview, delete/save control을 참고한다 (`src/components/ThemeModal.tsx:38-170`, `src/components/ThemeModal.tsx:129-150`, `src/components/ThemeModal.tsx:181-274`, `src/components/ThemeModal.tsx:278-328`, `src/components/ThemeModal.tsx:337-415`).
- [ ] `wr-annotation-note`: `AnnotationNoteDialog`의 max-lg, 88vh/44rem, color label/meaning header, serif quote, resizable textarea, count, footer geometry를 참고한다 (`src/components/reader/AnnotationNoteDialog.tsx:40-99`).
- [ ] `wr-translation-dialog`: `TranslationDialog`의 max-xl, 90dvh/46rem, source quote, loading/error/success state와 copy/save footer geometry를 참고한다 (`src/components/reader/TranslationDialog.tsx:55-206`). target에 동등한 result dialog가 있을 때만 적용한다.
- [ ] `wr-jump-dialog`: Reader `#` status entry point가 여는 CFI/percentage dialog의 `menuSheet`, `MenuSheetHeader`, `app-menu-sheet-content` geometry를 참고한다 (`src/components/reader/JumpDialog.tsx:22-66`). 현재 portable mapping은 native `<dialog>` + `.wr-dialog-header/body/footer`다. 이 rare entry를 누락하지 않는다.
- [ ] `wr-progress-confirm`: progress commit 전 max 19rem dialog, chapter label, percent copy, resolving disabled state와 pointer-safe backdrop geometry를 참고한다 (`src/components/reader/ProgressJumpConfirmDialog.tsx:21-148`).
- [ ] `wr-remote-progress`: remote-progress conflict prompt의 max-sm panel 및 reset/normal-operation 상태별 surface를 참고한다 (`src/components/reader/SyncConflictDialog.tsx:74-117`). target에 같은 conflict prompt가 있을 때만 적용한다.
- [ ] `wr-sync-review`: sync review의 max-md, current/remote comparison `dl`, target label/time, conflict notice, 3-action footer geometry를 참고한다 (`src/components/SyncConflictResolutionDialog.tsx:105-289`). resolving disabled state도 동등 화면이 있을 때 참고한다.
- [ ] `wr-login-disclosure`: `LoginDisclosureModal`의 max-lg/88dvh, two-mode header, sign-in asset, disclosure scroll body, cancel footer, trailing icon을 참고한다 (`src/components/LoginDisclosureModal.tsx:39-132`). 자체 backdrop/focus variant가 있음을 coverage에 남긴다.
- [ ] `wr-install-prompt`: `AppInstallPrompt`의 Reader-frame panel과 iOS/non-iOS/checkbox-footer responsive variants를 참고한다 (`src/components/AppInstallPrompt.tsx:13-59`). target에 동등한 install/help prompt가 있을 때만 적용한다.

## 책장 전역 특수 모달과 notice

- [ ] `wr-library-annotation`: `LibraryAnnotationModal`의 max 36rem, 78dvh→82dvh, query/book/color/sort/note filter, export strip, missing/unresolved state, result row geometry를 참고한다 (`src/components/LibraryAnnotationModal.tsx:293-459`).
- [ ] `wr-statistics`: `LibraryReadingStatisticsModal`의 max 36rem, 78dvh→82dvh, refresh/subtitle, notice, headline cards, segmented range, totals, book filter, long-press row, footer geometry와 nested confirm surface를 참고한다 (`src/components/LibraryReadingStatisticsModal.tsx:420-683`).
- [ ] `wr-notice-stack`: page-level progress persistence error, service-worker update, sync review badge의 fixed notice surface를 참고한다 (`src/app/page.tsx:928-975`, `src/app/page.tsx:1004-1010`). target에 같은 page-level notice가 있을 때 spacing/color recipe만 적용한다.

## 채택 체크리스트

- [ ] 실제 기반: `wr-kit` wrapper와 `data-theme`/`data-material`/`data-texture`/`data-accent`를 target root에 연결하고 `.wr-panel`, `.wr-button`, `.wr-field`, `.wr-chip`, `.wr-menu`, `.wr-notice`를 동등 화면에 매핑한다.
- [ ] surface: `.wr-panel`, `.wr-dialog`, `.wr-sheet`, `.wr-search`, `.wr-dock`, `.wr-reader-bar`의 standard/glass/modern과 mobile sheet geometry를 확인한다.
- [ ] controls: `.wr-button`, `.wr-icon-button`, `.wr-choice`, `.wr-input`, `.wr-toggle`, `.wr-range`, `.wr-progress`의 hover/pressed/disabled/loading/error 상태를 확인한다.
- [ ] source families: `wr-shelf-shell`, `wr-shelf-header`, `wr-layout-control`, `wr-card-simple`, `wr-card-grid`, `wr-card-list`, `wr-cover`, `wr-empty`를 target에 대응하는 collection 화면이 있을 때 확인한다.
- [ ] reader families: `wr-reader-shell`, `wr-reader-bar`, `wr-progress-rail`, `wr-reader-status`, `wr-reader-menu`, `wr-selection-menu`, `wr-highlight-menu`를 target에 대응하는 reading/chrome 화면이 있을 때 확인한다.
- [ ] common sheets: `wr-records-sheet`, `wr-toc-sheet`, `wr-settings-sheet`, `wr-theme-sheet`, `wr-book-info`, `wr-filter-sheet`, `wr-import-sheet`, `wr-offline-list`를 동등 화면이 있을 때 확인한다.
- [ ] rare dialogs: `wr-jump-dialog`(Reader `#`), `wr-progress-confirm`, `wr-remote-progress`, `wr-sync-review`, `wr-annotation-note`, `wr-translation-dialog`, `wr-login-disclosure`, `wr-install-prompt`를 동등한 target entry/dialog가 있을 때 빠짐없이 확인한다.
- [ ] nested confirmation: BookInfo 삭제, Offline Storage 삭제, Statistics 회차 완료/목록 삭제, page logout/disconnect/info variants와 같은 nested alertdialog가 target에 있으면 `.wr-dialog`/`.wr-button--danger`로 별도 확인한다.
- [ ] global: `wr-theme`, `wr-radius`, `wr-material`, `wr-glass-ring`, `wr-tag`, `wr-filter-chip`, `wr-modal-occlusion`, `wr-modal-backdrop`, `wr-scroll`, `wr-library-annotation`, `wr-statistics`, `wr-notice-stack`의 source pointer를 확인한다.
- [ ] 포팅 경계: 위 coverage ID를 실제 selector와 혼동하지 않고, target에 없는 Web Reader domain feature를 새로 만들지 않는다. 동등 화면에 적용한 항목만 체크한다.
