# Web Reader 1.8.10 hotfix.10 — 명시적 완료·재독 회차 전환

작성일: 2026-08-13

기준 커밋: `2acdbf6`

상위 문서: [update_1.8.10.md](./update_1.8.10.md)

상태: 구현·전체 자동 gate·Firestore Rules 배포 완료. 실기기 확인 대기

## 실사용 finding

독서 session이 진행률 99.5% 이상에서 자동으로 `completed=true`가 되었다. 사용자가 완료를 선택하지 않아도 회차가 닫혀, 100% 부근의 후속 session이나 처음으로 돌아간 기록이 2회차로 잘못 분리되고 1·2회차 모두 완료처럼 보일 수 있었다.

## 변경

### 완료 가능과 완료 확정 분리

- 99% 이상인 최신 미완료 회차에만 `완료` 버튼을 표시한다.
- 99% 도달은 완료 가능 상태일 뿐 회차를 자동으로 닫지 않는다.
- 사용자가 `완료`를 눌러야 `completionConfirmedAtClient`가 있는 immutable 완료 확인 기록을 생성한다.
- 기존 독서 session의 `completed` 자동 생성은 중단한다.
- 과거 앱이 자동 생성한 `completed=true` 기록은 보존하지만 명시 완료로 해석하지 않는다.
- 완료된 행의 `완료` 텍스트는 기존처럼 시작일·종료일 상세를 펼치는 역할을 한다.

### 재독 회차 경계

- 완료 확인 전에는 진행률이 100%에서 99% 미만으로 내려가도 같은 회차를 유지한다.
- 완료 확인 뒤에도 진행률 99~100%의 후속 기록은 닫힌 회차에 포함한다.
- 완료 확인 뒤 처음으로 시작 또는 종료 진행률이 99% 미만인 실제 독서 session이 생길 때만 다음 회차를 시작한다.
- 완료 확인 기록은 원본 session과 같은 시간 구간을 사용하되 overlap dedup으로 독서 시간을 중복 합산하지 않는다.

### 저장·동기화

- 완료 확인은 현재 owner·book·최신 회차를 IndexedDB readwrite transaction 안에서 다시 검증한 뒤 한 번만 추가한다.
- Firebase owner에서는 pending session으로 기존 독서 통계 outbox·lease 동기화 경로를 사용한다.
- guest owner에서는 로컬 완료 상태만 유지한다.
- Firestore Rules는 `completed=true`, 진행률 99% 이상, session 종료 이후의 유효한 확인 시각 조합만 허용한다.
- 리더에서 통계 모달을 열 때 활성 독서 구간을 먼저 확정해 1분 checkpoint를 기다리지 않고 완료 가능 상태를 확인한다.
- Service Worker script를 갱신해 설치형 PWA도 변경을 감지한다.

## 자동검증

- 미확정 `100% → 20%` 독서가 계속 1회차인지 확인한다.
- 99%에서 완료 가능하고 98.9%에서는 완료할 수 없는지 확인한다.
- 명시 완료 뒤 99%대 기록은 기존 회차, 99% 미만 기록은 다음 회차인지 확인한다.
- 완료 확인 마커를 포함해도 독서 시간이 중복 합산되지 않는지 확인한다.
- 같은 회차를 연속 완료 요청해도 완료 마커가 하나만 남는지 확인한다.
- Firestore Rules가 정상 완료 마커를 허용하고 미달 진행률·미완료 플래그·역행 확인 시각을 거부하는지 확인한다.
- production browser에서 99% 회차에만 완료 처리 버튼이 보이고 클릭 후 읽는 중·완료 권수가 갱신되는지 확인한다.
- `npm run check:full`: 통과
- ESLint: 오류 0, 기존 Foliate vendor 경고 2
- TypeScript·production build: 통과
- Node: formats 63/63, drive 49/49, archives 33/33, storage 273/273, shelf 69/69, Service Worker 9/9, release 3/3 — 합계 499/499
- Firestore Rules: 28/28
- Chromium/WebKit Playwright: 14/14
- production Chrome regression: 통과
- production Chrome에서 2회차 99% 완료 버튼, 클릭 후 `0권 읽는 중 · 완료 1권`, 1·2회차 완료 상태 확인
- Firestore Rules: `web-novel-viewer` 배포 완료
- `git diff --check`: 통과

## 실기기 확인

- Android·iPad에서 99%부터 완료 버튼이 보이고 98.9% 이하에서는 보이지 않는지 확인한다.
- 완료를 누르지 않은 채 100%에서 앞부분으로 돌아가 읽어도 1회차 하나로 유지되는지 확인한다.
- 완료를 누른 뒤 99%대에 머무르면 1회차를 유지하고, 99% 미만으로 돌아가 실제 독서가 기록된 뒤에만 2회차가 생기는지 확인한다.
- 완료 상태와 회차 번호가 기기간 동기화되는지 확인한다.
