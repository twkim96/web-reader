# Web Reader 1.8.11 — 도서 정보·플랫폼 메타데이터

작성일: 2026-08-14

기준 커밋: `3b8712d`

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

이전 버전: [update_1.8.10.md](./update_1.8.10.md)

상태: Phase A~G 구현, 자동검증, Firebase Rules 배포와 메타데이터 최초 게시 완료. 외부 코드 리뷰·실기기 확인 대기

## 목표

책장에서 도서를 길게 누르거나 우클릭했을 때 바로 삭제 확인창을 띄우지 않고, 통계 모달과 같은 크기의 도서 정보창을 연다. 정보창에서 파일·독서 상태와 외부 플랫폼 최신 메타데이터를 확인한 뒤 읽기 또는 삭제할 수 있게 한다.

`file_check`의 964MB 상태 DB와 플랫폼 크롤러는 Web Reader에 포함하지 않는다. 비정기 Python 게시기가 공개 가능한 최신값만 Firebase의 별도 읽기 전용 컬렉션으로 투영하고, Web Reader는 정보창을 열 때 버킷 문서 한 건만 조회한다.

## Phase A — 도서 정보 모달

- 책 카드의 650ms 길게 누르기와 데스크톱 우클릭이 도서 정보 모달을 연다.
- 손가락이 12px 넘게 움직이면 길게 누르기를 취소해 책장 스크롤을 방해하지 않는다.
- 정보창은 통계 모달과 같은 `min(90vw, 36rem)` 폭과 모바일 78dvh·큰 화면 82dvh 상한을 사용한다.
- 제목, 원본 파일명, 파일 형식, 파일 크기, 기기 저장 여부, 누적 독서 시간, 진행률, 최근 독서 시각을 표시한다.
- 저장 위치 정보 카드는 중복이므로 제거하고 로컬·클라우드 상태는 상단 badge로만 표시한다. 누적 독서 세션이 없으면 읽은 시간 값은 비워 둔다.
- `읽기`는 기존 도서 열기 경로를 사용한다.
- 휴지통을 누른 뒤 같은 정보창 안에서 삭제 영향을 다시 확인해야 `영구 삭제`가 실행된다.
- 삭제 중에는 닫기·중복 요청을 막고 기존 안전 삭제 순서와 owner fencing을 그대로 사용한다.

## Phase B — 공개 플랫폼 메타데이터

### 게시 구조

- 도구: `scripts/publish-book-metadata.py`
- 입력: `file_check/.dedup_state/dedup_decisions.sqlite3` read-only
- 기본 동작은 dry-run이며 `--apply`를 명시해야 Firebase를 수정한다.
- 실제 게시에는 `--project`가 필요하고, `--allow-create` 없이는 기존 문서만 갱신한다.
- 현재 normalizer `1.3.3`, `catalog_platform_stats.status == ok`, HTTPS 작품 URL, 마지막 성공 시각이 있는 행만 사용한다.
- 공개 필드는 플랫폼, 표시 제목, 작품 URL, 다운로드·관심·조회·추천·평점·평가 수와 마지막 성공 시각뿐이다.
- 파일 경로, 사용자 계정, 파일 hash, 원문, 메모, 중복 판정은 게시하지 않는다.

### 조회·비용 계약

- 파일명·core title·표시 제목 alias를 NFC/소문자/한글·영숫자·CJK 기준으로 정규화한 뒤 SHA-256한다.
- 서로 다른 작품으로 연결되는 alias는 추측하지 않고 제외한다. 현재 DB dry-run에서 충돌 alias 7건을 제외했다.
- SHA-256 앞 2자리로 256개 bucket 문서를 만든다. 현재 projection은 alias 27,053개, 약 21MB, bucket당 최대 약 105KB이다.
- Firestore 경로는 `publicBookMetadataV1/{hashPrefix}`이며 앱은 정보창을 열 때 정확한 bucket 한 건만 `get`한다.
- Rules는 단일 문서 공개 조회만 허용하고 collection list와 모든 클라이언트 쓰기를 거부한다.
- 정보창은 플랫폼 tag, 최신 수치, 게시 갱신일과 외부 HTTPS 링크를 표시한다. 조회 실패는 도서 정보·삭제 기능을 막지 않는다.
- 연결된 카카오페이지·네이버 시리즈·노벨피아를 파일 형식·기기 저장 badge 옆에도 표시한다.
- 작품 행은 기존 2줄 구조를 유지하되 주요 수치를 큰 첫 줄, 작품 제목을 작은 둘째 줄로 반전해 메타데이터 가독성을 높인다.

## Phase C — 통계 목록 정리

