# Web Reader 1.8.14 — 통합 필터·카탈로그 태그

작성일: 2026-08-17

기준 커밋: `defa985`

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

이전 버전: [update_1.8.13.md](./update_1.8.13.md)

상태: 코드·전체 자동검증·Firebase Rules/index/catalog 게시·Web Reader 1.8.14 production 배포와 PC Chromium/320px 검증 완료. 실제 모바일 Chrome·iPad Safari·설치형 PWA와 offline/generation 교체 검증 대기

## 목표

PC와 모바일 책장의 기존 정렬 버튼을 하나의 **필터 버튼**으로 교체한다. 필터 버튼은 반응형 모달을 열고, 한 화면에서 정렬과 도서 출처·장르·인기 태그 필터를 함께 설정한다.

기본 도서 검색창은 기존 제목 검색을 유지하면서 `#하렘`처럼 `#`으로 시작하는 검색어를 태그 검색으로 해석한다. 태그 검색 결과는 일치 태그를 최상단에, 해당 태그를 사용하는 도서를 그 아래에 보여준다. 최상단 태그를 누르면 그 태그가 책장의 활성 필터가 된다.

필터에 필요한 compact catalog는 책장을 막지 않고 백그라운드에서 준비한다. 같은 데이터를 책장 카드·목록과 도서 정보창에도 재사용해 도서별 통합 장르·대표 태그를 표시한다. 책장에서는 원본 수치를 하나의 표시용 조회수로 합산하고, 정보창은 플랫폼별 상세를 유지한다.

정렬에는 기존 `최근에 읽은 순`, `가나다순`과 함께 다음 공개 수치를 조합한 `통합 인기순`을 추가한다.

- 네이버 시리즈: 다운로드 수
- 카카오페이지: 조회 수
- 노벨피아: 조회 수

## 사용자 확정 UX

1. PC와 모바일 모두 기존 정렬 버튼 자리에 필터 버튼을 둔다.
2. 보기 방식 전환 버튼은 그대로 유지한다.
3. 필터 버튼을 누르면 정렬과 필터를 동시에 설정하는 모달이 열린다.
4. 출처 필터는 `시리즈 / 카카오 / 노벨피아 / 없음(기타)`를 제공한다.
5. 통합 장르와 인기 태그를 필터로 제공한다.
6. 기본 도서 검색창에서 `#태그`를 검색할 수 있다.
7. 태그 검색에서는 태그가 책보다 먼저 나오며, 태그 선택은 책장 필터로 이어진다.
8. 책장 그리드·목록과 도서 정보창에 도서별 장르·태그를 표시한다.
9. 시리즈 다운로드 수, 카카오 조회 수, 노벨피아 조회 수를 플랫폼 차이를 보정한 하나의 인기 정렬키로 사용한다.
10. 필터 모달의 인기 태그는 작품 수가 많은 순서로 처음 15개만 표시하고, `더보기`를 누를 때마다 다음 15개를 추가한다.
11. 책장 그리드·목록에는 연결된 플랫폼의 유효한 원본 수치를 합산해 `304.7만 조회`처럼 한 줄로 표시한다. 출처명과 `다운로드` 문구는 넣지 않으며, 합산할 수치가 없으면 영역을 만들지 않는다.
12. 모바일 필터는 화면 하단에 붙는 sheet가 아니라 상하좌우 여백과 네 모서리 radius를 가진 floating modal로 표시한다.
13. 목록 보기의 합산 조회수는 제목 영역 아래에 별도 행을 만들지 않고, 제목·저장 확인 표시 옆의 진행률 열에서 `%` 바로 위에 표시한다.

## 리뷰 판정

| 항목 | 판정 | 이유 |
| --- | --- | --- |
| PC·모바일 정렬 버튼을 필터 버튼으로 교체 | 수용 | 정렬과 필터의 단일 진입점 |
| 필터 모달에서 정렬·출처·장르·태그 동시 설정 | 수용 | 전체 목록을 로컬에서 한 번에 파생 가능 |
| `#태그` 검색과 태그 우선 결과 | 수용 | 1,295개 전체 태그를 칩으로 나열하지 않고 찾을 수 있음 |
| 책장 카드·목록과 정보창의 태그 표시 | 수용 | 동일 compact catalog를 재사용하고 별도 도서별 요청을 만들지 않음 |
| 책장 카드·목록의 합산 조회수 표시 | 수용 | compact source count를 같은 derived record에서 재사용하되 플랫폼명 없이 한 줄로 합산 |
| 기존 256개 상세 bucket을 전체 필터용으로 재사용 | 제외 | 약 21MB 상세 projection 대부분을 읽게 됨 |
| raw 플랫폼 수치를 인기 점수로 그대로 단순 합산 | 설계 보정 | 다운로드와 조회의 단위·분포가 달라 정렬에는 플랫폼별 순위 정규화 후 조합 |
| `Book`, Drive metadata, `metadata-v5`에 플랫폼 필드 저장 | 제외 | 외부 갱신 파생 데이터이며 사용자 콘텐츠 migration이 불필요함 |
| Firestore server query로 필터 조합 실행 | 제외 | compact index를 받은 뒤 모든 검색·필터·정렬을 로컬에서 수행 |
| 태그 제외 조건, 추천 시스템, 사용자별 필터 동기화 | 후속 보류 | 이번 요청의 필수 범위를 넘음 |
| `file_check` crawler·identity·metadata writer 변경 | 제외 | 이미 수집된 SQLite read-only projection만 사용 |

## 설계 기준 snapshot

2026-08-16 `file_check` SQLite를 기존 공개 게시 조건으로 읽기 전용 재생성한 기준값이다. 아래 숫자는 고정 invariant가 아니며 게시 dry-run마다 다시 기록한다.

첨부된 `WEB_READER_HANDOFF_1.4.22.md`는 구현 명령이 아니라 upstream 호환 계약으로 대조했다. 확인 시점의 `file_check`는 working tree clean, `HEAD == origin/main == c23b5f3b97a43b413b0d1fc21db2d3e93825594b`, management health 1.4.22였으며 crawler·metadata writer·maintenance/backfill은 실행하거나 변경하지 않았다.

| 항목 | 측정값 |
| --- | ---: |
| 공개 유효 작품 | 12,102 |
| 공개 alias | 27,051 |
| 충돌로 제외되는 alias | 7 |
| 기존 상세 projection | 약 21.86MB |
| compact alias 16 shard | 약 1.95MB |
| catalog 8 shard | 약 1.23MB |
| tag dictionary | 1,295개 |
| manifest | 약 3.5KB |
| compact 전체 raw JSON | 3,182,063 bytes, 약 3.18MB |
| alias shard 최대 | 약 127KB |
| catalog shard 최대 | 187,917 bytes, 약 188KB |
| canonical genre 보유 작품 | 12,065 |
| raw tag 보유 작품 | 8,597 |

