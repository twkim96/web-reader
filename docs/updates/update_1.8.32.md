# Web Reader 1.8.32 — 메뉴 글래스 재질 개편

작성일: 2026-08-22

기준 커밋: `48456000a6b99e1fcb0533c410408403e098b671`

상위 계획: `docs/updates/update_1.8.x_plan.md`

## 목표

책장과 리더가 공유하는 메뉴 스타일을 `표준 / 글래스 / 모던` 3종으로 확장한다.

- `표준`은 1.8.31까지의 기존 글래스 외형을 그대로 보존한다.
- 새 `글래스`는 ci.me 상단 바에서 확인한 저투명·저블러 유리 재질을 사용한다.
- `모던`은 기존 Muzio 계열 외형과 동작을 그대로 유지한다.
- 메뉴 버튼, 액션, 순서, 크기, 배치와 PC/모바일 전환 동작은 변경하지 않는다.

## 리뷰 판정

| 항목 | 판정 | 계약 |
| --- | --- | --- |
| 메뉴 스타일 3종 | 수용 | `glass / standard / modern` |
| 기존 글래스의 표준화 | 수용 | 기존 책장·리더 글래스 구현을 `standard` 분기로 이동 |
| ci.me 재질의 새 글래스 | 수용 | 20% dark surface, 4px blur, 10% shadow, 1px gradient rim |
| 기본 메뉴 스타일 | 수용 | 새 설치·누락·잘못된 값은 `standard` |
| 기존 `glass` 저장값 마이그레이션 | 제외 | 개인용 앱이므로 별도 migration marker나 rewrite를 만들지 않음 |
| 버튼·메뉴 구조 복제 | 제외 | 현재 앱의 버튼·메뉴 DOM과 동작을 그대로 유지 |
| 모던 재설계 | 제외 | 기존 `shelf-muzio-dock`과 reader modern surface 유지 |

## 재질 계약

새 글래스 표면은 다음 값을 기준으로 한다.

- background: `rgba(20, 21, 23, 0.20)`
- backdrop blur: `4px`
- shadow: `0 4px 12px rgba(20, 21, 23, 0.10)`
- rim: 1px, 164deg white gradient
- Safari/PWA: `-webkit-backdrop-filter`와 `-webkit-mask-composite` fallback 포함
- 기존 요소의 border radius, width, height, padding, gap은 유지

## 명시적 제외

- 책장/리더 메뉴 액션 추가·삭제·재정렬
- 모바일 bottom dock과 desktop top dock 전환 로직 변경
- 리더 진행률·검색·책갈피·TTS 동작 변경
- 독서 테마와 커스텀 테마 데이터 구조 변경
- 저장값 schema version 또는 일회성 migration
- Google 로그인 버튼을 제외한 외부 아이콘·이미지·스크립트 반입

## Phase 1 — 설정 계약 확장

상태: 완료

- `ShelfDockStyle`을 `glass | standard | modern`으로 확장한다.
- 기본값과 invalid fallback을 `standard`로 바꾼다.
- 테마 모달을 `표준 / 글래스 / 모던` 3개 선택지로 바꾸고 PC·모바일 모두 한 줄에 배치한다.
- 기존 `glass` 값은 그대로 새 글래스로 해석한다.

## Phase 2 — 공용 글래스 재질

상태: 완료

- 전역 CSS에 책장·리더가 함께 쓰는 글래스 surface class를 추가한다.
- 1px gradient rim은 pseudo-element로 만들고 현재 border radius를 상속한다.
- blur 미지원 환경에서도 반투명 배경은 남도록 한다.

## Phase 3 — 책장·리더 적용

상태: 완료

- 책장 dock에서 기존 glass branch를 `standard`로 이동한다.
- 새 glass branch에는 공용 글래스 surface만 적용한다.
- 리더 top chrome과 bottom toolbar의 모든 surface에 같은 분기를 적용한다.
- modern 분기는 수정하지 않는다.

## Phase 4 — 버전·검증

상태: 완료

