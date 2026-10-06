# Private Cloud Reader

Google Drive를 개인 서재로 사용하는 오프라인 우선 PWA 리더입니다. TXT·EPUB·PDF·ZIP·CBZ·7z를 열고, 한 번 저장한 도서는 브라우저의 IndexedDB에서 다시 읽습니다. Drive에는 업로드한 원본을 보관하고, TXT는 읽기용 EPUB으로 변환합니다.

Firebase 로그인은 진행률·수동 책갈피·주석·독서 통계의 기기 간 동기화를 담당합니다. Google Drive 연결은 파일 목록·다운로드·업로드를 담당하며 두 계정의 역할은 독립적입니다. 로컬 도서 캐시는 브라우저 프로필 공용입니다.

## 시작하기

Node.js 22와 npm을 사용합니다. Firebase/Google OAuth 설정을 [개발 가이드](docs/development/setup-and-checks.md)에 따라 `.env.local`에 준비한 뒤 실행합니다.

```sh
npm ci
npm run dev
```

기본 개발 주소는 `http://localhost:3000`입니다. 코드 검증은 `npm run check`, Rules·브라우저 검증까지 포함하면 `npm run check:full`을 사용합니다. 각 명령의 준비 사항과 실기기 검증 구분은 개발 가이드에 있습니다.

## 문서

- [현재 사양과 문서 지도](docs/SPEC.md): 기능별 동작, 데이터 경계, 코드와 검증 진입점
- [남은 작업](docs/TODO.md): 미완료 구현·원인 조사·실기기 및 운영 확인
- [개발과 검증](docs/development/setup-and-checks.md)
- [배포·업데이트·복구](docs/operations/deployment-and-recovery.md)
- [Firebase·Google Drive 연동](docs/integrations/firebase-and-drive.md)
- [메타데이터 API](docs/integrations/book-metadata.md), [메타데이터 게시](docs/operations/book-metadata-publishing.md)
- [Web Reader Design Kit](ui-kit/README.md): 다른 프로젝트에 시각 요소를 가져가는 독립 HTML/CSS 키트
- [릴리스와 개발 이력](docs/updates/README.md): 버전별 기록, 완료된 리팩터 계획과 과거 Rules 배포 근거

## 기술과 코드

Next.js App Router·React·TypeScript, Foliate/PDF.js, Tailwind CSS, Firebase Firestore, Google Drive API, IndexedDB(`idb`)를 사용합니다. 정확한 의존성과 실행 명령은 [package.json](package.json)을 기준으로 합니다.

| 경로 | 역할 |
| --- | --- |
| `src/app/page.tsx` | 인증·책장·리더 조합 |
| `src/components/shelf/` | 도서 가져오기·검색·필터·표지·도서 정보 |
| `src/components/EpubReader.tsx`, `src/components/reader/` | 공통 리더 화면과 메뉴 |
| `src/hooks/foliate/`, `public/foliate-js/` | Foliate 어댑터와 렌더러 |
| `src/hooks/reader/` | 위치 저장·책갈피·주석·TTS·독서 추적 |
| `src/lib/` | 로컬 저장·동기화 정책·파일 처리 |
| `src/app/api/`, `src/server/` | 메타데이터 갱신·표지 프록시 |
| `tests/`, `scripts/`, `.github/workflows/ci.yml` | 자동검증과 게시 도구 |
