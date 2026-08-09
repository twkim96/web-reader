# Web Reader 1.8.7 현재 장 연속 TTS

작성일: 2026-08-09

기준 커밋: `b3fe6e1` (`feat(reader): add basic text to speech`)

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: 구현·1차 외부 리뷰 finding 수정·전체 자동검증 완료, 재리뷰 대기 — 실기기 검증은 1.8.9 누적 안정화로 이관

## 목표

1.8.6의 선택·현재 문장 TTS 계약을 유지하면서 현재 EPUB spine section을 작은 문장 window로 연속 재생하고, 발화 문장이 화면 밖에 있을 때만 비영속 TTS 이동으로 화면을 맞춘다.

## 장 경계

- 1.8.7의 `현재 장`은 현재 로드된 EPUB의 linear spine section 하나다.
- section 안에서는 문장 window를 이어 붙여 끝까지 재생한다.
- 장 끝 동작이 `다음 장`이면 다음 linear spine section으로 이동해 새 queue를 만든다.
- 다음 책 자동 재생은 하지 않는다.

## 포함

- 현재 장 연속 듣기와 명시적인 저장 cursor 이어 듣기
- 최대 51개 Range만 유지하는 sliding sentence window
- 발화 문장 임시 강조와 화면 밖 문장 자동 이동
- TTS 자동 이동 전용 relocate reason
- 장 끝 `멈춤`·`다음 장` 설정
- owner·book별 local TTS cursor 저장·복원
- 10·20·30분 sleep timer
- `visibilitychange` 복귀 시 실제 speech 상태 재검증
- 재시도 가능한 speech error 1회 재시도 후 해당 문장 건너뛰기
- 수동 탐색·모달·책 전환·reader 종료 시 cleanup

## 제외

- OS lock-screen media control 보장
- background에서 음성이 반드시 계속된다는 보장
- 다음 책 자동 재생
- cloud voice·audio file cache
- TTS cursor 기기 간 동기화
- TTS 재생 시간을 독서 통계에 합치는 정책

## 핵심 계약

- 기존 toolbar `듣기`는 1.8.6의 현재 문장 동작을 유지하고, 열린 controls에서 `현재 장 연속 듣기`를 명시적으로 시작한다.
- 자동 화면 이동은 `tts-navigation` reason을 사용하며 진행률 저장 기준 CFI·자동 책갈피·수동 책갈피를 갱신하지 않는다.
- TTS cursor는 읽기 진행률과 다른 localStorage record다. owner key와 book id로 격리하며 Firestore·IndexedDB outbox에 넣지 않는다.
- cursor 복원은 사용자 버튼으로만 실행하고, 현재 reader 위치를 조용히 덮어쓰지 않는다.
- chapter queue는 전체 section text index를 한 번 만들되 live DOM Range는 현재 문장 주변에만 만든다.
- 사용자가 페이지·키보드·휠·slider·목차로 이동하면 연속 TTS를 멈추고 마지막 TTS cursor만 남긴다.
- background 동작은 추측하지 않는다. foreground 복귀 시 `paused`·`speaking`·`pending`을 읽고 UI를 맞추거나 현재 문장을 한 번 복구한다.

## 구현 단계

1. 1.8.7 settings·cursor storage·release 표기
2. 재사용 가능한 chapter text source와 sliding Range window
3. Foliate `tts-navigation`과 progress persistence 제외 정책
4. chapter queue·다음 section·retry·cursor 상태 머신
5. sleep timer·Page Visibility 복귀 검증
6. controls의 연속 듣기·이어 듣기·장 끝·timer UI
7. Node·Chromium/WebKit·production browser 회귀
8. 전체 gate와 외부 코드 리뷰 대기 전환

## 완료 조건

- 100개 이상 문장의 장도 queue 전체 Range를 보관하지 않고 순서대로 한 번씩 재생한다.
- 문장 window 경계에서 중복·누락 없이 다음 window로 넘어간다.
- 화면 밖 문장 이동은 reader UI를 따라가게 하지만 progress save 기준과 bookmark를 바꾸지 않는다.
- 같은 장·다음 장·저장 cursor 복원에서 오래된 speech callback과 navigation continuation이 새 상태를 바꾸지 않는다.
- 수동 탐색은 TTS 자동 이동보다 우선하며 즉시 speech·overlay를 정리한다.
- sleep timer 만료와 foreground 복귀 상태 불일치가 controls만 재생 중인 상태를 남기지 않는다.
- 재시도 가능한 오류는 한 번만 재시도하고 두 번째 실패 시 다음 문장으로 진행한다.
- 장 완료 시 저장 cursor를 지우고, 중지·sleep timer·reader 이탈 시 마지막 cursor를 유지한다.

## 자동검증 계획

- cursor schema·owner/book 격리·상한·malformed migration
- source index와 앞·뒤 sliding window 경계
- document end·다음 window·다음 section 중복 방지
- `tts-navigation` progress save·bookmark 불변
- 화면 밖 Range 자동 이동과 화면 안 Range 이동 생략
- 장 끝 stop·next 설정
- sleep timer 교체·해제·만료
- hidden→visible 상태 재검증과 lost utterance 복구
- retryable error 1회 재시도·2회 실패 skip
- 수동 relocate·모달·책 전환 cleanup
- `npm run check:full`
- `git diff --check`

