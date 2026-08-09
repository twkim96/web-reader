# Web Reader 1.8.8 독서 통계

작성일: 2026-08-09

기준: 1.8.7 working tree

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: 추가 전체 리뷰 후속을 [hotfix.3](./update_1.8.8-hotfix.3.md)~[hotfix.5](./update_1.8.8-hotfix.5.md)로 분리 구현하고 check·Rules·Playwright 완료. production Chrome 장기 회귀 P3와 실기기 검증은 [1.8.9](./update_1.8.9.md) Phase A로 이관

## 목표

진행률 저장 횟수가 아니라 실제 활성 독서 구간을 기록해 책별·일별·주별·월별 읽기 시간을 계산한다. 화면 독서와 TTS 듣기를 구분하고, 여러 기기의 겹치는 시간은 한 번만 집계한다.

## 세션 계약

- 원본은 수정 가능한 누계가 아니라 최대 5분의 불변 session segment다.
- segment는 owner·book·device·mode와 시작/종료 시각, 시작/종료 진행률, 현지 날짜·시간대 offset을 함께 저장한다. 실행 중 duration은 monotonic clock으로 계산해 시스템 시계 변경에 흔들리지 않는다.
- 화면 독서는 reader가 로드되고 문서가 visible·focused인 동안만 기록한다. 마지막 사용자 활동에서 90초가 지나면 새 활동 전까지 중단한다.
- TTS는 utterance `onstart` 뒤 presentation state가 실제 `playing`일 때만 `tts` mode로 기록한다. `loading`·`starting`·`paused`·`error`와 background 시간은 추측해 포함하지 않는다.
- 같은 시간에 screen과 TTS가 겹치면 TTS를 우선한다. 신뢰 가능한 서버 시각 표본이 있는 기기는 보정된 구간과 결정적인 session ID 순서로 하나만 선택한다. 표본이 없는 기록은 잘못 제거하지 않고 기기별로 합산하며 UI에 불확실성을 표시한다.
- 자정·시간대 변경은 segment 시작 시점의 timezone offset을 보존한다. 집계 날짜는 신뢰 가능한 서버 시각 보정 뒤 canonical timeline에서 다시 계산하며 자정 경계에서는 segment를 닫고 새 날짜로 시작한다.
- browser 종료 직전 draft는 5초마다 localStorage에 checkpoint한다. 각 session이 독립 key와 `closed-pending` 상태를 가져 이전 IndexedDB commit이 끝나기 전에 새 segment가 시작돼도 덮어쓰지 않으며, 동일 session ID로 멱등 복구한다.

## 동기화 계약

- 로컬 원본은 IndexedDB `reading-sessions-v11`에 owner별로 저장하고, DB v12의 `reading-statistics-sync-v12`에 hydration 상태를 분리한다.
- Firebase 사용자의 닫힌 segment만 `readingStatsV1/{sessionId}`에 불변 create로 업로드한다.
- session ID는 전역 고유하며 같은 ID의 재전송은 같은 payload일 때만 성공으로 취급한다.
- guest segment는 기기에만 저장한다.
- offline segment는 pending 상태를 유지하고 online·foreground·명시적 변경 wake에서 다시 업로드한다.
- 원격 hydration은 server-only 조회와 `(uploadedAtServer seconds, nanoseconds, documentId)` exact tuple cursor를 사용한다. 각 500개 page와 cursor는 session store·sync meta store의 한 transaction에서 commit하며, session store가 비었거나 7일 full audit 주기가 오면 전체 복원으로 돌아간다.
- 원격 수신과 upload health를 분리하고, 수신 실패는 실제 server hydration을 bounded exponential backoff로 재시도한다. 성공한 수신과 owner 전환은 health를 정상화하며 통계 health는 핵심 진행률·주석 sync health와 합치지 않는다.
- 원격 hydration은 동일 ID의 로컬 payload를 덮어쓰지 않는다. 파생 `localDate`는 정규화하고 나머지 malformed 문서는 ID·사유와 함께 격리한 뒤 정상 문서를 계속 복원한다.
- 기존 progress·bookmark·annotation outbox, revision과 conflict UI는 변경하지 않는다.

