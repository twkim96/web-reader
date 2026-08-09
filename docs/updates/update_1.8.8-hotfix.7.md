# Web Reader 1.8.8-hotfix.7 통계·이동 재시도 정확성

작성일: 2026-08-10

기준: [update_1.8.8-hotfix.6.md](./update_1.8.8-hotfix.6.md)

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: 추가 리뷰의 P2 3건·P3 1건 구현, `npm run check`·Rules 26/26·Chromium/WebKit 14/14 통과. 외부 재리뷰와 실기기 검증 대기

## 목표

TTS 실제 재생시간, clock sample 비용, 실패 후 이동 재시도와 손상된 통계 hydration을 사용자에게 보이는 결과 기준으로 정확하게 만든다.

## 수용한 finding

- 연속 TTS의 `starting`·`loading` 준비 시간이 실제 TTS 청취시간으로 집계되던 P2
- clock sample이 저장되기 전 여러 upload가 동시에 추가 server read를 시작할 수 있던 P2
- slider와 일반 이동이 navigation 성공·progress save 실패 뒤 재시도할 때 이동 후 위치를 자동 책갈피 시작점으로 다시 사용할 수 있던 P2
- `uploadedAtServer`가 잘못된 통계 문서가 per-document quarantine 전에 page hydration 전체를 중단하던 P3

## 구현

- 연속 TTS의 논리 상태에 `active-gap`을 추가했다. 문장 전환은 같은 TTS 흐름으로 유지하지만 `playing` 상태만 TTS 시간으로 배정하고 `starting`·`loading` 중에는 화면 독서로도 fallback하지 않는다.
- device별 clock sample read에 in-flight map을 두어 첫 요청이 끝날 때까지 같은 device의 후속 요청이 그 promise를 공유한다. 완료 또는 실패 뒤에는 map에서 제거해 정상 재시도를 허용한다.
- slider 확인 모달을 만들 때 이동 전 CFI·퍼센트로 자동 책갈피 후보를 한 번만 staging한다. navigation 뒤 저장이 실패해도 같은 확인 작업의 재시도는 이 frozen snapshot을 사용한다.
- CFI, 퍼센트 직접 이동도 target key별 pending snapshot을 유지한다. 저장 실패 뒤 같은 target을 다시 실행하면 live target 위치에서 책갈피를 재생성하지 않고 최초 이동 전 snapshot을 재사용한다.
- malformed `uploadedAtServer`를 해당 문서 quarantine으로 격리하고 뒤의 정상 문서를 계속 hydration한다.
- page 끝이 malformed timestamp이고 page가 가득 찬 경우에는 현재 실행 안에서 Firestore document snapshot cursor로 다음 page까지 건너뛴다. 정상 timestamp cursor를 찾거나 collection 끝에 도달한 뒤에만 durable exact cursor 또는 완료 sentinel을 저장한다.
- 정상 session 없이 quarantine만 있는 완료 page도 quarantine 정보와 full-audit 완료 marker를 원자적으로 저장한다.

## 자동검증

- `active-run → active-gap → active-run`에서 준비 구간이 TTS 또는 screen 시간으로 잡히지 않음
- 같은 device의 동시 clock sample 요청이 하나의 read를 공유하고 settlement 뒤 재시도 가능
- slider 및 일반 jump retry가 최초 이동 전 자동 책갈피 snapshot을 재사용
- malformed timestamp 뒤 정상 session hydration 지속
- page size 전체가 malformed 끝 문서인 경우 document snapshot cursor로 다음 정상 문서까지 진행
- quarantine-only 완료 hydration이 cursor 없이도 durable sentinel과 진단 목록을 저장
- `npm run check`: 통과
  - ESLint 오류 0, 기존 Foliate vendor 경고 2
  - formats 59/59, drive 49/49, archives 33/33, storage 225/225, shelf 58/58, Service Worker 9/9, release 3/3
  - TypeScript·production build 통과
- Firestore Rules: 26/26 통과
- Chromium/WebKit Playwright: 14/14 통과

## 범위 경계

- 이 single-flight는 한 탭의 같은 device 요청 중복만 제거한다. 탭 사이 hydration/upload 단일 실행자는 새 lease protocol이므로 [update_1.8.9.md](./update_1.8.9.md) Phase A1에 그대로 남긴다.
- production Chrome 장기 selection 회귀와 retention/compaction 설계도 기존 1.8.9 Phase A 범위를 유지한다.

## 실기기 검증 대기

- TTS 문장 전환·장 전환·재시도 지연이 많은 기기에서 실제 재생시간과 통계 TTS 시간이 일치하는지 비교한다.
- slider, TOC, 검색, 책갈피와 CFI 이동을 저장 실패·offline 상황에서 재시도해 자동 책갈피가 이동 전 위치를 가리키는지 확인한다.
- 손상 통계 문서는 emulator 자동검증으로 격리 계약을 고정했으며, 정상 기기간 통계 hydration은 1.8.9 누적 실기기 검증에서 확인한다.
