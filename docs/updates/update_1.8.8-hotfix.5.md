# Web Reader 1.8.8-hotfix.5 부트스트랩·진단·통계 동기화 방어

작성일: 2026-08-10

기준: [update_1.8.8-hotfix.4.md](./update_1.8.8-hotfix.4.md)

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: 추가 전체 리뷰 finding 구현·`npm run check`·Rules·Playwright 완료. production Chrome 장기 회귀 P3는 1.8.9 Phase A에서 마감

## 목표

저장된 guest의 진입을 외부 인증 callback과 분리하고, 충돌 판단 정보·통계 hydration cursor·시계 표본 비용을 안전하게 보강한다.

## 수용한 finding

- 저장된 guest도 Firebase auth callback이 올 때까지 `LOADING LIBRARY...`에 머물 수 있던 P2
- guest restore continuation과 뒤늦은 인증 owner 전환의 generation 경계가 명확하지 않던 P2
- 충돌 모달이 대상별 현재·원격 값 차이를 보여주지 않고 client 시각을 원격 확정 시각처럼 보이게 하던 P2 UX
- 화면이 작은 기기에서 충돌 모달이 viewport를 넘을 수 있던 P2 UX
- 새 통계 session마다 이미 유효한 clock sample이 있어도 추가 Firestore read를 수행하던 비용 finding
- Firestore에서 가능한 128자 초과 malformed document ID가 로컬 cursor 검증에서 탈락해 hydration을 반복시킬 수 있던 P3

## 구현

- 기억된 guest는 effect 시작 즉시 local owner를 활성화하고 로컬 복원을 시작한다. Firebase callback은 같은 restore promise를 공유하며 generation 검사를 통과한 continuation만 shelf를 확정한다.
- 인증 사용자가 뒤늦게 도착하면 generation을 올리고 owner를 전환해 guest continuation이 새 owner UI를 덮지 못하게 했다.
- 충돌 모달에 대상별 현재 기기/원격 상태 요약을 추가했다. progress는 퍼센트, bookmark는 이름·위치, annotation은 인용·색상·메모, palette는 라벨·의미를 보여준다.
- `occurredAtClient`는 `원격 기기 기록`으로 표시하고 실제 Firestore timestamp가 있을 때만 `서버 반영` 시각을 별도로 표시한다. 덮어쓰기·삭제 가능성을 안내하고 모달에 최대 높이와 내부 스크롤을 적용했다.
- device별 유효한 24시간 clock sample이 없을 때만 create 직후 server timestamp를 다시 읽는다.
- remote document cursor와 quarantine ID의 상한을 Firestore document ID 범위에 맞춘 1,500자로 분리하고, transaction 전 cursor·quarantine 입력을 검증한다.

## 검증

- 128자를 넘는 malformed remote ID가 exact cursor와 quarantine에 유지되는 IndexedDB 테스트
- TypeScript 및 local/statistics 집중 테스트 통과
- production Chrome 반복 실행에서 저장된 guest shelf는 첫 진입에 열렸고 기존 `LOADING LIBRARY...` timeout은 재현되지 않았다.
- 대량 책장 observer가 놓친 경우 1.5초 뒤 명시적 `더 보기` fallback을 노출하고 production 회귀도 두 번째 page까지 진행한다.
- 누적 `npm run check`, Rules 26/26, Chromium/WebKit 14/14 통과
- 그 뒤 기존 장기 selection 회귀에서 headless Chrome compositor/`requestAnimationFrame` 정지가 반복되어 `check:full` 전체 green은 아직 선언하지 않는다.

## 1.8.9로 이관한 항목

- 여러 탭의 통계 sync가 동시에 hydrate/upload하지 않도록 leader lease 또는 Web Locks를 도입하는 작업은 새 교차 탭 protocol이다. 작은 비용 수정으로 위장해 넣지 않고 [update_1.8.9.md](./update_1.8.9.md)의 실기기 전 선행 안정화 항목으로 이관한다.
- production Chrome 장기 회귀의 foreground·animation-frame 수명과 detached Foliate document 진단도 1.8.9 Phase A에서 마감한다.