## 포함

- active reading session 시작·중단·종료
- 책별 읽은 시간·읽은 날짜·완독 도달 기록
- 오늘·이번 주·이번 달·전체 집계
- 화면 독서와 TTS 듣기 시간 분리
- 기기 간 immutable session 동기화와 겹침 제거
- offline upload와 원격 hydration
- 통계 모달
- Markdown·JSON 내보내기와 지원 기기의 파일 공유

## 제외

- 기존 progress timestamp로 과거 독서 시간을 역산
- background에 둔 시간의 추정 집계
- 집중도·건강 지표
- 경쟁·소셜 기능
- 원격 aggregate 문서와 서버 통계 작업
- 저장된 통계 원본의 사용자 편집·삭제

## 구현 단계

1. local schema·session validator·5분 segment·draft recovery
2. overlap-safe day/week/month aggregation과 export
3. reader activity·visibility·focus·TTS lifecycle tracker
4. immutable Firestore upload·hydration·Rules
5. shelf 통계 진입점과 modal
6. Node·Rules·production browser 회귀
7. 전체 gate와 외부 리뷰 대기 전환

## 완료 조건

- reader loading·hidden·blur·90초 idle 시간이 읽기 시간에 포함되지 않는다.
- pause된 TTS와 화면 독서 시간이 TTS 시간으로 기록되지 않는다.
- 같은 session 재전송과 PC·iPad 겹침이 총시간을 두 배로 만들지 않는다.
- book·owner 전환과 빠른 종료가 이전 owner/book에 segment를 남기지 않는다.
- offline 기록이 재접속 뒤 같은 session ID로 한 번만 동기화된다.
- 오늘·주·월 경계와 timezone offset 정책이 테스트로 고정된다.
- Markdown·JSON이 동일한 deduplicated 합계를 표현하고 JSON 원본이 validator로 다시 파싱된다.

## 자동검증 계획

- local DB v10→v11 무손실 upgrade와 owner 격리
- schema 상한·malformed record·session ID collision
- 5분 split·90초 idle·hidden·focus·pagehide 멱등 종료
- screen/TTS mode 전환과 progress snapshot
- 다중 기기·다중 mode O(n log n) overlap sweep과 20,000 segment 성능
- 자정·주 시작·월 시작·timezone offset
- offline pending→upload→hydrate와 immutable replay
- Firestore ownership·payload·create-only Rules
- 320px shelf 진입점과 modal focus·scroll lock
- Markdown·JSON download/share fallback
- `npm run check:full`
- `git diff --check`

## 구현 결과

