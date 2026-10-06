# Web Reader 공개 도서 메타데이터 게시

## 역할 경계

- `file_check`가 크롤링·검증한 플랫폼 메타데이터의 원본은
  `/Users/twkim/Documents/GitHub/python/test/file_check/.dedup_state/dedup_decisions.sqlite3`이다.
- Web Reader 게시기는 이 SQLite를 `mode=ro`로 열어 SELECT만 수행한다.
- 게시기는 `file_check` 크롤러, backfill, schema migration을 실행하지 않는다.
- Firestore에는 상세 정보용 `publicBookMetadataV1`과 책장 필터·정렬용
  `publicBookCatalogIndexV1` projection만 게시한다.
- 요청형 `publicBookMetadataOnDemandV1`과 `publicBookCatalogDeltaV1`은 삭제하거나 덮어쓰지 않는다.

## 미리보기와 게시

게시기는 기본 dry-run이며 원본 SQLite를 읽기 전용으로 열고 외부 쓰기를 하지 않습니다. 먼저 저장소 루트에서 `python3 scripts/publish-book-metadata.py --database <원본-SQLite-경로>`로 projection을 확인합니다. CLI 옵션과 기본 원본 경로는 `scripts/publish-book-metadata.py`가 기준입니다. 실제 게시에는 `--apply --project <대상-project-id>`와 Admin 권한이 필요합니다. 인증 변수의 설정 방법은 [개발 가이드](../development/setup-and-checks.md)에 있습니다.

## Control Server 경로

아래는 기존 로컬 운영 연결입니다. Control Server Action 설정은 이 문서 초기화에서 재확인하지 않았으므로 실행 전 Action의 cwd·명령·대상 프로젝트를 확인합니다.

`http://127.0.0.1:9000`의 `Services` 탭에서 `Web Reader` Action Group을 연다.

1. `도서 메타데이터 게시 미리보기`로 문서 수, 충돌 수, generation과 최대 문서 크기를 확인한다.
2. 실제 게시 Action의 환경변수에 아래 둘 중 하나를 설정한다.
   - `FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON`: 한 줄 JSON 서비스 계정 값
   - `GOOGLE_APPLICATION_CREDENTIALS`: 로컬 서비스 계정 JSON의 절대 경로
3. `도서 메타데이터 Firestore 게시`를 실행한다.
4. Web Reader를 다시 열거나 새로고침해 새 manifest generation을 읽는다.

실제 게시 Action은 다음 명령과 같다.

```bash
/opt/anaconda3/bin/python3 -u scripts/publish-book-metadata.py \
  --apply \
  --project web-novel-viewer
```

기존 운영 기록에는 256개 상세 bucket이 생성되어 있다. 실제 대상의 기존 문서를 확인한 정기 갱신에서는 `--allow-create`를 사용하지 않는다. 최초 생성이 필요하면 dry-run 결과와 대상 프로젝트를 먼저 확인한다.
compact catalog는 새 immutable generation을 생성·검증한 뒤 manifest를 마지막에 전환한다.

## `file_check` 원본을 먼저 갱신해야 할 때

Control Server의 `file_check` Action Group은 SQLite 원본을 갱신하는 별도 작업이다.

- `플랫폼 인기 DB 업데이트`: 신규 작품과 미수집 플랫폼·장르·태그 수집
- `기존 플랫폼 인기값 갱신`: 이미 성공한 작품의 증가한 조회·다운로드·추천 수 갱신
- `플랫폼 실패 결과 재검사`: 명시적으로 실패 상태를 다시 조회할 때만 실행

원본이 이미 최신이면 이 작업들은 생략하고 Web Reader 게시만 실행한다.

## 검증과 문서

`npm run test:publisher`가 projection 생성 계약을 검사합니다. dry-run·fixture 검사와 실제 Firestore 게시 성공은 구분합니다. 공개 API와 base/delta 소유권은 [연동 계약](../integrations/book-metadata.md), 운영 진입점은 [문서 지도](../SPEC.md)에 있습니다.