- app/service-worker/Foliate runtime cache를 `1.8.32`로 맞춘다.
- 설정 정규화, reader surface, shelf browser regression과 release version 검증을 갱신한다.

## 완료 조건

- 설정 화면에 `표준 / 글래스 / 모던`이 한 줄로 표시된다.
- 초기값과 invalid 저장값은 `standard`다.
- 기존 `glass` 저장값은 migration 없이 새 글래스를 선택한다.
- 표준은 기존 글래스의 책장·리더 재질을 유지한다.
- 새 글래스는 책장·리더 모두 20% surface, 4px blur, gradient rim을 사용한다.
- 모던 외형과 메뉴 버튼/배치/동작에 회귀가 없다.
- app/service-worker/Foliate runtime release version이 `1.8.32`로 일치한다.

## Phase 5 — Midnight·빈 책장 온보딩

상태: 완료

- 내장 `Blue` 테마를 제거하고 배경 `#141517`, 글자 `#d2d3d6`인 `Midnight`로 교체한다.
- 앱의 초기 선택 테마 `dark`와 커스텀 테마 구조는 변경하지 않는다.
- 빈 책장 액션은 포인트 컬러를 사용하지 않고 현재 테마 배경에서 계산한 밝기 계층을 사용한다.
  - `도서 직접 추가하기`: 테마 배경보다 살짝 밝은 surface
  - `Google 계정 연동하기`: 현재 테마 배경색
  - `샘플 도서 보기`: Google 연동 버튼과 같은 현재 테마 배경색
- `샘플 도서 보기`는 외부 다운로드 없이 퍼블릭 도메인 이솝 우화 「토끼와 거북이」를 로컬 EPUB으로 설치한다.
- 샘플 EPUB에는 제목·저자·언어·설명·주제·권리 metadata와 전용 표지를 포함하고 동일한 고정 ID로 중복 생성을 막는다.
- 빈 책장 제목은 모드와 무관하게 정자체 `LIBRARY EMPTY`로 통일한다.
- 메뉴 스타일의 표준 설명은 `반투명 유리`로 쓰고, 3개 선택 카드 자체가 각 표면 재질을 미리 보여준다.
- `#태그` 검색 결과는 전역 metadata 권수가 아닌 현재 책장 권수를 표시한다. 책장에 없는 후보는 metadata 인기순 fallback으로 결과 수만 채우고 `0권`은 표시하지 않는다.
- 앱/service-worker/Foliate release version은 `1.8.32`를 유지한다.

### Phase 5 완료 조건

- 내장 테마 목록에 `Blue`가 없고 `Midnight`가 정확한 두 색상으로 표시·적용된다.
- 빈 책장 버튼의 computed background가 포인트 컬러와 무관하고, 직접 추가는 soft surface이며 Google·샘플은 동일한 테마 배경색이다.
- 샘플 버튼 한 번으로 로컬 책장에 표지 있는 「토끼와 거북이」 EPUB이 표시되고 열 수 있다.
- 샘플 EPUB 내부 metadata와 퍼블릭 도메인/CC0 권리 문구를 자동검증한다.
- 빈 책장 제목에 italic/transform이 없고 요청한 문구와 일치한다.
- 태그 검색에서 책장 권수 후보가 먼저 나오며 0권 fallback에는 숫자가 붙지 않는다.
- 모바일에서도 메뉴 스타일 선택 카드 3개가 한 줄이고 각각 standard/glass/modern surface를 사용한다.

## Phase 6 — 샘플 리더 회귀·기본 본문 크기 보완

상태: 완료

