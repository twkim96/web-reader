# Web Reader 1.8.15 — 요청형 메타데이터 수집

작성일: 2026-08-17

기준 커밋: `29d1bec`

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

이전 버전: [update_1.8.14.md](./update_1.8.14.md)

상태: 계획 수립 완료, 구현 대기

## 목표

공개 catalog에 태그가 없는 도서의 정보창에 `메타데이터 요청` 버튼을 제공한다. 로그인 사용자가 버튼을 누르면 Web Reader의 Vercel 서버 함수가 네이버 시리즈·카카오페이지·노벨피아의 공개 검색·상세 데이터를 직접 조회하고, 제목 identity를 검증한 성공 결과만 Firestore에 등록한다.

`file_check`는 파서·identity 안전선의 참고 원본일 뿐 실행하거나 import하지 않는다. 로컬 SQLite, Control Server, 사용자의 Mac과 Vercel 배포를 연결하지 않는다.

초기 배포는 공개 조회만으로 완전히 동작해야 한다. NovelPia 성인 인증은 서버 수집기와 분리된 optional auth provider로 구현해, 나중에 Vercel production sensitive environment variable을 추가하고 새로 배포했을 때만 활성화할 수 있게 한다.

## 사용자 확정 UX

1. shelf와 reader가 공유하는 도서정보 화면에서 raw tag가 하나도 없을 때 요청 버튼을 표시한다.
2. 버튼을 누르면 `요청 → 확인 중 → 반영 완료/결과 없음/확인 필요/재시도` 상태를 같은 영역에 표시한다.
3. 수집 성공 직후 도서정보에는 전체 tag를 표시한다.
4. shelf list에는 raw tag 최대 5개, grid에는 최대 2개와 `+N`을 유지한다.
5. 새 tag·장르·출처·조회수는 현재 책장의 검색·필터·통합 인기순 파생 상태에도 반영한다.
6. 같은 작품의 동시·반복 요청은 하나로 합치고 최근 성공 결과가 있으면 외부 플랫폼을 다시 호출하지 않는다.
7. 공개 검색에서 찾지 못한 결과를 성인 작품으로 단정하지 않고 `공개 검색에서 찾지 못함 · 성인 인증 작품일 수 있음`으로 표시한다.

## 리뷰 판정

| 항목 | 판정 | 이유 |
| --- | --- | --- |
| 요청 클릭 시 Vercel 서버에서 즉시 크롤링 | 수용 | 현재 Next.js 배포 안에 server route를 추가할 수 있음 |
| `file_check` 실행·SQLite 연결 | 제외 | 배포 환경에 로컬 상태가 없고 요청형 기능의 독립성을 깨뜨림 |
| 브라우저에서 플랫폼 사이트 직접 호출 | 제외 | CORS·Origin/Referer·비밀정보 경계를 클라이언트에 노출함 |
| 결과를 Firebase에 서버 권한으로 등록 | 수용 | 기존 public collection의 client write 차단을 유지할 수 있음 |
| 기존 compact base generation을 요청마다 in-place 수정 | 제외 | immutable generation·dictionary·checksum 계약을 깨뜨림 |
| per-title 원본 + compact delta generation | 수용 | 요청형 작은 변경을 base catalog와 독립적으로 게시 가능 |
| 계정명 하나만 env에 저장 | 불충분 | 현재 NovelPia 인증에는 이메일과 비밀번호 또는 교체 가능한 session credential이 필요함 |
| Vercel env가 없으면 전체 요청 기능 중단 | 제외 | 공개 수집은 인증 설정과 독립적으로 항상 동작해야 함 |
| 성인 계정 credential을 repo·Firestore·로그에 저장 | 제외 | 서버 secret 경계를 위반함 |
| 사용자가 tag 문자열을 직접 입력·수정 | 제외 | 플랫폼 출처가 증명된 metadata 요청만 다룸 |

## 데이터·보안 경계

### 요청 경로

```text
BookInfoModal
  → Firebase ID token을 포함한 POST /api/book-metadata/refresh
  → Vercel Node.js server route
  → alias/title 검증 + rate limit + lease
  → Series/Kakao/NovelPia crawler 병렬 실행
  → identity 검증
  → per-title Firestore 결과 저장
  → compact delta generation 게시
  → 현재 React catalog에 merge
```