현재 content generation은 `6ed40232b8555a45bde9`다. 구성은 alias 16개 + catalog 8개 + manifest 1개로 총 25문서이며, generation 본문 24개 중 가장 큰 문서도 900KB safety ceiling보다 충분히 작다.

태그는 태그가 있는 작품당 중앙값 5개, 95 percentile 12개, 최대 21개다. 기본 모달에는 전체 태그를 노출하지 않고 작품 수 기준 인기 태그만 보여주며, 나머지는 `#태그` 검색으로 찾는다.

## 데이터 경계

### 기존 상세 projection 유지

```text
publicBookMetadataV1/{00..ff}
```

기존 정보창용 collection은 그대로 유지한다.

- 플랫폼 표시명·작품 제목·HTTPS URL
- 플랫폼별 원본 수치와 마지막 성공 시각
- alias SHA-256 앞 2자리의 256개 bucket
- 정보창을 열 때 필요한 bucket 1건만 조회

필터 기능 때문에 이 256개 문서를 한꺼번에 읽거나 기존 payload를 `Book`에 복제하지 않는다.

### 신규 compact catalog

```text
publicBookCatalogIndexV1/manifest
publicBookCatalogIndexV1/{generation}_alias_0..f
publicBookCatalogIndexV1/{generation}_catalog_0..7
```

첫 generation은 manifest 1개, alias 16개, catalog 8개로 구성한다. tag dictionary는 catalog shard 중 하나에 포함해 최초 서버 조회를 총 25개 문서로 제한한다.

개념 payload는 다음과 같다.

```ts
type PublicCatalogManifestV1 = {
  schemaVersion: 1;
  generation: string;
  publishedAt: string;
  normalizerVersion: string;
  genrePolicyVersion: string;
  popularityFormulaVersion: 1;
  aliasShardCount: 16;
  catalogShardCount: 8;
  aliasCount: number;
  titleCount: number;
  excludedAliasCollisionCount: number;
  checksums: Record<string, string>;
};

type PublicCatalogRecordV1 = {
  id: number;                 // generation 안에서만 유효한 dense ID
  platformMask: number;       // series=1, kakao=2, novelpia=4
  canonicalGenreId: number | null;
  tagIds: number[];           // 플랫폼 raw tag의 title-level union
  popularityScore: number | null;
  sourceRanks: [number | null, number | null, number | null];
  sourceCounts: [number | null, number | null, number | null];
                              // series download, kakao view, novelpia view
};

type PublicCatalogTagV1 = {
  id: number;
  label: string;
  titleCount: number;         // alias 수가 아닌 distinct canonical title 수
  popularRank: number | null;
};
```

실제 Firestore payload는 반복 key를 줄인 compact 표현을 사용할 수 있지만, parser가 위 의미 계약으로 복원해야 한다.

### canonical genre와 raw tag

- canonical genre는 `file_check/backend/genre_flattening.py`의 기존 `Kakao > Series > NovelPia` 규칙을 그대로 재사용한다.
- `현판 → 현대판타지`, `로판 → 로맨스판타지` alias와 NovelPia modifier-first 보정을 복제 구현하지 않는다.
- raw `catalog_platform_tags`는 수정하지 않고 title-level 중복만 제거한다.
- 같은 태그가 여러 플랫폼에 있어도 필터 dictionary와 `titleCount`에서는 작품당 한 번만 센다.
- canonical genre와 raw tag는 별도 필드로 유지한다. raw tag에 `판타지`가 있어도 canonical genre와 의미를 합치지 않는다.
- 알 수 없는 장르를 임의로 `기타`로 채우지 않는다.

### `없음(기타)` 출처 의미

`없음(기타)`는 현재 책 이름을 alias index에 join했을 때 공개 catalog record를 찾지 못했거나 유효한 공개 플랫폼 bit가 하나도 없는 도서다.

다음 경우가 포함될 수 있다.

- 세 플랫폼 어디에도 매칭되지 않은 도서
- `file_check` 공개 catalog에 아직 없는 도서
- alias 충돌로 fail-closed 제외된 도서
- normalizer·파일명 차이로 현재 alias가 연결되지 않은 도서

따라서 UI label은 `없음(기타)`로 유지하고 “플랫폼에 절대 존재하지 않는 작품”이라고 단정하지 않는다.

## 통합 인기 점수 계약

세 플랫폼의 raw 수치는 단위와 분포가 다르므로 단순 합산하지 않는다. 게시 snapshot 안에서 플랫폼별 상대 순위를 먼저 계산한다.

```text
Series rank    = download_count의 플랫폼 내 percentile
Kakao rank     = view_count의 플랫폼 내 percentile
NovelPia rank  = view_count의 플랫폼 내 percentile

popularityScore
  = 존재하는 platform rank의 산술평균
  = 0..10,000 정수로 양자화
```

같은 raw 수치가 여러 작품에 반복될 때는 같은 점수를 받도록 midrank를 사용한다.

```text
sourceRank(value)
  = round-half-up(10,000 × (
      count(metric < value)
      + 0.5 × count(metric = value)
    ) / count(metric IS NOT NULL))
```

Python과 JavaScript의 기본 `.5` 반올림 차이를 허용하지 않고 두 publisher/client 모두 non-negative `round-half-up`을 사용한다.

규칙:

- `NULL`은 해당 플랫폼 점수 없음으로 처리한다.
- 수치 `0`은 유효한 최하위 관측값으로 처리하고 임의로 missing으로 바꾸지 않는다.
- 한 플랫폼만 있으면 그 플랫폼의 rank가 통합 점수다.
- 여러 플랫폼이 있으면 작품이 올라간 플랫폼 수 자체가 자동 가산점이 되지 않도록 평균한다.
- 필터에서 선택한 출처가 바뀌어도 저장된 통합 점수는 바뀌지 않는다. 필터와 정렬을 직교 상태로 유지한다.
- 동점은 최고 개별 source rank, 플랫폼 bit 수, 한글 제목, 기존 안정 순서 순으로 해소한다.
- 점수 공식이 바뀌면 기존 generation을 덮지 않고 `popularityFormulaVersion`과 새 generation을 함께 올린다.
- 정보창에는 기존 raw 다운로드·조회 수를 그대로 표시하며, 정규화 점수를 실제 조회 수처럼 표시하지 않는다.

## 게시 원자성·보안 계약

현재 상세 publisher의 순차 in-place patch를 신규 catalog generation에 그대로 사용하지 않는다.

