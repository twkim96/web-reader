# Web Reader 1.8.33 — EPUB 스크롤 입력 경로 최적화

작성일: 2026-08-23

기준 커밋: `d2a6dc328a56e45b4cc4a57615bdf45d95005ce9`

이전 버전: [1.8.32 메뉴 글래스·온보딩·시각 개편](./update_1.8.32.md)

상위 계획: [1.8.x 전체 계획](./update_1.8.x_plan.md)

## 목표

1.8.32의 기능과 UI를 마감한 상태에서, EPUB 스크롤 모드의 wheel/touch 입력이 브라우저의 비동기 네이티브 스크롤 경로를 사용할 수 있게 한다.

- 일반 스크롤 중에는 취소 가능한 `wheel`·`touchmove` 리스너를 두지 않는다.
- 페이지 모드의 swipe, 메뉴가 열린 동안의 본문 이동 차단, 스크롤 상·하단의 이전/다음 챕터 이동은 유지한다.
- 진행률 위치 계산과 저장 debounce 계약은 변경하지 않는다.
- 샘플 EPUB 내용·본문 스타일·글자 크기는 변경하지 않는다.

## 진단 근거

- 샘플 EPUB은 4개 XHTML 장과 일반 텍스트 문단으로 구성되어 파일 자체의 지속 스크롤 부하는 작다.
- Foliate의 스크롤 위치 계산은 입력이 멈춘 250ms 뒤 실행되고, 앱 진행률 저장은 1초 idle 뒤 실행되므로 프레임마다 저장하지 않는다.
- 기존 publication 문서와 Foliate paginator에는 스크롤 모드에서도 `passive: false`인 `touchmove`가 남아 있어 iPad/Safari가 입력마다 JavaScript의 취소 여부를 기다릴 수 있었다.

## 트레이드오프 계약

| 항목 | 처리 |
| --- | --- |
| 스크롤 모드 wheel | passive listener로 전환 |
| 스크롤 모드 Foliate touchmove | passive listener로 전환 |
| 페이지 모드 swipe | 취소 가능한 non-passive touchmove 유지 |
| 메뉴 표시 중 본문 스크롤 차단 | 메뉴가 열린 동안에만 non-passive touchmove를 임시 등록 |
| 상·하단 챕터 이동 | passive touchstart/touchend 거리 판정 유지 |
| 상단 rubber-band/scroll chaining | CSS `overscroll-behavior: contain`으로 대체 |
| 챕터 XHTML 교체 순간 | 이번 버전 범위 밖; 구조상 발생할 수 있는 단발성 지연은 별도 계측 |

## Phase 1 — 앱 publication 입력 분리

상태: 완료

- publication 문서 입력 등록을 `useReaderDocumentInput`으로 분리한다.
- 스크롤 모드 wheel은 passive, 페이지 모드 wheel은 기존처럼 취소 가능하게 등록한다.
- 진행률 변경 표시는 passive `touchstart`에서 시작하고, 실제 저장은 기존 relocate/idle 정책을 따른다.
- 메뉴가 닫혀 있을 때는 blocking touchmove를 제거하고, 메뉴가 열려 있을 때만 본문 이동 차단 listener를 등록한다.
- 장 교체와 컴포넌트 unmount 때 문서 listener를 정리한다.

## Phase 2 — Foliate·경계 이동 최적화

상태: 완료

- Foliate paginator가 `flow` 변경 시 host와 현재 publication 문서의 touch listener를 다시 등록한다.
- `scrolled`에서는 touchmove를 passive로, paginated에서는 non-passive로 유지한다.
- 별도 경계 이동 hook의 blocking touchmove를 제거하고 passive touchstart/touchend만으로 이전·다음 장을 판정한다.
- 스크롤 컨테이너에 `overscroll-behavior: contain`을 적용한다.

## Phase 3 — 버전·자동검증

상태: 완료

- app/service worker/Foliate runtime을 `1.8.33`으로 맞춘다.
- listener 정책, 페이지 모드 보존, 경계 이동, 진행률 저장과 기존 리더 기능을 검증한다.

## 완료 조건

- 메뉴가 닫힌 스크롤 모드 publication 문서에 앱 소유 blocking touchmove가 없다.
- Foliate touchmove는 스크롤 모드에서 passive, 페이지 모드에서 non-passive다.
- 스크롤 모드 wheel은 passive지만 페이지 모드 wheel/키보드/탭 이동은 기존과 같다.
- 메뉴가 열린 상태에서는 본문 touch 이동이 계속 차단된다.
- 스크롤 최상단·최하단에서 이전·다음 챕터 이동이 유지된다.
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
  - 스크롤 wheel passive, 메뉴 닫힘 touchmove blocker 없음, 메뉴 표시 중 blocker 유지
  - Foliate scrolled touchmove passive, paginated touchmove 취소 가능, boundary hook blocking touchmove 제거와 overscroll containment 확인
- `git diff --check`: 통과

## 실기기 검증 상태

자동검증 완료. iPad Safari/PWA의 관성 스크롤 체감과 장 경계 제스처 확인은 배포 후 진행한다.
