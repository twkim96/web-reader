1. 프로젝트 개요
Private Cloud Reader는 Google Drive를 스토리지로 활용하는 개인용 웹 소설 뷰어입니다.
Next.js 15 기반의 PWA(Progressive Web App)로 개발되었으며, 대용량 텍스트 파일의 최적화된 렌더링, 오프라인 저장소 지원, 기기 간 실시간 독서 기록 동기화 기능을 제공합니다.

2. 기술 스택 (Tech Stack)
Framework: Next.js 15 (App Router), TypeScript

Auth & Database: Firebase Authentication (Google Auth), Firestore (Real-time DB)

Storage: Google Drive API (Read-only scope)

Local Cache: IndexedDB (브라우저 내 대용량 파일 저장)

Styling: Tailwind CSS, Lucide React (Icons)

Font: 리디바탕 (Ridi Batang), Noto Sans/Serif

PWA: Service Worker (sw.js), Manifest 지원 (설치형 앱 동작)

3. 프로젝트 구조 (Project Structure)
src/app/page.tsx: 메인 진입점. 인증, 데이터 구독, 라우팅(Shelf ↔ Reader) 및 브라우저 히스토리(뒤로가기) 관리.

src/components/Shelf.tsx: 도서 목록(책장) UI. 오프라인 상태 관리 및 파일 관리 모달 연동.

src/components/Reader.tsx: 핵심 뷰어. 텍스트 가상화, 내비게이션, 설정, 동기화 충돌 감지 로직 포함.

src/lib/googleDrive.ts: Google Drive API 연동 (폴더 탐색, 파일 다운로드).

src/lib/localDB.ts: IndexedDB 래퍼. 파일의 오프라인 저장/로드/삭제 관리.

src/lib/firebase.ts: Firebase 초기화 및 인증/DB 인스턴스 export.

4. 핵심 기능 및 구현 상세 (Core Logic)
A. 데이터 관리 및 오프라인 우선 정책 (Offline First)
Google Drive 연동: 사용자의 구글 드라이브 루트에서 "web viewer" 폴더를 찾아 .txt 파일 목록을 가져옵니다.

하이브리드 로딩 전략:

책을 열 때 IndexedDB를 먼저 확인합니다.

Hit: 로컬에 저장된 데이터가 있으면 즉시 로드 (네트워크 비용 절약).

Miss: 구글 드라이브에서 다운로드 후, 즉시 IndexedDB에 비동기 저장.

관리 기능: 사용자는 Shelf에서 로컬에 저장된 도서 목록을 확인하고 삭제하여 저장 공간을 관리할 수 있습니다.

B. 뷰어 렌더링 최적화 (Virtualization)
대용량 텍스트 파일(1MB 이상)을 끊김 없이 보여주기 위해 커스텀 가상화 로직을 사용합니다.

블록 분할: 전체 텍스트를 BLOCK_SIZE (15,000자) 단위로 분할하여 메모리에 로드합니다.

동적 렌더링: 현재 스크롤 위치에 해당하는 블록(±Buffer)만 DOM에 렌더링(MAX_VISIBLE_BLOCKS: 4)하여 메모리 누수를 방지합니다.

역방향 스크롤 보정: 위로 스크롤 시 상단 블록이 추가될 때, paddingTop과 scrollBy를 이용해 시각적 흔들림(Jank)을 방지합니다.

C. 고급 내비게이션 및 줄 잘림 방지 (Navigation)
모드 지원: 기본 스크롤 외 3가지 탭 모드 지원 (config에서 설정 가능).

T/B Tap: 상단/하단 터치로 이동.

L/R Tap: 좌측(이전)/우측(다음) 터치로 이동.

4-Way: 상/하 우선, 좌/우 보조 이동.

D. 실시간 동기화 및 충돌 방지 (Real-time Sync & Conflict Guard)
Firestore 연동: readingHistory 컬렉션을 통해 실시간으로 독서 진행률(charIndex, percent)을 저장합니다.

SPA 히스토리 관리: window.history.pushState를 사용하여 뷰어 진입 시 가상의 히스토리를 생성, 브라우저/기기의 물리적 '뒤로가기' 버튼이 앱을 종료하지 않고 책장으로 돌아가도록 처리했습니다.

동기화 충돌 감지 (Conflict Detection):

다른 기기에서 독서를 진행하여 서버 데이터가 갱신되면, 현재 기기에서 이를 실시간으로 감지합니다.

로직: (서버의 저장 시간) > (내 마지막 저장 시간 + 2초) 일 경우 충돌로 간주.

UI: 화면 하단(모바일) 또는 우측 하단(PC)에 Toast 알림을 띄워 "동기화(이동)" 또는 **"무시"**를 선택하게 합니다.

데이터 보호: 알림이 떠 있는 동안은 자동 저장을 차단하여, 실수로 과거 기록이 최신 기록을 덮어쓰는 것을 방지합니다.

5. 사용자 설정 (Settings)
다음 설정값은 Firestore에 영구 저장되어 기기 간 공유됩니다.

테마: Light, Dark, Sepia, Blue

타이포그래피: 폰트 크기, 줄 간격, 좌우 여백, 정렬(Left/Justify), 폰트 종류(Sans/Serif/Ridi)

기능: 인코딩(Auto/UTF-8/EUC-KR 등), 내비게이션 모드