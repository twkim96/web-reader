# Firestore production Rules 기준선

## 상태

- production 프로젝트: `web-novel-viewer`
- 데이터베이스: `(default)`, `asia-northeast3`
- 기준선 확인: 2026-07-13 08:24 KST
- 기존 배포 시각: 2026-02-23 09:39 KST
- 기존 Rules 백업: `docs/backups/firestore.rules.production-2026-07-13.rules`
- 기존 Rules SHA-256: `136abebd45ae3538aa668371f69b1d69e53b6d1373d6e6d05930cb8c9b0778b4`
- 1.7.0 후보 SHA-256: `039bdbd893ceb815b6b491ec57e28808b898dd7253dd4bcb93cd677d61e8e1ab`
- 1.7.0 Rules 배포: **완료**, Firebase Console 배포 이력 `2026-07-13 08:26 KST`

## 검증 증거

- 기존 production Rules 원문을 배포 전에 별도 파일로 보존했다.
- 후보 Rules는 기존 `readingHistory/{bookId}` v1 소유자 read/create/update/delete를 유지한다.
- 후보 Rules는 v2 progress/bookmark/receipt의 strict schema, revision, tombstone, 소유권을 추가한다.
- demo emulator Rules 8개 테스트에서 본인 접근, 다른 UID 거부, transaction conflict, receipt replay, reset/delete tombstone을 통과했다.
- 게시 후 Firebase Console을 새로고침해 최신 이력과 `readingHistoryV2` 후보 원문이 유지되는 것을 확인했다.

production의 실제 로그인·다중 기기 write/read smoke test는 Vercel 실기기 테스트에서 수행한다.

## 롤백

Firebase Console의 Firestore `(default)` → 규칙에서 백업 원문을 다시 붙여넣고 게시한다. 롤백하더라도 v1/v2 데이터와 IndexedDB v4/v5는 삭제하지 않는다.
