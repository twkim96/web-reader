# Web Reader 1.8.0 텍스트 선택 기반

작성일: 2026-07-30

기준 커밋: `b98c659`

상위 계획: `update_1.8.x_plan.md`

상태: 개발·독립 리뷰·자동검증 완료, 실제 iPad Safari/PWA 검증 대기

## 목표

기존 페이지·좌우·전체 방향 탭 이동과 스크롤 읽기를 유지하면서 reflow EPUB/TXT 본문을 길게 누르거나 드래그해 선택할 수 있게 한다. 선택 범위 근처에 이후 하이라이트·번역·TTS가 함께 사용할 액션 메뉴 기반을 만들고, 이번 버전에서는 복사와 시스템 공유만 제공한다.

고정 레이아웃 PDF·archive의 확대·이동 overlay는 유지하고 텍스트 선택 기능을 표시하지 않는다. IndexedDB, Firestore, 진행률과 책갈피 schema는 변경하지 않는다.

## 리뷰 판정

| 항목 | 판정 | 1.8.0 처리 |
| --- | --- | --- |
| 비스크롤 모드의 전체 화면 interaction overlay가 iframe 선택을 차단 | 수용 | reflow 문서는 문서 이벤트로 탭 이동을 처리하고 overlay를 제거 |
| 선택이 생성된 뒤 click이 페이지 이동이나 controls toggle 실행 | 수용 | selection gesture와 non-collapsed range가 만든 click을 억제 |
| paginator touchmove가 선택 손잡이 이동도 page swipe로 처리 | 수용 | 활성 텍스트 selection에서는 paginator swipe·snap을 중단 |
| iframe range 좌표와 parent viewport 좌표 불일치 | 수용 | frame rect와 실제 client 크기로 selection rect를 변환 |
| 선택 메뉴가 viewport·safe area 밖으로 나감 | 수용 | 실제 메뉴 크기 측정 후 위·아래 반전과 좌우 clamp |
| 기본 브라우저 selection 기능 제거 | 제외 | native selection·callout은 fallback으로 유지 |
| PDF·archive 텍스트 선택 | 제외 | fixed-layout interaction과 zoom/pan 계약 유지 |
| 하이라이트·메모·번역·사전·TTS | 제외 | 후속 1.8.x 범위로 유지 |
| IndexedDB·Firestore·책갈피 변경 | 제외 | 1.8.0은 비영속 selection UI만 변경 |

### Web GPT 1차 코드 리뷰 finding 처리

| 등급 | finding | 판정 | 처리 |
| --- | --- | --- | --- |
| P1 | 일반 본문 tap의 collapsed `selectstart`를 selection gesture로 오인 | 수용 | `selectstart` 기반 억제를 제거하고 실제 non-collapsed `selectionchange`만 suppression 근거로 사용 |
| P2 | native selection 페이지 경계 이동이 `page`·`anchor` relocate로 전달되어 range가 지워짐 | 수용 | Foliate에 `selection-page`·`selection-anchor` reason을 추가하고 앱에서 selection relocate의 clear·save를 생략 |
| P2 | 1.8 앱이 구형 active Service Worker의 1.7.10 Foliate runtime cache와 혼합될 수 있음 | 수용 | Foliate entry URL을 1.8.0으로 versioning하고 reader 초기화 전에 이전 `pc-reader-*` cache의 `/foliate-js/` entry만 제거 |
| P3 | 메뉴 버튼 실제 hit target이 40px | 수용 | 복사·공유·닫기를 모두 최소 44×44px로 확대 |
| P3 | 복사·공유 문자열에 `trim()`을 저장해 selection 원문이 바뀜 | 수용 | 유효성 검사에만 trim을 쓰고 action payload에는 raw selection 문자열을 보존 |

실제 iPad에서만 판정 가능한 long-press 초기 touchmove, safe area, native callout 중첩, Safari clipboard/share 권한은 코드 finding으로 단정하지 않고 실기기 검증 항목으로 유지한다.

### Web GPT 2차 코드 리뷰 finding 처리

