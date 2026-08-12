# Web Reader 1.8.10 hotfix.1 — 기기 간 독서 통계 충돌 수렴

작성일: 2026-08-12

기준 커밋: `68c1f6b`

상위 문서: [update_1.8.10.md](./update_1.8.10.md), [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: 구현·전체 자동 gate 완료. Android·iPad 동일 계정 실기기 수렴 확인 대기

## 실사용 finding

Firestore Rules 배포 후 권한 경고는 사라졌지만, `독서 통계 데이터 형식을 확인해야 합니다.`가 표시되며 Android와 iPad 사이의 통계가 수렴하지 않았다.

동일 Firebase UID는 기기 ID가 달라도 `libraries/local/readingStatsV1`을 공유하므로 독서 통계는 원래 기기 간 동기화 대상이다.

## 원인

독서 session은 UUID를 document ID로 사용하고 서버에 처음 생성된 뒤에는 수정하지 않는 immutable 기록이다. 그러나 이전 로컬 기록과 서버에 이미 확정된 동일 session ID의 payload가 다르면:

- remote hydration page 전체가 중단됐다.
- upload queue도 해당 기록에서 멈춰 뒤의 정상 session을 보내지 않았다.
- 하나의 충돌이 전체 양방향 동기화를 `blocked-schema`로 만들었다.

## 수정 계약

- 서버에 이미 생성된 동일 session ID의 유효한 immutable payload를 권위 값으로 사용한다.
- hydration은 충돌한 로컬 기록을 remote payload로 교체하고 `synced`로 표시한 뒤 같은 page의 나머지 session과 cursor를 같은 transaction에서 완료한다.
- upload transaction은 충돌을 예외로 종료하지 않고 기존 remote payload를 반환한다.
- 로컬 reconciliation은 현재 lease와 upload 시점의 expected payload를 다시 검증한 뒤 remote payload로 교체한다.
- 수렴이 완료되면 다음 pending session upload을 계속한다.
- 스키마가 손상된 remote 문서의 기존 quarantine과 Rules 차단은 유지한다.

## 자동검증

- pending local과 유효한 remote가 동일 session ID에서 다를 때 remote로 수렴하는지 확인
- 충돌 뒤의 정상 remote session hydration과 cursor 전진 확인
- upload 충돌 수렴 뒤 다음 pending session이 그대로 대기열에 남는지 확인
- Firestore의 create-only·same-payload replay·update/delete 금지 계약 유지
- `npm run check:full`: 통과
- ESLint: 오류 0, 기존 Foliate vendor 경고 2
- TypeScript·production build: 통과
- Node: formats 63/63, drive 49/49, archives 33/33, storage 257/257, shelf 66/66, Service Worker 9/9, release 3/3 — 합계 480/480
- Firestore Rules: 27/27
- Chromium/WebKit Playwright: 14/14
- production Chrome regression: 통과
- `git diff --check`: 통과

## 실기기 검증 대기

- Android와 iPad에 동일 Firebase 계정으로 로그인한다.
- 각 기기에서 1분 이상 독서한 뒤 양쪽의 오늘·주간·월간 합계와 도서별 통계가 수렴하는지 확인한다.
- 기존 `데이터 형식` 경고가 사라지고 새 정상 session이 계속 업로드되는지 확인한다.
- 한 기기를 offline으로 독서한 뒤 online으로 복귀해도 누락·중복 없이 합쳐지는지 확인한다.
