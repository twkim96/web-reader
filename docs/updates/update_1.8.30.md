# Web Reader 1.8.30 — metadata cover fallback 안정화

## 배경

1.8.29에서 file_check/Firebase의 `coverUrl`을 이용한 로컬 표지 캐시를 추가했지만 두 가지 조건 때문에 기존 도서에서 표지가 생기지 않을 수 있었다.

1. metadata 표지 경로가 TXT에만 제한되어 EPUB/PDF/ZIP/CBZ/7z는 기존 embedded 표지 추출이 실패해도 metadata로 fallback하지 않았다.
2. metadata 표지 다운로드가 reader load effect의 AbortSignal을 공유해, 도서를 연 뒤 서재로 빠르게 돌아오면 이미 commit된 표지 캐싱도 함께 취소될 수 있었다.

## 수정

- 모든 지원 형식(TXT/EPUB/PDF/ZIP/CBZ/7z)을 metadata 표지 fallback 대상으로 둔다.
- EPUB/PDF/ZIP/CBZ는 기존 embedded 표지를 먼저 시도한다.
- embedded 표지가 이미 캐시되었거나 추출에 성공하면 metadata 네트워크 요청을 하지 않는다.
- embedded 표지가 없거나 추출에 실패하면 published/on-demand metadata의 cover URL을 순서대로 시도한다.
- 7z와 TXT는 embedded 추출 없이 metadata 표지를 사용한다.
- reader open이 commit된 뒤의 표지 persistence는 reader 화면의 lifecycle AbortSignal과 분리한다.
- 서재로 돌아가도 표지 캐시는 계속 진행하며, Firebase owner가 변경/해제되면 별도 owner-scoped AbortController로 중단한다.
- Shelf는 계속 `book-covers-v14`만 읽으며 shelf 진입/스크롤 중 외부 이미지 요청을 만들지 않는다.

## 기대 동작

```text
book open commit
  -> existing book-covers-v14 hit: 종료
  -> EPUB/PDF/ZIP/CBZ: embedded cover 시도
       -> 성공: 저장 후 종료
       -> 없음/실패: metadata fallback
  -> TXT/7z: metadata fallback
       -> publicBookMetadataV1 / on-demand metadata
       -> allowlisted /api/book-cover/source
       -> 480x720 이하 WebP/JPEG normalize
       -> book-covers-v14 저장
  -> Shelf cache-change event로 표지 반영
```

## 버전

- app/service-worker cache: `1.8.30`
- Foliate runtime cache release version: `1.8.30`
- metadata crawler version은 1.8.29의 `web-reader-1.8.29-v3` 유지. 이번 패치는 crawler 결과가 아니라 client cover fallback/lifecycle 수정이다.

## 검증

- `npm run check`: PASS
- 기존 `tests/e2e/bookCoverCache.spec.ts` Chromium PDF/CBZ import/cache 회귀: PASS
- `git diff --check`: PASS
- 임시 guest TXT live script는 해당 임시 프로필에서 TXT import 자체가 완료되지 않아 metadata cover 단계 검증에는 사용하지 않았다. 기능 실패로 간주하지 않고 정식 회귀 결과만 기록한다.
