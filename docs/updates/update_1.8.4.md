# Web Reader 1.8.4 라이브러리 전체 주석 검색·내보내기

작성일: 2026-08-09

기준 커밋: `4e9264a` (`fix(sync): complete 1.8.3 hotfix stabilization`)

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: 코드·전체 자동검증·외부 리뷰 완료, 리뷰 후속 hotfix.1과 실기기 검증 대기

## 목표

로컬에 수화된 하이라이트와 메모를 책을 열지 않고 서재 전체에서 검색하고, 사람이 읽을 수 있는 Markdown과 복구 가능한 versioned JSON으로 내보낸다.

## 포함

- 원문·메모·장·책 제목·팔레트 의미 통합 검색
- 책·색상·메모 유무 필터와 정렬
- 결과에서 해당 책과 CFI 범위로 이동하고 서재 복귀 시 검색 상태 유지
- 단일 책·전체 라이브러리 Markdown export
- 모든 annotation 필드와 팔레트를 보존하는 JSON v1 export
- 파일 다운로드와 Web Share 파일 공유
- 네트워크가 없어도 동작하는 IndexedDB local export

## 데이터 정책

- 현재 `annotations-v8`에 존재하는 annotation만 검색·내보낸다.
- 원격 tombstone과 outbox 내부 기록은 사용자 문서에 포함하지 않는다.
- `anchorState: unresolved` 항목은 삭제하지 않고 `위치 확인 필요` 상태로 포함하며 이동만 막는다.
- 현재 서재에 없는 orphan annotation도 검색·export에는 포함하되 책 열기는 막고 book ID를 표시한다.
- JSON import·merge는 1.8.4 범위에서 제외한다.

## 구현 단계

1. owner 전체 annotation과 canonical palette read API
2. normalized library search index와 필터·정렬
3. Markdown serializer와 JSON v1 validator·serializer
4. download/share adapter
5. shelf modal과 reader one-shot annotation jump
6. 자동검증과 실기기 대기 항목 기록

## 구현 결과

- `annotations-v8`의 `by-owner` index로 현재 owner의 모든 로컬 주석을 읽는다.
- 책 제목·원문·메모·장·팔레트 라벨과 의미를 NFKC 정규화한 검색 index를 만든다.
- 서재 상단의 형광펜 버튼에서 전체 주석 modal을 열고 책·색상·메모 유무 필터, 세 가지 정렬과 100개 단위 더 보기를 제공한다.
- 정상 anchor는 해당 책을 열고 range CFI로 한 번만 이동한 뒤 하이라이트를 flash한다.
- 리더에서 서재로 돌아오면 modal의 검색어·필터·정렬 상태가 유지된다.
- Markdown은 책·독서 순서로 정렬하고 원문·메모의 개행, Markdown 기호와 emoji를 보존한다.
- JSON v1은 format·version·scope·책·팔레트·annotation 전체 필드를 보존하며 exact-key validator로 다시 파싱한다.
- JSON validator는 알 수 없는 필드, 잘못된 단일 책 scope, 중복 annotation key를 거부한다.
- Web Share 파일 공유가 없거나 파일 공유를 지원하지 않으면 동일 파일 다운로드로 fallback한다.
- export는 현재 수화된 IndexedDB 데이터만 읽으므로 네트워크가 없어도 생성할 수 있다.

## 자동검증

- cross-book owner 격리와 orphan 조회
- 한글 NFKC 부분 검색, 책·색상·메모 필터, 정렬
- 따옴표·개행·Markdown 기호·emoji 보존
- JSON export self-parse와 unknown field rejection
- download/share capability fallback
- 결과 이동 command 소비와 shelf modal 상태 유지
- `npm run check:full`: 통과
  - ESLint 오류 0, 기존 Foliate vendor 경고 2
  - TypeScript 통과
  - formats 58/58, drive 49/49, archives 33/33
  - storage 182/182, shelf 32/32, Service Worker 9/9, release 2/2
  - production build 통과
  - Firestore Rules 22/22
  - Chromium/WebKit Playwright 12/12
  - production Chrome regression 통과
- production browser regression에서 전체 검색, JSON 다운로드, Markdown 시스템 공유, 공유 미지원 다운로드 fallback, 결과 이동과 서재 복귀 후 검색 상태 복원을 확인했다.
- `git diff --check`: 통과

## 리뷰 후속

- 외부 리뷰의 동기화 release blocker와 검색·내보내기 P2를 검토했다.
- 타당한 finding은 [1.8.4-hotfix.1](./update_1.8.4-hotfix.1.md)에서 수정·재검증한다.
- JSON v2 book fingerprint와 검색 Web Worker는 import·merge 또는 실기기 성능 증거가 있는 후속 버전으로 보류한다.

## 실기기 대기

- Android/iPad의 전체 주석 검색 스크롤
- iPad Safari/PWA 파일 다운로드와 시스템 공유
- 결과 이동 후 Back으로 검색 상태 복귀
- offline 상태의 검색·내보내기