게시 순서:

1. SQLite를 read-only로 열고 상세 projection과 compact catalog를 동일 snapshot에서 만든다.
2. 새 generation의 alias·catalog 24개 문서를 create-only로 게시한다.
3. 문서 수, encoded size, schema, checksum을 readback 검증한다.
4. 모든 generation 문서가 유효할 때만 manifest를 CAS로 마지막 전환한다.
5. 직전 generation은 manifest를 먼저 읽은 클라이언트를 위해 한 세대 보존한다.
6. 다음 정상 게시에서 더 오래된 generation만 별도 정리한다.

부분 게시·timeout·checksum 불일치에서는 기존 manifest를 변경하지 않는다. 클라이언트는 manifest가 가리키는 한 generation만 조립하며 서로 다른 generation shard를 섞지 않는다.

Firestore Rules:

- manifest·generation 문서의 공개 단건 `get` 허용
- collection `list` 거부
- 비로그인·로그인 클라이언트 create/update/delete 거부
- publisher credential만 서버 REST 쓰기 수행

catalog는 document ID point-get만 사용하므로 `firestore.indexes.json`에서 대형 map/array payload의 자동 indexing을 제외한다.

## 로드·cache 계약

책장 태그 표시가 필요하므로 catalog를 필터 버튼 클릭 시점까지 미루지 않는다. 대신 기본 책장 렌더를 막지 않는 background prefetch를 사용한다.

```text
기존 Book/progress로 책장 즉시 표시
  → server manifest 확인
  → 같은 generation의 Firestore persistent cache 확인
  → cache miss·checksum 불일치·새 generation만 필요한 shard 병렬 조회
  → schema/checksum 검증
  → alias join
  → 태그 표시와 필터 기능 활성화
```

세부 계약:

- production은 현재 `persistentLocalCache`를 재사용한다.
- manifest는 server 우선으로 확인하되 offline에서는 cached manifest로 fallback한다.
- generation이 같으면 data shard는 `getDocFromCache()`를 먼저 사용한다.
- cache miss 또는 checksum 불일치 문서만 server에서 다시 받고 재검증한다.
- development의 memory cache 정책은 변경하지 않는다.
- catalog loading 동안 책 제목·진행률·열기·삭제·기존 정보창은 정상 동작한다.
- catalog가 없거나 malformed이면 필터 모달의 `최근에 읽은 순`과 `가나다순`은 계속 사용할 수 있고 metadata 필터·통합 인기순만 재시도 상태로 둔다.
- 준비된 catalog는 React session에서 한 번만 parse하고 책 ID별 derived join map을 memoize한다.
- alias hash는 동일 normalized filename별로 한 번만 계산한다.
- `Book`, Drive file, local content metadata record에는 catalog payload를 쓰지 않는다.

## 필터 버튼과 모달 UX

### 헤더 진입점

- `data-shelf-sort-control` 정렬 버튼을 PC·모바일에서 제거한다.
- 같은 위치에 `data-shelf-filter-control` 필터 버튼을 둔다.
- 그리드·목록 보기 전환 버튼은 기존 위치와 동작을 유지한다.
- 기본 정렬이고 필터가 없으면 중립 아이콘을 사용한다.
- 기본이 아닌 정렬 또는 필터가 하나라도 있으면 포인트 색상을 사용한다.
- badge에는 정렬을 제외한 활성 출처·장르·태그 조건 수를 표시한다.
- `aria-label`은 현재 정렬과 활성 필터 수를 함께 설명한다.

### 반응형 모달

PC와 모바일이 같은 상태·컴포넌트를 사용한다.

- PC: 화면 중앙 dialog
- 모바일: safe-area를 지키는 넓은 bottom-aligned dialog
- 최대 높이 안에서 본문만 스크롤
- header: `책장 정렬·필터`, 닫기
- body: 정렬 → 출처 → 장르 → 인기 태그
- footer: `초기화`, `N권 보기`

모달 안의 선택은 draft state다. `N권 보기`를 누를 때 정렬·필터를 한 번에 commit하고 책장 pagination을 첫 50권으로 되돌린다. 닫기·Back은 적용 전 draft를 버린다.

### 정렬 선택

- 최근에 읽은 순
- 가나다순
- 통합 인기순

기존 `recent`와 `alpha`의 읽는 중 그룹·최근 import 우선 계약은 그대로 유지한다. `통합 인기순`은 catalog 점수를 최우선으로 사용하고, 점수가 없는 책은 점수가 있는 책 뒤에서 기존 안정 순서를 유지한다.

정렬 preference는 현재처럼 localStorage에 보존한다. 출처·장르·태그 필터는 책장 화면 생명주기 동안 유지하되 전체 앱 재시작 뒤에는 기본 전체 목록으로 시작해, 오래된 필터 때문에 책이 사라진 것처럼 보이지 않게 한다.

### 필터 조합 의미

필터 category 내부와 category 사이는 다음처럼 고정한다.

```text
출처 여러 개      OR
장르 여러 개      OR
선택 태그 여러 개 AND

출처 category
  AND 장르 category
  AND 태그 category
  AND 일반 제목 검색
```

- category에서 아무것도 선택하지 않으면 그 category는 전체다.
- `없음(기타)`도 다른 출처와 함께 OR 선택할 수 있다.
- 장르는 canonical genre만 사용한다.
- 인기 태그는 `titleCount` 내림차순, label 오름차순의 전체 목록을 만들고 처음 15개만 노출한다.
- `더보기`를 누를 때마다 서버 요청 없이 다음 15개를 추가하며, 남은 태그가 없으면 버튼을 숨긴다.
- 모달을 새로 열면 노출 개수는 15개로 돌아가되, 이미 선택된 비인기 태그는 별도 `선택됨` 줄에서 계속 보인다.
- canonical genre와 같은 label의 raw tag는 인기 태그 영역에서 중복 노출하지 않는다.
- 현재 보이는 15개 밖의 태그는 반복 `더보기` 또는 기본 검색창의 `#태그` 모드로 찾는다.
- 모달 footer는 draft 조건으로 계산한 실제 결과 수를 `N권 보기`에 즉시 반영한다.

## `#태그` 검색 UX

현재 기본 도서 검색 모달을 두 검색 모드로 확장한다.

### 일반 제목 모드

- 검색어가 `#`으로 시작하지 않으면 기존 제목 부분 검색을 유지한다.
- 활성 출처·장르·태그 필터가 있으면 제목 검색 결과에도 함께 적용한다.
- 기존 최근/가나다/통합 인기 정렬 선택을 검색 결과 순서에도 동일하게 사용한다.

### 태그 모드

