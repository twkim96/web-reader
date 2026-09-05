# Web Reader Design Kit

Web Reader의 **디자인만 다른 프로젝트로 가져가는 독립 키트**입니다. 현재 UI의 색상·재질·질감 값을 추출하고, 자주 쓰는 요소와 모달을 HTML/CSS 레시피로 단순화했습니다. 앱의 로그인·책장·동기화·리더 기능은 포함하지 않습니다.

**먼저 [index.html](index.html)을 브라우저에서 여세요.** 설치나 빌드 없이 테마·재질·질감을 바꾸고, 모달을 직접 열 수 있습니다. 파일 열기를 제한하는 환경에서는 이 폴더에서 `python3 -m http.server 4387 --bind 127.0.0.1`을 실행하고 `http://127.0.0.1:4387`을 엽니다.

## 다른 프로젝트에 전달할 것

`ui-kit/` 폴더 전체를 복사하고 [ADOPT.md](ADOPT.md)의 프롬프트를 함께 전달하세요. 코드가 필요 없는 디자인 참고 작업이라면 이 미리보기와 [COVERAGE.md](COVERAGE.md)를 사용하면 됩니다.

| 파일 | 역할 | 제품에 가져갈 때 |
| --- | --- | --- |
| `tokens.css` | 원본에서 추출한 테마·포인트색·재질·질감 | 필수 |
| `components.css` | `wr-*` 공통 요소와 모달 레시피 | CSS를 재사용하면 필수 |
| `assets/` | Pretendard Variable, OFL 라이선스 | 폰트 사용 시 함께 복사 |
| `tokens.json` | 테마별 색상/질감, 포인트 팔레트, 기하 값, 원본 버전/SHA | 다른 언어·플랫폼의 토큰 변환용 |
| `index.html` | 요소 카탈로그와 복사 가능한 마크업 | 참고용 |
| `preview.css`, `preview.js` | 카탈로그 배치와 데모 동작 | 참고용; 제품에는 불필요 |
| `ADOPT.md` | 다른 AI/개발자에게 전달할 적용 프롬프트 | 함께 전달 |
| `COVERAGE.md` | 화면·특수 모달·상태별 누락 점검표와 원본 지도 | 함께 전달 |
| `scripts/sync-tokens.mjs` | Web Reader 원본에서 토큰을 다시 추출 | 원본 저장소 유지보수용 |

`tokens.json`은 테마/색상/질감용 데이터입니다. blur, 그림자, glass 하이라이트를 포함한 **재질 레시피는 `tokens.css`와 `components.css`**를 함께 참고하세요.

## 최소 사용법

```html
<link rel="stylesheet" href="ui-kit/tokens.css">
<link rel="stylesheet" href="ui-kit/components.css">

<main class="wr-kit wr-texture"
      data-theme="midnight" data-material="glass" data-texture="grain">
  <section class="wr-panel">
    <h2>새 컬렉션</h2>
    <label class="wr-field">
      이름
      <input class="wr-input" placeholder="이름을 입력하세요">
    </label>
    <button type="button" class="wr-button wr-button--primary">만들기</button>
  </section>
</main>
```

CSS는 `tokens.css` → `components.css` → 대상 앱의 배치/보정 CSS 순서로 불러옵니다. `wr-*`는 독립 클래스이고 Tailwind는 필요하지 않습니다. 원본과 비교할 수 있도록 내부 변수명 `--viewer-*`, `--app-menu-*`, `--accent-*`를 유지했습니다. 변수와 기본 스타일은 `.wr-kit` 범위에서 선언됩니다. 기존 앱에서 같은 변수명을 쓴다면 해당 범위를 분리하세요. 문서 스크롤 잠금은 열린 `.wr-kit .wr-dialog`가 있을 때에만 적용됩니다.

| 속성 | 값 | 기본 |
| --- | --- | --- |
| `data-theme` | `midnight`, `dark`, `sepia`, `light` | midnight |
| `data-material` | `standard`, `glass`, `modern` | standard |
| `data-texture` | `none`, `paper`, `linen`, `canvas`, `grid`, `grain` | none |
| `data-accent` | `indigo`, `rose`, `emerald`, `amber`, `sky`, `yellow` | 테마의 기본 포인트색 |
| `data-transparency` | `reduced` | 기본 재질의 투명도 |

이 속성들은 **같은 `.wr-kit` 요소**에 둡니다. 화면 배경에는 `wr-texture`를 붙입니다. 테마를 생략하면 midnight의 질감이 적용됩니다. 별도 `.wr-kit` 영역을 중첩하면 새 테마 범위가 되므로 해당 영역의 속성도 지정하세요. React portal로 모달을 root 밖에 렌더링할 경우 portal host에 동일한 `.wr-kit`와 속성을 전달해야 합니다.

## 디자인 규칙

