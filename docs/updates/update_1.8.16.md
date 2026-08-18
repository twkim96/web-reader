# Web Reader 1.8.16 — 반응형 UI 정리

작성일: 2026-08-18

기준 커밋: `4e08dab`

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

이전 버전: [update_1.8.15.md](./update_1.8.15.md)

상태: Phase A Muzio mini-player형 책장 dock 구현·자동검증 완료, 실제 Android/iPad/PWA 확인 대기

## 목표

1.8.15에서 추가된 정보 밀도를 유지하면서 책장·모달·리더 chrome의 시각적 무게와 모바일 배치를 정리한다. 책장 dock은 Muzio의 실제 mini-player 색상·곡률·테두리·blur·shadow 계약을 Web Reader 테마에 맞게 이식한다.

## 사용자 확정 계약

- 책장 메뉴는 Muzio mini-player처럼 PC에서 `rounded-full`, 모바일에서 `rounded-2xl`을 사용한다.
- 표면은 Muzio처럼 앱 본문과 같은 surface token에 88% 불투명도를 적용한다. Web Reader에서는 현재 theme background RGB를 그대로 사용한다.
- 테두리·그림자도 Muzio의 light `zinc-200/35`·`black/10`, dark `white/4.5%`·`black/35` 값을 사용한다.
- 메뉴와 화면 최하단 사이에는 별도 여백을 두고 `safe-area-inset-bottom`을 추가한다.
- iPad·desktop 상단 메뉴는 `LOCAL/CLOUD LIBRARY` 헤더와 같은 행에 두고, 높이가 다른 로고 버튼과 capsule의 아래쪽 끝을 맞춘다.
- Android나 blur 미지원 브라우저에서도 모든 버튼이 정상 동작하고 같은 theme surface가 남아야 한다.
- 일반 메뉴 아이콘은 theme text 색상을 상속하고, 기존보다 조금 높은 84% 불투명도로 표시한다.
- 아이콘 순서, 필터·검색·통계·추가·테마·관리 동작과 모바일 layout control 분리는 변경하지 않는다.

## Phase A — Muzio mini-player형 floating dock

상태: 구현·자동검증 완료, 실기기 확인 대기

- `ShelfHeader`의 상단/하단 dock surface를 공통 `shelf-muzio-dock`으로 통일한다.
- Muzio의 responsive radius, surface, border, 2xl shadow와 24px blur를 적용한다.
- Web Reader의 dark/light/sepia/blue/custom theme background를 88% surface로 사용하고, 명암 판정은 Muzio의 light/dark border·shadow 선택에만 사용한다.
- 하단 간격은 mobile 20px, iPad/desktop 폭 24px에 기기 safe area를 더한다.
- iPad·desktop의 top dock은 고정 화면 좌표가 아니라 header flex 행의 오른쪽에 배치한다. iPad 폭에서는 44px action과 좁은 gap을 사용하고 넓은 desktop에서 48px로 확장한다. 66px capsule은 48px 로고 버튼보다 18px 높으므로 9px 위로 보정해 아래쪽 끝을 일치시킨다.
- 320px 회귀에서 버튼 수, overflow, capsule radius와 shadow를 검증한다.

완료 조건:

- dark/light/custom theme에서 text와 border 대비가 유지된다.
- scroll에 따른 top dock ↔ bottom dock 전환에서 위치가 튀거나 action이 사라지지 않는다.
- iPad Safari와 Android Chrome에서 시각 차이는 허용하되 기능·safe area는 동일하다.

## Phase B — 책장 list/grid 밀도

상태: 대기

- 제목·tag·시간·조회수의 정렬과 긴 문자열 overflow를 mobile/tablet/desktop별로 재점검한다.
- list 한 줄 tag와 grid 다중 tag가 카드 높이를 불필요하게 키우지 않게 한다.
- metadata가 늦게 join될 때 layout transition과 scroll 안정성을 확인한다.

## Phase C — filter·정보창 modal

상태: 대기

- 모바일 modal의 상단 여백, 최대 높이, sticky action과 15개 tag pagination을 다듬는다.
- 작품 정보·장르·전체 tag 통합 카드의 구분선과 밀도를 정리한다.
- keyboard, rotation, backdrop close와 내부 scroll을 함께 검증한다.

## Phase D — reader chrome

상태: 대기

- reader toolbar, TTS panel, progress/status와 selection menu의 surface·간격을 통일한다.
- Safari browser chrome 및 PWA safe area와 겹치지 않게 한다.
- navigation tap zone과 text selection event 계약은 변경하지 않는다.

## Phase E — release gate

상태: 대기

```bash
npm run check:full
git diff --check
```

실기기:

- Android Chrome portrait/landscape
- iPad Safari portrait/landscape
- iPad 홈 화면 PWA
- 320px narrow viewport와 desktop
- dark/light/custom theme, 투명도 감소 설정

## 구현 결과

- Phase A는 UA 분기 없이 theme CSS variable과 CSS blur를 사용한다.
- 메뉴 위치·끝단 정렬과 아이콘 강조색은 Web Reader 계약을 유지하고, surface와 radius만 Muzio mini-player를 따른다.
- Service Worker와 Foliate app cache release version을 1.8.16으로 올리되 Foliate runtime revision과 metadata crawler version은 코드가 바뀌지 않아 유지한다.

## 자동검증 결과

- 통과: `npm run lint`(기존 Foliate warning 2건), `npm run typecheck`, `npm run test:release` 3건, `npm run test:shelf-ui` 8건, `npm run test:shelf` 106건, `npm run test:sw`, `npm run build`, `npm run test:browser:ci`.
- Service Worker lifecycle Chromium/WebKit 4건을 별도로 통과했다.
- 768×1024 viewport에서 dock 426px, 가로 overflow 0을 확인했다. 후속 시각 보정은 capsule을 9px 위로 올려 48px 로고 버튼과 아래쪽 끝을 맞춘다.
- 390×844 viewport에서 bottom dock은 폭 374px·높이 68px, 하단 gap 20px, visible action 6개, 가로 overflow 0이었다.
- Chromium 기반 자동 시각 검증에서 Web Reader dark theme surface `rgba(39,39,40,0.88)`, mobile radius 16px, 24px blur, 2xl shadow와 icon opacity 84%가 적용된 것을 확인했다. 실제 iPad Safari와 Android Chrome의 렌더링은 실기기 gate로 남긴다.
