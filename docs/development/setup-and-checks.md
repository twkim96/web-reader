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

서버 API에는 Firebase Admin의 `FIREBASE_ADMIN_SERVICE_ACCOUNT_JSON` 또는 Application Default Credentials가 필요합니다. 로컬 ADC 파일 경로는 `GOOGLE_APPLICATION_CREDENTIALS`로 지정할 수 있습니다. 선택적 NovelPia 인증은 `NOVELPIA_EMAIL`과 `NOVELPIA_PASSWORD`를 서버에만 설정합니다. Admin/플랫폼 비밀값에 `NEXT_PUBLIC_` 접두사를 붙이지 않습니다.

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

## 완료 증거

자동검증, CI, 배포 상태, 실기기/실제 Firebase 확인은 각각 기록합니다. 빌드 통과나 Playwright WebKit 통과를 iPad/PWA 확인으로 대체하지 않습니다. 실패·생략·권한/환경 차이는 원인과 남은 다음 행동을 명시합니다.

현재 확인이 남은 항목과 재현 조건은 [TODO](../TODO.md)에서 관리하고, 버전별 당시 증거는 [updates](../updates/README.md)에 보존합니다. 특정 버전의 테스트 개수나 과거 통과 상태를 현재 개발 환경의 기본 보증으로 사용하지 않습니다.