trim한 검색어가 `#`으로 시작하면 나머지 문자열을 tag query로 사용한다.

```text
#하렘

태그
  #하렘 · 709권

이 태그를 사용하는 도서
  도서 A  [판타지] [하렘]
  도서 B  [현대판타지] [하렘]
```

태그 결과 정렬:

1. normalized exact match
2. prefix match
3. substring match
4. 같은 단계에서는 `titleCount` 내림차순, label 오름차순

태그 label은 NFKC·공백 정리·case-insensitive 검색키를 별도로 만들되 화면에는 원본 label을 표시한다.

태그를 누르면:

1. 현재 활성 tag filter에 해당 tag를 추가한다.
2. literal `#검색어`를 일반 제목 keyword로 남기지 않는다.
3. 검색 모달을 닫는다.
4. 책장 pagination을 초기화한다.
5. 필터 버튼 badge와 책장 결과 수를 즉시 갱신한다.

태그 아래 도서 preview는 현재 출처·장르·기존 선택 태그에 후보 태그를 추가했을 때 실제 남는 도서를 보여줘, 태그 선택 뒤 결과와 preview가 일치해야 한다.

## 책장·도서 정보 태그 표시

### 그리드 카드

- 제목 아래에 한 줄 높이의 metadata 영역을 미리 확보해 background hydration 시 큰 layout shift를 만들지 않는다.
- `canonical genre` 1개와 대표 raw tag 최대 2개를 compact chip으로 표시한다.
- 나머지가 있으면 `+N`으로 표시한다.
- 대표 태그는 전역 `titleCount` 내림차순, 원본 source order, label 순으로 안정적으로 고른다.
- 태그 아래에는 플랫폼별 원본 수치 중 유효한 값을 합산해 `135.3만 조회`처럼 한 줄만 표시한다. 이 합계는 책장 표시용이며 통합 인기 정렬 점수에는 사용하지 않는다.
- 연결된 모든 출처의 원본 수치가 `NULL`이면 조회수 줄 자체를 렌더링하지 않는다.
- tag chip은 카드 전체 열기·길게 누르기 gesture와 충돌하지 않도록 이번 버전에서는 표시 전용이다.

### 목록 행

- 제목 아래 보조 줄에 canonical genre와 대표 raw tag 최대 2개를 표시한다.
- 다음 보조 줄에 연결된 출처와 원본 수치를 최대 3개까지 표시한다.
- 320px에서도 진행률·삭제 버튼과 겹치지 않도록 태그·출처 줄은 각각 한 줄 ellipsis 처리한다.
- metadata가 없는 책은 빈 chip 대신 기존 파일/최근 독서 정보를 유지한다.

### 도서 정보창

- 기존 플랫폼 badge·raw 수치·링크는 `publicBookMetadataV1`에서 계속 읽는다.
- compact catalog join이 준비되면 별도 `장르·태그` 영역에 canonical genre와 deduplicated raw tag 전체를 wrap해서 표시한다.
- current snapshot 최대 21개를 기준으로 모달 scroll body 안에서만 늘어나게 한다.
- catalog가 아직 loading이면 작은 skeleton/status를 표시하되 플랫폼 상세 정보 로드를 기다리게 하지 않는다.
- catalog 실패 시 기존 작품 정보·읽기·삭제·독서 인증은 그대로 유지하고 장르·태그 영역만 unavailable 처리한다.

## Phase A — read-only compact projection

상태: 구현·실데이터 dry-run·자동검증 완료

주요 영역:

- `scripts/publish-book-metadata.py`
- `file_check/backend/genre_flattening.py` read-only dependency
- publisher projection tests

작업:

1. 기존 상세 document 생성 조건을 공통 public-title selector로 분리한다.
2. alias → generation-local canonical ID projection을 만든다.
3. platform mask, canonical genre, raw tag union, tag dictionary, distinct title count와 출처별 원본 수치를 만든다.
4. 플랫폼별 rank와 통합 popularity score를 deterministic하게 계산한다.
5. 16 alias + 8 catalog shard의 encoded size와 checksum을 검증한다.
6. 같은 DB snapshot에서 반복 dry-run한 결과가 generation time을 제외하고 byte-stable한지 확인한다.
7. canonical genre 결과가 `file_check` library API projection과 표본·전체 집계에서 일치하는지 확인한다.

완료 조건:

- SQLite·crawler·identity writer를 변경하지 않는다.
- alias collision 7건과 향후 collision을 fail-closed로 제외한다.
- 각 Firestore document가 900KB safety ceiling 아래다.
- tag text·배열 길이·정수 범위를 client schema와 같은 한도로 제한한다.
- 파일 경로, 계정, 원문, 메모, dedup evidence가 public payload에 들어가지 않는다.

## Phase B — generation 게시·Rules·cache loader

상태: 구현·자동검증·라이브 Rules/index/catalog 게시와 public REST readback 완료

주요 영역:

- `scripts/publish-book-metadata.py`
- `firestore.rules`
- `firebase.json`
- 신규 `firestore.indexes.json`
- 신규 `src/lib/publicBookCatalogSchema.ts`
- 신규 `src/lib/publicBookCatalog.ts`
- 신규 catalog loading hook

작업:

1. immutable generation 문서와 manifest-last CAS 게시를 구현한다.
2. partial publish·readback mismatch에서 기존 manifest가 유지되게 한다.
3. public point-get only Rules와 collection indexing exemption을 추가한다.
4. manifest server 확인, cache-first shard 복원, generation 변경 fetch를 구현한다.
5. schema·checksum·count 검증이 끝난 snapshot만 React에 publish한다.
6. offline cached generation과 network/cache miss failure state를 구분한다.

완료 조건:

- 첫 generation은 최대 25 document read다.
- unchanged generation의 다음 실행은 server manifest 1 read와 local cache 복원을 목표로 한다.
- 새 generation 중 한 shard라도 없거나 잘못되면 이전 validated generation 또는 metadata 없는 기본 책장으로 안전하게 fallback한다.
- 로그인 여부와 관계없이 단건 읽기만 가능하고 모든 client write/list가 거부된다.

## Phase C — derived join·정렬·필터 엔진

상태: 구현·자동검증 완료

주요 영역:

- `src/components/shelf/bookUtils.ts`
- `src/components/shelf/useFilteredBooks.ts`
- `src/components/shelf/useShelfPreferences.ts`
- 신규 catalog/filter state utilities
- `tests/shelfBooks.test.mjs`

작업:

