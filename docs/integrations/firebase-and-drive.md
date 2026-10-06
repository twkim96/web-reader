# Firebase·Google Drive 연동

## 계정과 데이터 경계

Firebase Google 로그인은 앱의 사용자 UID를 정합니다. 진행률·수동 책갈피·주석·팔레트·독서 통계는 이 UID로 동기화합니다. Drive OAuth는 서재 파일 접근용 별도 연결이며 Firebase 계정과 같을 필요가 없습니다. Drive 연결 수명이 바뀌어도 Firebase 동기화의 listener/outbox/conflict를 초기화하지 않습니다.

본문·표지·압축 검사 캐시는 계정과 무관한 브라우저 프로필 공용입니다. 게스트 읽기는 guest owner를 사용하며 다른 계정의 대기 이벤트를 새 UID로 보내지 않습니다. owner 경계의 기준은 [ownerIdentity.ts](../../src/lib/ownerIdentity.ts), `ownerRuntime`, [contentNamespace.test.mjs](../../tests/contentNamespace.test.mjs)입니다. 저장소 보존과 복구는 [운영 가이드](../operations/deployment-and-recovery.md)에 있습니다.

## Firebase 로그인 설정

클라이언트는 `signInWithRedirect`와 `useAuthBootstrap`을 사용합니다. 공개 설정 변수는 [개발 가이드](../development/setup-and-checks.md)에 있습니다.

- `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`에 실제 앱 접속 host를 사용합니다. Firebase Console의 Authorized domains에 그 host를 등록합니다.
- Google Cloud 웹 OAuth 클라이언트에 `https://<앱-host>/__/auth/handler`를 redirect URI로 등록합니다.
- [next.config.ts](../../next.config.ts)는 `/__/auth/*`, `/__/firebase/*`를 `${NEXT_PUBLIC_FIREBASE_PROJECT_ID}.firebaseapp.com`으로 프록시합니다. 같은 origin의 Firebase helper를 사용하는 조건이며 단순 302 대체로 처리하지 않습니다.
- 배포/PWA에서 helper 응답·쿠키·redirect 복귀를 확인합니다. Service Worker가 인증 경로를 캐싱하지 않아야 합니다.

로그아웃은 UI 준비 → Firebase `signOut` 성공 → 로컬 연결 상태 정리 순서입니다. 실패하면 owner/UI를 복구하고 성공한 것으로 취급하지 않습니다. 계정 전환이 저장된 기기 도서를 지우는 작업을 뜻하지 않습니다. 실제 PWA/WebView sign-out/sign-in 수용 확인은 [TODO](../TODO.md)에 있습니다.

## Drive OAuth와 수명

OAuth 동의 화면에 `drive.file`, `drive.readonly`, `drive.appdata`를 등록하고 Drive API를 활성화합니다. Google Cloud 클라이언트의 redirect URI에는 앱의 origin+pathname(루트 배포 예: `https://<앱-host>/`)을 등록합니다. `drive.readonly`의 제한된 범위와 공개 서비스의 Google 검증 조건도 확인합니다.

`useDriveOAuthRedirect`는 같은 창에서 Google 계정 선택 페이지로 이동해 access token을 요청합니다. 최초 연결·만료/401 뒤 재연결 모두 이 redirect 경로를 사용합니다. callback의 state를 검증한 뒤 hash를 history에서 제거합니다.

access token·만료 시각·session ID는 메모리와 현재 탭의 `sessionStorage`(`google_drive_session_v2`)에만 저장합니다. 같은 탭 새로고침에서는 유효한 token을 복원하지만 탭 종료·만료 후에는 다시 연결해야 합니다. token을 localStorage/IndexedDB에 저장하지 않습니다.

OAuth **state**는 token과 다릅니다. `google_drive_oauth_state_v2`의 session 값과, PWA 재진입을 위한 localStorage의 `google_drive_oauth_pending_states_v1`을 사용합니다. 공유 pending state는 10분 유효·최대 4건이며 callback에서 소비합니다. 연결 해제·로그아웃은 pending state도 정리합니다. 이 fallback의 구현을 실제 Android/iPad 첫 callback 수용 완료로 간주하지 않습니다.

해제 시 원격 token revoke를 제한된 시간 동안 시도하고 실패해도 로컬 해제를 끝냅니다. token 교체·만료·401은 세션별 Drive 요청/cache를 무효화합니다. 확인된 로컬 파일과 Firebase 상태는 계속 사용할 수 있습니다.

## 폴더·파일 API

Drive v3의 `files`, `about`과 resumable upload를 사용합니다. 앱은 확정된 `web viewer` 폴더의 직접 자식만 목록에 표시합니다. 계정별 폴더 ID는 숨겨진 appData의 `twreader-library.json` registry로 재사용합니다. registry가 없는 계정에 같은 이름의 폴더가 여러 개 있으면 임의 선택하지 않고 충돌 오류를 반환합니다.

Drive 웹에서 직접 추가한 지원 파일도 읽기 목록에 나타날 수 있습니다. 앱이 만든 파일이 아니면 `drive.file` 삭제 권한이 부족할 수 있으므로 403을 로그인 만료로 바꾸지 않습니다. 삭제의 로컬 보존 순서는 [서재 사양](../SPEC/library-and-files.md#캐시삭제-계약)에 있습니다.

네트워크/본문 소비 timeout, 취소, pagination과 upload retry는 [googleDrive.ts](../../src/lib/googleDrive.ts), [driveUpload.ts](../../src/lib/driveUpload.ts)를 기준으로 합니다. 취소된 요청 결과가 새 Drive session을 덮지 않아야 합니다.

## Firestore 경로와 Rules

내부 앱 ID는 [appIdentity.ts](../../src/lib/appIdentity.ts)의 `APP_ID`입니다. Firebase 웹 앱 ID 설정과 혼동하지 않습니다. 현재 계정 경로는 `artifacts/{APP_ID}/users/{uid}/libraries/local/` 아래입니다.

| 데이터 | 경로·계약의 코드 기준 |
| --- | --- |
| 진행률·수동 책갈피·receipt | [progressV2Schema.ts](../../src/lib/progressV2Schema.ts)의 `getFirebaseSyncHistoryPath`, `readingHistoryV2`와 하위 컬렉션 |
| 주석·aggregate·삭제 marker | [annotationSyncSchema.ts](../../src/lib/annotationSyncSchema.ts)의 `getFirebaseAnnotationSyncPath`, `annotationSyncV1` |
| 팔레트 | 같은 schema의 `getFirebaseAnnotationPalettePath`, `annotationSettingsV1/palette` |
| 통계 세션 | [readingStatisticsSync.ts](../../src/lib/readingStatisticsSync.ts)의 `getFirebaseReadingStatisticsPath`, `readingStatsV1` |

[firestore.rules](../../firestore.rules), [firestore.indexes.json](../../firestore.indexes.json), [firebase.json](../../firebase.json)이 소유권·schema·index·배포 대상의 기준입니다. 과거 v1/이전 library 경로의 정리 여부는 별도 운영 확인이 필요합니다. 실패는 retry 가능한 전송, schema/권한 실패, revision 충돌을 구분하며 receipt/tombstone 보존 계약을 유지합니다.

주요 검증은 `test:drive`, `test:storage`, `test:rules`입니다. emulator 통과와 실제 production Rules/동기화 확인은 [개발 가이드](../development/setup-and-checks.md#완료-증거)처럼 구분합니다.
