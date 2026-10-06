# 배포·업데이트·복구

## 실행과 배포

저장소의 릴리스 기록은 Vercel 배포를 사용합니다. 현재 배포 성공은 대상 커밋/빌드의 배포 상태를 따로 확인해야 하며 Git push나 로컬 build 성공만으로 판정하지 않습니다. runtime은 `npm run build` → `npm run start`로 확인할 수 있습니다. 클라이언트 공개 변수는 빌드에 반영하고 서버 비밀 설정은 [개발 가이드](../development/setup-and-checks.md)에 따라 배포 환경에 설정합니다.

버전은 [package.json](../../package.json), [package-lock.json](../../package-lock.json), [public/sw.js](../../public/sw.js)와 [releaseVersion.test.mjs](../../tests/releaseVersion.test.mjs)의 일관성을 유지합니다. 같은 버전의 코드 변경도 [app-build-id.mjs](../../scripts/app-build-id.mjs)가 `src/`, `public/`, 패키지·Next config·공개 환경변수로 build ID를 계산합니다. 문서 파일만 바꾼 경우 이 입력은 바뀌지 않습니다.

배포 전 작업 범위에 필요한 [검증](../development/setup-and-checks.md#검증-선택)을 끝내고 버전별 증거는 [updates](../updates/README.md)에 보관합니다. 사용자가 위임하지 않은 실제 게시·Rules 배포·서비스 조작을 문서 정리의 일부로 실행하지 않습니다.

## PWA 설치와 업데이트

Service Worker는 manifest/정적 자원과 일관된 오프라인 HTML shell을 준비합니다. `pc-reader-` + 버전 + build ID로 shell/runtime cache를 구분하고 새 worker가 활성화되면 같은 앱 prefix의 이전 cache를 정리합니다. IndexedDB 도서와 이 Cache Storage는 별도 저장소입니다.

worker가 대기하면 사용자 적용 동작 전에 현재 진행률 flush와 로컬 commit drain이 성공해야 합니다. 실패하면 업데이트를 멈추고 오류를 알립니다. 성공 후 `SKIP_WAITING`과 controller 교체로 새로고침합니다. 임시 슬라이더 이동 중에는 [리더 저장 계약](../SPEC/reader-and-progress.md)에 따라 업데이트 flush도 성공 처리하지 않습니다.

인증/Firebase helper·`/api/`·외부 origin·Authorization·Range·GET 이외 요청은 SW cache 경로에서 제외합니다. 응답 `private`/`no-store`도 저장하지 않습니다. [sw-policy.js](../../public/sw-policy.js), [sw.js](../../public/sw.js), `useServiceWorkerUpdate`, `serviceWorkerUpdatePolicy`가 기준입니다.

PWA 최초 설치, 대기 worker 적용, 오프라인 재진입은 실제 브라우저에서 따로 확인합니다. Android/iPad/PWA 확인 중 남은 것은 [TODO](../TODO.md)에 있습니다.

## 저장과 복구

IndexedDB 이름·버전·store/index의 기준은 [localDBSchema.ts](../../src/lib/localDBSchema.ts)입니다. 현재 `web-reader-db`에서 store 이름의 v5/v8/v11 등은 기능 도입 시점이며 DB 현재 버전과 같다는 뜻이 아닙니다. 구조 변경은 active user data를 보존해야 합니다. v6 이전 콘텐츠 구조의 의도된 초기화와 v6 이후 index 추가 업그레이드를 구분합니다.

기기 콘텐츠 namespace와 Firebase/guest 상태 namespace는 [계정 경계](../integrations/firebase-and-drive.md#계정과-데이터-경계)를 따릅니다. 업그레이드 `blocking`에서 오래된 connection을 닫고 다시 열 수 있어야 하며 실패를 DB 전체 삭제로 복구하지 않습니다. 용량 부족에는 오류를 표시하고 검증된 기존 파일·진행 상태를 보존합니다.

Drive 원본은 재다운로드용입니다. 로컬로만 넣은 원본은 사용자가 별도 보관해야 합니다. 주석·통계 export와 진단 JSON은 전체 브라우저 데이터 백업/복원 수단이 아닙니다. 게스트 기록과 아직 전송하지 않은 outbox는 다른 기기의 Firestore 기록만으로 복구할 수 있다고 가정하지 않습니다.

저장소 진단은 [통계 화면](../SPEC/reading-statistics.md#진단)에서 export합니다. 미전송 outbox, event receipt, 삭제 tombstone/marker, revision head, 이전 library namespace의 역할을 확인한 뒤 정리 여부를 결정합니다. 진단의 보존 기간이나 정리 계획 함수는 자동 삭제 허가가 아닙니다. 실제 기기 migration/rollback·pending/conflict 0건·구 namespace 조사 등 기존 완료 조건은 [TODO](../TODO.md)에 보존합니다.

## Firestore Rules와 롤백

[firebase.json](../../firebase.json)의 `firestore.rules`·`firestore.indexes.json`을 기준으로 demo emulator 검사(`npm run test:rules`)를 먼저 수행합니다. production 배포 전 대상 프로젝트/DB와 배포된 Rules/index를 확인하고 원문을 보존합니다. Rules에는 클라이언트 owner 접근과 공개 metadata read, 서버 전용 쓰기 경계가 함께 있으므로 과거 v2 후보만 현재 전체 Rules로 취급하지 않습니다.

[2026-07-13 production 기준선](../updates/firestore-rules-production-baseline-2026-07-13.md)과 [원문 백업](../backups/firestore.rules.production-2026-07-13.rules)은 당시 v1→v2 배포의 역사적 자료입니다. 배포 설정과 Rules 테스트는 루트의 `firestore.rules`를 읽으며 이 이력 Markdown을 입력으로 사용하지 않습니다. 현재 production Rules는 문서 정리에서 새로 확인하지 않았습니다. 롤백 시 **해당 배포 전에 확인한** 백업을 복원하고, Firestore/IndexedDB 데이터를 삭제하지 않습니다. 오래된 백업은 후속 주석·통계·메타데이터 schema와 맞지 않을 수 있으므로 현재 client와의 호환성을 먼저 확인합니다.

## 반복 장애 조사

- 인증/Drive callback: 실제 접속 origin, OAuth redirect URI, 같은 origin Firebase helper와 SW 제외 여부, pending state 소비를 확인합니다. access token/비밀값을 로그에 남기지 않습니다.
- 첫 페이지로 잘못 열림: 기존 진행률을 보존하고 재발 직후 진단 JSON의 `readerResumeFailures`와 실제 도서/기기 조건을 확인합니다.
- 동기화 누락/충돌: UID/owner 수명, offline 여부, outbox·revision·receipt·permission 오류를 구분합니다. 데이터 초기화를 첫 해결책으로 사용하지 않습니다.
- 오래된 PWA: waiting worker/build ID와 로컬 저장 성공을 확인합니다. 설치된 앱의 확인을 배포 HTTP 상태로 대체하지 않습니다.
