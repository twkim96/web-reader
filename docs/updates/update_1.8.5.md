# Web Reader 1.8.5 번역·사전 다중 경로

작성일: 2026-08-09

기준 커밋: `d5eaa4b` (`fix(sync): stabilize 1.8.4 review findings`)

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: 외부 코드 리뷰 finding 수정·전체 자동검증 완료, 코드 릴리스 마감 — 실기기 검증은 1.8.10 누적 안정화로 이관

## 목표

선택한 텍스트를 서버 proxy나 앱 내 공용 API key 없이 번역·사전 경로로 전달한다. 지원되는 데스크톱 Chrome에서는 브라우저 Translator API 결과를 앱 안에서 보여주고, 모바일·미지원·실패 환경에서는 사용자가 명시적으로 실행하는 외부 제공자 페이지를 연다.

## 포함

- Translator API feature detection과 언어 pair availability 확인
- 자동·브라우저 내장·Google Translate·Papago 번역 경로
- Naver Dictionary·Wiktionary 사전 경로
- 한국어·영어·일본어 원문 설정과 자동 추정
- 한국어·영어·일본어 번역 대상 설정
- 번역 결과 원문·결과 표시, 결과 복사
- 번역 결과를 기존 또는 신규 하이라이트 메모에 저장
- popup 차단·offline·내장 모델 미지원·download/error 상태 표시
- 외부 제공자 왕복 뒤 reader 위치 보존

## 데이터·개인정보 정책

- 앱은 선택 텍스트를 자동 전송하지 않는다.
- 브라우저 내장 번역은 사용자가 `번역`을 누른 뒤에만 Translator session을 생성한다.
- 외부 번역·사전은 사용자가 해당 action 또는 fallback 버튼을 누른 순간에만 URL query에 원문을 넣는다.
- 외부 번역 결과는 앱이 읽거나 저장하지 않는다.
- 앱 안에서 얻은 번역 결과를 메모로 저장할 때만 기존 annotation IndexedDB·outbox·Firestore 계약을 사용한다.
- provider 사용 이력과 선택 원문은 별도 analytics나 localStorage에 저장하지 않는다.

## 제공자 정책

| 종류 | 경로 | 동작 |
| --- | --- | --- |
| 번역 자동 | Translator API 감지 시 내장, 아니면 Google Translate | 미지원 상태를 성공 가능한 것으로 표시하지 않음 |
| 번역 내장 | top-level `Translator` API | availability·model download·runtime 오류 표시 |
| 번역 외부 | Google Translate, Papago | 직접 클릭에서 새 탭을 동기적으로 열어 popup 차단 판정 |
| 사전 | Naver Dictionary, Wiktionary | 추정·설정 원문 언어에 맞는 검색 UI 사용 |

Chrome 공식 문서상 Translator API는 Chrome 138 stable부터 제공되지만 데스크톱 전용이며 모바일에서는 동작하지 않는다. 따라서 iPad Safari/PWA와 Android는 외부 경로가 정상 기본 동작이다.

## 제한

- 선택 번역은 공백 포함 5,000자까지 허용한다.
- 사전 검색은 단어·짧은 구절 200자까지 허용한다.
- 자동 언어 판정이 불확실하면 설정한 원문 언어를 요구하거나 외부 자동 감지 경로를 사용한다.
- source와 target이 같으면 내장 번역을 실행하지 않고 설정 변경을 안내한다.
- 메모는 기존 최대 길이를 넘기지 않으며 초과 시 원문 메모를 덮어쓰지 않는다.

## 구현 단계

1. provider·URL·언어 추정·길이·메모 결합 pure policy
2. Translator API adapter와 취소·download progress
3. ViewerSettings migration과 설정 UI
4. 선택 메뉴 번역·사전 action
5. 번역 결과 dialog와 복사·외부 fallback
6. 하이라이트 생성·기존 annotation 메모 저장 연결
7. Node·production browser·전체 release gate
8. 외부 코드 리뷰 대기 전환

## 완료 조건

- 미지원 브라우저에서 내장 번역을 성공 가능한 action으로 표시하지 않는다.
- 외부 새 탭은 클릭 event 안에서 열며 차단 결과를 사용자에게 알린다.
- 내장 translation 실패가 selection·reader 위치·annotation을 변경하지 않는다.
- 결과 메모 저장은 기존 하이라이트 제한·중복·동기화·owner 격리를 우회하지 않는다.
- 책 전환·reader 종료 시 translator와 비동기 continuation을 취소·폐기한다.
- provider가 열리지 않거나 offline이어도 reader 위치와 기존 선택 데이터가 손상되지 않는다.

## 자동검증 계획

- provider URL encoding과 언어·길이 policy
- Translator API available·downloadable·unavailable·runtime failure
- popup success·blocked 경계
- 기존 ViewerSettings migration
- 번역 결과 복사와 신규·기존 하이라이트 메모 저장
- reader selection 메뉴의 44px action target과 위치 유지
- `npm run check:full`
- `git diff --check`

## 구현 결과

