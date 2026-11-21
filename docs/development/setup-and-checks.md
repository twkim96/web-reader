# 개발 환경과 검증

## 준비와 실행

저장소 루트에서 실행합니다. CI는 Node.js 22와 npm을 사용합니다. [package-lock.json](../../package-lock.json)을 기준으로 `npm ci`로 설치합니다. Python 3는 메타데이터 게시기 테스트에, Java 21은 Firestore emulator에 필요합니다. 브라우저 검증에는 Playwright의 Chromium/WebKit 설치가 필요합니다.

Next.js 코드를 작성하기 전에는 설치된 `node_modules/next/dist/docs/`의 관련 가이드를 읽습니다. 프로젝트의 [AGENTS.md](../../AGENTS.md)에 있는 Next.js 생성 블록을 보존합니다. 버전·스크립트·의존성은 [package.json](../../package.json)이 기준입니다.

`.env.local`에 Firebase Console의 웹 앱 설정과 Google Cloud의 웹 OAuth client ID를 넣습니다. 이 파일과 서비스 계정 파일은 커밋하지 않습니다.

```dotenv
NEXT_PUBLIC_FIREBASE_API_KEY=<firebase-web-api-key>
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=<authorized-app-host>
NEXT_PUBLIC_FIREBASE_PROJECT_ID=<firebase-project-id>
NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET=<firebase-storage-bucket>
NEXT_PUBLIC_FIREBASE_MESSAGING_SENDER_ID=<firebase-sender-id>
NEXT_PUBLIC_FIREBASE_APP_ID=<firebase-web-app-id>
NEXT_PUBLIC_GOOGLE_CLIENT_ID=<google-web-oauth-client-id>
```

`NEXT_PUBLIC_FIREBASE_APP_ID`는 Firebase 웹 앱 ID이며 동기화 경로의 내부 `APP_ID`와 다릅니다. OAuth origin/redirect URI와 프록시 조건은 [연동 가이드](../integrations/firebase-and-drive.md)에 있습니다. 실제 운영 로그인 확인과 더미 CI 설정을 이용한 자동검증을 구분합니다. CI용 더미 공개 설정은 [.github/workflows/ci.yml](../../.github/workflows/ci.yml)을 재사용합니다.

```sh
npm ci
npm run dev
```

개발은 기본 `http://localhost:3000`에서 실행합니다. production 모드는 `npm run build` 후 `npm run start`입니다. 개발 Firestore SDK는 메모리 캐시, production은 여러 탭용 persistent cache를 사용하므로 테스트 환경을 기록합니다.

Tailscale Serve로 루프백 개발 서버를 HTTPS 프록시할 때는 `.env.development.local`에 `WEB_READER_TAILSCALE_DEV_HOST=<기기>.<tailnet>.ts.net`을 설정한 뒤 개발 서버를 다시 실행합니다. 호스트 이름만 입력합니다. Next.js 개발 자산은 지정된 주소에서 불러올 수 있으며 브라우저 저장소는 해당 HTTPS 주소에 속합니다.

일반 `next dev`에서는 PWA Service Worker를 등록하지 않습니다. 개발 중 같은 URL의 Next chunk가 바뀌어 이전 오프라인 shell과 섞이는 것을 피하며, 이전 `/sw.js` 등록이 있으면 해제하고 해당 worker가 현재 탭을 제어할 때 한 번 새로고침합니다. IndexedDB·도서·진행률·설정은 지우지 않습니다. 이미 오래된 shell로 초기 실행이 실패했다면 강력 새로고침 후 재확인합니다. 개발 서버에서 PWA 자체를 검증할 때만 `NEXT_PUBLIC_ENABLE_DEV_SERVICE_WORKER=1`로 명시적으로 켭니다. Playwright 기본 설정은 이 옵션을 사용하며 production PWA 등록·업데이트 정책은 유지합니다.

소스 변경과 다른 오래된 CSS가 개발 빌드에 남으면 `.next/dev/static/chunks/`의 실제 CSS부터 대조합니다. 2026-11-16에는 별도 production build 이후 `next dev`가 이전 CSS를 재사용했고, 개발 서버 종료 후 생성물 `.next/dev`만 지우고 다시 실행해 새 CSS 적용을 확인했습니다. 브라우저의 IndexedDB·도서·진행률을 초기화할 필요는 없습니다.

서버 API에는 Firebase Admin의 `FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON` 또는 Application Default Credentials가 필요합니다. 로컬 ADC 파일 경로는 `GOOGLE_APPLICATION_CREDENTIALS`로 지정할 수 있습니다. 선택적 NovelPia 인증은 `NOVELPIA_EMAIL`과 `NOVELPIA_PASSWORD`를 서버에만 설정합니다. Admin/플랫폼 비밀값에 `NEXT_PUBLIC_` 접두사를 붙이지 않습니다.

