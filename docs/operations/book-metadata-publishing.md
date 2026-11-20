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

게시기는 기본 dry-run이며 원본 SQLite를 읽기 전용으로 열고 외부 쓰기를 하지 않습니다. 먼저 저장소 루트에서 `python3 scripts/publish-book-metadata.py --database <원본-SQLite-경로>`로 projection을 확인합니다. CLI 옵션과 기본 원본 경로는 [publish-book-metadata.py](../../scripts/publish-book-metadata.py)가 기준입니다. 실제 게시에는 `--apply --project <대상-project-id>`와 Admin 권한이 필요합니다. 인증 변수의 설정 방법은 [개발 가이드](../development/setup-and-checks.md)에 있습니다.

## 도서 탐색 인덱스

로컬에서 공개 탐색 인덱스를 생성합니다.

```bash
python3 scripts/publish-book-metadata.py --discovery-output public/catalog/discovery.v1.json
```

게시기는 같은 SQLite 읽기 스냅샷에서 공개 작품 키·제목·표지 URL·플랫폼 링크·장르·태그·정렬 수치를 뽑습니다. 로컬 파일명 별칭과 독서 기록은 출력 범위 밖입니다. `schemaVersion`은 파일 형식, `generation`은 공개 인덱스 내용의 해시입니다. 출력 내용이 같으면 생성 시각이 달라도 같은 파일이 나옵니다. 요약에 표시되는 generation, 작품 수와 크기를 확인합니다.

Firestore 게시와 탐색 갱신을 함께 할 때는 승인된 기존 `--apply` 명령에 `--discovery-output public/catalog/discovery.v1.json`을 추가해 한 번 실행합니다. Firestore 게시 성공과 생성 파일을 확인한 뒤, 인덱스 파일을 포함한 앱을 Vercel에 배포합니다. 탐색 인덱스는 새로 배포된 앱 버전이 제공하며, PWA는 해당 버전에서 처음 받아온 뒤 정적 캐시에 보관할 수 있습니다. Firebase 상세 문서와 책장용 compact catalog는 기존 경로를 사용합니다.

## Control Server 경로

`http://127.0.0.1:9000`의 `Services` 탭에서 `Web Reader` Action Group을 엽니다.

1. **도서 메타데이터 게시 미리보기**로 문서 수, 충돌 수, generation과 최대 문서 크기를 확인합니다.
2. **도서 메타데이터 게시 + 프리뷰 배포**를 실행합니다. [프리뷰 게시 스크립트](../../scripts/publish-book-metadata-preview.py)가 Firestore의 `web-novel-viewer` 프로젝트에 게시하고, 같은 SQLite 읽기 스냅샷으로 탐색 인덱스를 생성합니다.
3. Firestore 게시가 성공하면 인덱스를 로컬에 보관하고, 별도 작업 공간에서 인덱스 파일만 `preview/mypage`에 커밋·푸시합니다. 파일이 동일하면 새 커밋을 만들지 않습니다. Vercel 빌드가 성공하고 대상 커밋이 여전히 프리뷰 브랜치의 최신이면 완료를 기록합니다.
4. 서재는 새 Firestore manifest를 읽고, 마이페이지 도서목록은 [프리뷰](https://twreader-git-preview-mypage-twkims-projects-b9c7f5a3.vercel.app/#mypage)의 새 인덱스를 읽습니다.

Action은 로컬 `/Users/twkim/Documents/web_reader`의 게시 스크립트를 실행합니다. Firestore 인증 환경변수는 실제 게시 프로세스에 전달하며 Git·GitHub CLI에서는 제외합니다. `FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON`에 서비스 계정 JSON을 넣거나 `GOOGLE_APPLICATION_CREDENTIALS`에 로컬 서비스 계정 JSON의 절대 경로를 설정합니다. 실행 계정에는 GitHub 프리뷰 브랜치 푸시 권한과 `gh` 로그인이 필요합니다.

Firestore 게시 뒤 프리뷰 푸시나 배포 확인이 실패하면 같은 버튼으로 저장된 인덱스에서 재개합니다. 이때 SQLite 재조회와 Firestore 재게시는 생략합니다. 보관 파일이 없고 Firestore 게시를 별도로 마쳤다면 다음 명령으로 현재 SQLite에서 프리뷰 인덱스를 갱신할 수 있습니다. 두 단계 사이에 원본이 바뀌었다면 통합 게시를 실행합니다.

```bash
/opt/anaconda3/bin/python3 -u scripts/publish-book-metadata-preview.py --preview-only
```

Vercel 빌드가 실패하면 로그에 표시된 커밋을 Vercel에서 재배포한 뒤 버튼을 다시 눌러 완료를 확인합니다. 상태 조회의 일시 오류는 기존 확인 시간 안에서 재시도합니다.

기존 운영 기록에는 256개 상세 bucket이 생성되어 있다. 실제 대상의 기존 문서를 확인한 정기 갱신에서는 `--allow-create`를 사용하지 않는다. 최초 생성이 필요하면 dry-run 결과와 대상 프로젝트를 먼저 확인한다.
compact catalog는 새 immutable generation을 생성·검증한 뒤 manifest를 마지막에 전환한다.

## `file_check` 원본을 먼저 갱신해야 할 때

Control Server의 `file_check` Action Group은 SQLite 원본을 갱신하는 별도 작업이다.

- `플랫폼 인기 DB 업데이트`: 신규 작품과 미수집 플랫폼·장르·태그 수집
- `기존 플랫폼 인기값 갱신`: 이미 성공한 작품의 증가한 조회·다운로드·추천 수 갱신
- `플랫폼 실패 결과 재검사`: 명시적으로 실패 상태를 다시 조회할 때만 실행

원본이 이미 최신이면 이 작업들은 생략하고 Web Reader 게시만 실행한다.

## 검증과 문서

`npm run test:publisher`의 [test_public_book_catalog.py](../../tests/test_public_book_catalog.py)는 [public_book_catalog.py](../../scripts/public_book_catalog.py)와 게시 스크립트를 직접 불러 projection 생성·게시 계약을 검사합니다. dry-run·fixture 검사와 실제 Firestore 게시 성공은 구분합니다. 공개 API와 base/delta 소유권은 [연동 계약](../integrations/book-metadata.md), 운영 진입점은 [문서 지도](../SPEC.md)에 있습니다.
