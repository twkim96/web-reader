# Web Reader 1.8.11 — 도서 정보·플랫폼 메타데이터

작성일: 2026-08-14

기준 커밋: `3b8712d`

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

이전 버전: [update_1.8.10.md](./update_1.8.10.md)

상태: Phase A·B 구현 및 자동검증 완료. 외부 코드 리뷰·Firebase Rules 배포·메타데이터 최초 게시·실기기 확인 대기

## 목표

책장에서 도서를 길게 누르거나 우클릭했을 때 바로 삭제 확인창을 띄우지 않고, 통계 모달과 같은 크기의 도서 정보창을 연다. 정보창에서 파일·독서 상태와 외부 플랫폼 최신 메타데이터를 확인한 뒤 읽기 또는 삭제할 수 있게 한다.

`file_check`의 964MB 상태 DB와 플랫폼 크롤러는 Web Reader에 포함하지 않는다. 비정기 Python 게시기가 공개 가능한 최신값만 Firebase의 별도 읽기 전용 컬렉션으로 투영하고, Web Reader는 정보창을 열 때 버킷 문서 한 건만 조회한다.

## Phase A — 도서 정보 모달

- 책 카드의 650ms 길게 누르기와 데스크톱 우클릭이 도서 정보 모달을 연다.
- 손가락이 12px 넘게 움직이면 길게 누르기를 취소해 책장 스크롤을 방해하지 않는다.
- 정보창은 통계 모달과 같은 `min(90vw, 36rem)` 폭과 모바일 78dvh·큰 화면 82dvh 상한을 사용한다.
- 제목, 원본 파일명, 파일 형식, 파일 크기, 저장 위치, 기기 저장 여부, 진행률, 최근 독서 시각을 표시한다.
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

- 도서 정보 모달 크기·필드·삭제 2단계 확인 browser regression
- 공개 메타데이터 alias 정규화·schema·HTTPS URL 검증
- 게시기 전체 DB dry-run: 256 bucket, alias 27,053개, 충돌 7개 제외
- Firestore Rules: 비로그인·로그인 단건 읽기 허용, list·create·update·delete 거부
- `npm run check:full`
- `git diff --check`

현재 working tree에서 `npm run check:full`과 `git diff --check`가 통과했다. 게시기는 실제 Firebase를 수정하지 않는 전체 DB dry-run으로 256개 bucket과 alias 27,053개를 만들고, 서로 다른 작품으로 연결되는 충돌 alias 7개를 제외하는 것을 확인했다.

실제 Rules 배포와 메타데이터 `--apply`는 외부 코드 리뷰 뒤 별도 운영 단계로 남긴다. 자동검증 통과만으로 공개 데이터를 배포하지 않는다.

## 실기기 확인

- Android·iPad에서 길게 누르기와 세로 스크롤이 충돌하지 않는지 확인한다.
- 정보창의 제목·원본 파일명·정보 카드·삭제 확인이 좁은 모바일에서 넘치지 않는지 확인한다.
- 로컬 도서와 Drive 도서의 삭제 영향 문구 및 실제 삭제 범위가 맞는지 확인한다.
- 포인트 색상을 바꿔도 정보창의 강조색이 설정을 따르는지 확인한다.
- Firebase 게시 후 실제 카카오페이지·네이버 시리즈·노벨피아 tag와 수치·링크가 맞는지 표본 확인한다.