- 도서별 기록 행을 650ms 길게 누르거나 우클릭하면 선택한 회차 하나만 목록에서 삭제할 수 있다.
- 12px 넘게 움직이면 길게 누르기를 취소해 모바일 스크롤을 보존한다.
- 삭제는 잠깐 열어서 생긴 짧은 회차를 정리하기 위한 owner별 이 기기 표시 설정이며, 선택 시점의 session ID만 숨기고 원본 독서 session을 물리 삭제하지 않는다.
- 숨긴 session은 오늘·주·월·전체 합계와 Markdown/JSON 내보내기, 도서 정보·리더 누적 시간에서 제외해 표시값을 일치시킨다.
- 미완료 1회차를 숨긴 뒤 같은 책을 다시 읽으면 새 session이 1회차로 다시 나타난다.
- 완료 경계는 원본 session으로 보존하므로 이미 시작된 2회차는 1회차로 재번호화되지 않는다. 완료 처리를 하지 않은 다음 독서는 기존 회차에 계속 합산된다.

## Phase D — 탐색 모드 전환 복원

- paginated와 scrolled 모드는 서로 다른 스크롤 축을 사용한다.
- 모드 전환 시 이전 축의 `scrollLeft` 또는 `scrollTop`이 남아 현재 chapter iframe 전체가 화면 밖으로 밀리던 문제를 수정했다.
- Foliate paginator가 렌더할 때 현재 사용하지 않는 축만 0으로 초기화하고, 현재 위치 anchor와 활성 축의 위치는 그대로 보존한다.
- production browser regression이 실제 설정 UI에서 `L/R Tap → Scroll → L/R Tap`을 전환하고 각 단계에 보이는 본문 text rect가 존재하는지 검증한다.

## Phase E — 책장 길게 누르기 선택 충돌 제거

- 책장 도서 카드에서는 `user-select: none`과 WebKit touch callout 차단을 적용해 길게 누르기 정보창과 브라우저 기본 텍스트 선택 메뉴가 함께 열리지 않게 한다.
- 도서 정보 모달은 `user-select: text`를 명시해 제목·원본 파일명·작품 정보를 계속 선택하고 복사할 수 있다.
- 카드의 클릭·650ms 길게 누르기·12px 이동 취소와 데스크톱 우클릭 계약은 변경하지 않는다.

## Phase F — 최근 독서순 통계 목록

- 도서별 통계 회차는 선택한 기간에서 마지막으로 읽은 시각이 최신인 항목부터 표시한다.
- 다중 기기의 신뢰 가능한 clock correction을 반영한 session 종료 시각을 비교한다.
- 같은 시각이면 제목과 회차를 보조 기준으로 사용해 렌더 순서가 흔들리지 않게 한다.

## Phase G — 도서 정보 접근·삭제 범위·독서 인증

- 도서 정보 모달을 연 직후 브라우저가 programmatic focus에 기본 흰색 outline을 그리던 원인을 확인했다. 키보드·Back 접근성을 위한 focus는 유지하고 모달 root의 기본 outline만 제거한다.
- Google Drive 도서가 이 기기에도 저장된 경우 삭제 확인을 `로컬 삭제 / 전체 삭제 / 취소`로 분리한다.
  - `로컬 삭제`는 기기 content namespace의 파일·메타데이터·archive inspection만 지우고 계정 진행률·주석과 Drive 원본은 유지한다.
  - `전체 삭제`는 기존 Drive 삭제와 progress·annotation 정리 순서를 그대로 사용한다.
  - 로컬 전용 도서나 기기 사본이 없는 Drive 도서는 기존 `영구 삭제 / 취소`를 유지한다.
- 리더 메뉴의 상단 utility는 `듣기 → 통계 → 정보` 순서다. 정보 버튼은 현재 독서 session을 먼저 flush한 뒤 같은 도서 정보 모달을 열며, 리더에서는 `읽기`와 삭제 버튼을 노출하지 않는다.
- 도서 정보 모달 하단은 `읽기(가변 폭) → 독서 인증 아이콘 → 삭제 아이콘` 한 줄로 구성한다. 제목·진행률·독서 시간·작품 정보를 PNG로 렌더하고 하단 작업 버튼 영역은 이미지에서 제외한다.
- 웹 앱은 임의의 파일 시스템 경로를 지정하지 않고 Blob URL과 `download` 속성을 사용하므로, PNG는 브라우저가 설정한 기본 다운로드 위치로 저장된다. iPad Safari가 data URL을 빈 탭으로 여는 경로를 피한다.

## Phase H — 챕터 경계 이전 페이지 복원

