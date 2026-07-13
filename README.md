# Private Cloud Reader

**Private Cloud Reader**는 Google Drive를 개인 서재로 쓰고, 브라우저 IndexedDB에 읽기용 EPUB 캐시를 유지하는 **Offline-First PWA 리더**입니다.

Drive에는 원본 `.txt`/`.epub` 파일을 보관하고, 실제 리더와 로컬 책장은 EPUB 기반으로 동작합니다.

---

## Core Technologies

### 1. EPUB Reader Engine
*   **Foliate 기반 렌더링**: EPUB 파일을 `<foliate-view>` 기반으로 열고, CFI 위치/진행률/목차/검색을 EPUB 표준 흐름에 맞춰 처리합니다.
*   **TXT → EPUB 정규화**: Drive 또는 로컬에서 들어온 TXT는 최초 읽기/저장 시 EPUB으로 변환되어 로컬 책장에는 EPUB만 남습니다.
*   **Reader Adapter 구조**: Foliate 엔진 로딩/이동/검색/레이아웃은 `src/hooks/foliate`에서 감싸고, Reader 화면 상태는 `src/hooks/reader`에서 관리합니다.

### 2. Hybrid Data Architecture
*   **Cloud Source Storage**: Google Drive의 `web viewer` 폴더는 도서 원본과 도서 목록만 담당합니다. Drive 계정은 진행률 소유권에 관여하지 않습니다.
*   **Original File Upload**: Drive에는 변환본이 아니라 사용자가 올린 원본 `.txt`/`.epub` 파일을 그대로 저장합니다.
*   **Firestore Progress Sync**: 진행률과 수동 북마크는 Firebase UID 하나만 기준으로 Firestore에 동기화합니다. Drive 연결 여부나 Drive 계정 변경은 동기화 경로를 바꾸지 않으며, Firebase 계정을 바꾸면 해당 계정의 진행 상태로 전환됩니다. 자동 북마크는 기기별 로컬 기록으로만 유지합니다.
*   **IndexedDB EPUB Cache**: 한 번 연 도서는 Firebase·Drive 계정과 무관한 기기 공용 IndexedDB 공간에 EPUB으로 캐싱되어 오프라인에서도 읽을 수 있습니다.

### 3. Reading UX
*   **Auto-Encoding TXT Import**: TXT 변환 시 UTF-8, EUC-KR, UTF-16 계열 인코딩을 처리합니다.
*   **Reader Settings**: 스크롤/페이지 이동, 폰트, 줄간격, 테마, 액센트 컬러를 지원합니다.
*   **Cross-Device Resume**: 다른 기기의 최신 진행률을 감지하면 이동 확인 창을 표시하고, 수락 시 현재 기기가 새 읽기 위치를 이어받습니다.
*   **Post-Move Save Policy**: 점프/검색/목차/북마크/% 이동은 이동 후 위치를 최신 진행률로 저장하고, 이동 전 위치는 자동 북마크로만 남깁니다.

### 4. PWA Experience
*   **Cloud/Local Shelf**: 클라우드 책장과 로컬 캐시 책장을 오가며 사용할 수 있습니다.
*   **Installed App Experience**: Service Worker와 manifest 기반으로 설치형 웹앱처럼 사용할 수 있습니다.

---

## 🛠 Tech Stack

*   **Framework**: Next.js 16 (App Router), React 19
*   **Language**: TypeScript
*   **Database**: Firebase Firestore, IndexedDB (`idb`)
*   **Storage**: Google Drive API (`drive.file` + `drive.readonly` + `drive.appdata`)
*   **Styling**: Tailwind CSS v4, Lucide React

---

## Project Structure