1. normalized book filename hash를 catalog record와 join한다.
2. `Book`을 수정하지 않고 prepared/derived shelf view model에 catalog record를 연결한다.
3. 출처 OR, 장르 OR, tag AND, category AND 조건을 pure function으로 구현한다.
4. `없음(기타)`와 alias miss를 같은 명시적 predicate로 구현한다.
5. 기존 recent/alpha와 신규 popularity comparator의 tie-break를 고정한다.
6. 검색·filter·sort 뒤에만 기존 50권 progressive slice를 적용한다.
7. filter/catalog generation 변경을 pagination reset dependency에 추가한다.

완료 조건:

- 1,100권 전체에 filter·sort를 먼저 적용한 뒤 첫 50권만 렌더링한다.
- 최근 import priority가 metadata filter를 우회해 조건 불일치 책을 살리지 않는다.
- 통합 인기순에서 score missing은 마지막에 안정적으로 유지된다.
- 같은 입력은 매번 같은 결과 순서를 만든다.

## Phase D — 필터 버튼·반응형 모달

상태: 구현·자동 browser regression·production PC Chromium과 320px viewport 확인 완료. 실제 모바일·iPad/PWA 확인 대기

주요 영역:

- `src/components/shelf/ShelfHeader.tsx`
- 신규 `src/components/shelf/ShelfFilterModal.tsx`
- `src/components/shelf/index.tsx`

작업:

1. 모든 responsive header/dock의 sort control을 filter control로 교체한다.
2. view control과 login/theme/import 등 기존 action 순서를 보존한다.
3. draft sort/filter state, 결과 수, 적용·초기화·Back 동작을 구현한다.
4. 인기 태그 15개 초기 노출, `더보기`당 15개 증가와 선택된 숨은 태그 영역을 구현한다.
5. catalog loading/error/offline 상태에서도 recent/alpha를 사용할 수 있게 한다.
6. filter button의 active color, count badge, title과 aria-label을 맞춘다.
7. 320px, iPad portrait/landscape, desktop에서 overflow와 dock 충돌을 검증한다.

완료 조건:

- PC와 모바일에서 기존 sort button이 남아 있지 않다.
- filter button 하나로 정렬과 필터를 함께 변경할 수 있다.
- 닫기·Back은 draft를 적용하지 않고 `N권 보기`만 commit한다.
- 적용·초기화 즉시 결과 수, badge, 첫 page가 일치한다.
- 인기 태그는 15 → 30 → 45개 순으로 늘고 추가 Firestore read를 만들지 않는다.

## Phase E — `#태그` 검색

상태: 구현·pure search/filter 회귀와 production `#하렘` catalog handoff 확인 완료

주요 영역:

- `src/components/ShelfSearchModal.tsx`
- catalog tag search utilities
- shelf search/browser regression tests

작업:

1. 일반 제목 검색과 `#` tag mode를 분리한다.
2. 태그 exact/prefix/substring ranking과 distinct title count를 표시한다.
3. 일치 태그를 도서보다 위에 렌더링한다.
4. 아래 도서 preview가 candidate tag와 현재 filter 조합을 반영하게 한다.
5. tag 선택을 active filter commit으로 연결하고 literal hashtag keyword를 제거한다.
6. IME composition, 공백, 대소문자, NFKC와 빈 `#` 입력을 처리한다.

완료 조건:

- `#하렘`에서 `#하렘` 태그가 최상단 exact match로 나온다.
- 태그 아래 도서가 실제 해당 태그 record만 포함한다.
- 태그를 누르면 책장 tag filter가 활성화되고 동일한 도서 집합이 표시된다.
- 일반 제목 검색 회귀가 바뀌지 않는다.

## Phase F — 카드·목록·정보창 태그 UI

상태: 구현·typecheck·build와 production 카드·출처·정보창 catalog 시각 확인 완료

주요 영역:

- `src/components/shelf/BookCard.tsx`
- `src/components/shelf/BookInfoModal.tsx`
- `src/components/shelf/index.tsx`
- browser regression fixtures

작업:

1. grid/list 공통 representative tag selector를 만든다.
2. 카드에는 genre + raw tag 2개 + `+N`을 고정 높이로 표시한다.
3. grid/list에 유효한 시리즈 다운로드·카카오 조회·노벨피아 조회 원본값의 표시용 합계를 `조회` 한 단위로 표시한다.
4. 정보창에는 canonical genre와 deduplicated raw tag 전체를 표시한다.
5. metadata late hydration의 layout shift와 unmounted setState를 방지한다.
6. public detail metadata와 compact catalog의 loading/error를 독립 상태로 유지한다.
7. 테마 포인트 색상과 좁은 화면 contrast·wrap을 확인한다.

완료 조건:

- catalog record가 있는 모든 shelf book은 grid/list에서 같은 대표 tag를 보인다.
- grid/list의 합계가 SQLite 원본의 유효한 지정 metric 합과 일치하고 유효 수치 없음은 빈 줄을 만들지 않는다.
- 정보창은 동일 record의 전체 tag를 빠짐없이 보인다.
- catalog가 없는 책도 카드 높이·열기·정보·삭제 동작이 깨지지 않는다.
- tag chip이 카드 클릭·650ms long press·12px 이동 취소를 가로채지 않는다.

## Phase G — release·게시·acceptance

상태: 1.8.14 버전 동기화·전체 자동 gate·Firebase 게시·Vercel production 배포·PC Chromium/320px acceptance 완료. 실제 모바일·iPad/PWA와 offline/generation 교체 확인 대기

1. Phase A dry-run의 count, collision, shard raw/Firestore encoded size와 checksum을 기록한다.
2. Rules와 index exemption을 먼저 배포하고 Firestore field operation이 `SUCCESSFUL`이 될 때까지 기다린다.
3. catalog generation 24개를 게시·readback 검증한 뒤 manifest를 전환한다.
4. 비로그인 REST 표본에서 manifest, alias, catalog와 SQLite 원본을 대조한다.
5. Web Reader 1.8.14를 배포하고 이전 1.8.13 client가 새 collection 때문에 영향받지 않는지 확인한다.
6. PC·모바일·설치형 PWA에서 first-load, cached-load, generation update를 확인한다.
7. 실제 카카오·시리즈·노벨피아 각 3개 이상과 `없음(기타)` 3개 이상을 표본 대조한다.

## 자동검증 계획

### publisher·schema

- 기존 상세 projection의 alias·bucket·collision 회귀
- compact projection deterministic output
- 16 alias + 8 catalog shard 분배와 900KB ceiling
- platform mask와 `없음(기타)` join
- canonical genre parity
- raw tag dedup, titleCount와 popularity 순서
- Series download/Kakao view/NovelPia view sourceCounts
- Series/Kakao/NovelPia source rank와 formula version
- malformed manifest, unknown schema, oversized tag, invalid score 거부
- partial publish·checksum mismatch·manifest CAS failure에서 이전 generation 유지

