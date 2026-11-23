# 배포·업데이트·복구

## 실행과 배포

저장소의 릴리스 기록은 Vercel 배포를 사용합니다. 현재 배포 성공은 대상 커밋/빌드의 배포 상태를 따로 확인해야 하며 Git push나 로컬 build 성공만으로 판정하지 않습니다. runtime은 `npm run build` → `npm run start`로 확인할 수 있습니다. 클라이언트 공개 변수는 빌드에 반영하고 서버 비밀 설정은 [개발 가이드](../development/setup-and-checks.md)에 따라 배포 환경에 설정합니다.

[vercel.json](../../vercel.json)은 프로젝트의 Vercel Functions를 서울(`icn1`)에 배치합니다. 운영 기본 Firestore의 서울 리전(`asia-northeast3`)과 가깝게 두기 위한 설정입니다. 배포 후 동적 API 응답의 `x-vercel-id`에서 함수 실행 위치를 확인합니다. 마이페이지의 인증·조회·작품 정보 연결 시간은 [계측 방법](../development/setup-and-checks.md#완료-증거)으로 배포 전후를 비교합니다. [Vercel 함수 리전](https://vercel.com/docs/functions/configuring-functions/region)

버전은 [package.json](../../package.json), [package-lock.json](../../package-lock.json), [public/sw.js](../../public/sw.js)와 [releaseVersion.test.mjs](../../tests/releaseVersion.test.mjs)의 일관성을 유지합니다. 같은 버전의 코드 변경도 [app-build-id.mjs](../../scripts/app-build-id.mjs)가 `src/`, `public/`, 패키지·Next config·공개 환경변수로 build ID를 계산합니다. 문서 파일만 바꾼 경우 이 입력은 바뀌지 않습니다.

배포 전 작업 범위에 필요한 [검증](../development/setup-and-checks.md#검증-선택)을 끝내고 버전별 증거는 [updates](../updates/README.md)에 보관합니다. 사용자가 위임하지 않은 실제 게시·Rules 배포·서비스 조작을 문서 정리의 일부로 실행하지 않습니다.

## PWA 설치와 업데이트

Service Worker는 manifest/정적 자원과 일관된 오프라인 HTML shell을 준비합니다. `pc-reader-` + 버전 + build ID로 shell/runtime cache를 구분하고 새 worker가 활성화되면 같은 앱 prefix의 이전 cache를 정리합니다. IndexedDB 도서와 이 Cache Storage는 별도 저장소입니다. 읽기 글꼴은 오프라인에서 선택할 수 있도록 설치 중 준비합니다. 리디 바탕은 WOFF2를 준비하고 OTF 대체 파일은 필요할 때 가져옵니다.

업데이트 안내는 휴대폰처럼 좁은 화면에서 좌우 여백을 남긴 넓은 폭을 사용하고, 적용 버튼은 `저장 후` / `적용` 두 줄로 표시합니다. 넓은 화면에서는 기존 자동 너비와 한 줄 버튼을 유지합니다.

`저장 후 적용`을 누르면 `처리 중…`을 표시하고 현재 진행률 flush와 로컬 commit drain을 기다립니다. 저장이 끝나면 대기 중인 worker에 `SKIP_WAITING`을 보내고 controller 교체 후 새로고침합니다. 같은 브라우저의 다른 탭이 먼저 worker를 활성화하면 현재 탭도 `저장 후 적용`을 통해 자체 저장을 끝낸 뒤 새로고침합니다. 저장이 실패하거나 worker 활성화가 응답하지 않으면 버튼에서 다시 시도할 수 있습니다. 임시 슬라이더 이동 중에는 [리더 저장 계약](../SPEC/reader-and-progress.md)에 따라 업데이트 flush도 성공 처리하지 않습니다.

인증/Firebase helper·`/api/`·외부 origin·Authorization·Range·GET 이외 요청은 SW cache 경로에서 제외합니다. 응답 `private`/`no-store`도 저장하지 않습니다. 실행 중 Cache Storage를 읽을 수 없으면 네트워크로 요청하고 성공한 응답을 캐시 쓰기 결과와 독립적으로 전달합니다. 새 worker 설치에는 필수 자원의 캐시 준비가 필요합니다. [sw-policy.js](../../public/sw-policy.js), [sw.js](../../public/sw.js), `useServiceWorkerUpdate`, `serviceWorkerUpdatePolicy`가 기준입니다.

PWA 최초 설치, 대기 worker 적용, 오프라인 재진입은 실제 브라우저에서 따로 확인합니다. Android/iPad/PWA 확인 중 남은 것은 [TODO](../TODO.md)에 있습니다.

## 저장과 복구

IndexedDB 이름·버전·store/index의 기준은 [localDBSchema.ts](../../src/lib/localDBSchema.ts)입니다. 현재 `web-reader-db`에서 store 이름의 v5/v8/v11 등은 기능 도입 시점이며 DB 현재 버전과 같다는 뜻이 아닙니다. 구조 변경은 active user data를 보존해야 합니다. v6 이전 콘텐츠 구조의 의도된 초기화와 v6 이후 index 추가 업그레이드를 구분합니다.

기기 콘텐츠 namespace와 Firebase/guest 상태 namespace는 [계정 경계](../integrations/firebase-and-drive.md#계정과-데이터-경계)를 따릅니다. 업그레이드 `blocking`에서 오래된 connection을 닫고 다시 열 수 있어야 하며 실패를 DB 전체 삭제로 복구하지 않습니다. 용량 부족에는 오류를 표시하고 검증된 기존 파일·진행 상태를 보존합니다.

Drive 원본은 재다운로드용입니다. 로컬로만 넣은 원본은 사용자가 별도 보관해야 합니다. 주석·통계 export와 진단 JSON은 전체 브라우저 데이터 백업/복원 수단이 아닙니다. 게스트 기록과 아직 전송하지 않은 outbox는 다른 기기의 Firestore 기록만으로 복구할 수 있다고 가정하지 않습니다.

저장소 진단은 [통계 화면](../SPEC/reading-statistics.md#진단)에서 export합니다. 미전송 outbox, event receipt, 삭제 tombstone/marker, revision head, 이전 library namespace의 역할을 확인한 뒤 정리 여부를 결정합니다. 진단의 보존 기간이나 정리 계획 함수는 자동 삭제 허가가 아닙니다. 실제 기기 migration/rollback·pending/conflict 0건·구 namespace 조사 등 기존 완료 조건은 [TODO](../TODO.md)에 보존합니다.

## Firestore Rules와 롤백

[firebase.json](../../firebase.json)의 `firestore.rules`·`firestore.indexes.json`을 기준으로 demo emulator 검사(`npm run test:rules`)를 먼저 수행합니다. production 배포 전 대상 프로젝트/DB와 배포된 Rules/index를 확인하고 원문을 보존합니다. Rules에는 클라이언트 owner 접근과 공개 metadata read, 서버 전용 쓰기 경계가 함께 있으므로 과거 v2 후보만 현재 전체 Rules로 취급하지 않습니다.

둘러보기의 위시리스트 최신순에는 `myPageWishlistV1`의 저장 여부·저장 시각·작품 키 복합 인덱스가 필요합니다. 운영 반영 시 [인덱스 정의](../../firestore.indexes.json)를 배포하고 인덱스가 준비되면 공개 위시리스트 피드를 확인합니다. 빌드 중에는 저장 항목을 읽어 서버에서 정렬하는 대체 경로가 동작합니다.

공개 마이페이지의 다음 페이지 토큰은 Admin SDK로만 접근하는 `serverSecretsV1/myPageProfileCursor`의 키로 암호화합니다. 첫 토큰 발급 시 서버가 키를 생성하며 여러 서버 인스턴스가 공유합니다. Firebase 클라이언트는 이 경로에 접근할 수 없습니다.

[2026-07-13 production 기준선](../updates/firestore-rules-production-baseline-2026-07-13.md)과 [원문 백업](../backups/firestore.rules.production-2026-07-13.rules)은 당시 v1→v2 배포의 역사적 자료입니다. 배포 설정과 Rules 테스트는 루트의 `firestore.rules`를 읽으며 이 이력 Markdown을 입력으로 사용하지 않습니다. 현재 production Rules는 문서 정리에서 새로 확인하지 않았습니다. 롤백 시 **해당 배포 전에 확인한** 백업을 복원하고, Firestore/IndexedDB 데이터를 삭제하지 않습니다. 오래된 백업은 후속 주석·통계·메타데이터 schema와 맞지 않을 수 있으므로 현재 client와의 호환성을 먼저 확인합니다.

### 자동 필드 인덱스 축소

`publicBookMetadataV1`의 상세 버킷은 문서 ID로 조회합니다. `readingStatsV1`은 서버 업로드 시각의 컬렉션 범위 양방향 인덱스를, `eventReceipts`는 생성 시각의 컬렉션 범위 양방향과 컬렉션 그룹 오름차순 인덱스를 사용합니다. 유지 방향과 제외 대상은 [인덱스 정의](../../firestore.indexes.json)가 기준입니다.

기존 컬렉션의 인덱스를 제외할 때는 운영 설정을 기록한 뒤 필요한 개별 필드를 먼저 명시적으로 설정합니다. 필드별 Admin API에서 `updateMask=indexConfig`와 유지할 방향 전체를 보냅니다. 작업 완료와 인덱스 `READY`를 확인하고 실제 쿼리를 실행한 뒤 와일드카드나 미사용 필드를 제외합니다. Firebase CLI 전체 배포에는 이 순서와 완료 대기를 맡기지 않습니다. 롤백할 때는 이전 필드 설정을 복원한 뒤 인덱스 재구축과 실제 쿼리 복구까지 확인합니다.

적용 전후에 도서 상세 단건 조회, 통계 양방향 페이지·주간 건수 대조·문서 ID 기반 조회, 영수증 단건·날짜·그룹 조회를 확인합니다. 인덱스 작업 완료와 DB 전체 용량 지표 `firestore.googleapis.com/storage/data_and_index_storage_bytes`의 감소 확인은 별도입니다. 비교할 때 동일한 데이터베이스와 단위의 적용 전후 시계열을 사용합니다. [Firestore 인덱스 관리](https://firebase.google.com/docs/firestore/query-data/indexing) · [저장량 지표](https://cloud.google.com/monitoring/api/metrics_gcp_d_h)

## 공개 프로필 후보 캐시

페이지가 여러 개인 공개 목록은 서버 인스턴스 안에서 후보를 짧게 재사용합니다. 삭제 기록까지 포함한 항목 수와 저장 버전의 합을 Firestore에서 대조하고, 처음 저장한 목록과 그 버전은 같은 시점의 스냅샷으로 읽습니다. 위시리스트와 평가를 변경하는 기존 경로는 항목 버전을 높이며 삭제할 때도 버전을 보존합니다.

별도 환경 변수, 쓰기, 인덱스 배포와 백필 없이 적용합니다. 버전 대조에 실패하면 최신 후보를 읽습니다. 관리자 복원이나 이관으로 공개 목록 문서를 직접 교체할 때도 항목 버전을 보존하거나 증가시킵니다. 이전 버전으로 되돌리는 복원에서는 공개 요청을 재개하기 전에 기존 서버 인스턴스를 교체하거나 후보 캐시가 만료될 때까지 기다립니다. [검증 로그](../development/setup-and-checks.md#완료-증거)에서 첫 페이지·다음 페이지·평가 수정·비공개 전환을 비교합니다.

## 독서 통계 사전 집계 검증

맥에서 Node.js 22.13 이상으로 실행하여 같은 고정 시점의 독서 이력을 SQLite에 페이지별로 저장하고 7일 상세 후보를 계산합니다. 기존 앱과 동일한 겹침·시간 보정·활동 기준을 사용합니다. 각 계정의 마지막으로 저장한 문서 ID와 같은 Pacific 날짜의 프로젝트 예산을 한 SQLite 파일에 기록합니다. 예제는 별도 demo Firestore를 사용합니다.

```sh
FIRESTORE_EMULATOR_HOST=127.0.0.1:8089 node --import tsx scripts/backfill-reading-statistics.mjs --project demo-web-reader --uid fixture-account --first-week 2026-09-14 --through-week 2026-11-09 --daily-reads 1000 --daily-weeks 5
```

`--through-week`는 마지막 주의 월요일입니다. 원본 페이지 예산과 후보 생성 주 수는 각기 제한하며, 필요한 원본을 다 모은 뒤 후보 생성을 시작합니다. 기본 SQLite 파일은 `~/.local/state/web-reader/statistics-backfill.sqlite`입니다. 검증 환경에서는 `--state`로 별도 파일을 사용합니다. 이 파일에는 개인 원본 세션이 들어 있으므로 작업 폴더와 Git 밖에서 관리합니다. `weeks` 테이블의 `payload`가 주간 후보입니다. 기본 모드는 Firestore를 읽고 SQLite에 결과를 저장합니다. 같은 DB를 처리하는 동안은 같은 상태 파일을 사용합니다. 운영을 읽는 경우 프로젝트 ID·ADC·`--confirm-live-read`가 필요하며 실제 할당량에 반영됩니다.

입력 세대의 시각은 밀리초와 그보다 작은 나노초를 함께 보존합니다. 같은 밀리초 안에서도 백필 기준 시각 뒤에 생성된 문서는 이후 증분 수집 대상입니다. 원본이 기준 시각 뒤에 수정됐거나 세션 형식이 깨졌으면 `blocked` 결과와 문서 ID·사유를 SQLite에 기록합니다. 같은 작업을 다시 실행하면 추가 읽기 없이 중단 위치를 반환합니다. 기존 파일에 정밀도 변경 전의 작업이 있으면 파일을 보존하고, 새 조회가 필요할 때 해당 날짜의 잔여 읽기 예산을 확인한 뒤 별도 `--state`에서 시작합니다.

주간 계산에는 주 경계와 겹칠 수 있는 세션과 그 세션의 시계 보정에 필요한 표본을 사용합니다. 파일럿 검증은 SQLite의 9주 초안과 정기 마감용 증분을 합쳐 전체 입력으로 계산한 값과 주별 상세·달력 값을 대조합니다. 아직 초안인 주에 늦은 기록이 들어오면 기존 초안과의 차이를 검증 결과에 포함합니다.

### 공유 예산과 정기 마감

`--handoff`는 정확히 연속된 9주를 준비한 뒤 Firestore에 비공개 초안과 다음 마감 작업을 저장합니다. 이 모드의 원본 페이지 읽기는 맥과 Vercel이 같은 계정 작업권과 Pacific 날짜별 프로젝트 예산을 사용합니다. 원본 페이지 예약 상한은 프로젝트당 2,000건이며 작업권·예산·발행 트랜잭션의 읽기는 별도입니다. 파일럿에는 `--pilot-tuesday`를 함께 지정합니다. 이미 등록한 동일 초안은 재실행해도 한 번만 저장합니다.

Vercel Cron은 매일 오후 6시 KST에 `/api/reading-statistics/rollup`을 호출합니다. 배포 환경의 `ENABLE_READING_STATS_ROLLUP=1`과 `CRON_SECRET`이 있어야 실행됩니다. 기기 시간대의 마지막 일요일이 아직 지나지 않은 월요일 슬롯은 다음 실행에서 처리합니다. 정기 마감은 등록된 작업만 대상으로 하고 예산이나 실행 시간이 끝나면 저장된 업로드 시각·문서 ID부터 이어갑니다. 첫 마감은 백필 기준일 전 하루를 겹쳐 읽어 문서 생성 시각과 업로드 시각의 경계를 잇고, 세션 ID로 중복을 제거합니다. 이후에는 직전 마감의 업로드 시각 뒤만 조회합니다.

9주 초안과 첫 정기 상세를 모두 준비한 뒤, 10주 달력과 발행 포인터를 같은 트랜잭션에서 저장합니다. 이후에도 상세는 주마다 확정하고 달력 문서는 열 주가 모일 때마다 확정합니다. 이전 집계는 각 마감 시각 기준으로 고정하며 뒤늦은 원본은 보존합니다. 손상 입력이나 문서 크기 한계에 걸린 작업은 기존 발행본을 유지한 채 자동 실행에서 빠집니다. 운영에서 켜기 전에 새 인덱스 적용, 실제 계정 대조, 파일 크기·읽기량을 확인합니다. [남은 작업](../TODO.md#독서-통계-사전-집계)

계정별 파일 합계와 전체 통계의 도서별 합계는 인덱스를 만들지 않는 `readingStatsRollupFilesV1/current`에 함께 저장합니다. 주간 마감에서 기존 합계에 이번 주를 더하고 같은 트랜잭션에서 발행 주를 갱신합니다. 768 KiB 한도에서는 파일 합계를 우선하고, 열린 기간의 평가 증빙 입력이 함께 들어갈 수 있으면 도서별 통계 합계보다 먼저 보존합니다. 파일 합계만으로도 한도를 넘으면 해당 문서의 갱신을 건너뛰고 달력은 계속 발행합니다. 첫 마감 전에는 같은 맥 초안을 다시 넘겨 누락된 항목을 채울 수 있습니다. 마감 이후에는 누락된 항목을 해당 주의 집계에서 재구축해야 합니다.

앱의 마이페이지 달력과 집계 범위 기반 재검사를 확인하려면 `NEXT_PUBLIC_ENABLE_READING_STATS_ROLLUP_READS=1`을 적용한 빌드를 사용합니다. 달력 조회는 발행 포인터와 10주 요약을 읽습니다. 새 발행 포인터에는 마지막 10주 묶음 뒤의 주별 날짜 합계도 담아, 달력에서 개별 상세 문서를 열지 않고 날짜 합계를 표시할 수 있습니다. 인증된 계정의 주 상세는 날짜를 선택할 때 요청합니다. 맥은 첫 발행 주가 시계 보정 오차를 감안해도 모든 초기 기록을 덮을 때만 시작 범위를 인증합니다. 정기 마감에서 그보다 이른 원본이 발견되면 인증을 내립니다. 인증이 없는 이전 발행은 기존 원본 검사를 사용합니다. [달력·검사 계약](../SPEC/reading-statistics.md#저장동기화출력)

같은 플래그로 인증된 계정의 파일별 합계와 전체 통계의 도서별 합계를 조회합니다. 기간별 도서 통계는 최대 31일과 겹치는 주간 상세만 서버에서 읽어 도서별 합계를 반환합니다. 열린 기간의 원본 입력은 평가 증빙 서버에만 남깁니다. 발행 범위의 세션을 관리자가 수정하거나 업로드 시각 없이 복원하는 경우 집계 조회를 끈 빌드에서 원본을 검증한 뒤 발행 집계를 재구축합니다. 집계 조회는 기존 업로드 시각 이하에 생긴 관리자 변경을 자동으로 반영하지 않습니다.

## 유한 동기화와 영수증 정리

운영 Firestore Rules는 모든 계정의 진행률·책갈피·주석·팔레트 쓰기에 서버 발급 권한을 요구합니다. Vercel 운영 빌드는 기본으로 쓰기 권한을 사용합니다. `NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES=0`로 배포하면 이 경로의 새 쓰기가 거절됩니다. [계약](../SPEC/reader-and-progress.md#유한-동기화)과 [남은 수용 확인](../TODO.md#동기화-유효기간과-영수증-정리)을 먼저 확인합니다.

이미 쓰기 권한을 사용하는 운영에서 기간을 바꿀 때는 Firestore Rules와 Vercel 앱의 기간을 같은 릴리스에 맞춥니다. 기간 단축은 기존 권한에도 발급 시각 기준으로 적용되므로 최신 앱에서 만료 작업을 격리하고 서버 상태를 다시 받습니다.

정리 API `POST /api/sync/maintenance`는 활성화 시 폐기 여부를 확인한 Firebase Bearer 토큰의 UID만 사용하고 요청 본문의 UID는 받지 않습니다. UID별 하루 한 번, 최대 500건·부모 100개·40초까지 검사하며 50건 이하 단위의 트랜잭션과 재개 커서를 사용합니다. 누락된 부모 아래 receipt도 검사합니다. receipt 조회는 보존 기간을 넘긴 `createdAtServer` 범위에서 오래된 순이며 timestamp+문서 ID 커서로 같은 시각의 문서도 이어갑니다. 이전 ID 전용 커서는 안전하게 처음부터 재검사합니다. 읽기 집계는 빈 조회의 최소 비용을 포함한 추정치이며 실제 청구액은 아닙니다. 삭제마다 관리자 정책 문서와 실행 권한을 다시 확인하고, 정책이 변경되면 멈춥니다. 도메인의 직접 실행은 기본 dry run이며 API만 명시적으로 삭제 모드를 요청합니다.

전체 계정의 TTL 전환 시각 T는 운영 Rules가 네 경로의 구형 쓰기를 모두 거절하도록 배포한 시각에 전파 여유를 더해 기록합니다. 계정별 정리 API는 별도로 `artifacts/{APP_ID}/users/{uid}/libraries/local/syncPolicyV1/writeLease`의 관리자 정책(`schemaVersion: 1`, `requireLeases: true`, 검증된 `legacyBlockedAtServer`)을 사용하며 현재 꺼져 있습니다. 모든 receipt는 생성 후 120일과 해당 차단 시각 이후 120일을 모두 충족해야 삭제됩니다. 인덱스 제외는 receipt의 미사용 필드에만 적용하고 `createdAtServer` 감사 인덱스는 보존합니다.

운영 `web-novel-viewer/(default)`에 전체 구형 쓰기 차단 Rules `fc42c724-e63a-4375-9714-32974b13c8fd`를 배포했습니다. Firebase가 기록한 릴리스 시각은 `2026-11-19T10:02:48.004421Z`입니다. 최대 전파 시간 10분을 더하고 분 단위로 올려, 유예 시작은 **2026-11-19 19:13 KST**, 최초 TTL 활성화 가능 시각은 **2027-03-19 19:13 KST**로 기록했습니다. 배포 후 운영 소스 일치와 TTL 정책 부재를 확인했습니다. [Firestore Rules 전파 안내](https://firebase.google.com/docs/firestore/security/get-started#deploying_rules)

Firestore TTL은 컬렉션 그룹에서 지정한 필드의 절대 만료 시각을 사용합니다. `eventReceipts`에 적용하려면 `expireAt` 같은 타임스탬프 필드를 두고 생성 시각과 차단 시각 T 각각에서 120일이 지나는 조건을 충족해야 합니다. 기존 영수증에는 만료 시각 채우기 또는 안전하게 한도를 둔 별도 정리가 필요합니다. TTL 삭제에는 결제 활성화가 필요하고 무료 할당량이 적용되지 않습니다. 적용 전에 모든 경로의 구형 쓰기 차단, 권한 소급 연장 금지, 유예 완료와 기존 문서 정리 비용을 확인합니다. [Firestore TTL](https://firebase.google.com/docs/firestore/ttl) · [Firestore 요금](https://firebase.google.com/docs/firestore/pricing#free-quota)

정리 시작 후에는 구형 쓰기를 허용하는 Rules로 되돌리거나 쓰기 권한 기간을 소급 연장하지 않습니다. 정리 시작 전에 구형 쓰기를 다시 허용했다면 유예 시각 T는 다음 차단 시각부터 다시 계산합니다. UI를 되돌릴 때도 서버 만료 차단과 IndexedDB v16 outbox를 지원하는 버전을 사용합니다. 업데이트가 구버전 연결 때문에 대기 중이면 열린 앱과 탭을 닫고 최신 앱을 엽니다. DB 버전 오류가 발생하면 로컬 데이터와 대기열을 보존한 채 호환 버전으로 복구합니다. 정리를 중단하려면 서버 정리 플래그부터 끄고 payload·outbox·head·tombstone을 보존해 조사합니다.

## 반복 장애 조사

- 주석 삭제와 미발급 저장 보호가 들어간 버전으로 전환할 때는 같은 계정의 설치형 PWA와 열린 탭을 모두 업데이트합니다. 이전 버전이 열린 동안에는 도서 전체 삭제를 피합니다. 새 클라이언트의 세대 확인과 탭 잠금은 이전 클라이언트가 직접 보내는 쓰기에 적용되지 않습니다.

- 인증/Drive callback: 실제 접속 origin, OAuth redirect URI, 같은 origin Firebase helper와 SW 제외 여부, pending state 소비를 확인합니다. access token/비밀값을 로그에 남기지 않습니다.
- 첫 페이지로 잘못 열림: 기존 진행률을 보존하고 재발 직후 진단 JSON의 `readerResumeFailures`와 실제 도서/기기 조건을 확인합니다.
- 동기화 누락/충돌: UID/owner 수명, offline 여부, outbox·revision·receipt·permission 오류를 구분합니다. 데이터 초기화를 첫 해결책으로 사용하지 않습니다.
- 오래된 PWA: waiting worker/build ID와 로컬 저장 성공을 확인합니다. 설치된 앱의 확인을 배포 HTTP 상태로 대체하지 않습니다.