- 샘플 EPUB의 네 장을 각각 20문단 이상, 본문 1,000자 이상으로 확장해 장별 스크롤·진행률·메뉴 호출을 시험할 수 있게 한다.
- 샘플 본문은 연속 공백을 넣지 않고 `word-break: normal`, 한국어 strict line break를 사용해 양쪽 정렬 설정에서도 좁은 화면의 단어 사이가 과도하게 벌어지지 않게 한다.
- EPUB 스크롤 모드에서도 publication iframe 바깥의 남는 reader content surface를 짧게 누르면 상·하단 메뉴를 호출한다. 고정 레이아웃의 기존 입력 처리는 유지한다.
- 새 설치 또는 저장값이 누락된 리더 설정의 기본 글자 크기를 `20px`로 변경한다. 사용자가 명시적으로 저장한 기존 글자 크기는 덮어쓰지 않는다.
- `LIBRARY EMPTY`로 제목이 짧아져도 빈 책장 액션의 부모 폭을 고정해 기존 `240px` 버튼 폭과 `11px` 글자 크기, 기존 세로 padding을 유지한다.

### Phase 6 완료 조건

- 샘플 EPUB 모든 장이 20문단·1,000자 이상이고 390px 및 desktop reader에서 실제 세로 스크롤이 생긴다.
- 샘플 모든 문단에 연속 공백이 없고 `keep-all`/EPUB 자체 강제 양쪽 정렬을 사용하지 않는다.
- 스크롤 모드의 바깥 빈 surface click이 숨은 reader chrome을 다시 연다.
- 설정 저장값이 없으면 publication 본문이 `20px`이며 명시적으로 저장한 `18px`는 그대로 복원된다.
- 390px 빈 책장에서 직접 추가·Google·샘플 버튼은 모두 `240px` 폭이고 글자 크기는 기존 `11px`다.

## Phase 7 — 메뉴 스타일 선택 표시 통일

상태: 완료

- 표준·글래스·모던 선택 카드는 재질별 box-shadow와 무관한 공용 2px 선택 박스와 체크 표시를 사용한다.
- 밝은 테마 전용 어두운 surface 합성은 글래스 투명감을 잃어 사용자 시각 확인 뒤 폐기했다.
- 글래스는 모든 테마에서 기존 ci.me 수치인 `rgba(20, 21, 23, 0.2)`, `blur(4px)`, 164deg rim을 그대로 유지한다.
- 표준·모던 메뉴 스타일과 본문 테마색은 변경하지 않는다.

### Phase 7 완료 조건

- 세 메뉴 스타일을 차례로 선택해도 동일한 네모 선택 박스와 체크 표시가 보인다.
- 글래스의 기존 surface·blur·rim·그림자 계산값에 회귀가 없다.

## Phase 8 — 독서 통계 포인트색 절제·모달 헤더 통일

상태: 완료

- 독서 통계의 포인트색은 새로고침, 선택한 기간, 선택한 도서 상태, 도서별 우측 독서 시간에만 사용한다.
- 오늘·이번 주·이번 달 요약, 화면/TTS 합계, 완료 상태·날짜, 피드백과 내보내기 액션은 현재 테마 글자색과 중립 surface를 사용한다.
- 공유 버튼의 채운 포인트 배경을 제거하고 MD·JSON·진단과 같은 테마 테두리 버튼으로 맞춘다.
- 도서 정보 헤더는 진입 버튼과 같은 `Info` 아이콘을 사용한다.
- 테마 설정, 리더 설정, 독서 통계, 라이브러리 주석, 책장 정렬·필터 헤더에 각각 Palette, Settings, BarChart3, Highlighter, SlidersHorizontal 아이콘을 왼쪽에 표시한다.
- 아이콘 박스와 통계 하단 액션은 브라우저 dark mode가 아니라 현재 앱 테마의 `secondary` surface를 사용한다.
- 대상 모달 헤더는 모두 본문과 구분되는 하단 테두리를 유지한다.

### Phase 8 완료 조건

- 독서 통계 DOM에서 허용한 네 역할 밖에 `accent-*` 표시 클래스가 없다.
- 하단 공유 버튼의 글자색·배경·테두리 계층이 인접한 내보내기 버튼과 같다.
- 6종 모달의 실제 브라우저 DOM에 올바른 헤더 아이콘과 1px 하단 구분선이 있다.
- 기존 모달 닫기, 새로고침, 필터, 내보내기와 스크롤 동작에 회귀가 없다.

