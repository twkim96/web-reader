# 동기화 전체 PRO 리뷰 — 2026-11-18

## 범위와 상태

내장 브라우저의 `browser` 프로젝트에서 **Pro 통합 질문 1회**를 제출했고 `Web Reader 동기화 리뷰` 답변을 받았습니다. 영수증 보존 외에 원격 이동 실패·송수신·재시도·충돌·다중 탭·통계·운영 전환을 묶었습니다. 이 단계에서 제품 코드 수정·커밋·푸시·배포·운영 데이터 변경은 하지 않았습니다. 후속 작업은 [TODO](../TODO.md#pro-리뷰-후속-동기화-정확성)에 있습니다.

- [원래 PRO 대화](https://chatgpt.com/g/g-p-6afccd8386988191ba79b02c4df4b6e7-browser/c/6afccf4f-1540-83e8-bac6-e278456e6167)
- 검토 기준: `main`, HEAD `d4a62b5bba385c58acd2003777e3d582834d19ad`와 당시 미커밋·신규 파일을 포함한 worktree. 원격 main도 `git ls-remote`로 같은 SHA임을 확인했습니다. HEAD만 리뷰한 것이 아닙니다.
- 소스 401개(원본 4,177,805바이트), 변경 전 소스·diff·Git 이력·검증 로그를 동결했습니다. ZIP SHA-256: `c5f84acba5385239accc4db0e64b2a9d9e6d469d4d68829705835691652f1003`. CRC와 모든 worktree 해시를 검증했고 Pro도 동일성을 확인했습니다. 인증 값·실제 UID·도서 원문·표지·개인 화면은 제외했습니다.
- 비공개 로컬 증거 위치: `.superloopy/evidence/reviews/sync-pro-20261118/`. 요청서·원문 표시 텍스트·표 8개·스크린샷·송부 ZIP·수신 검사 ZIP·검사 로그를 보존했습니다. Git에서 제외된 이 경로가 없는 환경에서도 아래 요약과 원래 대화로 판단할 수 있게 했습니다.

## 종합 판정

**기존 구조를 유지하면서 부분 단순화하되 정확성 결함을 먼저 수정합니다.** 열린 창의 최신 target 갱신, 수신/채택 revision 분리, 원 receipt의 수락 revision 보존, 제출 payload 불변성과 claim/owner/tombstone 경계는 유지할 가치가 있습니다. 아직 과거 화면 덮어쓰기 방어가 완결됐다고 판정하지 않습니다.

특히 발견 1·2는 유한 동기화 플래그 OFF에서도 영향을 받습니다. 유한 권한·정리 플래그는 OFF를 유지합니다. 정리 방식과 기간 변경은 아래 리뷰 권고이며 **채택·구현·활성화하지 않았습니다.**

## 검증 근거

| 근거 | 결과 | 제한 |
| --- | --- | --- |
| 리뷰 준비 중 현재 `npm run test:storage` | 432개 중 431 통과, 1 실패 | 전체 green 아님 |
| 앞선 집중 회귀 | 232/232 | 저장·이동·권한·복구·정리의 선정 범위 |
| 앞선 Rules/metadata emulator | 40/40 및 3/3 | 이후 작은 정책 schemaVersion 가드는 관련 단위 9개·정리 emulator 1개로 재검증 |
| 앞선 build/lint | TypeScript 포함 build 통과, lint error 0 / 기존 warning 4 | 로그별 실행 시점 구분 |
| PRO 제공 제어 검사 로컬 재실행 | 소스 분기 검사 8개가 동일한 관측을 확인 | **정상 동작 8개 통과가 아님**. 7개 문제 경로와 기존 정책 분기 1개를 확인 |

수신한 `web-reader-review-checks.zip`의 CRC·내용을 확인한 뒤 격리된 저장소/SDK 입출력 fixture와 AST 추출 방식임을 검토했습니다. 실제 TypeScript 소스를 읽고, 네트워크는 fixture에서 차단하며 제품 파일을 쓰지 않는 코드입니다. 로컬에서 다음 명령으로 다시 실행했습니다.

```sh
TYPESCRIPT_PATH="$PWD/node_modules/typescript" REVIEW_ROOT="$PWD" \
  node .superloopy/evidence/reviews/sync-pro-20261118/pro-checks/source-boundary-checks.cjs
```

로그는 같은 폴더의 `local-source-boundary-checks.log`입니다. 실제 IndexedDB 잠금·React 렌더링·Rules·브라우저/OS·기기 간 수용 검증을 대체하지 않습니다. 실제 source 분기를 제어한 검사이므로 수정 시 기존 실제 harness의 회귀로 옮겨야 합니다.

## 주요 발견과 코드 대조

| PRO 번호 | 분류 | 현재 코드에서 확인한 경계 | 필요한 후속 |
| --- | --- | --- | --- |
| 1 | P1, 제어 재현 | `syncOutboxV5.getProgressWriteBaseRevision`과 batch enqueue가 화면 R1보다 공유 IDB 행 R2를 우선해 과거 위치의 R3 쓰기를 허용 | reader/session별 채택·명시 무시 기준 전달. 다른 세션의 queued tail 자동 승계도 제한 |
| 2 | P1, 제어 재현 | `syncConflictPolicy.getAutomaticProgressConflictResolution`의 높은 percent 승리와 `useSyncConflictResolution`의 비활성 도서 자동 처리. keep-local 대체 ID는 현재 lease를 사용해 179일 된 원 권한을 갱신 | 비동등 위치 자동 승자를 제한하고 자동 대체 이벤트는 원 권한 경계 유지. 명시적 새 의도와 구별 |
| 3 | P1/P2, 제어 재현 + 설계 위험 | `useRemoteProgressPrompt.dismissSyncConflict`의 R2 await 완료가 R3 창을 닫음. `allowCurrentViewportAfterIgnoringRemote`는 target/attempt 구분 없이 guard를 해제 | book/target/attempt별 완료 확인. 새 guard 해제 후 실제 저장 덮어쓰기는 별도 검증 필요 |
| 4 | P1, 플래그 ON 제어 재현 | `writeLeaseTransport`는 발급 확인에 로컬 시각+5초, ID 생성에는 원래 시각을 사용. 기기 -2초에서 준비 성공 후 `unleased_` 생성 | 권한 준비/시각 미확인과 서버 기준 만료를 구분. 첫 온라인 발급 대기 경합은 별도 확인 |
| 5 | P1, 플래그 ON 제어 재현 | `quarantineExpiredSyncWork`가 대상의 모든 active 이벤트를 격리해 만료 선행 작업과 유효 후속 작업을 모두 expired로 전환 | 대상 동결과 최신 유효 의도 보존의 원자 경계 정리. 선행 의존성 제거 후 무조건 후속 전송하는 식으로 고치지 않음 |
| 6 | P2, 플래그 ON 제어 재현 | 복구 목록은 이미 expired인 이벤트를 찾고 claim은 pending을 찾음. conflict/blocked 상태로 만료되면 복구 목록에서 빠지고 로컬 유지가 오류 | 시작/복귀/충돌 처리에 공통 분류 적용. 다른 책 정상 작업은 유지 |
| 7 | 운영 설계 위험 | Rules 정책 부재/false는 legacy 허용. 삭제 후 정책 삭제·legacy 재허용·기존 권한 소급 연장은 replay 방어를 무효화할 수 있음 | 실제 Rules release·관리자 정책·최대 권한 기간을 비가역 안전선으로 검증. 정리 OFF만으로 과거 삭제는 되돌릴 수 없음 |
| 8 | 비용·운영 위험 | ID순 500건 검사는 연령순이 아니며 현재 고정 33,053건도 최소 67회의 적격 실행 필요. 40초는 await 사이의 연성 제한, 클라이언트 timeout은 10초 | custom 유지 시 연령 range/oldest-first, 빈 조회·부모 탐색·재시도 비용 계측. TTL 대안부터 결정 |
| 9 | 계측 후보 | `SnapshotListenerRecovery.reconcile`는 마지막 authoritative snapshot 후 15초를 stale로 보아 복귀/auth 시 조용한 정상 listener도 재연결할 수 있음 | 실제 실패와 무변경 구분, 복귀 authoritative 확인 single-flight. 15초마다 무조건 재구독하거나 전액 재과금한다는 뜻은 아님 |
| 10 | 계측 후보 | 송신 leader 전에 주석 삭제·만료 복구가 실행되고 탭별 health·stats 60초 refresh/2초 follower retry·draft 쓰기가 있음 | 기존 metrics로 탭별 IDB 처리량·빈 조회·중복 복구 측정 후 리더 범위/주기 조정 |

8개 제어 검사는 위 1·2·3·4·5·6의 경계를 재현하며 기존 초기 sync fixture가 `offer`를 고르는 것도 확인합니다. 번호 7~10은 동일 수준의 실기기 결함 재현이라고 취급하지 않습니다. 정상 ACK된 outbox 이벤트는 삭제되므로 서버 receipt 3만 개가 로컬 pending 3만 개라는 추론도 하지 않습니다.

## 정리 방식과 기간 권고 — 미채택

- 서버가 이벤트의 원 권한을 더 이상 받지 않는 시각 이후에만 receipt를 지웁니다. 원 권한 자동 갱신과 소급 연장은 막아야 합니다.
- H=180일을 우선 유지하고 보존 기간은 `H + 운영 여유 G`로 설명하는 안입니다. 187일(G=7일)은 선택 가능한 예이며 최적값으로 입증되지 않았습니다. 현재 210일을 변경한 것은 아닙니다.
- 기준은 변경 시각이 아니라 **권한 발급 시각**입니다. 170일 된 권한으로 오늘 만든 offline 변경은 약 10일 뒤 자동 전송 권한이 끝날 수 있습니다.
- 기기 마지막 활동/기기당 최근 N개는 단독 기준으로 부적합합니다. sequence/watermark·대상별 세대·영구 archive는 현재 규모에서 복잡도가 커 우선 도입하지 않습니다.
- 부분 rollout에서는 정리를 보류하거나 정책 재검증 배치를 유지하고, collection group 전체의 legacy 장벽을 검증한 뒤 **기존 timestamp + expiration offset TTL**로 정상 운영을 단순화하는 권고입니다. 계정별 정책을 TTL이 매번 확인해주지 않으므로 지금 전역 TTL을 켜면 안 됩니다.
- TTL offset 지원은 수신 후 [공식 문서](https://firebase.google.com/docs/firestore/ttl)를 직접 확인했습니다. 기존 `createdAtServer`에 기간을 더하는 구성이 가능합니다. 삭제는 비동기·과금 대상입니다. 실제 프로젝트 설정/정책은 변경하지 않았습니다.
- 실제 legacy 영구 차단과 각 receipt의 안전 연령이 보장되면 T 이후 추가 210일 대기는 별도 replay 필요조건보다는 운영 관측 여유라는 지적입니다. 현재 이행 계약을 자동 완화하지 않았으며 차단 검증이 먼저입니다.

## 기존 실패와 다음 작업의 순서

`tests/asyncUiLifecycles.test.cjs:118`은 초기 sync 입력으로 modal timer 1개를 기대하지만 정책은 `offer`를 반환합니다. assertion을 0으로 바꿔 통과시키기보다 초기 offer 유지와 초기 단계 이후 실제 modal timer 재예약을 분리해 기존 의도를 검증해야 합니다. 현재 결과는 431/432로 유지합니다.

1. 화면별 인과 기준과 비동등 위치 자동 승자/권한 갱신부터 수정합니다.
2. 수락·무시·이동 실패 guard를 같은 target/attempt 계약으로 연결합니다. guard를 시간만으로 해제하지 않습니다.
3. 서버 기준 권한 분류→대상 동결→최신 의도 보존→canonical 복구를 정리합니다.
4. 정리 정책과 rollout 범위를 결정한 뒤 API/cursor를 확대할지 TTL로 대체할지 선택합니다.
5. 기존 계측으로 재구독·stats·다중 탭 복구를 확인하고 실제 Samsung Internet/Android·iPad PWA 수용을 수행합니다.

새 ready queue 저장소·전역 watermark·영구 journal이나 모든 종류의 listener 통합은 보류합니다. 회귀·운영·실기기 완료 전 플래그 활성화나 배포로 완료 판정하지 않습니다.

## 후속 로컬 개발과 최종 내부 리뷰

사용자 요청에 따라 배포 없이 후속 개발을 진행했습니다. 위 PRO 표는 리뷰 당시의 발견이며 이 절은 그 뒤 변경입니다. 유한 권한·정리 플래그는 기본 OFF, 운영 Rules/정책/인덱스/TTL과 데이터는 변경하지 않았습니다.

- 화면별 채택 revision과 viewport ID로 저장 인과 기준을 고정합니다. 공유 IDB의 새 canonical 행이나 다른 reader가 만든 대기 이벤트로 과거 화면의 기준을 높이지 않습니다. 같은 화면의 ACK를 증명하는 event ID만 기준을 이어갑니다. 실제 reader hook+공유 IDB 테스트로 두 화면 경계를 검증합니다.
- 서로 다른 위치의 높은 percent·시각을 자동 승자로 삼지 않습니다. 동등 위치만 조용히 처리하고 실제 결정이 필요한 비활성 도서도 명시적 충돌로 남깁니다. 로컬 유지 대체 이벤트는 원 권한으로 만듭니다.
- R2 무시/이동의 늦은 완료가 R3 창이나 guard를 해제하지 않게 대상과 attempt를 확인합니다. 서버 채택 후 이동 실패에도 같은 revision 재시도와 명시적 현재 위치 유지가 남습니다.
- 서버 확인 발급 시각+단조 시계로 만료를 판단합니다. 권한 준비 중은 실제 만료와 구별하고 현재 실행의 미제출 placeholder만 한 번 연결합니다. 복원·시도된 과거 ID에 새 권한을 붙이지 않습니다.
- 만료 선행 작업을 격리한 뒤 유효 후속 작업은 최신 canonical 상태와 비교할 명시적 충돌로 보존합니다. 서버 head가 없을 때도 후속 의도를 버리거나 자동 제출하지 않습니다. conflict·blocked·deferred의 만료와 수신 중 취소된 책 전체 삭제 intent도 처리합니다.
- 정리는 연령 range+오래된 순서와 timestamp/ID 커서로 조회합니다. 180/210일 및 보수적 전환 대기는 유지합니다. client 네트워크 실패 뒤 재요청을 막던 marker도 해제합니다. TTL은 전역 barrier 검증 뒤의 대안이며 활성화하지 않았습니다.
- 조용한 정상 listener를 마지막 snapshot의 나이만으로 실패 처리하지 않습니다. 통계·다중 탭의 광범위 최적화는 실제 계측 후 판단할 항목으로 남깁니다.

Astra 최종 1차 검토에서 추가로 발견한 **P1: R2 이동 실패 뒤 R3 무시의 잔류 guard**, **P2: legacy 주석 삭제 intent의 복구 누락**을 모두 수정했습니다. 각각 실제 hook/IDB 회귀를 추가했고 같은 Astra의 재검토에서 두 건 해결 및 **요청 범위의 남은 correctness blocker 미발견** 판정을 받았습니다. 이는 실제 기기 수용이나 운영 활성화 승인을 대신하지 않습니다.

| 최종 검증 | 결과 |
| --- | --- |
| 저장·동기화 전체 `npm run test:storage` | 455/455 통과 |
| Rules와 metadata emulator `npm run test:rules` | 40/40 및 3/3 통과 |
| 다른 Node 그룹 | formats 83, Drive 58, archives 39 및 shelf/UI·게시기·SW·release 통과. storage와 함께 `test:node` 구성 전체를 분할 검증 |
| `npm run build` | 최종 소스 production build·TypeScript 통과 |
| ESLint | error 0, 기존 warning 4. 동결 리뷰 증거 `.superloopy/**`만 제외 |
| Chromium/WebKit 집중 검사 | 52개 중 50개 통과, 독립 Foliate trailing sentinel 검사 2개 실패 |

마지막 브라우저 실패는 outgoing Range 생성 0 기대가 Chromium 17/WebKit 26인 경로입니다. 해당 독립 fixture·renderer·공통 browser fixture가 HEAD와 바이트 단위로 같고 이번 동기화 코드를 불러오지 않음을 확인했습니다. 실제 다음 장 이동은 통과했으며 성능 assertion을 완화하거나 관련 없는 제품 코드를 변경하지 않았습니다. 전체 browser gate 통과로 보고하지 않습니다. 초기 `asyncUiLifecycles` 실패는 초기 offer와 이후 modal timer의 계약을 분리한 회귀로 해결됐습니다.

비공개 최종 diff·소스 해시·검증 로그는 `.superloopy/evidence/reviews/sync-pro-followup-20261118/`에 보존했습니다. 기존 개인 첨부/산출물은 유지했고 커밋·푸시·배포·운영 DB 쓰기는 하지 않았습니다. 실제 PWA·다중 기기 수용과 운영 전환은 [TODO](../TODO.md)에 남습니다.
