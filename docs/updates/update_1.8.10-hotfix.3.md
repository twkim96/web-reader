# Web Reader 1.8.10 hotfix.3 — 독서 통계 1분 확정

작성일: 2026-08-12

기준 커밋: `b3860b1`

상위 문서: [update_1.8.10.md](./update_1.8.10.md), [update_1.8.10-hotfix.2.md](./update_1.8.10-hotfix.2.md)

상태: 구현·전체 자동 gate 완료. Android 실기기 확인 대기

## 실사용 finding

Android 독서 입력 인식은 복구됐지만 리더를 닫지 않고 2~3분 읽은 경우 다른 기기의 통계가 계속 0으로 보였다. 초안은 5초마다 `localStorage`에 기록되고 있었으나, IndexedDB와 Firestore에 동기화할 불변 session은 최대 5분 경계·90초 유휴·리더 종료 중 하나가 발생해야 확정됐다.

따라서 계속 탭하며 읽는 정상 사용에서는 기록 손실이 아니라 **최대 5분의 표시·동기화 지연**이 발생했다.

## 수정 계약

- 새 screen·TTS session은 활성 독서 중 1분마다 닫고 다음 session을 이어서 시작한다.
- heartbeat 주기는 5초, 유휴 종료는 90초로 유지한다.
- 리더 종료·panel open·hidden·pagehide는 1분 전이라도 기존처럼 남은 session을 즉시 확정한다.
- 기존 session schema의 최대 5분 검증 한도는 유지한다. 이미 저장되거나 원격에 있는 1.8.8~1.8.10 기록을 거부하지 않는다.
- 새 확정 주기와 호환성 검증 한도를 별도 상수로 관리해 과거 데이터와 새 기록 정책을 섞지 않는다.
- 1분 경계는 5초 heartbeat에서 판정하므로 정상 상태의 추가 지연은 최대 약 5초다.
- 서비스 워커 script를 갱신해 설치형 Android PWA도 hotfix.3 배포를 감지한다.

## 부하 판단

- 지속 독서 시 session write는 기존 시간당 최대 12건에서 60건으로 5배 증가한다.
- CPU timer와 draft write 주기는 바뀌지 않아 단말 계산 부하는 사실상 동일하다.
- 개인용 규모에서는 즉시성 개선 가치가 더 크다고 판단했다. 30초 주기는 write가 10배가 되므로 적용하지 않는다.
- 여러 기기에서 같은 시간에 읽은 구간은 기존 통계 집계 단계에서 계속 중복 제거한다.

## 자동검증

- 새 확정 주기가 60초인지 확인
- 과거 5분 session이 계속 schema validator를 통과하는지 확인
- 자정까지 30초만 남은 session은 1분보다 자정 경계에서 먼저 분리되는지 확인
- 기존 Android focus·idle·TTS·draft recovery 회귀 확인
- Service Worker update·release 정합성 확인
- `npm run check:full`: 통과
- ESLint: 오류 0, 기존 Foliate vendor 경고 2
- TypeScript·production build: 통과
- Node: formats 63/63, drive 49/49, archives 33/33, storage 259/259, shelf 66/66, Service Worker 9/9, release 3/3 — 합계 482/482
- Firestore Rules: 27/27
- Chromium/WebKit Playwright: 14/14
- production Chrome regression: 통과
- `git diff --check`: 통과

## 실기기 확인

- Android PWA 업데이트 적용 후 리더를 닫지 않고 70~90초 이상 실제 독서한다.
- Android 로컬 통계와 iPad 원격 통계가 순차적으로 증가하는지 확인한다.
- 1분 미만에 책장으로 나가도 종료 시점까지의 기록이 표시되는지 확인한다.
- 화면 잠금·앱 전환·90초 무입력 구간은 통계에 더해지지 않는지 확인한다.