## Phase 9 — PC 더블클릭 선택 메뉴 점멸 방지

상태: 완료

- publication 문서의 `selectionchange`가 포인터 입력 도중 발생하면 곧바로 메뉴를 렌더하지 않고 pointer-up까지 기다린다.
- 280ms 이하·14px 이하의 짧은 포인터 입력이 만든 브라우저 단어 선택은 더블클릭 선택으로 보고 메뉴를 열지 않은 채 지운다.
- 280ms를 넘긴 길게 누르기 또는 14px를 넘긴 드래그 선택은 기존처럼 선택 메뉴를 연다.
- 키보드나 접근성 입력처럼 포인터 제스처 밖에서 만들어진 유효 선택의 기존 처리도 유지한다.

### Phase 9 완료 조건

- 실제 PC 더블클릭 중 선택 메뉴가 한 번도 mount되지 않고 브라우저 단어 선택도 남지 않는다.
- 드래그 선택은 메뉴를 열며 복사·공유·번역·듣기·사전·하이라이트 동작을 그대로 제공한다.
- 짧은 탭의 메뉴 표시·페이지 이동과 빠른 연속 탭의 native selection 정리 회귀가 없다.

## Phase 10 — 리더 설정·저장소·상단 종료 정렬 보완

상태: 완료

- 리더 설정의 헤더 구분선과 첫 `Navigation Mode` 사이에 20px 본문 여백을 둔다.
- `가로 모드 2페이지 보기`와 `마지막으로 읽던 책 자동 열기` 사이의 중복 구분선·양쪽 간격을 제거하고 12px 간격의 한 그룹으로 묶는다.
- `Offline Storage` 제목의 italic을 제거하고 헤더 저장소 아이콘은 다른 모달처럼 현재 테마의 `secondary` 박스와 글자색을 사용한다.
- 오프라인 도서 목록의 문서·삭제 아이콘과 닫기 아이콘은 포인트색 대신 현재 테마 글자색을 기본값으로 사용한다. 삭제 hover 경고색은 유지한다.
- PC 리더의 상단 종료 버튼을 제목 메뉴와 같은 세로 중심선에 맞추되 메뉴 재질·크기·동작은 유지한다.
- 테마 설정은 책갈피·리더 설정과 같은 화면 중앙에 배치하고 최대 높이를 82dvh로 제한해, 긴 내용의 스크롤이 바깥 오버레이가 아닌 모달 내부에서만 일어나게 한다.

### Phase 10 완료 조건

- 실제 브라우저에서 설정 헤더와 `Navigation Mode` 간격이 20px이고 두 토글 간격이 12px다.
- `Offline Storage` 제목은 정자체이며 헤더·목록 문서·닫기 아이콘의 computed color가 현재 테마 글자색과 같다.
- 리더 제목 surface와 종료 버튼의 세로 중심 차이가 1px 이하다.
- 테마 설정은 화면 중앙에 놓이고, 바깥 오버레이는 스크롤되지 않으며 모달 상단 위치는 내부 스크롤 전후에도 같다.
- 설정 저장, 오프라인 도서 삭제, 리더 종료 및 기존 툴바 동작에 회귀가 없다.

## Phase 11 — 테마 목록 독립 스크롤·리더 종료 우측선 정렬

상태: 완료

- 내장 테마와 커스텀 테마의 기존 순서·2열 카드 크기는 유지하되, 상단 테마 목록은 80px 카드 3행인 최대 6개까지만 한 번에 표시한다.
- 7번째 테마부터는 상단 테마 목록만 세로 스크롤되며 메뉴 스타일·Point Color 영역과 모달 위치는 그 스크롤을 따라 움직이지 않는다.
- 리더 종료 X의 오른쪽 끝은 본문 텍스트와 하단 메뉴가 공유하는 오른쪽 inset 계산값에 맞춘다.
- 제목은 기존 화면 중앙/우측 전환 계산과 기존 오른쪽 12px 기준선을 그대로 사용해 X 이동의 영향을 받지 않는다.

### Phase 11 완료 조건

