# 🚀 Private Cloud Reader (Stable v1.0)

**Private Cloud Reader**는 대용량 텍스트 파일(웹소설, e-Book 등)을 가장 빠르고 쾌적하게 읽을 수 있도록 설계된 **개인용 클라우드 뷰어**입니다. 

단순한 뷰어를 넘어, Google Drive를 무한한 서재로 활용하고 장치 간 끊김 없는 독서 경험을 제공하는 **Offline-First PWA** 솔루션입니다.

---

## 💎 Core Technologies (핵심 기술)

### 1. High-Performance Virtualization Engine
*   **Chunk-based Hydration**: 수십 메가바이트(MB)에 달하는 텍스트 파일을 15,000자 단위의 블록으로 분할하여 가상 렌더링합니다. 수백만 자의 텍스트도 메모리 점유율을 최소화하며 60fps의 부드러운 스크롤을 보장합니다.
*   **Precision Jump System**: 사용자가 어느 지점으로 이동하든 `useLayoutEffect` 기반의 스크롤 동기화 로직이 0.1초 내에 앵커를 잡아내어 공백 없는 화면을 제공합니다.

### 2. Hybrid Hybrid Data Architecture
*   **Cloud-Native Sync**: Google Drive를 데이터 원천(Storage)으로, Firebase Firestore를 메타데이터(Progress, Bookmark) 동기화 채널로 활용합니다.
*   **IndexedDB Persistent Cache**: 한 번 읽은 도서는 브라우저 내 IndexedDB에 로컬 캐싱되어, 네트워크가 없는 오프라인 상태에서도 완벽하게 동작합니다.

### 3. Smart Text Processor
*   **Auto-Encoding Protection**: 한국어 환경의 특수성을 고려하여 UTF-8, EUC-KR, UTF-16 등 다양한 인코딩 형식을 자동으로 감지하고 처리합니다.
*   **Dynamic Theme Engine**: 읽기 환경에 최적화된 고급스러운 다크 모드와 6종의 액센트 컬러 시스템을 제공합니다.

### 4. Desktop-Class UX (PWA)
*   **Spotlight Style Search**: MacBook의 Spotlight에서 영감을 받은 플로팅 검색 모달을 통해 도서와 본문을 빠르게 탐색합니다.
*   **Installed App Experience**: Service Worker 기반의 PWA로 작동하여, 브라우저 주소창 없이 네이티브 앱과 동일한 몰입감을 제공합니다.

---

## 🛠 Tech Stack

*   **Framework**: Next.js 16 (App Router), React 19
*   **Language**: TypeScript
*   **Database**: Firebase Firestore, IndexedDB (dexie)
*   **Storage**: Google Drive API (Drive.file Scope)
*   **Styling**: Tailwind CSS v4, Lucide React

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

## 📬 Road to v1.0
본 프로젝트는 초기 프로토타입에서 시작하여 **내비게이션 안정화, 대용량 파일 렌더링 최적화, 클라우드 동기화 정밀도 향상** 과정을 거쳐 `v1.0 Stable` 단계에 도달했습니다.


- Stable Rollback: Tue Apr 21 17:43:53 KST 2026