- API는 Firebase client ID token을 Firebase Admin SDK로 검증하고 `uid`를 신뢰 기준으로 사용한다.
- 클라이언트가 보낸 uid, platform URL, remote ID, tag와 count는 신뢰하지 않는다.
- 서버가 허용한 고정 HTTPS host와 path만 호출해 SSRF 입력면을 만들지 않는다.
- raw filename과 표시 제목은 길이를 제한하고 서버 normalizer를 다시 거친다.
- 동일 제목 후보가 여러 개면 첫 결과를 임의 선택하지 않고 `ambiguous`로 종료한다.
- 플랫폼별 실패를 분리해 한 플랫폼 timeout이 다른 유효 결과를 폐기하지 않게 한다.
- 응답 본문·로그·Firestore에는 credential, cookie, 원격 HTML 전문과 stack secret을 남기지 않는다.

### Firestore 원본과 delta

요청 결과의 서버 원본은 title 단위 문서로 둔다.

```text
publicBookMetadataOnDemandV1/{aliasId}
```

개념 schema:

```ts
type PublicBookMetadataOnDemandV1 = {
  schemaVersion: 1;
  aliasId: string;
  queryTitle: string;
  status: 'ready' | 'confirmed-empty' | 'not-found' | 'ambiguous' | 'restricted' | 'error';
  platforms: Array<{
    platform: 'series' | 'kakao' | 'novelpia';
    remoteId: string;
    remoteTitle: string;
    url: string;
    genre: string | null;
    tags: string[] | null;
    sourceCount: number | null;
  }>;
  crawledAt: string;
  nextRefreshAt: string;
  crawlerVersion: string;
};
```

base `publicBookCatalogIndexV1`은 1.8.14 형식 그대로 보존한다. 요청 결과는 별도 immutable delta generation으로 게시한다.

```text
publicBookCatalogDeltaV1/manifest
publicBookCatalogDeltaV1/{generation}_alias_*
publicBookCatalogDeltaV1/{generation}_catalog_*
```

- delta는 on-demand 원본 전체에서 deterministic하게 다시 만들고 manifest-last CAS로 전환한다.
- client는 base catalog를 검증한 뒤 delta를 검증·merge한다. 같은 alias는 delta가 base record를 대체한다.
- tag dictionary는 label 기준으로 합치고 overridden base record의 기존 tag count를 먼저 빼서 distinct title count를 이중 계산하지 않는다.
- delta publish가 실패하면 기존 manifest는 유지한다. per-title 원본의 `publishPending` 상태를 다음 요청 또는 관리 재시도로 복구한다.
- client는 collection list/query를 사용하지 않고 manifest가 지정한 point-get만 수행한다.
- public client는 두 collection 모두 `get`만 가능하고 create/update/delete/list는 계속 거부한다.

### 요청·중복·rate limit

- alias 단위 deterministic lease로 동시 요청 하나만 crawler를 실행한다.
- lease는 owner token과 만료 시각을 함께 저장하고 stale owner만 회수할 수 있다.
- 성공 또는 authoritative empty 결과는 기본 7일 동안 cache hit로 반환한다.
- transient error는 짧은 retry window를 두되 성공 cache를 덮어쓰지 않는다.
- 사용자별 일일 요청 상한과 alias별 전역 cooldown을 Firestore transaction에서 함께 검사한다.
- HTTP retry는 timeout·429·일시적 5xx만 bounded backoff하며 `not-found`, `ambiguous`, 인증 실패를 일반 재시도로 바꾸지 않는다.

## crawler 구조

`file_check/backend/platform_catalog.py`의 결과 의미와 fail-closed identity 정책을 참고하되 Web Reader server-only TypeScript로 독립 구현한다.

```ts
interface PlatformCrawler {
  readonly platform: 'series' | 'kakao' | 'novelpia';
  searchPublic(input: CrawlInput, signal: AbortSignal): Promise<CrawlResult>;
  fetchKnownIdentity?(input: KnownIdentityInput, signal: AbortSignal): Promise<CrawlResult>;
}

interface PlatformAuthProvider {
  readonly mode: 'disabled' | 'credentials';
  isConfigured(): boolean;
  withSession<T>(work: (session: AuthenticatedSession) => Promise<T>): Promise<T>;
}
```

- Series: 검색 HTML → unique exact title → 상세 HTML의 장르·다운로드 수
- Kakao: BFF search → overview → about, 고정 `Origin: https://page.kakao.com`과 `Referer` 적용
- NovelPia public: 공개 search JSON → 필요할 때 상세 tag fallback
- subsequent refresh: 저장된 remote ID와 remote title을 먼저 검증하고, 불일치에서 search로 조용히 다른 작품으로 갈아타지 않음
- crawler parser와 network orchestration을 분리해 저장 fixture로 parser를 재현 가능하게 테스트함

