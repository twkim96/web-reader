# Web Reader 1.8.3-hotfix.1 동기화 데이터 안전성 보강

작성일: 2026-08-08

기준 커밋: `f6d5780` (`fix(reader): shorten annotation undo window`)

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: 구현·전체 자동검증·누적 hotfix 커밋 완료, push·Rules 배포·실기기 검증 대기

## 목표

1.8.3의 annotation·palette 동기화 계약을 유지하면서 코드 리뷰에서 확인된 로컬 도서 식별자 충돌, 삭제 인과관계의 기기 시각 의존, aggregate 크기 초과, 삭제 intent 오류 전파와 tombstone read 증폭을 안정화한다.

## 리뷰 판정

| finding | 판정 | 처리 |
| --- | --- | --- |
| 같은 파일명의 로컬 도서가 동일 ID로 덮어써짐 | 수용 | 파일명과 독립된 로컬 도서 ID 사용 |
| 삭제 마커가 서로 다른 기기의 `Date.now()`를 비교함 | 수용 | 서버 marker revision 기반 book generation 도입 |
| 유효한 aggregate가 Firestore 1MiB를 초과할 수 있음 | 수용 | 기존 CFI 계약을 유지하고 aggregate 증가에 byte budget 적용 |
| 한 삭제 intent 오류가 뒤 intent를 차단함 | 수용 | intent별 오류 격리·backoff·상태 기록 |
| tombstone·receipt 누적과 전체 collection read | 부분 수용 | 활성 head만 조회하도록 변경, 물리 compaction은 신뢰 가능한 서버 작업으로 분리 |

## 범위

- 신규 로컬 import의 충돌 없는 ID
- annotation event가 생성 시점의 book generation을 보존
- 삭제 marker revision과 다른 오래된 upsert 차단
- 공식 클라이언트가 Firestore 문서 한도를 넘는 aggregate를 만들지 않도록 증가 쓰기를 사전 차단
- 기존의 긴 CFI와 이미 큰 aggregate는 읽을 수 있고, 삭제·축소 mutation으로 정상화 가능
- 삭제 intent별 독립 재시도
- active annotation listener와 삭제 reconciliation의 전체 tombstone scan 제거
- 활성 query에서 빠진 기존 remote head만 개별 확인해 오프라인 중 발생한 삭제를 복원
- package, Service Worker, Foliate runtime을 `1.8.3-hotfix.1`로 갱신

## 제외

- 기존 파일명 ID 도서의 강제 마이그레이션
- 동일 콘텐츠 자동 중복 제거
- client 권한으로 tombstone·receipt 물리 삭제
- Cloud Functions 또는 관리자 compactor 신규 배포
- 1.8.4 검색·내보내기 기능

## 완료 조건

- 같은 이름의 서로 다른 로컬 파일이 콘텐츠·진행률·주석 namespace를 공유하지 않는다.
- 미래 시각을 가진 삭제 전 event도 marker generation이 오래되면 서버에서 거부된다.
- 신규 aggregate 증가는 안전 byte budget 안에 머물고 기존 oversized aggregate의 삭제·축소는 막지 않는다.
- 한 삭제 intent가 실패해도 다른 책의 reconciliation은 계속된다.
- 책을 열거나 삭제를 재조정할 때 과거 tombstone 전체를 읽지 않는다.
- 기존 progress·bookmark와 annotation revision·receipt 계약이 회귀하지 않는다.

## 검증 계획

- 로컬 동일 파일명 import·저장 독립성
- generation capture·marker 증가·stale/fresh Rules transaction
- worst-case aggregate byte 증가 차단과 legacy oversized aggregate 축소
- 첫 intent 실패 뒤 두 번째 intent tombstone enqueue
- active-only listener, cached-active 누락 head 확인, authoritative active-head fetch
- `npm run check:full`
- `git diff --check`

## 물리 compaction 후속 경계

Firestore tombstone과 immutable receipt의 물리 삭제는 현재 사용자 클라이언트 Rules 권한으로 수행하지 않는다. 신뢰 가능한 관리자 실행 주체, checkpoint, replay 안전 기간과 장애 복구 계약을 먼저 설계해야 하므로 이번 hotfix에서는 초기 read 비용을 활성 head 수에 비례하도록 바꾸고 서버 저장 공간 compaction은 별도 유지보수 작업으로 남긴다.

## 자동검증 결과

- ESLint: 오류 0, 기존 vendored Foliate 경고 2건
- TypeScript: 통과
- Node: formats 58/58, drive 49/49, archives 33/33, storage 164/164, shelf 32/32, Service Worker 9/9, release 2/2
- production build: 통과
- Firestore Rules emulator: 22/22
- Playwright Chromium/WebKit: 12/12
- production Chrome regression: 통과
- `git diff --check`: 통과

실기기 PC↔Android/iPad/PWA 동기화와 새 Rules의 실제 배포는 push 전 별도로 진행한다.