### Rules·cache

- 비로그인·로그인 manifest/generation 단건 get 허용
- collection list와 create/update/delete 거부
- unchanged manifest에서 cached shard 사용
- 새 manifest에서 새 generation만 fetch
- cache miss 일부 문서만 server fallback
- offline cached generation 성공
- incomplete generation이 React catalog로 노출되지 않음

### shelf engine

- 출처 단일·복수 OR와 `없음(기타)`
- 장르 단일·복수 OR
- tag 단일·복수 AND
- category 간 AND와 제목 검색 추가 조합
- recent/alpha/popularity의 stable tie-break
- score missing last
- filter 적용 뒤 50권 progressive rendering
- 1,100권 fixture의 결과 정확성, 처리 시간 기록, long task·전역 오류 0

### UI·browser regression

- PC·모바일 sort control 0개, filter control 1개
- view control 유지
- modal draft/apply/reset/Back과 결과 수
- 인기 태그 15개 초기 노출과 15개 단위 `더보기`, 선택된 숨은 태그 유지
- active badge와 aria-label
- loading/error/offline metadata filter 상태
- `#하렘` 태그 우선 검색과 filter handoff
- grid/list 대표 tag와 `+N`
- grid/list 합산 조회수와 유효 수치 없음 생략
- 정보창 전체 tag wrap
- 320px horizontal overflow 0
- long press·context menu·card click 회귀

전체 gate:

```bash
npm run check:full
git diff --check
```

실행 결과와 실제 test count는 구현 후 기록하며 이전 버전의 통과 기록을 재사용하지 않는다.

## 실기기 검증 계획

### PC production Chrome

- 정렬 버튼 대신 필터 버튼이 보이고 보기 전환은 유지되는지 확인한다.
- 출처·장르·태그를 동시에 선택해 `N권 보기` 수와 실제 책장이 일치하는지 확인한다.
- `#하렘` 검색의 태그 우선 결과와 tag filter handoff를 확인한다.
- grid/list 전환에서 대표 tag와 카드 높이가 안정적인지 확인한다.
- 통합 인기순 상위 표본의 raw 플랫폼 수치와 source rank를 대조한다.

### 모바일 Chrome·iPad Safari·홈 화면 PWA

- filter dialog가 safe area와 keyboard를 침범하지 않는지 확인한다.
- 긴 장르·태그 chip이 가로 overflow를 만들지 않는지 확인한다.
- filter body만 스크롤되고 footer `초기화 / N권 보기`가 접근 가능한지 확인한다.
- tag hydration 전후 첫 도서 위치가 크게 점프하지 않는지 확인한다.
- 카드 스크롤과 650ms long press가 tag 표시 때문에 충돌하지 않는지 확인한다.
- cached second load와 offline 재실행에서 기존 tag/filter 데이터가 사용되는지 확인한다.

### generation 교체

- 기존 generation cache 상태에서 새 manifest를 게시한다.
- 앱 재진입 후 새 tag/count/score가 반영되는지 확인한다.
- 게시 중 network 차단에서 mixed generation이 노출되지 않는지 확인한다.
- 이전 generation rollback manifest로 복구 가능한지 확인한다.

## 명시적 제외

- `file_check` crawler 재수집과 metadata backfill 자동 실행
- SQLite schema migration 또는 raw platform genre/tag 덮어쓰기
- `Book`, Drive metadata, local content IndexedDB schema 확장
- 기존 `publicBookMetadataV1` 256 bucket 제거·대체
- 클라이언트의 플랫폼 사이트 직접 요청
- Firestore collection list/query 기반 서버 필터
- 태그 제외·NOT filter와 자유식 boolean query
- 개인별 추천·학습·선호도 점수
- 필터 상태의 Firebase 다기기 동기화
- 카드 안 tag chip의 직접 클릭 navigation

## rollback

- 1.8.13 client는 신규 catalog collection을 읽지 않으므로 신규 게시와 독립적으로 동작한다.
- 1.8.14 app은 manifest가 없거나 invalid하면 metadata 없는 기존 책장과 recent/alpha 정렬로 fallback한다.
- publisher는 직전 valid generation을 보존한다.
- 문제 generation은 문서를 in-place 수정하지 않고 manifest를 직전 generation으로 CAS 전환한다.
- 기존 상세 `publicBookMetadataV1`과 정보창 링크·수치는 rollback 과정에서 변경하지 않는다.

## 전체 완료 조건

- PC·모바일의 기존 정렬 버튼이 필터 버튼으로 완전히 교체된다.
- 하나의 모달에서 정렬·출처·장르·인기 태그를 함께 적용할 수 있다.
- `#태그` 검색은 태그를 책보다 위에 보여주고 tag 선택을 책장 필터로 연결한다.
- grid/list 카드와 도서 정보창이 같은 catalog record의 장르·태그를 일관되게 표시한다.
- 통합 인기순이 지정한 세 플랫폼 수치의 정규화 rank에서 재현 가능하게 계산된다.
- 기본 책장은 catalog loading·failure·offline 때문에 막히지 않는다.
- unchanged generation은 manifest 확인 후 persistent cache를 재사용한다.
- partial publish에서 mixed generation이 노출되지 않는다.
- `Book`, Drive metadata, 사용자 콘텐츠 IndexedDB와 기존 상세 projection을 변경하지 않는다.
- full automated gate와 PC·모바일·iPad/PWA 실기기 확인이 모두 기록된다.

## 구현 결과