| 등급 | finding | 판정 | 처리 |
| --- | --- | --- | --- |
| P2 | selection relocate의 UI CFI가 Service Worker 업데이트 전 강제 progress flush에 저장될 수 있음 | 수용 | UI 위치와 마지막 저장 가능 위치를 분리하고, selection reason은 저장 경계에서도 제외. pending 일반 relocate는 기존처럼 우선 저장 |
| P3 | Cache API 일시 실패 뒤 rejected Foliate 준비 promise가 페이지 수명 동안 재사용됨 | 수용 | 실패한 준비 promise를 초기화해 다음 책 열기에서 cleanup부터 재시도하고, 동시 호출은 기존처럼 single-flight 유지 |
| P3 | 병렬 `npm run test:e2e`가 실행마다 다른 timeout으로 릴리스 게이트 재현성이 낮음 | 수용 | 기본 E2E 릴리스 명령을 `--workers=1`로 직렬화하고 동일 checkout에서 반복 검증 |

진행률 수정은 저장 우회 조건 하나만 막는 방식이 아니라 저장 가능한 위치를 별도 ref로 관리했다. 모든 일반 relocate는 `skipNextSaveRef`와 `hasUnsavedUserChangeRef` 검사 전에 이 기준 위치를 갱신하고, `selection-page`·`selection-anchor`는 기준 위치를 바꾸지 않는다. 따라서 위치 A에서 selection으로 B까지 이동한 뒤 강제 flush해도 A를 저장하고, 이후 일반 이동 C가 발생하면 C를 저장한다.

## 선택·탭 우선순위 계약

1. fixed-layout PDF·archive는 기존 전체 화면 interaction overlay와 zoom/pan을 유지한다.
2. reflow EPUB/TXT는 iframe document가 pointer·touch·selection event를 직접 받는다.
3. non-collapsed selection 또는 selection gesture 직후 click은 탐색과 controls toggle을 실행하지 않는다.
4. 일반 click만 iframe 좌표를 top viewport 좌표로 변환해 기존 tap-zone 정책에 전달한다.
5. 내부·외부 링크 click은 selection 메뉴가 없을 때 기존 Foliate link 처리를 유지한다.
6. selection 중 paginator의 touch swipe와 touchend snap은 실행하지 않는다.
7. 일반 wheel·keyboard·tap 이동과 panel open에서는 stale selection menu를 정리한다.

## 복사·공유 정책

- 복사는 `navigator.clipboard.writeText`를 우선하고, 지원되지 않으면 임시 textarea fallback을 사용한다.
- 복사 성공 뒤 selection은 유지하고 액션 메뉴에서 성공 상태를 보여 준다.
- 공유는 `navigator.share`가 있는 환경에서만 표시한다.
- 사용자가 공유를 취소한 경우 오류 알림을 표시하지 않는다.
- 공유 성공 뒤에도 selection을 유지한다.
- 닫기, 바깥 탭, 실제 reader navigation에서는 selection과 메뉴를 함께 정리한다.

## Phase 1 — selection adapter와 탐색 억제

상태: 완료

- loaded publication document마다 selection lifecycle listener를 설치한다.
- document가 교체·unload되거나 reader가 닫힐 때 listener와 timer를 제거한다.
- range text와 visible client rect를 검증하고 top viewport anchor로 변환한다.
- reflow paged mode의 interaction overlay를 제거하고 일반 document click을 기존 tap action으로 전달한다.
- selection gesture click, link click과 일반 tap을 구분한다.
- paginator의 active-selection touchmove·touchend를 swipe와 snap에서 분리한다.

완료 조건: 네 탐색 모드에서 일반 tap은 기존 동작을 유지하고, selection 중에는 page navigation과 controls toggle이 발생하지 않는 자동·브라우저 회귀 통과.

## Phase 2 — 액션 메뉴·복사·공유

상태: 완료

- 선택 범위의 visible rect 근처에 parent document 메뉴를 표시한다.
- 메뉴 실제 크기와 visual viewport를 기준으로 좌우 clamp와 위·아래 반전을 적용한다.
- 복사·공유·닫기 action을 제공한다.
- 메뉴 자체 pointer/click이 reader navigation으로 전파되지 않게 한다.
- 성공·실패 상태는 짧은 live status로 제공한다.

완료 조건: PC Chrome과 mobile viewport에서 메뉴가 화면 밖으로 벗어나지 않고 복사·공유 지원 상태와 취소 처리가 정확함.

## Phase 3 — 회귀 테스트와 1.8.0 릴리스 정리

상태: 완료

