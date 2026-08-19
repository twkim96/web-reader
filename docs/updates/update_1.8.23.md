# Web Reader 1.8.23

## 목표

1.8.22 이후 iPad Safari 기반 리더 메뉴의 진행바에서 두 가지 입력 차이를 확인했다.

1. 트랙의 다른 위치를 한 번 탭하면 Android/PC에서는 즉시 이동 확인 모달이 뜨지만 iPad에서는 두 번 탭해야 했다.
2. Android/PC에서는 트랙의 어느 위치에서든 누른 뒤 드래그할 수 있지만 iPad Safari는 native range thumb의 현재 위치에서 시작해야만 드래그됐다.

1.8.23은 진행바 pointer 입력을 native `<input type="range">` hit-test/change 순서에 의존하지 않도록 통일한다.

## 원인

기존 구현은 다음 순서였다.

- `pointerdown`에서 시작 위치 저장
- native range의 `change`에서 목표 진행률 preview 저장
- `pointerup`에서 preview 값을 commit해 이동 확인 모달 생성

Safari의 range control은 트랙 탭/드래그 동작과 `change` 시점이 Chromium과 다를 수 있다. 특히 `pointerup` 시점에 아직 preview ref가 비어 있으면 첫 탭은 commit할 값이 없고, 이후 native change가 들어온 다음 두 번째 탭에서 모달이 생성될 수 있다. 또한 native range 자체가 트랙 임의 위치에서 drag 시작을 보장하지 않는다.

## 수정

- 진행바의 실제 pointer hit area를 별도 투명 layer로 만든다.
- `pointerdown`, `pointermove`, `pointerup`의 `clientX`를 트랙의 `getBoundingClientRect()`에 직접 대응해 0~100% 진행률을 계산한다.
- 0.1% step으로 반올림하며 범위를 벗어난 좌표는 0/100%로 clamp한다.
- `pointerdown`에서 즉시 preview를 기록하므로 같은 gesture의 `pointerup`에서 바로 이동 확인 모달을 생성할 수 있다.
- pointer capture를 사용해 thumb가 아닌 임의 트랙 위치에서 시작한 drag도 트랙 바깥까지 연속 추적한다.
- `touch-action: none`, selection/touch-callout 억제로 iPad의 scroll/long-press 기본 제스처와 충돌하지 않게 한다.
- native `<input type="range">`는 pointer hit-test에서는 제외하지만 그대로 유지해 키보드/접근성 range semantics와 기존 key/change 처리 경로를 보존한다.
- TOC 버튼 영역은 pointer track에서 제외하므로 기존 우측 목차 버튼 hit area는 유지한다.

## 검증

- 진행률 좌표 계산 단위 테스트
  - 트랙 시작/중앙/소수 step/범위 밖 clamp/0-width 방어
- React + LinkeDOM 통합 회귀
  - 현재 위치 20%에서 트랙 72%를 한 번 탭하면 즉시 72% pending move 생성
  - 현재 thumb가 아닌 18% 지점에서 pointerdown 후 86%로 drag하면 86% pending move 생성
  - native range가 pointer hit-test에서 제외되고 custom track에 `touch-action: none`이 적용됨을 확인
- `npm run typecheck` 통과
- `npm run test:formats` 64/64 통과
- `npm run test:shelf-ui` 9/9 통과
- Service Worker Playwright Chromium/WebKit 4/4 통과
- 전체 `npm run check` 통과
  - storage 305건
  - shelf 111건
  - shelf-ui 9건
  - SW/release/publisher 및 production Next.js build 통과

`test:browser:ci`는 이번 변경과 무관한 기존 도서 정보 PNG clipboard proof 단계에서 먼저 timeout되어 진행바 회귀 지점까지 도달하지 못했다. 해당 선행 fixture 실패는 진행바 구현 검증과 분리한다.

## 버전/캐시

- 앱 버전: `1.8.23`
- Service Worker cache: `pc-reader-v1.8.23`
- Foliate paginator 자체는 1.8.23에서 변경하지 않아 runtime revision은 `1.8.22.1`을 유지한다.