## optional NovelPia 인증 확장

계정명만 추가해서는 부족하다. 현재 참고 로직의 password login을 사용할 경우 다음 세 값을 server-only로 사용한다.

```text
NOVELPIA_AUTH_MODE=disabled|credentials
NOVELPIA_EMAIL=...
NOVELPIA_PASSWORD=...
```

운영 계약:

- 변수명에 `NEXT_PUBLIC_`을 붙이지 않는다.
- email/password는 Vercel production의 **Sensitive Environment Variables**로 등록한다.
- 기본값은 `disabled`이고 env가 전혀 없어도 public crawler와 요청 기능은 정상 동작한다.
- `credentials`인데 email/password 중 하나라도 없으면 authenticated path만 configuration error로 닫고 public 결과를 보존한다.
- env 변경은 과거 deployment에 적용되지 않으므로 새 production deployment 뒤에만 활성화됐다고 판단한다.
- login → CAPTCHA 확인 → adult-mode/session 검증을 모두 통과한 세션만 결과 쓰기를 허용한다.
- CAPTCHA, 성인 본인인증 미완료, session 만료는 서로 다른 status로 기록하고 partial authenticated result를 쓰지 않는다.
- session 만료 시 같은 요청에서 재로그인은 최대 1회로 제한한다.
- credential과 cookie는 module global 장기 cache, Firestore, response, log, telemetry에 남기지 않는다.
- 나중에 password 대신 session cookie/token 방식이 필요하면 새 `PlatformAuthProvider`만 추가하고 crawler·API·저장 schema는 바꾸지 않는다.