- **색과 재질은 별개입니다.** `midnight + standard`와 `midnight + glass`는 같은 배경색 위에서 투명도·blur·경계·그림자가 달라집니다. 재질 변경은 패널뿐 아니라 닫기 버튼, 액션, 푸터, 도크, 리더 바에도 이어져야 합니다.
- **질감은 배경에 한 번 둡니다.** 작은 반복 패턴 6종을 CSS gradient로 구현했습니다. 그 위에 반투명 재질이 올라갑니다. 패널마다 강한 노이즈나 큰 배경 이미지를 추가하지 않습니다.
- **주요 버튼은 약하게 물들입니다.** 포인트색 배경 12%, 경계 42%, 텍스트 68% 혼합이 원본 CTA 규칙입니다. 삭제는 별도의 붉은 의미색 16% 표면을 사용합니다. 선택된 필터 태그는 32% 표면입니다.
- **크기에 맞는 곡률을 씁니다.** 컨트롤 3/5/7/8/10/12px, 패널·카드 14px, 검색 20px, 모바일 시트 22px입니다. 모든 요소를 큰 pill 모양으로 만들지 않습니다.
- **타이포그래피는 Pretendard를 기본으로 합니다.** UI 본문 14px, 보조 11–12px, 모달 제목 16→18px를 레시피 기준으로 삼습니다. 카탈로그의 대형 제목과 여백은 전시용입니다. 독서 본문용 RIDIBatang은 이 UI 키트에 포함하지 않았습니다.
- **glass는 큰 blur가 아닙니다.** 원본의 1.5px blur, saturate 90%, contrast 82%, 164도 테두리 하이라이트를 유지합니다. standard는 28px blur, modern은 24px blur를 씁니다.

## 모달을 가져갈 때

카탈로그의 `<dialog>` 마크업을 참고하고 대상 앱의 dialog 컴포넌트에 시각 규칙을 옮겨도 됩니다. `preview.js`는 카탈로그 전용입니다. HTML에서 `showModal()`로 열면 브라우저가 외부 포커스 차단, Escape, 포커스 복귀를 처리하며 키트 CSS가 문서 스크롤을 잠급니다. backdrop 클릭 닫기는 `preview.js`의 pointer 시작/종료 판정을 참고하세요.

| 조합 | 쓰임 | 배치 |
| --- | --- | --- |
| `wr-dialog wr-sheet` | 설정, 목록, 확인, 진행률, 충돌 | 데스크톱 중앙; 640px 미만 하단 / 최대 60dvh |
| `wr-dialog wr-search` | Spotlight 검색 | 상단 12dvh, 모바일 7dvh / 20px 곡률 |
| `wr-dialog wr-dialog--compact` | 간단한 메모·텍스트 입력 | 상단 16dvh / 최대 384px |

공통 순서는 `wr-dialog-header`(원형 닫기 + 제목/설명) → `wr-dialog-body`(스크롤 영역) → `wr-dialog-footer`(동작)입니다. 모바일 시트 좌우 여백은 20px, 하단은 safe-area와 12px 중 큰 값입니다. 긴 본문에서 헤더·푸터를 스크롤 밖에 유지하세요. 고정 도크를 사용하는 앱은 `wr-floating-dock`을 추가하면 모달 동안 숨겨집니다.

원본은 모달별 크기와 동작이 더 다양합니다. 이 키트는 3가지 골격으로 단순화한 참고 구현입니다. 카탈로그의 8개 창은 설정, 검색, 삭제, `#` 이동, 충돌, 메모, 목차, 보조 메뉴 예시입니다. 저장/삭제/이동은 예시 안내만 표시합니다. 강제 확인, 처리 중 취소 차단, 중첩 모달, 비동기 실패 등은 대상 앱의 기존 동작 계약으로 연결합니다.

## React / 다른 플랫폼

React에서는 두 CSS를 앱의 스타일 진입점에서 불러오고 `class`를 `className`으로 바꾸면 됩니다. 열린 상태, 폼 검증, 로딩/실패, 이벤트 핸들러는 대상 앱이 소유합니다. Next.js에서는 프로젝트 버전의 CSS import 가이드를 따라 순서를 유지하세요.

네이티브 앱은 `tokens.json`의 색·곡률·질감을 디자인 값으로 사용하고, CSS의 재질 레이어를 플랫폼 방식으로 재현하세요. 플랫폼에서 blur/mask가 다르면 불투명한 테마 배경을 대체 표면으로 사용하고 실제 화면을 비교합니다.

## 적용 완료 기준

[COVERAGE.md](COVERAGE.md)에서 **대상 프로젝트에 존재하는 화면**을 매핑하고, 없는 기능은 해당 없음으로 기록합니다. 메인 화면뿐 아니라 검색·설정·확인·오류·빈 상태·팝오버·작은 진입 모달을 확인하세요. 390px 모바일과 데스크톱에서 길어진 제목, 스크롤, 키보드 포커스, 비활성/처리 상태를 확인합니다.

원본의 색 혼합을 보존했으므로 모든 조합의 대비를 일괄 인증한 키트는 아닙니다. 대상 앱의 실제 배경 위에서 작은 글자와 상태색을 확인하고, 필요하면 `data-transparency="reduced"`와 대상 CSS의 텍스트/포커스 보정을 사용하세요. 키트는 prefers-reduced-motion과 backdrop-filter 미지원 시 불투명 표면을 지원합니다.

## 원본 갱신

원본 버전과 추출 기준 커밋은 `tokens.json`에 기록되어 있습니다. 원본 저장소에서 다음을 실행하면 색상·질감과 세 가지 메뉴 재질을 다시 추출합니다. 이 명령은 원본 `src/`와 설치된 `tsx`가 있을 때만 사용합니다. 복사한 키트의 실행에는 필요하지 않습니다.

```sh
node --import tsx ui-kit/scripts/sync-tokens.mjs
```

`components.css`의 레시피·기하·상호작용과 `COVERAGE.md`는 자동 갱신되지 않습니다. 원본 `globals.css`, 공통 헤더, 대표 모달을 비교해 함께 갱신하세요. Pretendard를 재배포할 때는 `assets/Pretendard-OFL.txt`를 보존합니다.
