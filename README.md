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

3. 핵심 기능 및 구현 상세 (Core Logic)
A. 데이터 관리 및 오프라인 우선 정책 (Offline First)
하이브리드 로딩: 책을 열 때 IndexedDB를 먼저 확인하여 네트워크 요청을 최소화합니다.

Hit: 로컬 데이터 즉시 로드 (로딩 속도 < 0.1s).

Miss: Google Drive에서 다운로드 후 비동기로 로컬 DB에 저장.

데이터 보호: 원본 파일은 변형하지 않으며, 메타데이터와 진행 상황만 Firestore에 저장합니다.

B. 뷰어 렌더링 최적화 (Virtualization - useVirtualScroll)
블록 가상화: 전체 텍스트를 BLOCK_SIZE (15,000자) 단위로 분할하여 관리합니다.

동적 렌더링: 현재 스크롤 위치에 인접한 블록(±Buffer)만 DOM에 렌더링하여 메모리 누수를 방지합니다.

스크롤 보정: 역방향(위로) 스크롤 시 블록이 추가될 때, paddingTop 조정과 scrollBy를 통해 시각적 떨림(Jank)을 제거했습니다.

C. 동기화 및 책갈피 시스템 (Sync & Bookmarks - useReadingProgress)
Firestore를 통해 기기 간 독서 상태를 실시간으로 동기화합니다.

진행률 동기화:

스크롤 시 실시간으로 현재 위치(charIndex, percent)를 계산합니다.

Firestore 쓰기 비용 절약을 위해 5초 간격으로 스로틀링(Throttling)하여 저장합니다.

책갈피 관리 (Updated):

자동 책갈피 (Auto): 검색, 슬라이더 이동, 페이지 점프 등 대량 이동 시 자동으로 생성됩니다.

Rule: 최대 2개까지 유지되며, UUID를 발급하여 시간순으로 관리(오래된 항목 자동 삭제).

수동 책갈피 (Manual): 사용자가 직접 저장하며 최대 5개까지 색상별로 관리됩니다.

충돌 감지 (Conflict Guard):

다른 기기에서 독서를 진행한 경우(서버 타임스탬프 > 로컬 저장 시간 + 2초), 알림창(Toast)을 띄웁니다.

사용자는 "동기화(이동)" 또는 **"무시"**를 선택할 수 있으며, 알림이 떠 있는 동안은 데이터 덮어쓰기가 차단됩니다.

D. 사용자 경험 (UX)
고급 내비게이션: 스크롤 외 3가지 터치 모드(상하/좌우/4방향) 지원.

슬라이더 미리보기: 진행률 슬라이더 조작 시, 손을 떼기 전까지는 UI만 업데이트되고 실제 스크롤/저장은 발생하지 않습니다.

설정 동기화: 테마, 폰트(리디바탕 등), 줄 간격 등 모든 설정값은 클라우드에 영구 저장됩니다.

4. 실행 방법
Bash
# 의존성 설치
npm install

# 개발 서버 실행
npm run dev
Google Cloud Console에서 프로젝트 생성 후 NEXT_PUBLIC_GOOGLE_CLIENT_ID 및 Firebase 설정이 필요합니다.