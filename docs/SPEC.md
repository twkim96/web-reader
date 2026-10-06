# Web Reader 문서 지도

현재 동작과 유지해야 할 계약의 진입점입니다. 기능을 수정할 때 해당 페이지와 [TODO](TODO.md)의 관련 항목부터 읽고, 연결된 코드·검증을 확인합니다. 버전별 문서는 당시의 계획과 증거이며 현재 사양은 아래 페이지가 담당합니다.

## 기능 사양

| 변경 영역 | 문서 | 내용 |
| --- | --- | --- |
| 책장·가져오기·파일 형식 | [서재와 도서 파일](SPEC/library-and-files.md) | 클라우드/로컬 서재, 형식·검색·필터, 변환·캐시·삭제 |
| 읽기·위치·책갈피·충돌 | [리더와 진행률](SPEC/reader-and-progress.md) | 시작 위치 복원, 이동 후 저장, 임시 슬라이더 이동, 계정별 동기화 |
| 선택·주석·언어 도구 | [주석과 읽기 도구](SPEC/annotations-and-tools.md) | 하이라이트·메모·팔레트, 검색·내보내기, 번역·사전·TTS |
| 통계·진단 | [독서 통계](SPEC/reading-statistics.md) | 활성 시간·회독·날짜 집계, 세션 복구·동기화·진단 |
| 설정·디자인·메뉴 | [화면과 디자인](SPEC/interface.md) | 테마·재질, 모달·바텀시트, 제스처와 독립 UI 키트 |

## 개발·운영·연동

- [개발 환경과 검증](development/setup-and-checks.md): 설정 변수, 실행 명령, 자동검증과 실기기 확인
- [배포·업데이트·복구](operations/deployment-and-recovery.md): PWA 캐시, 데이터 보존, Rules 배포와 장애 진단
- [공개 도서 메타데이터 게시](operations/book-metadata-publishing.md): 읽기 전용 SQLite 원본, 미리보기와 Firestore 게시
- [Firebase·Google Drive](integrations/firebase-and-drive.md): 인증 설정, 계정 경계, 토큰·폴더 수명
- [메타데이터와 표지 API](integrations/book-metadata.md): 인증·입출력·쿼터·실패 처리와 공개 카탈로그
- [미완료 작업과 확인](TODO.md)

## 별도 경로와 과거 증거

- [ui-kit/README.md](../ui-kit/README.md), [ADOPT.md](../ui-kit/ADOPT.md), [COVERAGE.md](../ui-kit/COVERAGE.md)는 복사해서 배포하는 키트 자체의 가이드이므로 같은 폴더에 둡니다.
- [docs/updates/](updates/README.md)는 릴리스 기록입니다. 과거 미체크 항목 중 현재도 남은 작업은 TODO에서 관리합니다.
- [PHASE_PLAN.md](../PHASE_PLAN.md)는 완료된 hook 분리 리팩터 기록입니다.
- [Firestore production Rules 기준선](firestore-rules-production-baseline.md)과 `docs/backups/`는 2026-07-13 당시의 배포·백업 증거이며 현재 production 상태를 보증하지 않습니다.
- Git에서 제외된 `.superloopy/evidence/`의 과거 시각 QA와 로컬 `artifacts/`는 현재 가이드나 완료 판정의 대체물이 아닙니다. 비공개·실행 산출물을 문서 이동 과정에서 추적 대상으로 바꾸지 않습니다.