유한 동기화의 로컬 실험은 `NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES=1`, 정리 API는 별도로 `ENABLE_FINITE_SYNC_CLEANUP=1`입니다. 로컬과 Vercel Preview에서는 쓰기 권한을 기본으로 꺼두고, Vercel Production에서는 기본으로 켭니다. `NEXT_PUBLIC_ENABLE_FINITE_SYNC_LEASES=0`을 명시하면 다음 빌드에서 끌 수 있습니다. 정리 API는 별도 활성화가 필요합니다. 로컬 실험은 demo 프로젝트 자격으로 진행합니다. 격리된 emulator에서 [전환·복구 조건](../operations/deployment-and-recovery.md#유한-동기화와-영수증-정리)을 검증합니다. `tests/writeLeaseTransport.test.mjs`는 권한 고정→outbox→worker ACK 및 만료→격리→최신 수신을 연결해 검사합니다. 서버 발급·Rules·Admin pagination은 `test:rules`가 담당합니다.

리뷰용으로 동결한 소스·수신 검사 코드가 로컬 `.superloopy/`에 있으면 lint 대상에서 해당 증거 디렉터리만 제외합니다: `npm run lint -- --ignore-pattern '.superloopy/**'`. 보관된 과거 소스를 현재 제품 코드로 고치거나 증거를 삭제하지 않습니다.

## 검증 선택

| 명령 | 포함 범위·준비 |
| --- | --- |
| `npm run lint`, `npm run typecheck` | ESLint, TypeScript |
| `npm run test:node` / `npm run test:all` | 포맷·Drive·압축·저장/동기화·책장/UI·Python 게시기·SW·버전 검사. 브라우저/Rules는 포함하지 않음 |
| `npm run check` | lint → typecheck → test:node → production build |
| `npm run test:rules` | Java 21, demo 프로젝트 `demo-web-reader`, Firestore emulator `127.0.0.1:8089`; Rules와 metadata store 검사 |
| `npm run test:e2e` | Playwright Chromium/WebKit. 자체 Next dev 서버 `127.0.0.1:3107` |
| `npm run test:epub-sandbox` | EPUB sandbox·위치 이동/복원 집중 Playwright 검사 |
| `npm run test:browser:ci` | **build 선행**. 자체 production 서버 `127.0.0.1:3000`, headless Chromium CDP `127.0.0.1:9223`; 전체 UI/리더 회귀 |
| `npm run check:full` | check → Rules → E2E → production browser regression |

Playwright 준비는 `npx playwright install chromium webkit`을 사용합니다. Linux 시스템 라이브러리는 CI처럼 `--with-deps` 옵션을 사용합니다. `test:e2e`는 기존 서버를 재사용하지 않습니다. `test:browser:ci`와 개발 서버가 3000을 동시에 소유하지 않도록 합니다.

기존 브라우저 연결용 `npm run test:browser`는 `APP_URL`, `CHROME_DEBUG_URL`을 읽고 기본값은 위 3000/9223 주소입니다. 자동 실행에는 기존 Playwright 기반 CI 실행기를 우선 사용하고 매 시도마다 새 브라우저/디버그 포트를 만들지 않습니다.

관련 파일의 작은 검사부터 선택하고, 계획한 aggregate에 이미 들어 있는 검사는 중복 실행하지 않습니다. 실패 후에는 원인을 확인하고 해당 파일/사례부터 재검증합니다. fixture·환경 오류 때문에 무관한 제품 코드를 바꾸거나 assertion을 약화하지 않습니다. 순수 문서 이동에는 제품 전체 테스트 대신 diff·링크·경로·비공개 경계 검사를 사용합니다.

Playwright WebKit의 기본 임시 프로필은 IndexedDB에 Blob과 File을 저장할 때 `UnknownError: Error preparing Blob/File data to be stored in object store`를 반환할 수 있습니다. 압축 도서·도서 정보 이미지·샘플 도서 기반 설정 및 배경 검사는 `persistentBookFixtures.ts`의 테스트별 일회용 영속 프로필을 사용합니다. PDF·CBZ 서재 표지 캐시에는 WebKit 제외 두 건이 남아 있습니다. 자동 브라우저 검사와 실제 Safari/PWA 확인은 별도로 기록합니다.

## 완료 증거

마이페이지 도서목록의 첫 표시를 비교할 때 주소의 검색 매개변수에 `?mypagePerf=1`을 넣습니다. 브라우저 Performance 패널의 `mypage:catalog:` 측정에서 응답 본문 처리, 인덱스 검증, 작품 묶기, 검색 준비, 정렬, 필터, 목록 첫 행 커밋을 확인할 수 있습니다. 전송 시각과 크기는 같은 실행의 Resource Timing에서 확인합니다. 계정·검색어·작품명은 측정에 남기지 않습니다.

서버에 `MY_PAGE_PERF_LOG=1`을 설정한 환경에서는 공개 프로필 요청과 공개 작품 평가 집계에 대해 후보·반환·작성자 조회 수와 처리시간을 기록합니다. 이 수치는 논리적 조회 카운터로 사용하며 Firestore 청구 읽기 수는 Query Explain과 운영 지표로 확인합니다.

자동검증, CI, 배포 상태, 실기기/실제 Firebase 확인은 각각 기록합니다. 빌드 통과나 Playwright WebKit 통과를 iPad/PWA 확인으로 대체하지 않습니다. 실패·생략·권한/환경 차이는 원인과 남은 다음 행동을 명시합니다.

현재 확인이 남은 항목과 재현 조건은 [TODO](../TODO.md)에서 관리하고, 버전별 당시 증거는 [updates](../updates/README.md)에 보존합니다. 특정 버전의 테스트 개수나 과거 통과 상태를 현재 개발 환경의 기본 보증으로 사용하지 않습니다.