- `scripts/publish-book-metadata.py`가 기존 256개 상세 projection을 유지하면서 같은 read-only SQLite snapshot에서 compact catalog를 함께 생성한다.
- `scripts/public_book_catalog.py`가 16 alias shard, 8 catalog shard, tag·genre dictionary, 플랫폼 mask, source count·rank와 통합 인기 점수를 deterministic하게 만든다.
- generation 문서는 immutable create/readback으로 게시하고 마지막 manifest만 precondition CAS로 전환한다. 2026-08-17 `web-novel-viewer`에 generation `6ed40232b8555a45bde9`를 게시하고 manifest CAS를 완료했다.
- `publicBookCatalogIndexV1`의 point-get only Rules와 indexing exemption 설정을 추가했다.
- 배포 직전 라이브 index inventory가 `indexes: []`, `fieldOverrides: []`임을 재확인했고, 배포 후 `publicBookCatalogIndexV1/*`의 collection-level indexing exemption이 활성화됐다. 기존 composite index는 없었으므로 제거된 항목도 없다.
- client는 server manifest를 확인한 뒤 generation 문서를 cache-first로 복원하고 cache miss나 checksum 불일치만 server에서 보충한다. 전체 schema·reference·count·SHA-256 checksum 검증이 끝난 snapshot만 책장에 전달한다.
- `Book`, Drive metadata, 사용자 콘텐츠 IndexedDB와 기존 `publicBookMetadataV1` 형식은 변경하지 않았다.
- PC·모바일 정렬 버튼을 통합 필터 버튼으로 교체하고 `최근에 읽은 순 / 가나다순 / 통합 인기순`, 출처·장르·태그 조건을 한 반응형 모달에 넣었다.
- 인기 태그는 작품 수 내림차순으로 처음 15개를 표시하고 `태그 15개 더보기`마다 15개씩 확장한다. 현재 페이지 밖에서 선택된 태그는 별도 `선택됨` 영역에 유지한다.
- 기본 검색 모달에 `#태그` 모드를 추가했다. exact → prefix → substring 순으로 태그를 책 위에 표시하고, 태그 선택은 literal 검색어 대신 책장 tag filter를 적용한다.
- grid/list 카드에는 genre, 대표 raw tag 2개와 `+N`, 연결된 출처의 표시용 합산 조회수를 표시한다. 유효 원본 수치가 없는 도서는 조회수 행을 만들지 않는다.
- 도서 정보창은 상세 플랫폼 metadata와 별개 상태로 catalog의 genre·deduplicated 전체 tag를 표시한다.
- package, service worker cache와 Foliate runtime revision을 `1.8.14` / `1.8.14.1`로 동기화했다.

## 자동검증 결과

- 실제 `file_check/.dedup_state/dedup_decisions.sqlite3` read-only dry-run:
  - 상세 projection 256문서, alias 27,051개, collision 제외 7개
  - compact catalog 25문서, 작품 12,102개, tag 1,295개, genre 15개
  - generation `6ed40232b8555a45bde9`, raw 3,182,063 bytes, 최대 문서 187,917 bytes
- Python이 생성한 실제 25문서를 TypeScript/Node client schema로 다시 읽어 SHA-256 checksum, 27,051 alias, 12,102 record, 1,295 tag와 15 genre를 교차 검증했다.
- `npm run test:node`: 556개 통과
  - formats 63, Drive 49, archives 33, storage 303, shelf 93, publisher 3, service worker 9, release 3
- `npm run test:rules`: 31개 통과. public catalog 단건 get 허용, list/create/update/delete 거부와 index exemption 설정 포함
- Firebase CLI schema validator로 `firestore.indexes.json`을 검증했다. 배포 전 inventory는 composite index·field override 모두 0개였고, 배포 후에는 `publicBookCatalogIndexV1`, field path `*`, `indexes: []` override가 표시된다.
- `npm run test:e2e`: Chromium·WebKit 20개 통과
- `npm run test:browser:ci`: 1,100권 fixture, desktop filter apply, 320px bottom sheet·horizontal overflow 0, 기존 검색·정보창·리더·service worker 회귀 통과. 최종 실행 검색 15ms, filter를 통한 가나다순 전환 47ms, long task와 수집된 page error 0
- `npm run check:full`: 최종 통과. ESLint에는 기존 Foliate 파일의 warning 2개만 있고 error는 0개다.
- `git diff --check`: 통과
- 첫 전체 실행에서 Node 22 + `tsx`가 통합 테스트의 TypeScript singleton을 ESM/CJS 두 인스턴스로 읽어 기존 progress concurrency 3개가 실패했다. 제품 코드는 바꾸지 않고 해당 테스트가 실제 hook과 같은 CommonJS singleton을 사용하게 보정했으며, storage 303개와 최종 full gate를 다시 통과했다.

## 실기기 검증 결과

### Firebase·catalog 게시

- 2026-08-17 `web-novel-viewer`에 Rules와 `firestore.indexes.json`을 먼저 배포했다. 배포 전 live Rules는 기준 커밋과 trailing newline 외에 같았고 `/tmp/firestore.rules.pre-1.8.14.rules`에 SHA-256 `2d5514b9f1340af405f24be668bf38663f35aca3c7f9d5c5e407f5a30c0b59c8`로 보존했다.
- 비로그인 catalog point-get은 게시 전 404, collection list와 client write는 403, 기존 `publicBookMetadataV1/00` point-get은 200이었다.
- index exemption field operation이 아직 `PROCESSING`일 때 첫 publisher 시도가 index-entry 한도로 중단됐다. 이때 alias 16 + catalog 2의 18개 immutable shard만 생성됐고 manifest는 없어서 incomplete generation이 client에 노출되지 않았다.
- field operation이 `SUCCESSFUL`이고 `completedWork == estimatedWork == 18`임을 확인한 뒤 재실행했다. 기존 18개는 byte-for-byte readback 후 재사용하고 나머지 6개를 생성했으며, generation 24개 전부를 다시 읽은 뒤 manifest를 CAS 전환했다.
- 최종 게시 결과는 상세 bucket 256개 update, catalog `created: 6`, `reused: 18`, `manifestUpdated: true`다. manifest `publishedAt`은 `2026-08-16T16:30:21+00:00`이다.
- 비로그인 REST 25개 point-get을 `/tmp/web-reader-catalog-1.8.14-live.jsonl`과 exact 비교했다. generation은 `6ed40232b8555a45bde9`, 25문서 aggregate SHA-256은 `0acec6dfeccd41f7f8b7a68b1f34772ca2163ef0a27ee4857e65a053ad062b5e`이며 list/write는 계속 403이다.
- 시리즈 다운로드·카카오 조회·노벨피아 조회를 플랫폼별 3개씩 총 9개 대조했다. compact `sourceCounts`, 기존 상세 projection과 SQLite 지정 metric이 9/9 일치했고 catalog miss인 로컬 도서 3개도 `없음(기타)` join으로 확인했다.

### Web Reader production

