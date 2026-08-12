# Web Reader 1.8.10 hotfix.4 — 연속 독서 시간 기록 복구

작성일: 2026-08-12

기준 커밋: `f488b75`

상위 문서: [update_1.8.10.md](./update_1.8.10.md), [update_1.8.10-hotfix.3.md](./update_1.8.10-hotfix.3.md)

상태: 구현·전체 자동 gate 완료. Android 연속 독서 실기기 확인 대기

## 실사용 finding

hotfix.3 적용 뒤 첫 테스트에서는 약 1분이 기록됐지만, 두 번째 독서부터 시간이 전혀 증가하지 않았다. 홈 화면으로 나갔다 돌아온 뒤 첫 터치를 해도 같은 증상이 이어질 수 있었다.

## 원인

독서 tracker의 TTS 상태 효과는 `progressPercent` 변경 때도 다시 실행된다. 일반 화면 독서에서는 TTS phase가 계속 `inactive → inactive`인데도 기존 코드는 phase의 실제 전환 여부를 확인하지 않고 매번 다음 값을 실행했다.

```ts
if (nextTtsTrackingPhase === 'inactive' || nextTtsTrackingPhase === 'paused') {
  lastActivityAtRef.current = 0;
}
```

실제 실패 순서는 다음과 같다.

1. reader 터치가 활동 시각을 기록하고 screen session을 시작한다.
2. 같은 탭 이동의 진행률 변경이 React effect를 다시 실행한다.
3. TTS는 계속 inactive이지만 활동 시각이 0으로 초기화된다.
4. 다음 heartbeat는 screen session을 종료하려 한다.
5. 앱의 monotonic 생존 시간이 90초를 넘은 뒤에는 `0 + idle timeout`이 새 session 시작보다 과거가 된다.
6. 종료 시각이 session 시작으로 clamp되어 1초 미만 기록으로 폐기된다.

따라서 앱을 연 직후 약 90초 동안만 짧은 기록이 우연히 누적되고 그 뒤부터 완전히 멈추는 실사용 결과와 일치한다. `hidden → visible` 이후 첫 터치도 진행률 render가 뒤따르면 같은 경로로 사라졌다.

로컬 저장은 매 session마다 새 UUID를 사용하고 저장 완료 때마다 sync wake를 발생시키므로 “최초 session만 전송”이 원인은 아니었다.

## 수정 계약

- `inactive → inactive`, `paused → paused`처럼 TTS phase가 바뀌지 않은 render는 화면 독서 활동 시각을 보존한다.
- 실제 TTS 재생·gap·시작 대기 상태에서 `inactive` 또는 `paused`로 전환될 때만 활동 시각을 초기화한다.
- TTS가 끝난 직후 사용자의 새 입력 없이 화면 독서로 자동 전환하지 않는 기존 정책은 유지한다.
- Android 홈 화면 왕복 뒤에는 `hidden`에서 기존 session을 닫고, 복귀 후 첫 reader 입력이 새 screen session을 시작한다.
- hotfix.3의 1분 확정, 5초 heartbeat, 90초 idle 정책은 그대로 유지한다.
- 서비스 워커 script를 갱신해 설치형 PWA도 hotfix.4 배포를 감지한다.

## 자동검증

- 일반 progress render의 `inactive → inactive`가 활동 시각을 보존하는지 확인
- 활동 시각이 보존된 screen tracker가 페이지 생존 90초 이후에도 `screen`을 반환하는지 확인
- `active-run → inactive`, `active-gap → paused`가 활동 시각을 초기화하는지 확인
- 안정된 `paused → paused` render는 중복 초기화하지 않는지 확인
- 기존 1분 확정·과거 5분 schema·Android focus·idle·TTS·draft recovery 회귀 확인
- Service Worker·release 정합성 확인
- `npm run check:full`: 통과
- ESLint: 오류 0, 기존 Foliate vendor 경고 2
- TypeScript·production build: 통과
- Node: formats 63/63, drive 49/49, archives 33/33, storage 260/260, shelf 66/66, Service Worker 9/9, release 3/3 — 합계 483/483
- Firestore Rules: 27/27
- Chromium/WebKit Playwright: 14/14
- production Chrome regression: 통과
- `git diff --check`: 통과

## 실기기 확인

- 업데이트 적용 뒤 같은 책을 3분 이상 연속으로 넘기며 통계가 1분 단위로 2회 이상 증가하는지 확인한다.
- 홈 화면 또는 다른 앱으로 전환했다 돌아온 뒤 첫 탭부터 새로운 시간이 다시 증가하는지 확인한다.
- background에 머문 시간은 통계에 포함되지 않는지 확인한다.
- Android에서 생성된 두 번째 이후 session이 iPad에도 수렴하는지 확인한다.
