# Web Reader 1.8.36 — 전체 리뷰 경합·업데이트 수정

작성일: 2026-09-05

상태: 완료 · 자동검증 통과 · production Rules 배포 완료

기준: 1.8.35 최종 소스 `36bdc4c`. 외부 리뷰 문서의 주장은 현재 코드·통제 재현과 대조해 채택했다.

| 항목 | 판정과 수정 |
|---|---|
| R01 | 타당. 단일·batch enqueue 모두 미전송 마지막 set만 병합하며 reset·다른 세션·claim/재시도 경계를 보존한다. |
| R02 | 타당. Drive 로드 상태를 인증 사용자와 연결 세대로 관리하고 인증 변경·취소 후 재시도를 허용한다. |
| R03 | 타당. ACK 이벤트 제거와 원격 head 갱신을 분리한다. 캐시·로컬 revision은 내려가지 않으며 동일 revision의 이벤트 불일치는 거부한다. |
| R04 | 타당. 삭제 await 뒤와 React updater 안에서 owner·쓰기 세대를 확인한다. |
| R05 | 타당. 원격 위치 알림을 실제 표시하는 타이머에서 처리 완료 identity를 기록해 취소된 알림을 재예약한다. |
| R06 | 타당. draft 작성자 UUID와 브라우저 Web Lock으로 생존을 확인하고 별도 복구 lock을 얻은 실행 컨텍스트만 고아 draft를 확정한다. |
| R07 | 타당. 선택적 completionRoundNumber로 동일 도서·회차의 완료를 합친다. 새 완료 마커는 시간 구간에서 제외하고 실제 재독·기존 기록을 보존한다. |
| R08 | 타당. Drive 전체 파일 다운로드는 헤더부터 arrayBuffer/blob 소비 완료까지 호출자 취소·기한을 유지한다. |
| R09 | 타당. 검색 세대와 AbortSignal을 모달·훅·Foliate 반복자·지연 highlight에 적용한다. |
| R10 | 타당. 소스·정적 자산·의존성·공개 설정 해시를 SW import와 캐시·Foliate URL에 반영한다. 표시 버전이 같아도 업데이트를 감지하며 새 HTML의 초기 자산을 설치 전에 준비한다. 업데이트 승인 전에는 설치된 HTML을 유지하고 캐시 삭제는 SW activate만 수행한다. |
| R11 | 타당. 원격 팔레트 수용의 outbox·충돌·revision 검사와 저장을 같은 IndexedDB 트랜잭션에서 처리한다. |

## 검증 파이프라인과 네트워크 보강

- V01: 시스템 기본 음성에서는 발화 voice=null이라는 현재 계약으로 브라우저 검증을 수정했다. 명시적 선택 계약은 별도로 검증한다.
- V02: E2E에서 pageerror/console.error를 수집하고 예기치 않은 오류를 실패로 처리한다. standalone Foliate 테스트가 React hydration 도중 본문을 지우던 fixture는 같은 출처의 정적 테스트 문서로 교체하고, TouchEvent에 필요한 touch 목록을 제공한다. 의도적인 sandbox 차단·존재하지 않는 API 404는 해당 테스트의 좁은 예외로만 허용한다. 엄격한 앱 E2E에서 body 인라인 스타일의 hydration 불일치도 확인해 bootstrap의 중복 body mutation을 제거했다. 기존 루트 변수·초기 CSS는 유지한다. 공개 카탈로그 unavailable 및 WebKit의 해당 Listen 경로 접근 실패는 외부 서비스를 검증하지 않는 guest UI 테스트에서만 알려진 예외다.
- 표지/크롤러 리다이렉트는 각 목적지를 요청 전에 검사한다. 응답 크기는 stream 읽기 도중 제한하고 버리는 응답은 취소한다.
- NovelPia 선택적 인증 준비·본문 소비에도 크롤러 AbortSignal을 전달하며 인증 리다이렉트는 거부한다. 실제 자격 증명을 읽거나 인증 요청을 보내지는 않았다.

## 호환성과 실사용 확인 범위

- 기존 완료 기록은 계속 읽으며 새 필드는 선택적이다. 새 완료 쓰기 호환을 위한 additive Firestore Rules를 2026-09-05 production 프로젝트 `web-novel-viewer`에 컴파일·배포 완료했다. 기존 필드는 그대로 허용한다.
- legacy active draft 및 Web Locks 미지원 환경에서는 작성자 종료를 입증할 수 없어 journal을 보존한다. closed draft는 기존처럼 복구한다.
- 실제 두 기기 Firestore 동기화, 계정 OAuth 복귀, Android/iPad PWA 및 기본 TTS 음성은 로컬 자동검증과 별도다. 테스트를 운영 계정/기기 검증으로 간주하지 않는다.

## 검증 결과

- `npm run test:rules`: 33 + 보조 3 = 36개 통과, 생략 없음.
- `npx firebase deploy --only firestore:rules --project web-novel-viewer --non-interactive`: exit 0, compiled successfully 및 released to cloud.firestore 확인.
- Node `v22.18.0`에서 `npm run check` 통과: lint 오류 0/기존 경고 4, TypeScript, Node 712개, Python 3개, production build.
- 최종 body hydration 수정 뒤 lint·typecheck·production build 통과.
- `npm run test:e2e`: 38개 통과, 기존 WebKit input-backed File Blob 제약의 PDF/CBZ 표지 테스트 2개 생략. 두 엔진에서 같은 표시 버전의 SW import 업데이트·승인 전 기존 HTML 유지·승인 뒤 오프라인 새 HTML/자산 로드를 검증했다.
- production browser에서 시스템 기본/명시적 음성 검증을 분리했다. 이전 실패 이후 도달하지 못했던 TTS 대량 선택 구간은 리더 설정창을 닫지 못하던 기존 fixture 선택자를 수정하고 닫힘 assertion을 추가했다. 180문장·55문장 연속 처리 기대값은 유지한다. 후반부의 공용 헤더 닫기 이름·40px 크기·기존 반투명 메뉴 재질 기대값도 현재 계약에 맞췄으며 앱 UI 크기나 재질을 바꾸지 않았다. `npm run test:browser:ci` 최종 exit 0으로 TTS·주석·통계 완료/삭제·fixed-layout·PDF·PWA 검사까지 통과했다.

- `check:full` 구성 검사 모두 통과. 수정하지 않은 입력의 Node/Python·Rules 성공 증거는 재사용했고, 후속 body bootstrap 수정은 lint·typecheck·E2E·production build·전체 browser regression을 재실행했다.