- 기능 커밋 `86ff457`을 `main`에 push했고 Vercel 고정 URL `https://twreader.vercel.app` 배포가 성공했다. `sw.js`는 `pc-reader-v1.8.14`와 1.8.14 설명을 제공한다.
- 같은 커밋의 GitHub `static-node-build`, `firestore-rules`, `playwright-security`, `browser-regression` 4개 check와 Vercel deployment status가 모두 success다.
- 실제 사용자 production 책장 PC Chromium 계열 Edge에서 10권을 확인했다. filter control 1개만 보이고 sort control은 0개였으며, catalog 매칭 9권에 tag와 source row가 표시되고 catalog miss 1권은 source row가 없었다. 가로 overflow는 0이다.
- 필터 모달은 `최근에 읽은 순 / 가나다순 / 통합 인기순`, 네 출처, 장르, 인기 태그 15개와 `태그 15개 더보기`를 표시했다. 더보기 뒤 30개가 됐고 `통합 인기순 + 없음(기타)` 적용 결과가 `1권 보기` 및 실제 1권과 일치했다. 검증 후 초기화해 10권·최근 읽은 순으로 복원했다.
- `#하렘` 검색은 tag 결과 7개를 도서보다 위에 표시했고 첫 결과는 `#하렘 672권`이었다. tag 선택은 실제 책장 2권 filter로 이어졌으며 검증 후 다시 초기화했다.
- 실제 매칭 도서 정보창에서 catalog chip 6개, 상세 플랫폼 badge·수치 block 1개를 함께 확인했고 modal 가로 overflow는 0이었다.
- 320px viewport override의 실제 content viewport 291×672에서 modal width 275, page/modal horizontal overflow 0, scroll body 활성, footer와 `10권 보기`가 화면 안에 유지됐다. 확인 후 modal을 닫고 viewport를 원래 크기로 복원했다.
- service worker 교체 직후 첫 reload에서 이전 page의 구 chunk unload 로그가 남았지만, 현재 1.8.14 script set으로 두 번째 reload한 뒤 filter·tag/source hydration은 동일했고 새 console error는 0건이었다.

### 남은 실제 기기 게이트

- 실제 Android/모바일 Chrome과 iPad Safari의 touch scroll·650ms long press·safe area·키보드 확인
- 홈 화면 설치형 PWA의 실행·cached second load·완전 offline 재실행 확인
- 다음 실제 catalog 변경 시 새 generation 전환, publish 중 network 단절, 직전 manifest rollback 확인

위 항목은 PC viewport emulation이나 자동 WebKit 통과로 실기기 완료 처리하지 않는다. 이번 production 확인은 PC Chromium과 320px responsive layout까지다.

## 2026-08-17 모바일 모달·목록 밀도 후속

상태: 두 차례 스크린샷 피드백 반영·로컬 full gate·production 배포 및 모바일 viewport 확인 완료

- 모바일 필터 overlay를 `items-end` bottom sheet에서 중앙 정렬 floating dialog로 바꾸고, 전체 `rounded-3xl`과 12px 최소 외곽 여백을 적용했다. 본문 스크롤과 고정 footer 구조는 유지한다.
- 모바일에서는 보조 설명을 숨기고 정렬 버튼을 아이콘·문구 한 줄의 44px 높이로 축약했다. filter chip, section 간격, header/body padding과 `태그 15개 더보기` 버튼도 모바일에서만 줄이고 `sm` 이상은 기존 밀도를 유지한다.
- floating modal의 최대 높이를 `88dvh → 82dvh`로 줄였다. 320×640 browser regression에서 left/right 12px, top 57.59375px, bottom gap 57.609375px, height 524.796875px, bottom-left radius 24px, horizontal overflow 0으로 확인됐다.
- 목록 보기의 출처별 원본 수치는 본문 제목·날짜·태그 아래에서 제거하고 `data-shelf-list-progress` 열의 `%` 바로 위 `data-shelf-list-source-slot`으로 옮겼다. 여러 출처는 6rem 모바일 열 안에서 source 단위로 줄바꿈한다.
- 목록 row padding은 모바일 `py-3 → py-2.5`, desktop `py-3.5 → py-3`으로 줄였다. 그리드 카드의 기존 출처 위치는 변경하지 않았다.
- `tests/bookCardLayout.test.mjs` 2개가 list source slot의 DOM 순서와 grid/list 분리를 검증한다.
- `npm run check:full`을 최종 압축 변경 뒤 다시 통과했다. Node 558개, Rules 31개, Playwright Chromium/WebKit 20개와 전체 Chromium browser regression이 통과했고 lint는 0 error·기존 Foliate warning 2개다. 최종 browser regression의 검색 20ms, 정렬 41ms, page error·long task는 0이었다.
- 최종 후속 커밋 `a0ae1f3`을 `main`에 push했고 Vercel production deployment와 GitHub CI 4개 job이 모두 성공했다.
- production `https://twreader.vercel.app`의 실제 content viewport 291×672에서 modal height 551.633px, top/bottom gap 60.547/59.820px, radius 24px, 정렬 버튼 높이 43.999px, subtitle `display:none`, footer visible, horizontal overflow 0을 확인했다. 확인 뒤 modal을 닫고 viewport override를 원복했다.

### 합산 조회수 표시 후속

- 책장 grid/list에서 플랫폼별 `시리즈 … 다운로드`, `카카오 … 조회`, `노벨피아 … 조회` 나열을 제거했다.
- 현재 도서에 연결된 플랫폼의 non-null `sourceCounts`를 합산하고 compact format 뒤에 `조회`만 붙인다. 예를 들어 `166.9만 + 137.8만`은 `304.7만 조회`로 표시한다.
- 이는 화면 밀도를 줄이기 위한 표시용 합계다. 단위 차이를 보정하는 `popularityScore`와 통합 인기순 comparator, 정보창의 플랫폼별 상세 원본 수치는 변경하지 않는다.
- `tests/bookCardLayout.test.mjs`가 list와 grid 모두 단일 합계만 출력하고 출처명·`다운로드`를 노출하지 않는지 검증한다.
- 최종 변경 뒤 `npm run check:full`을 통과했다. Node 558개, Rules 31개, Playwright Chromium/WebKit 20개와 Chromium browser regression이 모두 통과했고 lint는 0 error·기존 Foliate warning 2개다.
- 구현 커밋 `6209037`을 `main`에 push했고 Vercel production 배포를 완료했다. GitHub CI 첫 시도의 기존 WebKit sanitizer test가 `sanitized frame timed out`으로 1회 실패했지만, 코드 변경 없이 실패 job 재실행에서 20/20 통과해 최종 4개 job이 모두 success다.
- production의 실제 10권 목록에서 metadata가 있는 9권을 확인했다. `1783.4만 조회`, `304.7만 조회`, `1.3억 조회`, `2928.6만 조회` 등 모두 단일 합계였고 출처명·`다운로드` 잔존 0건, 형식 위반 0건, horizontal overflow 0, 확인 구간의 신규 console error 0건이었다.

## 보류·후속 버전

- tag 제외/NOT filter는 실제 사용 필요가 확인되면 후속 버전에서 별도 추가한다.
- 플랫폼별 개별 인기순이 필요하면 이미 보존한 `sourceRanks`를 사용해 UI만 확장한다.
- tag chip 직접 선택, filter preset, 다기기 filter 동기화는 1.8.14 실사용 후 판단한다.