- 내장 4개와 커스텀 8개를 넣었을 때 최초 표시 항목이 위에서부터 정확히 6개이고, 스크롤 후 마지막 커스텀 테마까지 보인다.
- 테마 목록의 client height는 264px이며 목록 scrollTop만 변하고 모달 top·scrollTop은 변하지 않는다.
- PC에서 리더 종료 X와 하단 메뉴의 오른쪽 끝 차이가 1px 이하다.
- 제목 위치 계산용 기준선은 기존처럼 화면 오른쪽에서 12px이며 기존 title layout 테스트가 통과한다.

## Phase 12 — 책장 직접 진입·책장 surface 곡률·Google 로그인 브랜딩

상태: 완료

- Firebase 사용자가 없는 최초 진입은 별도 `TW READER / Guest Mode` 화면을 거치지 않고 로컬 guest 책장을 활성화한다.
- Google 로그인 시작 실패와 로그인 사용자의 로그아웃 완료 뒤에도 별도 인증 화면으로 이동하지 않고 guest 책장으로 복구한다.
- 빈 책장 액션의 기존 `240px` 폭·세로 padding·`11px` 글자 크기는 유지하고 곡률만 pill에서 `16px`로 낮춘다.
- 빈 책장 전체 패널 곡률은 `56px`에서 `32px`, grid 도서 카드 곡률은 `40px`에서 `24px`로 낮춘다. list 도서 행은 변경하지 않는다.
- 빈 책장, 책장 제목 옆, PC top dock, 모바일 header의 guest 로그인 버튼은 Google Identity 공식 Android + Web 1x Light square asset을 사용한다.
  - 표준색 Google `G`, 흰 배경, 테두리, 40×40 비율을 변형하지 않는다.
  - 외부 요청 없이 오프라인에서도 보이도록 공식 asset을 앱 번들에 포함한다.
  - 빈 책장 문구는 공식 권장 CTA인 `Google 계정으로 로그인`으로 표시한다.

### Phase 12 완료 조건

- `isGuest` 저장값이 없는 비로그인 브라우저를 reload해도 `data-app-view="shelf"`이며 guest 저장값이 생성되고 인증 landing 문구가 없다.
- 빈 책장 세 액션의 computed width·height·font-size는 기존과 같고 border radius는 모두 `16px`다.
- 빈 책장 패널은 `32px`, grid 도서 카드는 `24px`이며 list 모드는 기존 구조를 유지한다.
- 빈 책장과 모바일·PC 책장 로그인 진입에 원본 및 렌더링 크기 `40×40`인 Google 공식 asset이 표시된다.

## 자동검증 계획

- `npm run test:shelf`
- `npm run test:shelf-ui`
- `npm run test:release`
- `npm run typecheck`
- `npm run build`
- 관련 browser regression으로 PC top dock과 390px bottom dock의 3개 스타일 전환 확인
- `git diff --check`

## 실기기 테스트 계획

- PC Chrome: 책장 top dock 3종 전환과 저장 확인
- Android/모바일 Chrome: bottom dock의 형태·버튼 수·가로 overflow 불변 확인
- iPad Safari/PWA: blur와 gradient rim, safe-area, reader top/bottom chrome 확인
- 다크·라이트·세피아에서 아이콘과 텍스트 대비 확인

## 구현 결과

