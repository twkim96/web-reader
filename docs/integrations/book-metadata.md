# 공개 메타데이터와 표지 API

## 데이터 흐름

공개 도서 정보는 file_check 원본에서 게시한 상세 `publicBookMetadataV1`과 compact `publicBookCatalogIndexV1`, 앱 요청으로 수집한 `publicBookMetadataOnDemandV1`과 `publicBookCatalogDeltaV1`을 사용합니다. 상세 정보와 책장 필터/인기 정렬용 projection은 역할을 분리합니다. base/delta의 immutable generation을 읽고 검증한 뒤 manifest를 적용합니다. 새 generation이 불완전하면 이전 유효 캐시를 빈 성공으로 덮지 않습니다.

도서 정보창의 요청 버튼은 현재 카탈로그·메타데이터 상태를 확인해 필요한 경우 표시합니다. metadata 부재·모호한 작품·제공자 오류를 기존 정보로 위장하지 않습니다. 플랫폼은 네이버 시리즈·카카오페이지·노벨피아입니다. 파일명 alias와 query title은 서버에서 정규화하고 기존 신뢰 가능한 상세 제목이 있으면 사용합니다.

정기 게시의 원본·명령·권한·generation 전환은 [게시 가이드](../operations/book-metadata-publishing.md)가 담당합니다. file_check의 DB/crawler를 Web Reader 요청 API에서 변경하지 않습니다.

## `POST /api/book-metadata/refresh`

Node runtime API이며 `Content-Type: application/json`과 `Authorization: Bearer <Firebase ID token>`이 필요합니다. 서버는 revoked token도 검증합니다. 본문은 추가 키 없이 `{"fileName":"<도서 파일명>"}`만 받습니다. 서버가 alias/canonical key를 계산하므로 client가 UID·alias·임의 원격 URL을 선택하지 않습니다.

응답에는 `status`와 결과가 있을 때 `document`, `generation`, `cached`가 들어갑니다.

| HTTP | 의미와 다음 행동 |
| --- | --- |
| 200 | `ready`/`not-found`/`ambiguous`/`error` 등 document의 실제 상태 확인; HTTP 성공만으로 정보 존재를 판정하지 않음 |
| 202 | `busy`; 다른 요청이 진행 중이므로 UI에서 완료 상태를 다시 확인 |
| 400/413/415 | 본문/schema·크기·content type 오류 수정 |
| 401 | 유효한 Firebase 로그인/ID token 필요 |
| 429 | `quota` 또는 `cooldown`; 즉시 반복 요청하지 않음 |
| 502 | 수집/게시 복구 실패; 기존 정보 보존 후 재시도 가능 여부 표시 |

UID별 일일 quota, alias별 lease/cooldown과 유효 캐시로 중복 수집을 제어합니다. 요청/응답 크기·시간·기간 수치는 [config.ts](../../src/server/bookMetadata/config.ts)의 `BOOK_METADATA_LIMITS`가 기준입니다. `publishPending`이 남은 캐시 요청은 delta 게시 복구를 시도합니다. 신규 delta도 immutable 문서 확인 후 manifest를 바꿉니다.

서버의 Firebase Admin 설정은 [개발 가이드](../development/setup-and-checks.md)에 있습니다. 선택적 `NOVELPIA_EMAIL`/`NOVELPIA_PASSWORD`는 요청 수명 동안 인증 session을 제공하며 클라이언트에 노출하지 않습니다. 설정 없음·로그인 제한·제공자 접근 실패와 정상적인 not-found를 구분합니다.

## `POST /api/book-cover/source`

JSON 본문 `{"url":"<허용된 HTTPS 이미지 URL>"}`을 받아 이미지 bytes를 반환합니다. Firebase ID token을 요구하지 않지만 [bookCoverProxy.ts](../../src/server/bookCoverProxy.ts)의 호스트 allowlist와 URL 규칙을 적용합니다. redirect마다 허용 여부를 다시 확인하며 크기/시간을 제한하고 실제 이미지 signature를 판별합니다.

잘못된 요청/URL은 400, 과대 요청/응답은 413, content type/비이미지 payload는 415, 원격 실패는 502, timeout은 504입니다. 성공 응답에는 `private` cache control과 `nosniff`가 있으며 Service Worker의 공용 cache에 넣지 않습니다. 허용 도메인을 임의 URL 프록시로 넓히지 않습니다.

## 코드와 검증

- API: [refresh/route.ts](../../src/app/api/book-metadata/refresh/route.ts), [source/route.ts](../../src/app/api/book-cover/source/route.ts)
- 서버: `requestSchema`, `crawlers`, `store`, `boundedFetch`, `firebaseAdmin`
- 클라이언트: `publicBookMetadata`, `publicBookCatalog`, `publicBookCatalogDelta`, `usePublicBookCatalog`, `BookInfoModal`, `metadataBookCover`
- 검증: `test:shelf`, `test:formats`, `test:publisher`, `test:rules`. fixture/emulator 검사로 실제 플랫폼·배포 secret·브라우저 사용 확인을 대체하지 않습니다. 남은 수용 확인은 [TODO](../TODO.md)에 있습니다.
