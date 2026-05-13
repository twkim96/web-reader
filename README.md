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
*   **Cloud Source Storage**: Google Drive의 `web viewer` 폴더를 원본 파일 저장소로 사용합니다.
*   **Original File Upload**: Drive에는 변환본이 아니라 사용자가 올린 원본 `.txt`/`.epub` 파일을 그대로 저장합니다.
*   **Firestore Progress Sync**: 진행률과 수동 북마크는 Firestore로 동기화합니다. 자동 북마크는 기기별 로컬 기록으로만 유지합니다.
*   **IndexedDB EPUB Cache**: 한 번 연 도서는 브라우저 IndexedDB에 EPUB으로 캐싱되어 오프라인에서도 읽을 수 있습니다.

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
*   **Storage**: Google Drive API (Drive.file Scope)
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
# 기타 Firebase 및 Google Cloud 설정값
```

### Installation
```bash
npm install
npm run dev
```

---