- selection 좌표·tap suppression pure policy 테스트를 추가한다.
- Foliate sandbox E2E에 selection event와 paginator swipe 억제 회귀를 추가한다.
- production browser regression에서 reflow paged selection, 메뉴, copy와 일반 tap navigation을 검증한다.
- 기존 fixed-layout zoom·pan·tap overlay 회귀를 유지한다.
- package/lockfile, Service Worker cache, release test와 browser fixture를 1.8.0으로 통일한다.
- lint, typecheck, Node 전체 테스트, build, Rules, Playwright Chromium/WebKit, production Chrome regression을 실행한다.

완료 조건: `npm run check:full`, release consistency와 targeted browser regression 통과.

## Phase 4 — 독립 리뷰와 Web GPT 협업

상태: 완료

- Codex가 `b98c659..HEAD`와 uncommitted 1.8.0 전체 변경을 독립 리뷰한다.
- Business Web ChatGPT의 관련 Project에서 새 리뷰 chat을 만든다.
- chat 제목은 `2026-07-30 | Web Reader 1.8.0 선택 리뷰`로 지정한다.
- 가용한 고성능 model과 `매우 높음` reasoning을 visible UI에서 확인한다.
- 목표, baseline, 전체 diff, 관련 코드, 테스트 증거와 미해결 질문을 제공한다.
- 각 finding을 현재 코드·재현·테스트로 검증하고 수용·기각·보류를 기록한다.
- 이견이 있으면 같은 chat에서 증거를 주고 재검토하며, 최대 세 번 뒤에도 남으면 사용자 결정 대상으로 남긴다.
- 수정 뒤 전체 diff와 검증 결과를 같은 chat에 보내 최종 리뷰를 받는다.

완료 조건: Codex와 Web ChatGPT 사이에 제품 코드 기준 중요 finding이 남지 않고 수정 후 검증이 통과함. 실제 iPad 검증은 별도 실기기 gate로 유지.

## 자동검증 계획

- 변경 파일 ESLint
- `npm run typecheck`
- selection·navigation focused Node tests
- `npm run test:node`
- `npm run build`
- `npm run test:rules`
- `npm run test:e2e`
- `npm run test:browser:ci`
- `git diff --check`

## 실기기 테스트 계획

- PC production Chrome
- iPad Safari browser tab
- iPad home-screen PWA
- `scroll`, `page`, `left-right`, `all-dir`
- 단어·문장·여러 문단·페이지 경계 selection
- 선택 손잡이 이동 중 page turn 억제
- 화면 상하단·좌우단과 회전 뒤 메뉴 위치
- 복사·공유·공유 취소
- toolbar·status bar·modal과의 중첩
- fixed-layout PDF·archive zoom/pan/tap 회귀

## 구현 결과

- reflow EPUB/TXT에서 전체 화면 tap overlay를 제거하고 iframe document가 native text selection과 일반 tap을 함께 처리한다.
- 일반 본문 실제 click은 collapsed `selectstart`가 발생해도 navigation/controls로 전달되고, 실제 non-collapsed selection과 그 직후 click만 억제한다.
- 선택 range를 top viewport로 변환해 44px action의 복사·공유·닫기 메뉴를 배치하며 선택 원문 공백과 줄바꿈을 보존한다.
- Paginator touch swipe·snap과 selection을 분리하고 `selection-page`·`selection-anchor` 이동은 range와 progress save를 건드리지 않는다. 같은 spine document의 페이지 경계만 자동 이동하며 document 경계를 넘는 native selection은 시도하지 않는다.
- Foliate entry를 `/foliate-js/view.js?v=1.8.0`으로 고정하고, 현재 release cache는 보존하면서 이전 release cache의 Foliate entry만 reader 초기화 전에 삭제한다.
- Cache API cleanup이 일시 실패하면 해당 open은 fail-closed로 유지하되 rejected 준비 상태를 폐기해 같은 페이지의 다음 open에서 다시 시도한다.
- selection relocate가 갱신하는 UI 위치와 progress 저장 기준을 분리해 Service Worker의 강제 flush도 마지막 non-selection 위치만 저장한다.
- fixed-layout PDF·archive overlay와 zoom/pan, 기존 수동·자동 책갈피, IndexedDB·Firestore schema는 변경하지 않았다.

## 자동검증 결과