- ViewerSettings에 번역 제공자·원문 언어·대상 언어·사전 제공자 설정과 기존 저장값 migration을 추가했다.
- 자동 경로는 Translator API가 노출되고 원문 언어를 판정할 수 있을 때만 브라우저 내장을 사용하며, 그 외 환경은 Google Translate를 사용한다.
- 브라우저 내장 번역은 availability·모델 다운로드·취소·session destroy를 분리하고 책 전환이나 dialog 종료 뒤의 오래된 비동기 결과를 폐기한다.
- Google Translate·Papago·Naver Dictionary·Wiktionary는 사용자 클릭 event 안에서만 새 탭을 열고 popup 차단·offline 상태를 사용자에게 알린다.
- 선택 메뉴에 44px 번역·사전 action을 추가하고 번역 dialog에서 원문·결과·download/error 상태·복사·외부 fallback을 제공한다.
- 번역 결과의 메모 저장은 기존 하이라이트가 있으면 색상을 보존하고 메모만 합치며, 없으면 하이라이트 생성과 메모 기록을 하나의 annotation transaction으로 처리한다.
- 브라우저 뒤로가기는 번역 dialog만 먼저 닫고 reader를 유지하며, 번역·사전 사용 전후의 읽기 위치는 저장 기준을 바꾸지 않는다.
- 앱·Service Worker·Foliate runtime release 표기를 1.8.5로 맞췄다.

## 자동검증 결과

2026-08-09 외부 리뷰 후속 수정 기준 `npm run check:full`과 `git diff --check`가 통과했다.

| 검증 | 결과 |
| --- | ---: |
| ESLint | 오류 0, 기존 Foliate vendor 경고 2 |
| TypeScript | 통과 |
| formats | 58/58 |
| drive | 49/49 |
| archives | 33/33 |
| storage | 189/189 |
| shelf·설정·번역 policy | 46/46 |
| Service Worker | 9/9 |
| release version | 2/2 |
| Firestore Rules | 22/22 |
| Chromium·WebKit Playwright | 12/12 |
| production build | 통과 |
| production Chrome regression | 통과 |
| `git diff --check` | 통과 |

production Chrome regression에서 번역 action 노출, dialog 뒤로가기, 내장 번역 결과, 결과 복사, 하이라이트 메모 저장, Naver Dictionary URL, reader 위치 보존과 320px offline 선택 메뉴 배치를 함께 확인했다.

## 외부 코드 리뷰 1차 후속 수정

리뷰의 P1 3건, P2 6건과 P3 접근성 1건을 현재 코드에서 재현 가능한 문제로 판단해 수용했다.

- 번역 메모 추가는 IndexedDB transaction 안에서 최신 canonical annotation을 읽은 뒤 note updater를 실행한다. 다른 탭의 최신 note·color를 보존하고 annotation과 outbox를 함께 commit한다.
- 초기 원격 reset도 `isQuietResumeEligible`을 통과해야만 조용히 적용한다. 사용자가 먼저 이동했거나 pending save가 있으면 prompt로 전환한다.
- 서재 진행률 병합은 `ignoredRemoteRevision` 이하의 원격 head를 표시하지 않고, 더 높은 revision이 도착했을 때만 원격 진행률을 다시 후보로 사용한다.
- conflict 표시용 조회와 passive prompt 억제용 unresolved 조회를 분리해, `나중에 결정` 기간에는 같은 remote head의 reader prompt도 억제한다.
- progress·bookmark·annotation·palette 충돌 해결 실패를 dialog 안에 표시하고 conflict와 선택 버튼을 유지해 재시도할 수 있게 했다.
- 단건 원격 annotation head의 parse·identity 오류는 `invalid-argument` schema 오류로 분류하며, Firestore network 오류는 기존 transient 경로를 유지한다.
- 원문과 대상 언어가 같으면 내장·Google·Papago route 선택 전에 중단해 선택 원문을 외부 제공자에 보내지 않는다.
- 4,001~5,000자 선택은 번역만 허용하고 annotation quote 한계를 설명하며 메모 저장 버튼을 비활성화한다. 번역 block 자체가 note 한계를 넘는 경우도 동일하다.
- 선택 메뉴 action은 좁은 화면에서 여러 줄로 배치하고 긴 feedback을 독립 행에서 줄바꿈한다.
- 번역 dialog에 modal role·제목 연결·초기 focus·Tab 순환·Escape 닫기·reader focus 복원을 추가했다.

## 리뷰·실사용 정책

- 구현과 전체 자동검증 뒤 외부 코드 리뷰를 먼저 완료한다.
- 1.8.5 단독 실기기 완료를 release 조건으로 잡지 않는다.
- 1.8.0~1.8.9의 구현·코드 리뷰가 끝나면 1.8.10 누적 안정화 버전을 열고 실제 PC·iPad·PWA 독서에서 결함을 수집·수정한다.

## 제외

- 서버 번역 proxy
- 공용 번역 API key 저장
- 책 전체 자동 번역
- 외부 provider DOM scraping
- 번역 결과 자동 저장
- 단어장 저장과 복습 스케줄링 — 1.8.8 범위