- `ShelfDockStyle`을 `glass | standard | modern`으로 확장하고 기본값과 invalid fallback을 `standard`로 변경했다.
- 별도 migration 없이 기존 저장값 `glass`는 새 저블러 글래스로, 기존 외형은 새 값 `standard`로 연결했다.
- 테마 모달의 선택지를 `표준 / 글래스 / 모던` 순서의 3열 grid로 바꿨다.
- 책장 top/bottom dock과 리더 top/bottom surface에 공용 `viewer-cime-glass` 재질을 적용했다.
- 기존 글래스의 책장 24px blur와 리더 28px blur surface는 `standard` 분기로 보존했고 `modern` 분기는 유지했다.
- 내장 `Blue`를 정확한 `#141517 / #d2d3d6`의 `Midnight`로 교체했다.
- 빈 책장 버튼을 테마 surface로 바꾸고 Google·샘플 버튼 배경을 동일하게 맞췄다.
- 퍼블릭 도메인 이솝 우화를 한국어로 새로 각색한 표지·metadata 포함 로컬 EPUB 설치 경로를 추가했다.
- 샘플 네 장을 각각 20문단·1,000자 이상으로 확장해 실제 스크롤과 리더 기능을 점검할 수 있게 했다.
- 좁은 화면에서 `keep-all + justify`가 단어 사이를 늘리던 샘플 CSS를 자연스러운 한국어 줄바꿈으로 교정했다.
- `LIBRARY EMPTY`를 정자체로 통일하고 표준 설명을 `반투명 유리`로 변경했다.
- 짧아진 빈 책장 제목에 의해 액션 폭이 줄어들지 않도록 부모를 full-width로 만들고 기존 240px 폭·11px 글자 크기를 보존했다.
- 메뉴 스타일 카드에는 실제 standard 24px blur, glass 4px blur, modern Muzio surface를 CSS 미리보기로 적용했다.
- 필터와 검색이 공용 책장 태그 집계를 사용하도록 바꿔 `#태그` 검색 권수와 fallback 표시를 교정했다.
- EPUB 스크롤 모드의 iframe 바깥 reader surface에도 메뉴 호출 fallback을 추가하고, 누락 설정의 기본 글자 크기를 20px로 올렸다.
- 독서 통계의 accent 사용을 네 역할로 제한하고 하단 공유·내보내기 버튼을 동일한 중립 테마 계층으로 맞췄다.
- 도서 정보 등 6종 모달 헤더의 의미별 아이콘과 하단 구분선을 통일하고 현재 앱 테마의 secondary surface로 맞췄다.
- 포인터 선택 표시를 pointer-up까지 보류해 PC 더블클릭 단어 선택의 메뉴 점멸을 없애고 드래그·길게 누르기는 유지했다.
- 리더 설정 첫 섹션에 20px 여백을 주고 두 토글을 12px 간격의 단일 그룹으로 묶어 불필요한 공백을 제거했다.
- 오프라인 저장소 제목을 정자체로 바꾸고 헤더·목록·닫기 아이콘을 현재 테마의 secondary surface와 글자색으로 통일했다.
- PC 리더 종료 버튼의 위치를 제목 메뉴 중심선에 맞춰 상단 두 컨트롤이 같은 텍스트 라인에 보이게 했다.
- 테마 설정을 책갈피·리더 설정과 같은 중앙 배치와 82dvh 내부 스크롤 패널로 바꿔 모달 상자 전체가 스크롤을 따라 움직이지 않게 했다.
- 상단 테마 목록을 2열 3행·최대 6개 높이의 독립 스크롤 영역으로 제한해 커스텀 테마가 늘어도 아래 설정과 창 크기가 밀리지 않게 했다.
- 리더 종료 X는 하단 메뉴와 같은 본문 우측 inset에 맞추고, 제목 계산에는 기존 12px 기준선을 별도로 보존했다.
- 비로그인 최초 진입과 로그아웃 뒤에는 별도 인증 landing 대신 로컬 guest 책장을 바로 열도록 인증 bootstrap을 단순화했다.
- 빈 책장 버튼·전체 패널·grid 카드 곡률을 각각 16px·32px·24px로 낮추고 기존 크기와 list 행은 보존했다.
- Google 로그인 진입의 열쇠 아이콘을 공식 40×40 Google Identity asset으로 교체하고 빈 책장 CTA를 `Google 계정으로 로그인`으로 맞췄다.
- app, service worker, Foliate runtime cache 버전을 `1.8.32`로 맞췄다.

## 자동검증 결과

- `npm run check`: 통과
  - ESLint 오류 0건, 기존 경고 4건
  - TypeScript, 전체 Node 회귀, Next.js production build 통과
