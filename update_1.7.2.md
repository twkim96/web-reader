# Web Reader 1.7.2 개발·검증 계획

> 2026-07-13: 실기기에서 확인된 shelf remote 표시와 Drive popup 회귀는 [update_1.7.3.md](./update_1.7.3.md)에서 수정했다.

작성일: 2026-07-13
목표: 마이그레이션을 종료하고 Google Drive 도서 저장소와 Firebase 읽기 상태 동기화를 완전히 분리한다.

## 확정 원칙

1. Google Drive는 도서 원본, 도서 목록, 업로드·다운로드만 담당한다.
2. IndexedDB 도서 파일과 메타데이터는 현재 Firebase·Drive 계정과 무관한 기기 공용 도서 공간에 둔다.
3. Firebase는 Firebase UID별 진행률과 수동 북마크만 담당한다.
4. Firebase 로그인만 되어 있고 같은 `bookId`의 도서가 기기에 있으면 Drive 연결 없이 진행 상태를 동기화한다.
5. Drive 계정 연결·해제·교체는 진행률 listener, outbox, conflict, Firestore 경로를 바꾸지 않는다.
6. Firebase 계정을 바꾸면 해당 Firebase UID의 진행 상태로 전환한다.
7. 과거 v4 데이터와 Drive 범위 진행 상태는 가져오지 않는다. 전환 선택 UI, v1 Firestore bridge, migration marker와 owner binding을 제거한다.

## 리뷰 판정과 범위

| 항목 | 판정 | 반영 |
|---|---|---|
| Drive와 Firebase 진행 상태 결합 | 수용 | owner 타입에서 Drive scope를 제거하고 Firebase canonical `library:local`만 허용 |
| 도서 캐시의 계정 종속 | 수용 | `DEVICE_CONTENT_OWNER_KEY` 단일 namespace로 통합 |
| 1.7.0 한정 migration 유지 | 폐기 | migration UI·runtime·marker·v1 bridge 삭제 |
| Drive 인증을 Firebase처럼 redirect로 통일 | 미수용 | GIS token client는 백엔드 없는 팝업 방식이므로 유지 |
| macOS·Android 팝업 실패 | 수용 | 클릭 스택에서 `requestAccessToken()`을 동기 호출하고 COOP를 `same-origin-allow-popups`로 설정 |

## Phase

### Phase 1. 소유권 모델 고정

- [x] `OwnerKey`를 Firebase/guest + `library:local`로 제한한다.
- [x] Firebase canonical history 경로를 `libraries/local/readingHistoryV2`로 고정한다.
- [x] Drive 연결 코드가 `ownerRuntime.activate()`를 호출하지 않게 한다.

### Phase 2. 마이그레이션 종료

- [x] v4 migration 구현과 선택 dialog를 삭제한다.
- [x] 1.7.0 Drive-scope → Firebase-scope 전환 코드를 삭제한다.
- [x] 구형 Firestore `readingHistory` listener와 쓰기 허용 Rules를 제거한다.
- [x] IndexedDB schema 6에서 더 이상 쓰지 않는 v4·binding·session·migration store를 삭제한다.
- [x] 1.7.1의 계정별 도서 캐시는 복사하지 않고 한 번 초기화하며 canonical Firebase 진행률 store는 보존한다.

### Phase 3. 기기 공용 도서 공간

- [x] 업로드, 다운로드 캐시, 도서 열기, 오프라인 목록, 삭제, archive inspection을 단일 device namespace로 전환한다.
- [x] Firebase 계정 데이터 삭제가 기기 도서 파일을 삭제하지 않는 회귀 테스트를 추가한다.
- [x] Drive 도서 목록은 device namespace의 로컬 도서와 ID 기준으로만 합친다.

### Phase 4. Drive 인증 복구

- [x] GIS token 요청을 사용자 클릭 호출 스택에서 시작한다.
- [x] 전체 페이지 응답에 `Cross-Origin-Opener-Policy: same-origin-allow-popups`를 추가한다.
- [x] 팝업 single-flight와 COOP 선언 회귀 테스트를 추가한다.

### Phase 5. 릴리스 검증

- [x] TypeScript typecheck
- [x] storage/Firebase 경계 테스트
- [x] Drive/GIS 단위 테스트
- [x] lint, 전체 node 테스트, production build
- [x] Firestore Rules emulator
- [x] Playwright와 production browser regression

## 실기기 확인 항목

자동검증과 배포 후 사용자가 확인한다.

- macOS Safari/Chrome에서 Drive 계정 선택 후 도서 목록이 응답한다.
- Android Chrome/PWA에서 계정 선택 후 목록 로딩이 완료된다.
- Windows DevTools에서 COOP 때문에 GIS popup 완료가 중단되지 않는다. `window.closed` 관련 진단 로그가 보이더라도 실제 callback 성공 여부로 판정한다.
- Drive 미연결 상태에서 Firebase 로그인만 바꿔 같은 로컬 도서의 진행률이 계정별로 바뀐다.
- 동일 Firebase 계정에서 Drive A → 연결 해제 → Drive B 순서로 바꿔도 진행률이 유지된다.

## 완료 기준

- 화면과 runtime에 migration 선택·실행 경로가 없다.
- Drive permission ID와 session ID는 Drive cache 안에서만 사용한다.
- 도서 저장 API는 device namespace만, 진행 상태 API는 Firebase/guest canonical owner만 사용한다.
- 1.7.2 첫 실행에서는 과거 계정별 로컬 도서 캐시가 초기화되므로 Drive 원본을 다시 열어 공용 캐시를 만든다.
- 자동검증을 통과한 커밋을 배포한 뒤 위 실기기 항목을 확인한다.

## 자동검증 결과

- ESLint 통과(기존 Foliate vendor 경고 2건, 오류 0건), TypeScript typecheck 통과
- Node 단위·저장소·Drive·archive·shelf·service worker·release 테스트 통과
- Next.js 1.7.2 production build 통과
- Firestore emulator Rules 9개 통과: retired v1 쓰기와 Drive-scoped 경로 거부 포함
- Playwright Chromium/WebKit 10개 통과
- production Chrome browser regression 통과: schema 6 공용 도서함, 압축/PDF/EPUB, service worker `pc-reader-v1.7.2` 확인
