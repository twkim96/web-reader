# Private Cloud Reader

**Private Cloud Reader**는 Google Drive를 개인 서재(Storage)로 활용하는 웹 소설 뷰어입니다.
Next.js 16 기반의 PWA(Progressive Web App)로 개발되었으며, **오프라인 우선(Offline-First)** 전략과 **가상화(Virtualization)** 기술을 통해 대용량 텍스트 파일을 끊김 없이 렌더링합니다.

---

## 1. 기술 스택 (Tech Stack)

* **Framework**: Next.js 16.1 (App Router), React 19
* **Language**: TypeScript
* **Auth & DB**: Firebase Authentication (Google Auth), Firestore (Real-time Sync)
* **Storage**: Google Drive API (Read-only scope)
* **Local Cache**: IndexedDB (브라우저 내 대용량 파일 영구 저장)
* **Styling**: Tailwind CSS, Lucide React (Icons)
* **PWA**: Service Worker, Manifest (설치형 앱 동작 지원)

---

## 2. 프로젝트 구조 (Project Structure)

**핵심 로직은 유지보수성을 위해 Custom Hooks로 분리되었습니다 (`src/hooks`).**

```text
src/
├── app/
│   └── page.tsx            # 메인 진입점 (인증, 라우팅, 전역 상태 관리)
├── components/
│   ├── Shelf.tsx           # 도서 목록 (파일 관리, 오프라인 캐시 확인)
│   ├── Reader.tsx          # 뷰어 UI 컴포넌트 (Hooks 통합 및 이벤트 바인딩)
│   └── BookmarkModal.tsx   # 책갈피 관리 (자동/수동 리스트 렌더링)
├── hooks/                  # [Refactored] 비즈니스 로직 분리
│   ├── useBookLoader.ts    # Google Drive 다운로드, IndexedDB 캐싱, 디코딩
│   ├── useReadingProgress.ts # 독서 진행률, 책갈피(Auto/Manual), 동기화 충돌 감지
│   └── useVirtualScroll.ts # 대용량 텍스트 가상화, 스크롤 이벤트, 점프 로직
├── lib/
│   ├── googleDrive.ts      # Google Drive API 통신
│   ├── localDB.ts          # IndexedDB Wrapper (Offline Storage)
│   └── firebase.ts         # Firebase 초기화
└── types.ts                # 공용 타입 정의 (Book, Bookmark, UserProgress 등)


# 실행 방법
Bash
# 의존성 설치
npm install

# 개발 서버 실행
npm run dev
Google Cloud Console에서 프로젝트 생성 후 NEXT_PUBLIC_GOOGLE_CLIENT_ID 및 Firebase 설정이 필요합니다