- `npm run test:browser:ci`: 통과
  - 3종 선택 카드의 한 줄 배치·각 surface, 글래스 20% surface/4px blur/gradient rim, 표준 24px blur, 모던 확인
  - 표준·글래스·모던을 차례로 선택해 각 카드에 동일한 2px 선택 박스와 체크 표시가 하나만 생기는지 확인
  - Midnight, 테마색 빈 책장 액션, 기존 240px 버튼 폭·11px 글자 크기, 샘플 EPUB 설치·표지·열기, service worker `pc-reader-v1.8.32` 확인
  - 저장된 guest 상태가 없는 비로그인 최초 진입에서 인증 landing 없이 guest 책장 직접 진입과 guest 상태 저장 확인
  - 빈 책장 액션 16px·전체 패널 32px·grid 카드 24px 곡률과 액션 크기 보존, Google 공식 로그인 asset 40×40 확인
  - 샘플 첫 장 20문단·1,000자 이상, 실제 scroll flow, 기본 본문 20px, 바깥 reader surface 메뉴 호출 확인
  - 독서 통계에서 허용한 네 역할 밖의 accent 요소 0개, 공유와 MD/JSON/진단의 중립 버튼 계층 확인
  - 도서 정보·테마 설정·리더 설정·독서 통계·라이브러리 주석·책장 정렬필터 헤더 아이콘과 1px 구분선 확인
  - PC 실제 더블클릭 중 선택 메뉴 mount 0회와 선택 잔존 없음, 드래그 선택 메뉴 및 기존 선택 액션 확인
  - 리더 설정 헤더 아래 20px·두 토글 사이 12px, 오프라인 저장소의 정자체 제목과 테마색 아이콘, 제목/종료 버튼 중심 차이 1px 이하 확인
  - 320px 테마 설정의 세로 중심이 화면 중심과 1px 이내이고 바깥 오버레이 scrollTop 0, 내용이 넘칠 때만 내부 패널이 스크롤되는지 확인
  - 내장 4개+커스텀 8개에서 최초 6개 표시, 목록 `clientHeight 264px / scrollHeight 540px / scrollTop 276px`, 마지막 커스텀 테마 표시와 모달 위치 불변 확인
  - PC 리더 종료 X와 하단 메뉴의 오른쪽 끝 차이 1px 이하, 제목 위치 기준선의 기존 오른쪽 12px 유지 확인
- 집중 검증 `npm run test:shelf`, `npm run test:shelf-ui`, `npm run test:release`: 통과
- 태그 집중 검증: 책장 권수 우선 정렬과 metadata fallback 통과
- 로컬 브라우저 시각 확인:
  - PC: `표준 / 글래스 / 모던`의 top 좌표가 모두 같고 3열 유지
  - 390px: 세 선택지의 top 좌표가 모두 같고 약 97px씩 3열 유지
  - 새 글래스 computed style이 `rgba(20, 21, 23, 0.2)`, `blur(4px)`, 164deg rim과 일치
  - 빈 책장 `LIBRARY EMPTY`가 `font-style: normal`, transform 없음
  - 390px 빈 책장에서 직접 추가 `rgb(69, 69, 70)`, Google·샘플 `rgb(39, 39, 40)`, 세 버튼 폭 240px, 가로 overflow 0
  - 390px 샘플 첫 장에 viewport를 넘는 세로 스크롤과 20px 본문 표시 확인
  - PC Edge: 오프라인 저장소 제목 `font-style: normal`, 헤더·문서·닫기 아이콘 `rgb(184, 184, 184)`, 리더 설정 간격 20px/12px 확인
  - PC Edge: 리더 제목 surface와 종료 버튼 중심 차이 `0.71px` 확인
- `git diff --check`: 통과

## 실기기 검증 결과

자동 브라우저 검증 완료. Android Chrome과 iPad Safari/PWA 실기기 검증은 대기.

## 보류·후속 버전

- 실제 iPad/PWA blur와 mask 합성은 자동 브라우저 검증과 별도로 실기기 확인한다.
