# Web Reader 1.8.4-hotfix.1 동기화 충돌·대량 주석 안정화

작성일: 2026-08-09

기준 커밋: `74fdadc` (`feat(annotations): add library search and exports`)

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: 코드·전체 자동검증 완료, 커밋·push·실기기 검증 대기

## 목표

1.8.4 외부 리뷰에서 재현된 진행률·주석 충돌 경계를 수정하고, 대량 주석 화면이 숨겨진 동안 불필요한 조회·인덱싱·export 생성을 멈추며 동일 제목 도서를 사용자와 내보내기 결과에서 구분한다.

## 리뷰 판정

| finding | 판정 | 처리 |
| --- | --- | --- |
| passive 원격 `progress.reset` 무시 | 수용 | 원격 update에 `set`·`reset` operation을 명시하고 reset 수락·거절을 영속화 |
| keep-local 뒤 `knownRevision` 미갱신 | 수용 | 기존 target의 progress·bookmark·annotation·palette meta를 원격 revision으로 rebase |
| 동일 conflict 중복 해결 | 수용 | IndexedDB resolver 상태 guard와 UI resolving lock 추가 |
| 무시한 원격 revision이 다음 저장에서 소실 | 수용 | 일반 저장에서 marker 보존, local progress가 없어도 placeholder row에 기록 |
| 오래된 inactive conflict가 활성 도서를 가림 | 수용 | 활성 도서 progress → bookmark·annotation → 나머지 순서로 선택 |
| transient annotation 오류가 schema 오류로 변환 | 수용 | parse·identity 실패만 schema 오류로 분류하고 authoritative 단건 조회를 8개씩 제한 |
| 동일 제목 도서의 주석 혼합 | 수용 | 제목 다음 book ID로 정렬·그룹화하고 UI와 Markdown에서 구분 |
| 숨겨진 전체 주석 modal의 대량 작업 지속 | 수용 | hidden 상태에서 subscription·reload·index를 중지하고 export를 사용자 동작 시 생성 |
| modal scroll·접근성·공유 runtime fallback | 수용 | body lock, dialog semantics, focus trap, Escape, 공유 capability 오류 다운로드 fallback |
| JSON v2에 도서 fingerprint 추가 | 보류 | 1.8.4는 import·merge를 포함하지 않으므로 복구 연결 규약과 함께 후속 버전에서 설계 |
| 검색 index Web Worker·증분 cache | 보류 | hidden 작업 제거 후 실기기·대량 fixture 성능 증거가 생길 때 별도 최적화 |

## 구현 결과

- `RemoteProgressUpdate`가 원격 progress head의 `set`·`reset`을 reader까지 보존한다.
- 초기 local 위치가 없는 reset은 첫 페이지로 조용히 적용하고, 기존 위치가 있으면 `현재 위치 계속 읽기 / 읽기 기록 초기화` 선택을 표시한다.
- reset 수락은 원격 revision과 함께 local progress·save baseline을 0%로 rebase한 뒤 첫 위치로 이동한다.
- reset·set 거절 marker는 progress row가 아직 없어도 저장하며, 일반 페이지 저장이 marker를 보존한다.
- keep-local replacement와 같은 transaction에서 기존 target `knownRevision`을 authoritative remote revision으로 올린다. 원격 삭제 bookmark를 새 ID로 복원하는 target만 revision 0을 유지한다.
- progress·bookmark·annotation·palette resolver는 이미 해결된 conflict를 다시 실행하면 `null`을 반환한다. dialog 작업 중에는 모든 해결 버튼을 비활성화한다.
- reader가 연 책의 progress conflict revision을 전체 conflict 목록에서 직접 찾으며, 전역 dialog도 활성 도서 conflict를 먼저 표시한다.
- annotation snapshot은 schema parse·document identity 오류만 `invalid-argument`로 바꾼다. 네트워크·Firestore·IndexedDB 오류 code는 보존해 recovery가 재시도한다.
- 동일 제목 도서는 `name → bookId → reading order`로 정렬하고 Markdown section을 book ID별로 한 번만 만든다. 필터와 결과에는 format·size·짧은 ID를 붙인다.
- 전체 주석 modal이 reader 뒤에 숨으면 Firestore/IndexedDB wake subscription과 index 생성을 멈추고, shelf 복귀 시 한 번 다시 읽는다.
- Markdown·JSON 파일과 대형 `File` 객체는 render 중 만들지 않고 다운로드·공유를 누를 때만 생성한다.
- modal은 body scroll lock, `role=dialog`, `aria-modal`, 초기 포커스·focus trap·Escape·포커스 복귀를 적용한다.
- Web Share가 존재해도 `NotSupportedError`, `InvalidStateError`, `TypeError`로 파일 공유를 거부하면 다운로드로 fallback한다.

## 집중 자동검증

- remote reset의 initial quiet apply, 기존 위치 prompt, 오래된 revision 무시
- verified reset local adoption과 outbox 미생성
- progress·annotation keep-local 직후 다음 event revision chain
- progress·annotation resolver 재실행 멱등성
- local progress가 없는 ignored revision 영속화
- inactive bookmark보다 active-book progress conflict 우선
- 동일 제목 book ID별 검색 정렬·Markdown section·JSON 순서
- Web Share runtime `NotSupportedError` 다운로드 fallback
- `npm run typecheck`: 통과
- `npm run lint`: 오류 0, 기존 Foliate vendor 경고 2
- `npm run test:shelf`: 33/33 통과
- `npm run test:storage`: 187/187 통과

## 전체 자동검증 결과

| 검증 | 결과 |
| --- | ---: |
| ESLint | 오류 0, 기존 Foliate vendor 경고 2 |
| TypeScript | 통과 |
| Node formats | 58/58 |
| Node drive | 49/49 |
| Node archives | 33/33 |
| Node storage | 187/187 |
| Node shelf | 33/33 |
| Service Worker | 9/9 |
| release metadata | 2/2 |
| Node 합계 | 371/371 |
| production build | 통과 |
| Firestore Rules emulator | 22/22 |
| Chromium/WebKit Playwright | 12/12 |
| production Chrome regression | 통과 |
| `git diff --check` | 통과 |

`npm run check:full` 전체가 통과했다. production browser regression에서 Markdown 시스템 공유 성공, runtime `NotSupportedError` 다운로드 fallback, API 미지원 다운로드 fallback을 각각 확인했다.

## 실기기 대기

- PC에서 읽기 기록 reset 후 iPad의 기존 위치에서 prompt·수락·거절·재실행 확인
- 두 탭에서 같은 conflict 해결 버튼을 거의 동시에 실행해 replacement 중복이 없는지 확인
- keep-local 뒤 다음 페이지 저장이 충돌 modal을 다시 만들지 않는지 확인
- iPad에서 전체 주석 modal의 배경 scroll·focus·Escape/Back 경계 확인
- 동일 제목·동일 포맷 도서의 필터와 Markdown 구분 확인
- iPad Safari/PWA의 시스템 공유 거부 시 다운로드 fallback 확인

## 제외

- JSON import·merge와 book fingerprint 연결 정책
- 검색 전용 Web Worker·영구 증분 index
- 서버 전문 검색
