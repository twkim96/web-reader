# Web Reader 1.8.33 — EPUB 스크롤 입력 경로 최적화

작성일: 2026-08-23

기준 커밋: `d2a6dc328a56e45b4cc4a57615bdf45d95005ce9`

이전 버전: [1.8.32 메뉴 글래스·온보딩·시각 개편](./update_1.8.32.md)

상위 계획: [1.8.x 전체 계획](./update_1.8.x_plan.md)

## 목표

1.8.32의 기능과 UI를 마감한 상태에서, EPUB 스크롤 모드의 wheel/touch 입력이 브라우저의 비동기 네이티브 스크롤 경로를 사용할 수 있게 한다.

- 일반 스크롤 중에는 취소 가능한 `wheel`·`touchmove` 리스너를 두지 않는다.
- 페이지 모드의 swipe, 메뉴가 열린 동안의 본문 이동 차단, 스크롤 상·하단의 이전/다음 챕터 이동은 유지한다.
- 단순 탭은 상호작용만 기록하고 실제 스크롤·페이지 이동만 진행률 변경 generation을 올린다. 진행률 위치 계산과 저장 debounce 계약은 변경하지 않는다.
- 샘플 EPUB 내용·본문 스타일·글자 크기는 변경하지 않는다.

## 진단 근거

- 샘플 EPUB은 4개 XHTML 장과 일반 텍스트 문단으로 구성되어 파일 자체의 지속 스크롤 부하는 작다.
- Foliate의 스크롤 위치 계산은 입력이 멈춘 250ms 뒤 실행되고, 앱 진행률 저장은 1초 idle 뒤 실행되므로 프레임마다 저장하지 않는다.
- 기존 publication 문서와 Foliate paginator에는 스크롤 모드에서도 `passive: false`인 `touchmove`가 남아 있어 iPad/Safari가 입력마다 JavaScript의 취소 여부를 기다릴 수 있었다.

## 트레이드오프 계약

| 항목 | 처리 |
| --- | --- |
| 스크롤 모드 wheel | passive listener로 전환, Ctrl+wheel 브라우저 확대 허용 |
| 스크롤 모드 Foliate touchmove | passive listener로 전환 |
| 페이지 모드 swipe | 취소 가능한 non-passive touchmove 유지 |
| 메뉴 표시 중 본문 스크롤 차단 | 메뉴가 열린 동안에만 non-passive touchmove를 임시 등록 |
| 상·하단 챕터 이동 | passive single-touch start/move/end 판정, 시작·종료 경계 일치 필수 |
| 상단 rubber-band/scroll chaining | CSS `overscroll-behavior: contain`으로 대체 |
| 챕터 XHTML 교체 순간 | 이번 버전 범위 밖; 구조상 발생할 수 있는 단발성 지연은 별도 계측 |

## Phase 1 — 앱 publication 입력 분리

상태: 완료

- publication 문서 입력 등록을 `useReaderDocumentInput`으로 분리한다.
- 스크롤 모드 wheel은 passive, 페이지 모드 wheel은 기존처럼 취소 가능하게 등록한다.
- passive `touchstart`는 사용자 상호작용과 identifier·시작 좌표만 기록한다. 8px 이상 실제 이동한 첫 `touchmove`에서만 진행률 변경을 표시하고, 실제 저장은 기존 relocate/idle 정책을 따른다.
- 메뉴가 닫혀 있을 때는 blocking touchmove를 제거하고, 메뉴가 열려 있을 때만 본문 이동 차단 listener를 등록한다.
- 장 교체와 컴포넌트 unmount 때 문서 listener를 정리한다.

## Phase 2 — Foliate·경계 이동 최적화

상태: 완료

- Foliate paginator가 `flow` 변경 시 host와 현재 publication 문서의 touch listener를 다시 등록한다.
- `scrolled`에서는 touchmove를 passive로, paginated에서는 non-passive로 유지한다.
- 별도 경계 이동 hook은 passive touchmove로 single-touch identifier를 검증하고, 제스처가 같은 상·하단 경계에서 시작하고 끝날 때만 이전·다음 장을 판정한다. multi-touch와 `touchcancel`은 취소한다.
- 스크롤 컨테이너에 `overscroll-behavior: contain`을 적용한다.

## Phase 3 — 버전·자동검증

상태: 완료

- app/service worker/Foliate runtime을 `1.8.33`으로 맞춘다.
- listener 정책, 페이지 모드 보존, 경계 이동, 진행률 저장과 기존 리더 기능을 검증한다.

## 완료 조건