[Vercel Sensitive Environment Variables](https://vercel.com/docs/environment-variables/sensitive-environment-variables)는 생성 후 값을 읽을 수 없게 보관할 수 있다. 일반 [Vercel environment variable](https://vercel.com/docs/environment-variables) 변경은 기존 deployment에 소급 적용되지 않는다. 다만 Vercel project 접근 권한과 user code의 secret 취급 책임은 계속 운영자에게 있다.

client login을 custom backend에서 확인하는 경계는 Firebase 공식 [ID token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens)을 따른다.

## Phase A — 계약·fixture·위험 검증

상태: 대기

1. 세 플랫폼의 현재 공개 응답을 개인정보 없는 fixture로 고정한다.
2. title normalize, exact/author match, ambiguous rejection, count/tag normalize 계약을 TypeScript 테스트로 먼저 작성한다.
3. Vercel Preview에서 각 플랫폼의 고정 URL egress가 허용되는지 read-only probe한다.
4. 플랫폼 이용정책·rate limit과 request 빈도를 확인하고 기본 cooldown을 확정한다.

완료 조건:

- 로컬 성공만으로 Vercel 실행 가능을 단정하지 않고 Preview 실응답 증거가 있다.
- 같은 제목의 다른 작품을 선택하는 fixture가 0건이다.
- platform response shape가 바뀌면 정상 빈 결과가 아니라 parser error가 된다.

## Phase B — server auth·API 골격

상태: 대기

주요 영역:

- `src/app/api/book-metadata/refresh/route.ts`
- `src/server/firebaseAdmin.ts`
- `src/server/bookMetadata/config.ts`
- `src/server/bookMetadata/requestSchema.ts`

1. Node.js runtime과 bounded `maxDuration`을 명시한다.
2. Firebase Admin을 server-only singleton으로 초기화한다.
3. Bearer ID token 검증, body size·title 길이·method·content-type 검증을 추가한다.
4. env schema를 `disabled` 기본으로 parse하고 secret 값을 오류 메시지에서 제거한다.
5. AbortSignal 기반 overall/platform timeout을 고정한다.

완료 조건:

- 비로그인·위조 token·다른 project token은 crawler 실행 전 거부된다.
- client bundle과 static route에 Admin credential 또는 NovelPia env가 포함되지 않는다.
- env가 없는 production/preview build가 그대로 성공한다.

## Phase C — 공개 platform crawler

상태: 대기

1. Series, Kakao, NovelPia crawler와 공통 result validator를 구현한다.
2. 세 플랫폼을 병렬 실행하되 플랫폼 내부 search/detail 순서는 유지한다.
3. 고정 host allowlist, response size ceiling, redirect host 재검증을 적용한다.
4. 저장 remote identity가 있으면 direct refresh를 우선하고 title mismatch를 fail-closed한다.
5. partial success와 platform별 오류 상태를 보존한다.

완료 조건:

- 공개 작품 표본에서 출처·장르·tag·source count가 참고 로직과 일치한다.
- Kakao Origin/Referer 누락 회귀, NovelPia tag fallback과 Series unavailable page가 테스트된다.
- timeout·429·5xx·HTML/JSON shape 변경에서 잘못된 metadata를 쓰지 않는다.

## Phase D — lease·결과 저장·rate limit

상태: 대기

1. alias deterministic key와 request transaction을 구현한다.
2. fresh cache, active lease, stale lease takeover, daily user quota와 global cooldown을 분리한다.
3. validated result만 `publicBookMetadataOnDemandV1`에 서버 권한으로 쓴다.
4. success를 error/not-found가 덮지 못하게 상태 전이와 updated-at precondition을 둔다.
5. Rules에서 public point-get과 모든 client write/list 거부를 검증한다.

완료 조건:

- 동시 10개 요청에서도 upstream crawl은 alias당 1회다.
- replay는 같은 결과를 반환하고 document를 중복 생성하지 않는다.
- quota·lease 실패가 기존 공개 결과를 변경하지 않는다.

## Phase E — compact delta·client merge

상태: 대기

1. on-demand 원본에서 deterministic delta shard와 checksum을 생성한다.
2. immutable create/readback 후 manifest-last CAS로 전환한다.
3. base + delta parser/merge와 persistent cache fallback을 구현한다.
4. delta record를 shelf derived join, tag 검색·filter·popular tag count·통합 인기순에 연결한다.
5. publishPending 복구와 직전 delta generation rollback을 제공한다.

완료 조건:

- 요청 성공 직후 정보창 전체 tag, list 5개, grid 2개가 표시된다.
- 앱 재실행·다른 기기에서도 같은 delta가 적용된다.
- partial delta publish와 checksum mismatch에서 base catalog와 이전 delta가 유지된다.
- base generation 형식과 1.8.14 client 호환을 변경하지 않는다.

## Phase F — 요청 UI·상태

상태: 대기

1. shared `BookInfoModal`의 장르·태그 section을 catalog missing/empty/loading/error 상태별로 정리한다.
2. raw tag가 0개이고 catalog loading이 끝난 도서에만 요청 버튼을 표시한다.
3. request progress, cache hit, ready, confirmed-empty, not-found/restricted, ambiguous와 retryable error 문구를 구현한다.
4. 성공 response를 현재 React catalog에 즉시 merge하고 layout transition을 유지한다.
5. close/unmount·book switch에서 stale response가 다른 도서에 적용되지 않게 한다.

완료 조건:

- shelf와 reader 정보창이 같은 요청 상태·결과를 보인다.
- 중복 클릭, Back/close, offline, token refresh와 응답 순서 역전이 안전하다.
- tag가 이미 있는 도서에는 요청 버튼이 나타나지 않는다.

## Phase G — optional auth provider

상태: 대기

1. `disabled`와 `credentials` provider를 crawler에서 분리한다.
2. env 완전성 검사, login/CAPTCHA/adult mode/session verification을 구현한다.
3. public triple-miss 또는 명시적으로 restricted인 NovelPia 대상에만 authenticated fallback을 허용한다.
4. stored remote ID가 있는 authenticated metadata refresh는 search로 identity를 바꾸지 않는다.
5. fake provider와 redaction test를 통과한 뒤 실제 credential 추가 전까지 production mode는 `disabled`로 유지한다.

완료 조건:

- env 없음·불완전·잘못된 로그인에서도 공개 수집 결과와 기존 catalog가 보존된다.
- log, response, Firestore, test snapshot과 build artifact에서 secret 문자열이 0건이다.
- 실제 계정 env를 추가하기 전에는 성인 작품 성공으로 표시하지 않는다.
- 향후 session-cookie provider 추가가 API·crawler·저장 schema 변경 없이 가능하다.

## Phase H — release·production acceptance

상태: 대기

1. Firestore Rules/index를 먼저 배포하고 live deny/get 경계를 확인한다.
2. public-only 상태로 Vercel production을 배포한다.
3. Series/Kakao/NovelPia 성공, tag empty, not-found, ambiguous와 timeout 표본을 실제 정보창에서 확인한다.
4. request 완료 후 정보창·list/grid·filter/search·인기순과 재실행 cache를 대조한다.
5. credential activation은 사용자가 Vercel sensitive env를 별도로 추가한 뒤 새 deployment에서 독립 acceptance한다.

## 자동검증 계획

- parser fixture: 정상·빈 tag·동일 제목 복수·unavailable·shape drift
- request schema: oversized·unknown field·malformed title·arbitrary URL 거부
- Firebase Admin ID token: missing/expired/wrong-project token 거부
- lease/rate limit: concurrent winner, replay, stale takeover, quota boundary
- crawler: overall timeout, platform partial success, bounded retry, redirect allowlist
- result schema: count ceiling, HTTPS URL, tag dedup/length/count 제한
- delta: deterministic output, size ceiling, checksum, manifest CAS·rollback
- merge: base override, alias collision, tag count delta, filter/search/sort parity
- UI: shared shelf/reader modal, button visibility, stale response, offline/retry
- secret audit: `NEXT_PUBLIC_` 금지, error/log redaction, client bundle 문자열 검사

전체 gate:

```bash
npm run check:full
git diff --check
```

## 실기기·운영 검증 계획

- PC production Chrome에서 요청 1건의 상태 전이와 즉시 tag 반영
- Android Chrome·iPad Safari·설치형 PWA의 modal button, loading과 wrap
- 요청 완료 뒤 완전 종료·재실행 및 다른 로그인 기기에서 delta 복원
- offline 요청 차단과 online 복귀 후 명시적 재시도
- Vercel Preview/Production의 세 플랫폼 egress·timeout·로그 redaction
- env 없는 public-only deployment 성공
- 추후 sensitive env 추가 뒤 새 deployment에서 login, CAPTCHA, adult-mode verification과 성인 작품 표본 확인

## 명시적 제외

- `file_check` process·CLI·SQLite·Control Server 호출
- 클라이언트 직접 crawling과 credential 전달
- 자동 background crawl, shelf 진입 시 대량 누락 backfill
- 사용자가 입력한 tag·genre·source count의 직접 공개 반영
- 기존 `Book`, Drive metadata와 사용자 콘텐츠 IndexedDB migration
- 기존 `publicBookCatalogIndexV1` generation의 요청별 in-place patch
- credential·cookie를 GitHub, Firestore, Vercel build log 또는 client cache에 저장
- CAPTCHA 우회, 본인인증 자동화와 인증되지 않은 계정의 성인 작품 성공 처리

## rollback

- request 버튼은 server capability/config 오류에서 숨기거나 재시도 불가 상태로 전환할 수 있다.
- on-demand collection과 delta manifest를 읽지 않는 1.8.14 client는 영향을 받지 않는다.
- invalid delta는 client가 거부하고 base catalog만 사용한다.
- delta manifest를 직전 generation으로 CAS 전환해 결과를 되돌릴 수 있다.
- auth mode를 `disabled`로 바꾸고 새로 배포하면 credential path만 끌 수 있으며 public crawler는 유지된다.
- public request 기능 전체를 끌 때도 기존 1.8.14 catalog·필터·상세 metadata는 유지된다.

## 전체 완료 조건

- tag 없는 도서에서 로그인 사용자가 요청을 시작하고 Vercel이 직접 수집한다.
- `file_check`와 로컬 SQLite 없이 세 플랫폼 공개 metadata를 검증·저장한다.
- 성공 결과가 Firebase와 compact delta에 원자적·재개 가능하게 반영된다.
- 정보창 전체 tag, list 5개, grid 2개와 검색·필터·정렬이 같은 결과를 사용한다.
- 동시 요청·rate limit·timeout·ambiguous title이 잘못된 metadata를 만들지 않는다.
- env가 없어도 public-only 기능이 정상이며 auth provider는 disabled다.
- 추후 email/password sensitive env 추가와 새 deployment만으로 credentials provider를 활성화할 수 있다.
- secret이 source, client bundle, Firestore, log와 테스트 결과에 노출되지 않는다.
- full gate와 public-only production acceptance를 기록하고, 실제 성인 인증 성공은 credential 설정 후 별도 증거가 있을 때만 완료 처리한다.

## 구현 결과

구현 후 기록한다.

## 자동검증 결과

구현 후 기록한다.

## 실기기 검증 결과

구현 후 기록한다.

## 보류·후속 버전

- session cookie/token provider는 password login이 불안정하거나 플랫폼 계약이 바뀔 때 추가한다.
- 요청 데이터가 delta size ceiling에 가까워지면 Firestore on-demand 원본에서 base catalog를 재생성하는 별도 compaction release를 계획한다.
- 자동 backfill, 관리자 큐·dashboard와 수동 identity review는 요청량과 오매칭 표본이 확인된 뒤 판단한다.
