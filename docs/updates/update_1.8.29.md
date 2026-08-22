# Web Reader 1.8.29 — TXT 메타데이터 표지 로컬 캐시

작성일: 2026-08-22

이전 버전: [update_1.8.28.md](./update_1.8.28.md)

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: 구현·전체 `npm run check`·Firestore 실제 게시/readback·3플랫폼 live proxy 검증 완료, TXT 실기기 첫 open→Shelf 표지 확인 대기

## 배경

1.8.27에서 EPUB/PDF/ZIP/CBZ는 로컬에 생성한 `book-covers-v14`만 Shelf에서 읽도록 했다. 원본 도서나 외부 이미지를 Shelf 진입/스크롤 중 다시 읽지 않는 것이 성능 계약이다.

TXT는 원본 파일 자체에 표지가 없으므로 file_check 1.4.24가 수집한 플랫폼별 `catalog_platform_stats.cover_url`을 공개 메타데이터 projection에 포함하고, 실제 도서를 성공적으로 연 뒤에만 해당 표지를 한 번 내려받아 기존 로컬 표지 캐시에 저장한다.

## file_check / Control Server 확인

- 운영 DB: `/Users/twkim/Documents/GitHub/python/test/file_check/.dedup_state/dedup_decisions.sqlite3`
- `catalog_platform_stats.cover_url`은 nullable HTTPS-only schema다.
- 2026-08-22 확인 시 `ok` row 중 cover 보유:
  - Series: 10,307 / 10,329
  - Kakao: 9,804 / 9,833
  - NovelPia: 1,224 / 1,225
- 비-HTTPS cover row: 0
- Control Server Services의 `Web Reader > 도서 메타데이터 Firestore 게시`는 web-reader의 `scripts/publish-book-metadata.py --apply --project web-novel-viewer`를 서비스 계정 credential과 함께 실행한다.

## 상세 metadata projection

`scripts/publish-book-metadata.py`는 file_check schema에 `catalog_platform_stats.cover_url`이 존재하는지 확인한다. 각 성공 플랫폼 row의 HTTPS cover가 있으면 `publicBookMetadataV1`의 플랫폼 payload에 `coverUrl`을 추가한다.

compact `publicBookCatalogIndexV1`에는 cover URL을 넣지 않는다. 따라서 책장 필터/정렬용 catalog 크기와 generation 의미는 유지한다.

기존 coverUrl 없는 Firestore 문서는 계속 읽을 수 있게 client parser에서 missing/NULL cover를 `null`로 정규화한다.

운영 DB dry-run에서 상세 metadata는 256 bucket, 27,336 alias entry를 생성했다. cover URL 추가 뒤 플랫폼 payload 47,875개 중 47,798개가 cover를 포함하며 최대 bucket은 약 144KB로 900KB 안전 제한보다 충분히 작다.

## on-demand metadata

웹 리더 자체 Series/Kakao/NovelPia crawler도 `coverUrl`을 수집한다.

- Series: 상세 페이지 `og:image`
- Kakao: overview thumbnail key를 `dn-img-page.kakao.com/...&filename=o1`로 변환
- NovelPia: 상세 `og:image` 우선, 검색 응답 명시 cover 필드 fallback

crawler version을 `web-reader-1.8.29-v3`로 올려 이전 fresh on-demand cache도 새 cover-aware crawler로 교체될 수 있게 한다.

## TXT 표지 캐시

표지 capability를 둘로 분리했다.

- embedded cover extraction: EPUB/PDF/ZIP/CBZ
- cached cover display: EPUB/PDF/ZIP/CBZ/TXT
- metadata-only cover source: TXT

따라서 TXT import/open이 Foliate `getCover()` 추출기로 들어가지 않는다.

TXT reader open이 성공적으로 commit된 뒤 deferred task가 다음 순서로 동작한다.

1. `book-covers-v14`에 현재 fingerprint의 표지가 있으면 종료
2. offline이면 네트워크 작업 없이 종료
3. `publicBookMetadataV1` / on-demand metadata 조회
4. Series → Kakao → NovelPia 순서로 HTTPS cover 후보 선택
5. `/api/book-cover/source`를 통해 이미지 source 1회 요청
6. 기존 `normalizeBookCover()`로 최대 480×720 WebP/JPEG 정규화
7. `book-covers-v14`에 저장하고 cache-change event 발행
8. Shelf는 기존 `useShelfBookCovers()` 경로로 로컬 Blob만 표시

Shelf 자체는 외부 cover URL을 직접 렌더링하거나 다운로드하지 않는다.

## cover proxy 안전 경계

브라우저 CORS와 NovelPia의 `application/octet-stream` 응답을 처리하기 위해 Node route를 둔다.

허용 host는 현재 운영 DB 원본과 실제 NovelPia redirect CDN으로 제한한다.

- `comicthumb-phinf.pstatic.net`
- `dn-img-page.kakao.com`
- `novelpia.com`
- `image.novelpia.com` — `novelpia.com/imagebox/cover/...`의 실제 302 목적지
- `images.novelpia.com`

계약:

- HTTPS만 허용
- redirect 최종 URL도 동일 allowlist 재검증
- 최대 source 10MB
- upstream Content-Type은 신뢰하지 않음
- JPEG/PNG/WebP/GIF/AVIF magic byte를 확인해 실제 이미지 MIME으로 응답
- HTML/기타 payload 거절
- TXT 표지 실패는 reader open 성공을 되돌리지 않는 best-effort deferred 작업

NovelPia의 실제 `.file` 표지는 upstream이 `application/octet-stream`으로 응답해도 JPEG magic byte이면 `image/jpeg`로 정상 처리한다.

## 버전/캐시

- app/service-worker cache: `1.8.29`
- Foliate runtime cache release version: `1.8.29`
- Foliate vendored runtime revision은 변경하지 않는다.

## targeted 검증

완료:

- `npm run typecheck`
- `npm run test:formats`: 67건 통과
- `npm run test:shelf`: 112건 통과
- `npm run test:publisher`: 3건 통과
- Control Server와 동일한 `/opt/anaconda3/bin/python3 scripts/publish-book-metadata.py` dry-run 통과
- 운영 DB projection: 256 metadata bucket, 27,336 aliases, 최대 bucket 약 144KB
- 전체 `npm run check` 통과: storage 308, shelf 112, shelf-ui 12, publisher 3, SW 9, release 3 및 production build 포함
- 기존 `tests/e2e/bookCoverCache.spec.ts`: Chromium PDF/CBZ 2건 통과, WebKit 2건은 기존 input-backed File Blob 제약으로 의도적 skip
- Control Server와 동일한 service-account 환경으로 `--apply --project web-novel-viewer` 실제 게시 완료
  - `publicBookMetadataV1`: 기존 256 bucket 갱신
  - compact catalog: generation `3faac2dceeebd445f116`, generation document 24개 생성, manifest 갱신
- Firestore 대표 readback: `매화검수`, `레이센`, `던전에서살아남는방법`의 게시된 플랫폼 payload에서 HTTPS `coverUrl` 확인
- 실제 cover proxy live 응답:
  - Series: HTTP 200 `image/jpeg`
  - Kakao: HTTP 200 `image/jpeg`
  - NovelPia: `novelpia.com` → `image.novelpia.com` redirect 뒤 HTTP 200 `image/jpeg`

남은 수동 검증은 실제 Android/iPad/PC에서 cover cache가 없는 TXT를 처음 열고, Shelf 복귀 시 `book-covers-v14` 표지가 나타나며 두 번째 open/Shelf에서는 외부 이미지 네트워크 요청이 발생하지 않는지 확인하는 것이다.