- 메뉴가 닫힌 스크롤 모드 publication 문서에 앱 소유 blocking touchmove가 없다.
- Foliate touchmove는 스크롤 모드에서 passive, 페이지 모드에서 non-passive다.
- 스크롤 모드 wheel은 passive지만 페이지 모드 wheel/키보드/탭 이동은 기존과 같다.
- 스크롤 모드 Ctrl+wheel은 `preventDefault()`하지 않고 브라우저 확대 정책에 맡긴다.
- 메뉴가 열린 상태에서는 본문 touch 이동이 계속 차단된다.
- 본문 단순 탭·long press 시작은 원격 이동 attempt와 unsaved progress를 취소하지 않고, 8px 이상 실제 이동은 기존 progress generation을 갱신한다.
- 스크롤 최상단·최하단에서 이전·다음 챕터 이동이 유지된다.
- multi-touch·취소 gesture·중간에서 시작해 끝에서 도달한 단일 gesture는 챕터를 넘기지 않는다.
- 진행률은 스크롤 종료 뒤 기존 idle 정책으로 저장되고 연속 입력마다 쓰지 않는다.
- app/service worker/Foliate runtime cache 버전이 `1.8.33`으로 일치한다.

## 자동검증 계획

- `npm run test:formats`
- `npm run test:release`
- `npm run test:epub-sandbox`
- `npm run test:browser:ci`
- `npm run check`
- `git diff --check`

## 실기기 검증 계획

- iPad Safari/PWA에서 샘플 첫 장을 길게 관성 스크롤하고 1.8.32와 체감 비교한다.
- 메뉴 숨김/표시 상태에서 각각 스크롤 허용/차단을 확인한다.
- 첫 장 최상단과 마지막 위치에서 이전·다음 장 경계 제스처를 확인한다.
- 일반 EPUB에서도 한 장 내부 지속 스크롤과 장 교체 순간을 나눠 확인한다.

## 자동검증 결과

- `npm run check`: 통과
  - ESLint 오류 0건, 기존 경고 4건
  - TypeScript, 전체 Node 회귀, Next.js production build 통과
- `npm run test:epub-sandbox`: Chromium/WebKit 30건 통과
  - 페이지 이동 lock, section boundary, scroll flow 전환, range annotation과 publication sandbox 계약 유지
- `npm run test:browser:ci`: 통과
  - 실제 샘플 EPUB 열기, scroll/paginated 왕복, 본문 탭·메뉴, 선택·진행률, service worker `pc-reader-v1.8.33` 확인
- 입력 정책 집중 회귀: 통과
  - 스크롤 wheel passive·Ctrl+wheel 확대 허용, 메뉴 닫힘 touchmove blocker 없음, 메뉴 표시 중 blocker 유지
  - touchstart 상호작용/8px 실제 이동 progress 분리, Foliate scrolled touchmove passive, paginated touchmove 취소 가능 확인
  - boundary hook의 single-touch identifier·시작/종료 경계·touchcancel 계약과 overscroll containment 확인
- `git diff --check`: 통과

### 2026-08-24 리뷰 보정 재검증

- `npm run check`: 통과 — ESLint 오류 0건·기존 경고 4건, TypeScript, 전체 Node 회귀, production build 통과
- `npm run test:rules`: Firestore Rules 32건과 metadata store emulator 3건 통과
- `npm run test:epub-sandbox`: Chromium/WebKit 30건 통과
- 입력 정책 집중 회귀: 통과 — tap/8px 이동 분리, Ctrl+wheel, single-touch identifier·시작/종료 경계·cancel 계약 포함
- Firestore Admin 저장 시 크롤러가 제공하지 않은 `coverUrl`·장르·태그·권수 필드는 `undefined` 대신 스키마가 허용하는 `null`로 정규화한다.
- Firebase 최초 인증 콜백이 오지 않고 확인된 사용자도 없으면 3초 뒤 로컬 게스트 책장을 복원한다. 늦게 도착한 실제 인증 콜백은 기존 owner generation 전환으로 다시 수렴한다.
- GitHub Actions `browser-regression`은 Firebase 가짜 설정의 게스트 책장 bootstrap부터 PNG clipboard·TXT 선택을 포함한 production browser 장거리 회귀까지 통과했다.
- WebKit 장 경계 회귀는 이전 장 relocation이 시작된 뒤 현재 장으로 되돌아오는지만 검사해, 전환 직전의 정상적인 outgoing relocation을 실패로 오인하지 않는다.
- 위 WebKit 장 경계 회귀는 동일 조건 5회 반복에서도 모두 통과했다.

