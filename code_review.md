# Web Reader 코드베이스 종합 리뷰

전체 소스코드를 분석한 결과, 오프라인/클라우드 동기화, 가상 스크롤, 정밀 위치 추적 등 핵심 기능이 잘 구현되어 있습니다.  
아래는 카테고리별로 **부족한 부분**과 **구체적인 개선 방안**을 정리한 내용입니다.

---

## 1. 🏗️ 아키텍처 & 상태 관리

### 1-1. God Component 문제 — `page.tsx` (502줄)

[page.tsx](file:///Users/twkim/Documents/web_reader/src/app/page.tsx)에 인증, 토큰 관리, 라우팅, 진행률 동기화, 설정 관리가 모두 집중되어 있습니다.

> [!WARNING]
> 컴포넌트 하나에 비즈니스 로직이 과도하게 집중되어 유지보수와 테스트가 어렵습니다.

**개선안:**
```
src/
├── contexts/
│   ├── AuthContext.tsx       ← 인증 + 토큰 관리
│   ├── LibraryContext.tsx    ← 도서 목록 + 동기화 로직
│   └── SettingsContext.tsx   ← 설정 + 테마
├── hooks/
│   ├── useAuth.ts            ← AuthContext 소비용 훅
│   ├── useLibrary.ts         ← 도서 CRUD + sync
│   └── useSettings.ts        ← 설정 읽기/쓰기
```

- **React Context**로 전역 상태를 분리하면 prop drilling(`Shelf`에 14개 prop 전달 중)도 해소됩니다.
- `page.tsx`는 순수하게 라우팅(view 전환)과 레이아웃만 담당해야 합니다.

### 1-2. 라우팅이 수동 `ViewState`로 구현됨

현재 `useState<ViewState>('loading')`으로 화면 전환을 관리합니다. Next.js의 라우팅 기능을 전혀 활용하지 않고 있습니다.

**개선안:**
- `app/shelf/page.tsx`, `app/reader/[bookId]/page.tsx`로 분리
- `next/navigation`의 `useRouter`를 활용하면 브라우저 히스토리, 딥링크, SSR 이점을 얻습니다
- **최소 변경**: 현재 SPA 구조를 유지하되, URL hash(`#shelf`, `#reader/ID`)와 동기화만 시켜도 새로고침 시 현재 위치 유지가 가능해집니다.

### 1-3. `Shelf.tsx`가 745줄로 비대함

[Shelf.tsx](file:///Users/twkim/Documents/web_reader/src/components/Shelf.tsx)가 도서 카드, 헤더, 빈 상태, 파일 업로드, 검색 등을 모두 포함하고 있습니다.

**개선안:**
```
components/shelf/
├── ShelfHeader.tsx
├── BookCard.tsx         ← grid/list 둘 다 렌더링
├── EmptyState.tsx
├── FileUploader.tsx     ← upload 로직 분리
└── index.tsx            ← 조합만 담당
```

---

## 2. 🔒 보안

### 2-1. Google Drive 토큰을 localStorage에 평문 저장

[page.tsx L291-294](file:///Users/twkim/Documents/web_reader/src/app/page.tsx#L291-L294)에서 `access_token`을 그대로 localStorage에 넣고 있습니다.

> [!CAUTION]
> XSS 공격 시 토큰이 즉시 탈취됩니다. OAuth 토큰은 가급적 HttpOnly 쿠키 또는 메모리(state)에만 보관해야 합니다.

**개선안:**
- 가장 간단: 토큰은 **메모리(state)**에만 유지하고, 만료 시 `google.accounts.oauth2`로 재발급 (silent refresh)
- 불가피하게 persist가 필요하다면: Web Crypto API로 간단한 AES-GCM 암호화 후 저장
- `isPublicPC` 모드에서는 **반드시** sessionStorage만 사용 + 탭 닫기 시 토큰 삭제 (현재 구현은 OK)

### 2-2. Google Drive 쿼리에 SQL Injection 유사 위험

[googleDrive.ts L31](file:///Users/twkim/Documents/web_reader/src/lib/googleDrive.ts#L31):
```typescript
const query = `name = '${folderName}' ...`;
```

`folderName`에 `'`가 포함되면 쿼리가 깨집니다.

**개선안:**
```typescript
const safeName = folderName.replace(/'/g, "\\'");
const query = `name = '${safeName}' and ...`;
```

### 2-3. constants.ts에 더미 CLIENT_ID가 하드코딩

[constants.ts L62](file:///Users/twkim/Documents/web_reader/src/lib/constants.ts#L62): `GOOGLE_DRIVE_CONFIG`에 더미 값이 남아있습니다. 실제로는 `page.tsx`에서 `process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID`를 쓰고 있어 실제 문제는 없지만, 혼란을 줍니다.

**개선안:** 사용하지 않는 `GOOGLE_DRIVE_CONFIG` 상수를 삭제하세요.

---

## 3. ⚡ 성능

### 3-1. `getVisibleBlocks()`가 매 렌더링마다 재생성

[useVirtualScroll.ts L39-51](file:///Users/twkim/Documents/web_reader/src/hooks/useVirtualScroll.ts#L39-L51): `getVisibleBlocks`가 `useCallback`으로 감싸지지 않아, 호출할 때마다 새 배열 + 새 substring을 생성합니다.

**개선안:**
```typescript
const getVisibleBlocks = useCallback(() => {
  // ... 기존 로직
}, [visibleRange, fullContentRef]);
```
또는 `useMemo`로 `visibleBlocks` 배열 자체를 캐싱:
```typescript
const visibleBlocks = useMemo(() => {
  // range + content 기반 블록 생성
}, [visibleRange.start, visibleRange.end, contentVersion]);
```

### 3-2. `SearchModal` 본문 전체 검색이 메인 스레드 블로킹

[SearchModal.tsx L30-51](file:///Users/twkim/Documents/web_reader/src/components/SearchModal.tsx#L30-L51): 300ms 디바운스 후 `indexOf` 반복으로 전체 본문을 탐색합니다. 10MB 이상 파일에서는 UI가 멈출 수 있습니다.

**개선안:**
- **Web Worker**로 검색 로직을 분리
- 또는 검색 중임을 표시하는 로딩 상태 추가 + `requestIdleCallback`으로 청크 단위 검색

### 3-3. `Shelf` 도서 목록 정렬이 매 렌더링마다 실행

[Shelf.tsx L243-265](file:///Users/twkim/Documents/web_reader/src/components/Shelf.tsx#L243-L265): `filteredBooks`가 `useMemo` 없이 매번 filter + sort를 수행합니다.

**개선안:**
```typescript
const filteredBooks = useMemo(() => {
  return books.filter(/* ... */).sort(/* ... */);
}, [books, searchKeyword, sortMode, progress]);
```

### 3-4. `blockRefs.current`가 정리되지 않음

블록이 unmount되어도 `blockRefs.current`에 stale reference가 남아 메모리 누수 가능성이 있습니다.

**개선안:** `visibleRange`가 변경될 때 범위 밖의 ref를 `delete`하는 cleanup 로직 추가.

---

## 4. 🐛 안정성 & 버그 위험

### 4-1. `lastRead` 타임스탬프 처리 불일치

여러 곳에서 `lastRead`를 각기 다르게 파싱합니다:
- [page.tsx L109](file:///Users/twkim/Documents/web_reader/src/app/page.tsx#L109): `new Date(localData.lastRead).getTime()`
- [useReadingProgress.ts L29-31](file:///Users/twkim/Documents/web_reader/src/hooks/useReadingProgress.ts#L29-L31): `val.toMillis ? val.toMillis() : new Date(val).getTime()`
- [Shelf.tsx L235](file:///Users/twkim/Documents/web_reader/src/components/Shelf.tsx#L235): `timestamp.toDate ? timestamp.toDate() : new Date(timestamp)`

> [!IMPORTANT]
> Firestore `Timestamp`, JS `Date`, 밀리초 숫자가 혼재되어 비교 오류가 발생할 수 있습니다.

**개선안:**
```typescript
// lib/utils.ts
export const toMillis = (val: any): number => {
  if (!val) return 0;
  if (typeof val === 'number') return val;
  if (val.toMillis) return val.toMillis();          // Firestore Timestamp
  if (val.toDate) return val.toDate().getTime();     // Firestore Timestamp (alt)
  const d = new Date(val);
  return isNaN(d.getTime()) ? 0 : d.getTime();
};
```
이 함수 하나로 모든 곳에서 통일하세요.

### 4-2. `useEffect` 의존성 배열 누락/경고

- [page.tsx L180](file:///Users/twkim/Documents/web_reader/src/app/page.tsx#L180): `loadLibraryFromDrive`, `syncLocalAndCloud`가 deps에 없음
- [page.tsx L258](file:///Users/twkim/Documents/web_reader/src/app/page.tsx#L258): `isGuest`만 deps에 있어 `restoreLocalData` 등 콜백 변경 시 stale closure 발생 가능
- [useVirtualScroll.ts L234](file:///Users/twkim/Documents/web_reader/src/hooks/useVirtualScroll.ts#L234): `layoutDeps`가 spread로 전달되어 ESLint exhaustive-deps 규칙을 우회

**개선안:** 
- 함수들을 `useCallback`으로 안정화하고 deps에 추가
- `// eslint-disable-next-line` 대신 구조적으로 해결

### 4-3. `idb` 라이브러리 의존성 누락 (package.json)

[localDB.ts L2](file:///Users/twkim/Documents/web_reader/src/lib/localDB.ts#L2)에서 `import { openDB } from 'idb'`를 사용하지만, `package.json`에 `idb`가 dependencies에 없습니다.

> [!WARNING]
> `node_modules`에 다른 패키지의 간접 의존으로 존재할 수 있지만, 직접 의존으로 명시해야 안정적입니다.

**개선안:** `npm install idb` 실행

### 4-4. Auth `onSnapshot` unsubscribe 누수

[page.tsx L225-242](file:///Users/twkim/Documents/web_reader/src/app/page.tsx#L225-L242): `onSnapshot` 콜백 내부에서 `return () => { unsubProgress(); }`를 반환하지만, 이것은 `onAuthStateChanged` 콜백의 반환값이지 `useEffect`의 cleanup이 아닙니다.

> [!CAUTION]
> 로그인 → 로그아웃 → 재로그인 시 이전 `onSnapshot` 리스너가 해제되지 않아 중복 실행됩니다.

**개선안:**
```typescript
useEffect(() => {
  let unsubProgress: (() => void) | null = null;
  
  const unsubAuth = onAuthStateChanged(auth, (u) => {
    // 이전 progress 리스너 정리
    if (unsubProgress) { unsubProgress(); unsubProgress = null; }
    
    if (u) {
      const historyRef = collection(db, ...);
      unsubProgress = onSnapshot(historyRef, (snapshot) => { ... });
    }
  });
  
  return () => {
    unsubAuth();
    if (unsubProgress) unsubProgress();
  };
}, [/* deps */]);
```

### 4-5. `handleFileUpload`에서 Error Boundary 부재

[Shelf.tsx L169-207](file:///Users/twkim/Documents/web_reader/src/components/Shelf.tsx#L169-L207): `FileReader.onload` 내부의 async 에러가 catch되지 않습니다. `saveBookToLocal`이 실패하면 무시됩니다.

**개선안:** try-catch 추가 + 사용자에게 에러 토스트 표시

---

## 5. 📝 코드 품질

### 5-1. TypeScript `any` 남용

| 파일 | 위치 | 내용 |
|------|------|------|
| [types.ts L38](file:///Users/twkim/Documents/web_reader/src/types.ts#L38) | `lastRead: any` | Firestore Timestamp \| number \| Date |
| [SearchModal.tsx L14](file:///Users/twkim/Documents/web_reader/src/components/SearchModal.tsx#L14) | `theme: any` | 테마 타입 미정의 |
| [ManageModal.tsx L11](file:///Users/twkim/Documents/web_reader/src/components/ManageModal.tsx#L11) | `theme: any` | 동일 |
| [Shelf.tsx L232](file:///Users/twkim/Documents/web_reader/src/components/Shelf.tsx#L232) | `timestamp: any` | 동일 |

**개선안:**
```typescript
// types.ts
import { Timestamp } from 'firebase/firestore';

export type FirestoreTimestamp = Timestamp | number | Date;

export interface Theme {
  bg: string;
  text: string;
  border: string;
  secondary: string;
}

export interface UserProgress {
  bookId: string;
  charIndex: number;
  progressPercent: number;
  lastRead: FirestoreTimestamp;
  bookmarks?: Bookmark[];
}
```

### 5-2. 매직 넘버가 곳곳에 산재

| 값 | 위치 | 의미 |
|----|------|------|
| `5000` | page.tsx L64 | 자동 저장 간격(ms) |
| `15000` | useVirtualScroll.ts L4 | 블록 크기 |
| `80` | useVirtualScroll.ts L67 | 상단 nav 높이(px) |
| `300` | useReadingProgress.ts L177 | 동기화 감지 임계값(chars) |
| `100` | useReadingProgress.ts L94 | 자동 북마크 최소거리 |
| `2000` | useReadingProgress.ts L160 | 시간 버퍼(ms) |
| `48` | Reader.tsx L145 | 기본 상단 패딩 |

**개선안:** `lib/constants.ts`에 의미 있는 상수명으로 통합 정의
```typescript
export const READER_CONFIG = {
  AUTO_SAVE_INTERVAL_MS: 5000,
  BLOCK_SIZE: 15000,
  NAV_HEIGHT_PX: 80,
  SYNC_THRESHOLD_CHARS: 300,
  AUTO_BOOKMARK_MIN_DISTANCE: 100,
  SYNC_TIME_BUFFER_MS: 2000,
};
```

### 5-3. 한국어/영어 주석 혼재

주석이 한국어와 영어가 무규칙하게 섞여 있어 가독성이 떨어집니다.  
하나의 언어로 통일하는 것을 추천합니다 (개인 프로젝트라면 한국어 OK).

---

## 6. 📱 PWA & 오프라인

### 6-1. Service Worker 캐시 버전 갱신 전략 부재

[sw.js L3](file:///Users/twkim/Documents/web_reader/public/sw.js#L3): `CACHE_NAME = 'pc-reader-v1'`이 하드코딩. 배포 시 버전을 올리지 않으면 **구버전 JS가 영원히 캐시**됩니다.

**개선안:**
- 빌드 시 해시를 포함한 캐시명 생성 (`pc-reader-${BUILD_HASH}`)
- 또는 `next-pwa` / `workbox` 같은 SW 도구를 도입

### 6-2. 오프라인 fallback 페이지 부재

네트워크 실패 + 캐시 미스 시 빈 화면이 표시됩니다.

**개선안:** `sw.js`에 오프라인 fallback HTML 추가:
```javascript
// install에서 '/offline.html' 를 precache
// fetch catch에서:
if (request.mode === 'navigate') {
  return caches.match('/offline.html');
}
```

### 6-3. Manifest에 `description`, `lang` 누락

[manifest.json](file:///Users/twkim/Documents/web_reader/public/manifest.json)에 PWA 설치 프롬프트에 필요한 필드가 일부 빠져있습니다.

**개선안:**
```json
{
  "description": "구글 드라이브 기반 개인용 웹소설 리더",
  "lang": "ko",
  "orientation": "portrait",
  "categories": ["books", "education"]
}
```

---

## 7. ♿ 접근성 (A11y)

### 7-1. 시맨틱 HTML 미사용

- Reader의 본문이 `<div>`로만 구성됨 → `<article>`, `<section>` 사용
- 모달에 `role="dialog"`, `aria-modal="true"`, `aria-labelledby` 없음
- 버튼에 `aria-label` 없이 아이콘만 표시되는 경우 다수

### 7-2. 키보드 네비게이션 미지원

- Reader에서 화살표 키로 페이지 이동 불가
- 모달 열림 시 포커스 트랩(focus trap) 없음
- ESC 키로 모달 닫기 미구현 (현재 뒤로가기만 가능)

**개선안:**
```typescript
// 모달 공통 래퍼에 추가
useEffect(() => {
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') onClose();
  };
  window.addEventListener('keydown', handleKeyDown);
  return () => window.removeEventListener('keydown', handleKeyDown);
}, [onClose]);
```

---

## 8. 🧪 테스트 & DX

### 8-1. 테스트 코드 전무

단위 테스트, 통합 테스트, E2E 테스트가 하나도 없습니다.

**개선안 (우선순위 순):**
1. `useReadingProgress` — 동기화 분기 로직 단위 테스트 (Jest + React Testing Library)
2. `localDB.ts` — IndexedDB CRUD 테스트 (fake-indexeddb)
3. `googleDrive.ts` — API 호출 모킹 테스트
4. Reader ↔ Shelf 전환 — Playwright E2E

### 8-2. 에러 핸들링이 `console.error`로만 처리됨

사용자는 개발자 도구를 열지 않으므로, 에러 발생 시 아무 피드백을 받지 못합니다.

**개선안:**
- 토스트/스낵바 컴포넌트 추가 (이미 `autoSyncToast` 패턴이 있으므로 확장)
- 전역 Error Boundary 추가 (`app/error.tsx`)

---

## 요약: 우선순위별 개선 로드맵

| 우선순위 | 영역 | 항목 | 난이도 |
|:---:|------|------|:---:|
| 🔴 P0 | 안정성 | `onSnapshot` 구독 누수 수정 (4-4) | 낮음 |
| 🔴 P0 | 안정성 | `idb` 의존성 명시 (4-3) | 낮음 |
| 🔴 P0 | 보안 | 토큰 저장 방식 개선 (2-1) | 중간 |
| 🟡 P1 | 성능 | `getVisibleBlocks` 메모이제이션 (3-1) | 낮음 |
| 🟡 P1 | 성능 | `filteredBooks` useMemo 적용 (3-3) | 낮음 |
| 🟡 P1 | 안정성 | 타임스탬프 유틸 통일 (4-1) | 낮음 |
| 🟡 P1 | 코드 품질 | `any` 타입 제거 + Theme 타입 정의 (5-1) | 낮음 |
| 🟢 P2 | 아키텍처 | Context 분리 (1-1) | 높음 |
| 🟢 P2 | 아키텍처 | Shelf 컴포넌트 분할 (1-3) | 중간 |
| 🟢 P2 | 성능 | 검색 Web Worker 분리 (3-2) | 중간 |
| 🟢 P2 | PWA | SW 캐시 버전 전략 (6-1) | 중간 |
| 🔵 P3 | 접근성 | 시맨틱 HTML + ARIA + 키보드 (7) | 중간 |
| 🔵 P3 | DX | 테스트 인프라 구축 (8-1) | 높음 |
| 🔵 P3 | 보안 | Drive API 쿼리 이스케이프 (2-2) | 낮음 |

---

> [!TIP]
> **가장 빠르게 안정성을 높이는 방법**: P0 항목 3개(onSnapshot 누수, idb 의존성, 타임스탬프 통일)를 먼저 처리하면, 현재 발생할 수 있는 실질적 버그의 대부분이 해소됩니다.
