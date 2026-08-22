# Web Reader 공개 도서 메타데이터 게시

## 역할 경계

- `file_check`가 크롤링·검증한 플랫폼 메타데이터의 원본은
  `/Users/twkim/Documents/GitHub/python/test/file_check/.dedup_state/dedup_decisions.sqlite3`이다.
- Web Reader 게시기는 이 SQLite를 `mode=ro`로 열어 SELECT만 수행한다.
- 게시기는 `file_check` 크롤러, backfill, schema migration을 실행하지 않는다.
- Firestore에는 상세 정보용 `publicBookMetadataV1`과 책장 필터·정렬용
  `publicBookCatalogIndexV1` projection만 게시한다.
- 요청형 `publicBookMetadataOnDemandV1`과 `publicBookCatalogDeltaV1`은 삭제하거나 덮어쓰지 않는다.

## Control Server 경로

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

기존 256개 상세 bucket은 이미 생성되어 있으므로 정기 갱신에서는 `--allow-create`를 사용하지 않는다.
compact catalog는 새 immutable generation을 생성·검증한 뒤 manifest를 마지막에 전환한다.

## `file_check` 원본을 먼저 갱신해야 할 때

Control Server의 `file_check` Action Group은 SQLite 원본을 갱신하는 별도 작업이다.

- `플랫폼 인기 DB 업데이트`: 신규 작품과 미수집 플랫폼·장르·태그 수집
- `기존 플랫폼 인기값 갱신`: 이미 성공한 작품의 증가한 조회·다운로드·추천 수 갱신
- `플랫폼 실패 결과 재검사`: 명시적으로 실패 상태를 다시 조회할 때만 실행

원본이 이미 최신이면 이 작업들은 생략하고 Web Reader 게시만 실행한다.
