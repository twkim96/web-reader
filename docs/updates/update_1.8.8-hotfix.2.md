# Web Reader 1.8.8-hotfix.2 독서 통계 복원·집계 안정성

작성일: 2026-08-09

기준: [update_1.8.8-hotfix.1.md](./update_1.8.8-hotfix.1.md)

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: 구현·전체 자동검증 완료, 외부 재리뷰 대기

## 목표

원격 통계 문서 하나가 손상돼도 나머지 기록을 복원하고, Firestore Timestamp와 시계 보정 날짜를 손실 없이 사용한다. 통계 전용 장애가 진행률·주석의 핵심 동기화 경고로 보이지 않게 분리한다.

## 수용한 전체 리뷰 finding

- Rules가 허용한 형식상 올바른 `localDate`와 client의 파생 날짜 검사가 달라 한 문서가 전체 hydration을 영구 차단할 수 있던 P2
- 시계 보정 뒤 날짜가 달라지는 겹침에서 상단 기간 합계와 상세 합계가 서로 다른 winner를 사용할 수 있던 P2
- millisecond cursor가 Firestore Timestamp nanoseconds를 잃고 단순 local count만으로 부분 손실을 탐지하던 P2
- 독서 통계 receive/upload health가 progress·bookmark·annotation의 핵심 동기화 경고에 합쳐지던 P2 UX
- annotation/outbox/conflict/statistics 원본이 장기적으로 계속 증가하는 retention 위험

## 구현

### 문서별 정규화·격리

- remote session의 `localDate`는 `startedAtClient + timezoneOffsetMinutes`에서 다시 계산해 Rules가 이미 허용한 과거 문서도 동일한 client 계약으로 정규화한다.
- duration, identity 등 나머지 schema가 손상된 문서는 page 전체를 실패시키지 않고 문서 ID·사유·감지 시각을 hydration meta에 최대 100개까지 격리 기록한다.
- cursor는 격리 문서를 포함해 실제 조회한 마지막 문서까지 전진하므로 같은 손상 문서에서 무한 재시도하지 않는다.
- 통계 모달은 제외된 원격 기록 수를 알리고 정상 기록은 계속 표시한다.

### 정확한 cursor와 주기적 전체 감사

- cursor를 `(uploadedAtServer.seconds, uploadedAtServer.nanoseconds, documentId)` exact tuple로 저장하고 같은 Firestore `Timestamp`로 `startAfter`한다.
- 기존 unreleased millisecond cursor는 읽을 때 seconds·nanoseconds 형태로 변환하고 다음 write부터 새 형식만 저장한다.
- raw store 전체 삭제뿐 아니라 개별 session 손실도 회복할 수 있도록 마지막 full audit에서 7일이 지나면 cursor를 버리고 처음부터 authoritative hydration을 수행한다.
- 여러 page로 진행 중인 full audit 상태를 meta에 남겨 앱이 중간 종료돼도 마지막 exact cursor에서 이어 간다.

### canonical timeline

- 모든 유효 session을 먼저 서버 시각 표본으로 보정한 뒤 하나의 overlap timeline을 만든다.
- day/week/month 범위는 저장 당시의 신뢰할 수 없는 `localDate`로 session을 선필터하지 않고, 보정된 slice의 시작 시각과 해당 session timezone으로 계산한 canonical date에 적용한다.
- 상단 오늘·주·월 카드와 상세 도서·일별 행이 같은 winner와 canonical date를 사용한다.

### 통계 전용 상태

- 독서 통계 sync health를 progress·bookmark·annotation의 전역 `syncHealth`에서 분리했다.
- 재시도·인증·권한·schema 상태와 격리 문서 수는 독서 통계 모달 안에서만 안내한다.
- 핵심 동기화 경고는 기존 진행률·북마크·주석 상태만 나타낸다.

## retention finding 판정

장기 무제한 증가는 타당한 구조적 위험으로 수용했다. 다만 receipt·tombstone·outbox·불변 통계 문서를 지금 즉시 삭제하면 offline device 재등장, 삭제 부활 방지와 cloud recovery 계약이 바뀐다. 따라서 이번 hotfix에서는 임의 TTL이나 local-only 삭제를 넣지 않는다.

1.8.9 실사용 안정화에서 owner별 문서 수·IndexedDB 용량·오래된 device 재접속을 계측한다. 그 결과를 바탕으로 다음 개발선에서 다음을 하나의 migration으로 설계한다.

- ack된 outbox와 resolved conflict의 안전한 local compaction
- tombstone·receipt의 최소 보존 기간과 오래된 device watermark
- 통계 raw segment의 월별 immutable archive 또는 aggregate 전환
- export·복구·계정 삭제를 포함한 사용자 제어
- emulator migration, offline 장기 복귀와 rollback 검증

## 자동검증

- TypeScript: 통과
- reading statistics·local hydration 집중 Node 테스트: 통과
- 20,000 session O(n log n) 성능 회귀: 통과
- corrected cross-date headline/detail 일치: 통과
- nanosecond tuple cursor·손상 문서 격리·7일 full audit: 통과
- ESLint: hotfix 신규 오류 0, 기존 Foliate vendor 경고 2개
- Node: formats 58, drive 49, archives 33, storage 211, shelf 57, Service Worker 9, release 3 통과
- production build: 통과
- Firestore Rules: 26/26 통과
- Chromium/WebKit Playwright: 14/14 통과
- production Chrome regression: 통과
- 전체 `check:full`: 통과
- `git diff --check`: 통과

## 실기기 이관

- PC와 iPad의 시계·시간대를 다르게 두고 같은 시각에 화면/TTS 독서 후 오늘 합계와 상세 합계 비교
- 한 기기 offline session 업로드 뒤 다른 기기에서 전체 복원
- 통계 sync 장애가 발생해도 진행률·주석 동기화 경고가 정상 상태를 유지하는지 확인
- 최소 2~3일 사용 뒤 full audit 전후 합계가 변하지 않는지 확인