## 실기기 검증 상태

핵심 자동검증 완료. iPad Safari/PWA의 관성 스크롤 체감·장 경계 제스처와 production 장거리 회귀 재완주는 배포 후 진행한다.

## 2026-08-26 그리드·리더 하단 UI 후속 패치

- 그리드 카드는 모바일 1열·태블릿/PC 2열의 가로형 카드로 바꾸고, 큰 세로형 표지를 좌측 높이에 가득 채운다. 우측 정보 열은 `확장자 → 제목 → 태그 → 진행률` 순서로 정리한다.
- 조회수는 확장자 행의 우측 보조 정보로 유지하고, 마지막 읽은 시각·진행률 초기화·진행률 퍼센트도 기존 기능을 보존한다.
- 리더 최하단의 현재 제목과 읽은 퍼센트는 굵은 `font-black` 대신 얇은 `font-normal`을 사용한다. 위치·크기·진행률 이동 버튼 동작은 바꾸지 않는다.
- production browser 회귀는 2열·136×208px 표지와 우측 정보 순서, 표지·진행률 하단 정렬을 새 레이아웃 계약으로 검증한다.
- WebKit CI가 느린 환경에서도 publication sanitizer의 sandbox frame 보안 검증이 비결정적으로 실패하지 않도록, 검증 조건은 유지한 채 frame load 대기 한도만 15초로 보강한다.
- 리더 최하단의 현재 제목은 본문 글꼴을 상속하지 않고 Pretendard 고딕(`font-sans`)을 명시적으로 사용한다. 기존 크기·위치·얇은 굵기는 유지한다.
- 책장 상단 상태명은 `Guest Library`·`Local Library`·`Cloud Library`를 유지하되 전체 대문자 강제 스타일을 제거하고 `font-normal`로 가볍게 표시한다.
- 상단 상태 아이콘은 포인트색 버튼 배경·테두리·그림자를 없애고 테마 글자색의 아이콘만 남긴다. 축소된 아이콘 영역에 맞춰 상태명을 왼쪽으로 당기며, 이메일·`Guest User`도 대문자 강제 없이 얇은 굵기로 표시한다.
- 배경 없이 표시되는 상단 상태 아이콘은 제목과의 시각적 균형을 위해 24px에서 28px로 키운다.
- 배경이 사라진 상태 아이콘의 작은 클릭 영역을 보완하도록 `아이콘 + 라이브러리명 + 계정명` 전체를 하나의 터치 영역으로 묶는다. 동기화 취소 버튼은 별도 영역을 유지한다.
- 상단 상태 아이콘은 배경 없는 형태를 유지하면서 포인트 컬러로 표시해 제목·계정 정보와 시각적으로 구분한다.
- 모바일 책장 헤더는 안전 영역 아래 여백을 32px에서 16px로 줄여 상태 아이콘과 화면 상단 사이의 불필요한 공간을 줄인다. 데스크톱 간격은 유지한다.
- 모바일 정렬·보기 아이콘의 40px 터치 영역 안쪽 여백을 고려해 첫 그리드 카드까지의 콘텐츠 여백을 8px로 광학 보정한다. 터치 영역과 데스크톱 콘텐츠 상단 여백은 유지한다.
- 모바일 책장 상태 제목을 18px에서 19px로 키우며 데스크톱 크기는 유지한다.
- 책장 보기 모드를 `심플 → 그리드 → 리스트` 세 단계로 확장하고 심플을 새 기본값으로 지정한다. 기존 보기 설정과 분리된 `shelf_viewMode_v2`에 선택값을 저장한다.
- 심플 보기는 카드 배경 없이 세로 표지를 크게 배치하고, 아래에 `로컬·장르·확장자`, 두 줄 제목, `지우개·진행률 | 최근 읽은 월.일.`만 표시한다. 모바일 2열에서 시작해 화면 폭에 따라 최대 5열까지 확장한다.
- 라이브러리 주석과 독서 통계 모달 표면에 현재 활성 테마 CSS 변수를 직접 주입해 초기 기본 테마나 다른 뷰의 변수를 상속하지 않도록 한다. 독서 통계의 포인트 컬러 변수는 그대로 유지한다.
- 책장 상단 `Library` 제목 굵기를 `font-normal`에서 `font-medium`으로 한 단계 높인다.
- 심플 모드의 큰 자동 생성 표지에 맞춰 표지 제목을 모바일 14px, 넓은 화면 15px로 확대한다. 기존 그리드·리스트·도서 정보 표지는 변경하지 않는다.