```text
src/app/page.tsx              # App shell, auth/mode/library composition
src/components/shelf/         # Shelf UI, filtering, sorting, local/cloud controls
src/components/reader/        # Reader toolbar and dialogs
src/components/EpubReader.tsx # Reader composition layer
src/hooks/foliate/            # Foliate custom element adapter
src/hooks/reader/             # Reader source/bookmark/progress/chrome hooks
src/hooks/progressPolicy.ts   # Shared sync/bookmark persistence policy
src/lib/                      # Google Drive, Firebase, IndexedDB, TXT->EPUB helpers
```

---

## 🚀 Getting Started

### Environment Variables
`.env.local` 파일을 생성하고 아래 정보를 입력해야 합니다.
```bash
NEXT_PUBLIC_FIREBASE_API_KEY=...
NEXT_PUBLIC_GOOGLE_CLIENT_ID=...
NEXT_PUBLIC_FIREBASE_PROJECT_ID=...
NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN=...
# 기타 Firebase 및 Google Cloud 설정값
```

### Firebase Redirect Auth
Google 로그인은 `signInWithRedirect`를 사용합니다. 배포 도메인에서 안정적으로 동작하려면 다음 설정이 필요합니다.

* `NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN`은 실제 접속 도메인으로 설정합니다. 예: `twreader.vercel.app`
* `next.config.ts`는 `/__/auth/*`, `/__/firebase/*` 요청을 Firebase 기본 도메인인 `${NEXT_PUBLIC_FIREBASE_PROJECT_ID}.firebaseapp.com`으로 프록시합니다.
* Firebase Console의 Authorized domains와 Google Cloud Console OAuth redirect URI에 배포 도메인을 등록해야 합니다.
* Google Cloud OAuth redirect URI 형식: `https://<배포도메인>/__/auth/handler`

### Google Drive OAuth
Cloud Library 연결은 Google Identity Services token client의 계정 선택 팝업으로 access token을 요청합니다. Drive 연결에는 OAuth redirect URI보다 배포 도메인을 Google Cloud OAuth 클라이언트의 **승인된 JavaScript 원본**에 등록하는 것이 핵심입니다.

* Drive token client는 백엔드 token 교환 없이 access token을 받는 팝업 방식입니다. Firebase의 페이지 redirect 로그인과는 서로 다른 인증 흐름입니다.
* `next.config.ts`는 팝업과 원래 창의 통신이 브라우저 COOP 정책에 차단되지 않도록 `Cross-Origin-Opener-Policy: same-origin-allow-popups`를 설정합니다.
* OAuth 동의 화면에 `drive.file`, `drive.readonly`, `drive.appdata` 범위를 등록합니다.
* `drive.readonly`는 제한된 범위이므로 공개 서비스는 Google OAuth 검증 요구사항을 확인해야 합니다.
* 각 Drive 계정의 확정된 `web viewer` 폴더 ID는 숨겨진 appData 설정에 저장되어 다른 기기에서도 재사용됩니다.
* Drive access token과 만료 시각은 메모리에만 유지하며 localStorage, sessionStorage와 IndexedDB에 저장하지 않습니다.
* 새로고침이나 token 만료·401 뒤에도 검증된 로컬 서재와 Firebase 진행률은 사용할 수 있지만, Drive 목록 갱신·다운로드·업로드에는 팝업 재연결이 필요할 수 있습니다.
* token이 바뀌거나 만료되면 Drive session cache를 폐기하며 계정 전환 시 폴더가 섞이지 않습니다.
* Drive 연결·해제·계정 교체는 도서 목록과 Drive 요청에만 영향을 주며 Firebase 진행률 listener, outbox, conflict 상태는 유지됩니다.
* 앱은 Drive 전체를 목록에 표시하지 않고 확정된 폴더의 직접 자식만 조회합니다.
* appData 설정이 없는 첫 연결에서 이름이 같은 폴더가 여러 개면 임의 선택하지 않고 충돌 오류를 표시합니다.
* Drive 웹에서 직접 넣은 파일은 자동으로 표시되지만, 앱에서 만든 파일이 아니면 앱 삭제 요청이 거부될 수 있습니다.

### Installation
```bash
npm install
npm run dev
```

---