## 구현 결과

- 1.8.6의 선택·현재 위치 단일 문장 듣기를 그대로 유지하고 controls 안에 현재 장 연속 듣기와 저장 위치 이어 듣기를 추가했다.
- 현재 linear spine section의 전체 문장 offset은 한 번 계산하되 DOM `Range`는 현재 문장 주변 최대 51개만 유지한다.
- window 경계를 넘어 55개 문장을 연속 재생하는 production 회귀에서 중복·누락 없이 순서가 이어지고 live window가 51개 이하임을 확인했다.
- 화면 밖 문장만 `tts-navigation`으로 이동하며 이 reason은 React reader state에는 반영되지만 progress persistence 기준 위치에는 반영되지 않는다.
- owner·book별 local cursor를 별도 localStorage schema로 저장하고, CFI와 문장 index를 함께 사용해 사용자 요청 시에만 이어 듣는다.
- 재시도 가능한 음성 오류는 같은 문장을 한 번 재시도하고 두 번째 실패 시 다음 문장으로 넘어간다.
- 다음 장 계속 듣기는 비어 있는 linear section을 건너뛰며, 더 읽을 section이 없으면 정상 완료한다.
- 10·20·30분 취침 타이머와 hidden→visible 복귀 시 실제 `paused`·`speaking`·`pending` 상태 재검증을 연결했다.

## 1차 외부 리뷰 후속

리뷰의 제품 코드 finding은 모두 실제 경합 또는 UX 실패 경로로 확인해 반영했다.

- TTS section 이동의 최초 relocate뿐 아니라 뒤따르는 `anchor` relocate에도 동일한 `navigationSource`·`navigationId`를 전파한다. 파생 이동도 TTS 자체 이동으로 판별하므로 speech를 스스로 중단하거나 progress 저장 기준을 오염시키지 않는다.
- Foliate section 이동을 generation 기반 latest-task로 직렬화했다. 새 section은 숨긴 staging view에서 준비하고 가장 최신 요청만 commit하며, 사용자의 페이지·목차 이동은 진행 중인 TTS 이동보다 우선한다. 폐기된 이동은 renderer와 history를 갱신하지 않는다.
- cursor 복원 중 queue가 아직 없거나 오류 상태여도 정지·뒤로가기가 pending navigation과 늦은 continuation을 취소한다.
- 마지막 문장을 발화 중일 때 사용자가 `다음`을 누르면 다음 항목 유무와 관계없이 현재 speech를 먼저 취소한다.
- 책 삭제가 로컬 저장소에 commit되면 캡처한 owner·book의 TTS cursor도 제거한다. 책 내용 identity가 바뀐 cursor는 폐기하고, 복원은 CFI → 저장 section → 문장 index 순으로 시도한 뒤 저장 문장과 실제 문장을 비교한다.
- 선택 영역 TTS는 UTF-16 50,000자 상한을 두고 live DOM `Range`를 최대 51개 sliding window로 제한했다. 180문장 선택 후 55문장을 이동하는 회귀에서 중복·누락과 window 상한을 함께 검증한다.
- 320×480 viewport에서는 확장 controls에 safe-area 기반 최대 높이와 내부 세로 스크롤을 적용해 현재 문장·정지 controls가 화면 밖으로 밀려나지 않게 했다.
- production regression의 guest identity와 install ID는 첫 navigation 전에 주입한다. 기존 마지막 reader session과 TTS cursor는 지우지 않아 auto-open·이어 듣기 회귀를 그대로 검증한다.

큰 선택 영역 처리는 비동기 전체 materialization 대신 입력 상한과 51개 sliding window로 유한하게 만들었다. 따라서 장시간 main-thread 작업을 남겨 둔 채 단순히 테스트만 완화하지 않는다.

## 자동검증 결과

- ESLint: 오류 0, 기존 Foliate vendor 경고 2개
- TypeScript: 통과
- formats: 58/58
- drive: 49/49
- archives: 33/33
- storage: 189/189
- shelf: 55/55
- Service Worker: 9/9
- release: 2/2
- production build: 통과
- Firestore Rules: 22/22
- Chromium/WebKit Playwright: 14/14
- production Chrome regression: 통과
- `git diff --check`: 통과

## 실기기 검증 이관

다음 항목은 코드 완료 판정과 분리해 1.8.9 누적 안정화에서 확인한다.

- PC Chrome, iPad Safari, iPad 홈 화면 PWA에서 20~30분 이상 연속 재생
- 네 탐색 모드와 화면 회전·글자 크기·줄 간격 변경
- foreground·background·화면 잠금 뒤 실제 음성 지속·중단 범위
- 10·20·30분 sleep timer 실제 시간
- Bluetooth 출력 전환과 다른 앱 오디오 interruption
- 장 경계·다음 장·저장 cursor 이어 듣기
- 최소 2~3일 실제 듣기 안정화

## 참고

Page Visibility API는 문서가 hidden·visible로 바뀔 때 `visibilitychange`를 제공한다. 복귀 시 Web Speech의 `paused`, `speaking`, `pending` 값을 다시 읽되, OS·브라우저가 background speech를 유지한다고 가정하지 않는다.
