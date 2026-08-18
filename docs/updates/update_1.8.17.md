# Web Reader 1.8.17 — foreground 원격 진행률 이동 안정화

작성일: 2026-08-18

이전 버전: [update_1.8.16.md](./update_1.8.16.md)

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: 코드 수정·전체 `npm run check`·집중 Chromium/WebKit 회귀 완료, 실기기 재검증 대기

## 배경

Android에서 같은 도서를 Mac과 동시에 열어 둔 뒤 Android를 홈 화면으로 보냈다가 다시 복귀하면 원격 진행률 이동 모달이 나타난다. 모달이 뜨자마자 `이동하기`를 누를 경우 화면이 이동하지 않거나 목표보다 덜 이동하고, 이후 조용히 추가 이동하거나 로컬 화면 위치와 canonical 진행률이 어긋나는 현상이 실기기에서 확인됐다.

## 원인

- Foliate paginator는 페이지 전환 중 `#locked` 상태에서 새 `goTo()` 요청을 받으면 이전에는 결과 없이 반환할 수 있었다.
- 상위 React navigation wrapper는 `false`가 아닌 결과를 성공으로 처리해 `undefined`를 성공으로 오인할 수 있었다.
- 원격 진행률 경로는 canonical progress를 먼저 로컬에 채택하고 viewport를 이동하므로, false-success가 발생하면 저장 상태만 원격 위치로 바뀌고 실제 화면은 이전 위치에 남을 수 있었다.
- foreground 직후에는 ResizeObserver, 폰트, 이미지와 viewport geometry가 재정착하는 중이라 즉시 CFI를 적용하면 후속 reflow가 같은 anchor를 다시 적용하며 추가 이동처럼 보일 수 있었다.

## 수정

- paginator의 locked/invalid `goTo()`는 명시적으로 `false`를 반환한다.
- React navigation wrapper는 `Boolean(result)`로 실제 navigation commit 결과만 성공으로 취급한다.
- paginator에 `waitForNavigationReady()`를 추가한다.
  - 진행 중 page-turn lock이 풀릴 때까지 제한 시간 내 대기한다.
  - 현재 paginated view의 폰트·이미지와 연속 layout frame을 안정화한다.
  - 추가 render/frame을 거쳐 foreground resize가 정착한 뒤에만 ready를 반환한다.
- Foliate view와 hook에 readiness 경계를 노출한다.
- canonical remote adoption 경로는 readiness를 먼저 확인하고, 실패하거나 timeout이면 remote progress를 로컬 canonical 상태에 채택하지 않은 채 retryable cancellation으로 반환한다.
- 일반 목차·검색·수동 이동에는 readiness barrier를 강제하지 않아 기존 navigation latency를 유지한다.
- Foliate runtime revision을 `1.8.17.1`, app/service-worker cache version을 `1.8.17`로 올려 기존 캐시가 수정 전 paginator를 재사용하지 않게 한다.

## 자동검증

- `npm run check` 통과: lint, typecheck, 전체 Node 테스트, publisher 테스트, production build 포함.
- remote progress adoption/prompt 집중 테스트 8건 통과.
- `npm run test:release` 3건 통과.
- `npm run test:formats` 63건 통과.
- Playwright Chromium/WebKit에서 `page turn locked -> programmatic goTo=false -> readiness wait -> 재이동 성공` 회귀 2건 통과.

## 실기기 재검증

1. Android와 Mac에서 같은 도서를 연다.
2. Android를 홈 화면으로 보내고 Mac에서 충분히 앞으로 읽는다.
3. Android 웹/PWA를 다시 foreground로 올린다.
4. 원격 위치 모달이 뜨자마자 `이동하기`를 누른다.
5. 목표 위치로 한 번만 이동하는지 확인한다.
6. 2~3초 동안 추가 조용한 이동이 없는지 확인한다.
7. 한 페이지 넘긴 뒤 Mac 쪽과 revision conflict가 불필요하게 발생하지 않는지 확인한다.
8. 같은 시나리오를 Android Chrome과 설치형 PWA에서 각각 반복한다.