- 변경 파일 ESLint: 오류 0. 기존 vendor warning 2개만 유지.
- `npm run typecheck`: 통과.
- `npm run test:node`: 통과. formats 55/55, storage 81/81 포함. selection 저장 기준 2개와 Foliate 준비 재시도·single-flight 2개를 추가했다.
- `npm run build`: production build 통과.
- `npm run test:rules`: 9/9 통과.
- `npm run test:e2e` 기본 직렬 게이트: 독립 2회와 `check:full` 내부 1회, 총 3회 연속 Chromium/WebKit 10/10 통과. 두 엔진에서 `selection-page`와 `selection-anchor` reason 확인.
- `npm run test:browser:ci`: 통과. 실제 CDP mouse 입력의 `selectstart(collapsed)` 순서에서 본문 tap 2회가 controls를 각각 한 번만 toggle하고 페이지 위치를 유지함.
- production browser에서 구형 Foliate sentinel 제거, versioned entry, 44×44px action 3개, 앞뒤 공백을 포함한 copy/share 원문 일치, 기존 7z/PDF/fixed-layout/SW 회귀를 확인.
- `git diff --check`: 통과.
- 1차 수정 당시 `npm run check:full` 한 번은 마지막 production browser가 기능 진입 전 게스트 Firebase bootstrap `LOADING LIBRARY...`에서 시간 초과했고 즉시 단독 재실행은 통과했다.
- 2차 리뷰 수정 뒤 기본 E2E를 직렬화한 `npm run check:full`은 lint, typecheck, Node 전체, build, Rules 9/9, Playwright 10/10, production Chrome regression까지 한 번에 통과했다. lint에는 기존 vendor warning 2개만 남아 있다.

## 실기기 검증 결과

자동화된 Desktop WebKit과 production Chrome 검증은 완료했다. 실제 iPad Safari browser tab과 home-screen PWA는 아직 미검증이며 다음을 확인해야 한다.

- 2026-07-31 Android 휴대폰 브라우저에서 텍스트 선택 시 브라우저 native 선택 툴바와 Web Reader 메뉴가 동시에 표시되는 것을 확인했다. 선택 손잡이를 유지하면서 native UI를 웹이 완전히 통제할 수는 없으므로 1.8.1 working tree에서 WebKit callout 억제와 선택 중 `contextmenu.preventDefault()`를 함께 적용했고 같은 기기 재검증을 대기한다.

- controls가 열린 상태의 long-press 시작과 첫 selection handle 이동
- 페이지 상·하단 경계 selection과 같은 spine document 안의 자동 page 이동
- 회전·주소창 축소·standalone safe area에서 메뉴 위치
- Safari native callout과 자체 메뉴 중첩
- clipboard 권한 실패, share 취소와 share sheet 복귀 뒤 selection 유지

## Web GPT 리뷰 결과

- workspace: `Space Business`
- Project: `web-reader`
- chat: `Web Reader 코드 리뷰`
- visible model/reasoning: `GPT-5.6 Sol`, `매우 높음`
- 1차 판정: P1 1건, P2 2건, P3 2건을 모두 코드 근거와 재현 경로로 수용해 수정했다.
- 2차 판정: 기존 finding 5건 수정 확인. 새 P2 1건과 P3 2건을 실제 코드 경로와 재현 가능성에 따라 모두 수용해 수정했다.
- 2차 수정: selection 위치의 강제 flush 차단, 실패한 Foliate 준비의 재시도, 기본 E2E 직렬화와 회귀 테스트 추가.
- 최종 판정: 제품 코드 기준 P0~P2 신규 finding 없음. 이전 P2 1건과 P3 2건이 의도대로 수정됐음을 확인했다.
- Web GPT 환경에서는 production browser regression이 selection 진입 전 `LOADING LIBRARY...` guest shelf timeout으로 2회 실패했다. auth/shelf 코드는 이번 scope에서 변경하지 않았고 같은 checkout의 Codex `check:full` 및 production Chrome regression은 통과했으므로 제품 회귀가 아닌 release-gate 진단성 P3로 기록한다.
- 남은 작업: 실제 iPad Safari browser tab과 home-screen PWA 검증. guest bootstrap timeout 진단 개선은 selection 1.8.0 제품 코드의 차단 finding으로 보지 않고 후속 테스트 인프라 정리 대상으로 유지한다.

## 보류·후속 버전

- 1.8.1: local range annotation과 5색 하이라이트
- 1.8.2: 메모·팔레트·주석 관리 UI
- 1.8.5: 번역·사전 action
- 1.8.6: 선택·현재 위치 기본 TTS
