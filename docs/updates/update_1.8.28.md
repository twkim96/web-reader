# Web Reader 1.8.28 — foreground 진행률 수신 지연·late prompt 안정화

작성일: 2026-08-21

## 실기기 증상

웹/PWA 리더를 종료하지 않고 background로 보낸 동안 다른 기기에서 같은 책을 읽고, 다시 foreground로 복귀하면 원격 진행률 모달이 즉시 뜨지 않고 늦게 나타나는 경우가 있었다.

또 그 지연 중 현재 기기에서 먼저 페이지를 넘긴 뒤 뒤늦게 나타난 `클라우드 동기화` 모달에서 `이동하기`를 누르면 모달은 닫히지만 원격 위치로 이동하지 않고 방금 넘긴 로컬 위치가 유지되는 경우가 있었다.

## 원인

### foreground 수신 지연

1.8.12의 listener recovery는 불필요한 account-wide Firestore 재조회와 subscription churn을 막기 위해 `hidden -> visible`에서 마지막 authoritative server snapshot이 15초 이상 오래된 경우에만 progress listener를 강제 재구독한다.

Firestore가 foreground 직후 먼저 돌려주는 cache snapshot은 stale remote head를 적용하지 않기 위해 `ServerSnapshotHydrator`가 의도적으로 무시한다. 따라서 모바일 네트워크/Firestore 연결이 늦게 복구되면 server-authoritative snapshot 도착까지 원격 진행률 모달도 늦어질 수 있다.

### late prompt 뒤 로컬 page-turn

사용자가 원격 head가 UI에 반영되기 전에 먼저 페이지를 넘기면 해당 위치의 progress event가 local outbox에 `pending`/`in_flight`로 생긴다. 이후 뒤늦은 원격 모달을 수락하면 `adoptRemoteProgressLocallyV5()`가 이 미완료 로컬 intent를 덮어쓰지 않기 위해 `blocked-by-local-work`를 반환한다.

기존 `acceptSyncConflict()`는 이 안전 차단을 성공과 비슷하게 취급해 모달을 닫아 버렸다. 결과적으로 데이터 보호는 됐지만 사용자에게는 `이동하기`가 아무 동작 없이 무시된 것처럼 보였다.

## 수정

### 현재 책 1건 foreground server refresh

- 기존 15초 stale listener reconciliation 정책은 유지한다.
- `visible` 복귀 시 전체 progress collection을 무조건 다시 읽지 않는다.
- 현재 열려 있는 `activeBookId`의 progress document 한 건만 `getDocFromServer()`로 즉시 확인한다.
- 결과는 기존 progress head parser, remote-head IndexedDB cache, session-echo 방어를 그대로 통과한다.
- targeted read와 account-wide listener가 경합할 수 있으므로 `mergeRemotePositionUpdates()`는 더 낮은 `syncRevision`이 이미 반영된 높은 revision을 덮지 못하게 한다.
- targeted refresh 실패 시 기존 realtime listener/recovery가 그대로 fallback한다.

### local work로 막힌 명시적 원격 이동

- `blocked-by-local-work`에서는 원격 모달을 닫지 않는다.
- `현재 기기에서 방금 이동한 위치를 저장·동기화 중`이라는 feedback을 표시하고, 저장/동기화가 끝난 뒤 `이동하기`를 다시 누를 수 있게 한다.
- `stale-remote`와 이동 도중 새 사용자 조작으로 supersede된 경우도 조용히 닫지 않고 각각 이유를 표시한다.
- local outbox를 강제로 삭제하거나 미완료 로컬 intent를 원격 값으로 덮어쓰는 동작은 추가하지 않는다.

## 회귀 검증

- late prompt 수락 시 local progress work가 남아 있으면 viewport navigation 없이 모달이 유지되고 feedback이 표시되는지 확인한다.
- targeted foreground refresh로 더 높은 revision을 반영한 뒤 늦은 collection listener snapshot이 낮은 revision으로 UI를 되돌리지 못하는지 확인한다.
- 기존 automatic remote retry, readiness 중 user-intent abort, SnapshotListenerRecovery stale/cooldown 계약을 유지한다.

## 검증 결과

- `npm run typecheck` 통과.
- foreground/remote progress 집중 회귀 15건 통과.
- `npm run check` 전체 통과.
  - storage 308건
  - shelf 111건
  - shelf-ui 12건
  - archive 36건
  - SW 9건
  - release 3건
  - publisher 3건
  - Next.js production build 통과

## 버전/캐시

- 앱 버전: `1.8.28`
- Service Worker cache: `pc-reader-v1.8.28`
- Foliate renderer 변경 없음. runtime revision은 기존 값을 유지한다.