- IndexedDB를 v12로 올리고 owner별 `reading-sessions-v11` 원본 store와 `reading-statistics-sync-v12` hydration meta store를 추가했다. 기존 v10 이하의 도서·진행률·주석 store는 그대로 보존한다.
- reader가 로드되고 visible·focused인 것만으로 화면 독서를 시작하지 않는다. publication pointer·key·wheel·touch 또는 명시적 page key 입력 뒤에만 시작하며, 90초 무입력, background, blur, 설정·목차·검색·책갈피 panel에서 session을 닫는다.
- utterance가 실제 `onstart`를 보낸 뒤에만 screen segment를 닫고 `tts` segment를 시작한다. 시작 watchdog과 resume runtime 확인을 두고 pause·loading·starting·error는 TTS 시간으로 기록하지 않는다.
- 최대 5분 segment와 5초 localStorage draft checkpoint를 사용한다. session별 key와 동기식 `closed-pending` journal을 먼저 남긴 뒤 IndexedDB에 직렬 commit하므로 빠른 mode 전환도 이전 draft를 잃지 않는다.
- segment에 book title snapshot, 시작·종료 진행률, 완독 여부, 현지 날짜와 timezone offset을 보존한다. 도서를 삭제해도 이미 발생한 독서 기록은 유지한다.
- heap 기반 O(n log n) sweep-line 집계가 겹치는 기기·책·mode 구간을 하나만 선택한다. TTS를 screen보다 우선하고 같은 mode는 session ID 순서로 결정한다. 완독·진행률·독서일 metadata는 시간 winner와 분리해 모든 유효 session에서 보존한다.
- 오늘·월요일 시작 주간·이번 달·전체 집계와 책별 화면/TTS 시간, 읽은 날짜, 진행률과 완독 수를 통계 modal에 표시한다.
- Markdown은 deduplicated 도서·날짜 집계를, JSON은 validator로 다시 읽을 수 있는 불변 원본 session과 같은 집계를 함께 내보낸다. Web Share 미지원·실행 거부는 다운로드로 fallback한다.
- Firebase 사용자는 create-only `readingStatsV1/{sessionId}` 문서로 동기화한다. 재전송은 payload가 같을 때만 replay로 인정하고 다른 payload의 동일 ID는 차단한다.
- 원격 hydration은 Firestore server에서 500개씩 읽고 exact tuple cursor를 같은 IndexedDB transaction에 저장한다. cache snapshot은 cursor를 전진시키지 않으며, raw store/cursor 불일치 시 전체 hydration을 다시 수행한다.
- 첫 online upload의 server timestamp와 요청 구간으로 낮은 불확실성 clock sample을 만들고 이후 session에 기록한다. 집계는 24시간 이내 sample만 사용하며, 보정할 수 없는 기기 구간은 삭제하지 않고 통계 화면에 안내한다.
- 수신 재시도는 실제 server fetch를 재실행하고 성공 즉시 receive health를 복구한다. upload retry는 저장된 `nextAttemptAt`에 맞춰 예약하며 owner 전환 시 이전 health를 초기화한다.
- 통계 sync health는 통계 모달 안에서 별도로 표시하며 progress·bookmark·annotation의 전역 sync health와 conflict chain은 변경하지 않았다.
- 320×640 production Chrome 회귀에서 통계 진입점, modal viewport, 44px action, 화면/TTS 구분과 저장 session 표시를 확인했다.

## 1차 외부 리뷰 반영

수용한 finding은 다음과 같다.

- session별 durable draft journal이 없어 빠른 전환에서 이전 closed segment가 덮일 수 있던 P1
- cache snapshot과 localStorage cursor 조합이 원격 과거 기록을 영구 건너뛸 수 있던 P1
- utterance `onstart` 전에 TTS 시간이 시작되던 P1
- O(n²) overlap 집계와 modal render마다 네 summary를 다시 만들던 P2
- receive retry가 실제 hydration을 재시도하지 않고 health가 owner를 넘어 남던 P2
- 자동 도서 복원만으로 최대 90초 화면 독서가 생기던 P2
- overlap loser의 완독·진행률·독서일 metadata가 사라지던 P2
- 기기 wall clock skew가 cross-device overlap 판정을 왜곡하던 P2

수정은 통계 저장소·TTS presentation state·집계기에만 한정했다. 기존 progress·bookmark·annotation revision/outbox/receipt 경로는 변경하지 않았다.

## 자동검증 결과

- ESLint: 오류 0, 기존 Foliate vendor 경고 2개
- TypeScript: 통과
- formats: 58/58
- drive: 49/49
- archives: 33/33
- storage: 211/211
- shelf: 57/57
- Service Worker: 9/9
- release: 3/3
- production build: 통과
- Firestore Rules: 26/26
- Chromium/WebKit Playwright: 14/14
- production Chrome regression: 통과
- `git diff --check`: 통과

## 실기기 검증 이관

다음 항목은 1.8.9 누적 안정화에서 확인한다.

- PC Chrome·iPad Safari·홈 화면 PWA의 30분 이상 실제 독서 시간 비교
- 90초 idle 전후, 화면 잠금, background·foreground, 앱 전환
- 화면 독서와 TTS 듣기 전환
- PC와 iPad 동시 독서·offline 재연결
- 자정 통과와 시간대 변경
- 빠른 PWA 종료·재실행 뒤 draft 복구
- 최소 2~3일 수기 시간과 통계 비교
