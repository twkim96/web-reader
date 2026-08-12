# Web Reader 1.8.10 hotfix.2 — Android 독서 시간 기록 복구

작성일: 2026-08-12

기준 커밋: `938471c`

상위 문서: [update_1.8.10.md](./update_1.8.10.md), [update_1.8.10-hotfix.1.md](./update_1.8.10-hotfix.1.md)

상태: 구현·전체 자동 gate 완료. Android 실기기 확인 대기

## 실사용 finding

Android에서 약 20분 동안 페이지를 읽고 기기 간 통계 동기화도 성공했지만 Android 자체 독서 시간이 전혀 증가하지 않았다. 다른 기기를 함께 열어 둔 것만으로는 설명되지 않는다. 통계는 같은 서버 시각 구간의 실제 독서만 중복 제거하고, 기기별 session 생성 자체는 독립적이다.

## 원인

화면 독서 session은 실제 reader 입력 직후에도 top-level `document.hasFocus()`가 참이어야 시작됐다. Android Chrome과 홈 화면 PWA에서는 주소창·소프트 키보드·publication iframe 포커스 상태에 따라 보이는 문서가 실제 touch를 받고 있어도 이 값이 안정적이지 않을 수 있다.

따라서 다음 조건이 동시에 발생할 수 있었다.

- publication iframe에서 탭 이동과 진행률 저장은 정상 동작한다.
- `pointerdown` 또는 `touchstart`가 독서 tracker에 도착한다.
- 같은 순간 top-level `document.hasFocus()`가 false를 반환한다.
- 화면 독서 session만 시작되지 않아 장시간 사용 뒤에도 통계가 0으로 남는다.

## 수정 계약

- reader에서 캡처한 실제 pointer·touch·wheel·key 입력을 활성 포커스의 직접 증거로 사용한다.
- tracker 초기화만으로는 화면 독서를 시작하지 않고 실제 reader 입력을 기다린다.
- 실제 reader 입력 직후 1초 안의 window `blur`는 publication iframe 포커스 이동으로 보고 focus evidence를 유지한다.
- 최근 reader 입력이 없는 window `blur`는 기존처럼 화면 독서 session을 닫는다.
- `visibilityState=hidden`, panel open, 90초 idle 정책은 그대로 session을 닫는다.
- 단순히 reader가 visible하거나 앱이 foreground로 돌아온 것만으로는 session을 시작하지 않는다.
- TTS는 기존처럼 실제 `playing` 구간만 기록한다.
- 최대 5분 immutable segment, draft recovery, 기기 간 overlap 제거 정책은 변경하지 않는다.
- 서비스 워커 script도 hotfix.2에서 갱신해 기존 Android PWA가 업데이트 대기 상태를 감지하고 안전한 적용·reload 경로를 사용하게 한다.

## 자동검증

- focus false 상태에서도 직접 reader activity가 focus evidence를 복구함
- 실제 입력 직후 iframe focus transfer는 유지하고, 최근 입력 없는 blur는 focus evidence를 제거함
- hidden·panel·90초 idle·TTS 기존 계약 유지
- `npm run check:full`: 통과
- ESLint: 오류 0, 기존 Foliate vendor 경고 2
- TypeScript·production build: 통과
- Node: formats 63/63, drive 49/49, archives 33/33, storage 258/258, shelf 66/66, Service Worker 9/9, release 3/3 — 합계 481/481
- Firestore Rules: 27/27
- Chromium/WebKit Playwright: 14/14
- production Chrome regression: 통과
- `git diff --check`: 통과

## 실기기 검증 대기

- Android Chrome과 홈 화면 PWA에서 탭 이동으로 6분 이상 읽고 책장으로 나간 뒤 Android 자체 통계가 증가하는지 확인한다.
- Android에서 기록된 session이 iPad의 오늘·주간·월간·도서별 통계에도 반영되는지 확인한다.
- 앱 전환이나 화면 잠금 동안 시간이 증가하지 않는지 확인한다.