- 새 section iframe은 column 확장이 ResizeObserver로 반영되기 전에 잠시 sentinel 2페이지만 가진다. 이 시점에 이전 장 끝 `fraction=1`을 계산하면 첫 페이지 anchor로 잘못 고정되어 여러 페이지 앞쪽으로 이동할 수 있었다.
- section load 직후 초기 column geometry를 동기 확장하고, 이전 방향의 목적지는 숫자 `fraction=1` 대신 마지막으로 렌더되는 비공백 문자 Range(텍스트가 없으면 마지막 media)로 잡는다. 이후 font·resize 재확장도 이 Range anchor를 유지한다.
- 제품 버전과 Service Worker cache 이름은 1.8.11을 유지하되 Foliate entry와 paginator import에 런타임 리비전 `1.8.11.1`을 붙인다. 이미 1.8.11을 설치한 PWA도 같은 cache의 구형 모듈을 재사용하지 않고 수정된 paginator를 받는다.
- 여러 페이지인 이전 장의 끝 marker와 다음 장 첫 페이지를 구성한 Chromium·WebKit 회귀에서 이전 페이지 1회가 끝 marker가 보이는 페이지로 돌아오는지 확인한다.

## 메타데이터 최신화 운영

예시 dry-run:

```bash
python3 scripts/publish-book-metadata.py \
  --output /tmp/web-reader-book-metadata.jsonl
```

실제 게시 전 필수 순서:

1. `file_check` 플랫폼 카탈로그를 비정기 갱신한다.
2. 게시기 dry-run의 문서 수·충돌 수·bucket 최대 크기를 확인한다.
3. Firebase Rules를 먼저 배포하고 공개 단건 읽기·목록 금지·클라이언트 쓰기 금지를 확인한다.
4. 서비스 계정 또는 ADC로 `--apply --project <project> --allow-create`를 실행한다.
5. 이후 갱신은 `--allow-create` 없이 기존 256개 bucket만 업데이트한다.

운영 주의: 현재 게시기는 업서트만 하므로 alias 제거가 필요한 schema 변경에서는 새 컬렉션 버전으로 교체한다. 클라이언트에서 플랫폼 사이트를 실시간 크롤링하지 않는다.

## 자동검증

- 도서 정보 모달 크기·필드·focus outline 제거·삭제 2단계 확인 browser regression
- 독서 인증 캡처 root의 작업 영역 제외, 실제 PNG Blob 생성·크기·비투명 픽셀 확인 browser regression
- 리더 utility `듣기 → 통계 → 정보` 순서 및 관리 버튼 없는 정보창 browser regression
- 로컬 사본만 삭제할 때 계정 progress·annotation을 보존하는 storage regression
- 실제 설정 UI의 탭·스크롤 왕복 전환 후 본문 표시 browser regression
- 책장 카드의 선택·touch callout 차단과 도서 정보 모달의 텍스트 선택 허용 browser regression
- 통계 회차의 최근 독서순 정렬 Node·browser regression
- 공개 메타데이터 alias 정규화·schema·HTTPS URL 검증
- 게시기 전체 DB dry-run: 256 bucket, alias 27,053개, 충돌 7개 제외
- Firestore Rules: 비로그인·로그인 단건 읽기 허용, list·create·update·delete 거부
- `npm run check:full`
- `git diff --check`

현재 working tree에서 `npm run check:full`과 `git diff --check`가 통과했다. 게시기는 실제 Firebase를 수정하지 않는 전체 DB dry-run으로 256개 bucket과 alias 27,053개를 만들고, 서로 다른 작품으로 연결되는 충돌 alias 7개를 제외하는 것을 확인했다.

Firebase Rules는 2026-08-14에 `web-novel-viewer` 프로젝트로 배포했다. 같은 날 전체 DB projection 256개 bucket과 alias 27,053개를 최초 게시했으며, 공개 단건 조회에서 bucket `00`의 93개 entry와 카카오페이지 표본을 확인했다. 충돌 alias 7개는 게시하지 않았다.

## 실기기 확인

- Android·iPad에서 길게 누르기와 세로 스크롤이 충돌하지 않는지 확인한다.
- 정보창의 제목·원본 파일명·정보 카드·삭제 확인이 좁은 모바일에서 넘치지 않는지 확인한다.
- 로컬 도서와 Drive 도서의 삭제 영향 문구 및 실제 삭제 범위가 맞는지 확인한다.
- Android·iPad에서 도서 정보창을 열 때 흰 focus 테두리가 다시 나타나지 않는지 확인한다.
- Drive 도서의 로컬 사본만 삭제한 뒤 다시 열면 재다운로드되고 기존 진행률·주석이 남는지 확인한다.
- Android Chrome·iPad Safari·설치형 PWA에서 독서 인증 PNG가 기본 다운로드 위치 또는 시스템 다운로드 UI로 전달되는지 확인한다.
- 포인트 색상을 바꿔도 정보창의 강조색이 설정을 따르는지 확인한다.
- Firebase 게시 후 실제 카카오페이지·네이버 시리즈·노벨피아 tag와 수치·링크가 맞는지 표본 확인한다.
