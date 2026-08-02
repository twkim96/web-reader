# Web Reader 1.8.2 메모·팔레트·주석 관리 UI

상위 계획: [1.8.x 전체 개발 계획](./update_1.8.x_plan.md)

시작일: 2026-08-01

기준 커밋: `cd0e4aa` (`docs: organize version update records`)

상태: 1차 실기기 UI 피드백 반영 — 기능 검증 대기

## 목표

1.8.1의 로컬 범위 하이라이트에 메모와 색상별 의미를 추가하고, 현재 책의 주석을 최대 100개까지 찾고 정리할 수 있는 관리 화면을 제공한다. 기존 책갈피·진행률·동기화 계약과 Foliate 범위 anchor는 변경하지 않는다.

## 시작 조건과 범위 판단

- 사용자가 2026-08-01에 1.8.2 시작을 승인했다.
- 1.8.1 및 두 안정화 패치는 자동검증·commit·push가 완료됐고 실제 Android/iPad/PWA 검증은 별도 대기 상태다.
- 이전 실기기 대기 상태를 완료로 바꾸지 않고, 1.8.2 결과와 분리해 기록한다.
- 이번 버전은 로컬 주석 UI만 다루며 1.8.3의 Firestore 동기화 작업을 앞당기지 않는다.

## 포함

- 하이라이트 메모 작성·편집·삭제
- 계정별 로컬 5색 팔레트 표시명·의미 설정
- 기존 하이라이트에 즉시 반영되는 팔레트 그룹 라벨
- 색상별 접기·펼치기와 `현재 개수/20` 표시
- 현재 책의 원문·메모·장·팔레트 검색
- 독서 순서·최근 생성순·최근 수정순 정렬
- 메모 있는 항목만 보기
- 목록 항목 범위 이동과 이동 직후 임시 강조
- 복수 선택 일괄 색상 변경·삭제와 실행 취소
- 책갈피 모달 상단의 `책갈피 / 주석` 전환 탭

## 제외

- annotation·palette Firestore 동기화
- 라이브러리 전체 주석 검색
- Markdown/JSON 내보내기
- 번역·사전·TTS
- 기존 `UserProgress`, manual bookmark, auto bookmark schema 변경
- IndexedDB 버전 증가 또는 annotation store migration

## 구현 계약

### 팔레트

- 안정적인 `HighlightColorId` 다섯 개는 바꾸지 않는다.
- 표시명은 24자, 의미는 80자로 제한한다.
- 저장 key는 `OwnerKey`로 분리해 같은 브라우저의 다른 Firebase/guest owner 사이에 설정이 섞이지 않게 한다.
- 잘못되거나 일부만 존재하는 저장값은 다섯 색 기본값으로 안전하게 보정한다.
- 팔레트는 이번 버전에서 `localStorage`에만 저장하고 원격 동기화는 1.8.3으로 남긴다.

### 메모와 일괄 변경

- 메모는 기존 annotation의 `note` 필드를 사용하며 최대 4,000자를 유지한다.
- 메모 갱신은 현재 DB record에서 note만 바꿔 동시 anchor 상태 보정을 덮어쓰지 않는다.
- 일괄 색상 변경은 하나의 IndexedDB transaction에서 목적 색상 20개 제한을 먼저 검사한다.
- 일괄 삭제는 현재 owner·book·선택 ID만 한 transaction에서 삭제한다.
- 단일 색상·범위·메모 갱신은 IndexedDB의 최신 record에서 대상 필드만 바꿔 다른 탭의 최신 필드를 보존한다.
- 단일·일괄 mutation은 기존 6초 실행 취소 UI를 공유하며, inverse 전체를 한 transaction에서 검증한 뒤 반영한다.
- undo 시 현재 대상 필드 값이 해당 mutation 결과와 다르거나 20/100개 제한을 넘으면 일부 복구하지 않고 전체를 거부한다.
- 생성 undo는 생성 직후 다른 탭에서 수정된 record를 삭제하지 않는다.
- 생성 직후 renderer가 자동 보정한 `sectionIndex`·`anchorState`는 사용자 변경으로 보지 않아 undo를 막지 않는다.

### 관리 UI

- 책갈피와 하이라이트의 데이터·목록·용어는 분리하되 하나의 모달 안에서 탭으로 전환한다.
- 리더 툴바에는 별도 주석 버튼을 두지 않고 책갈피 버튼을 통합 진입점으로 사용한다.
- 다섯 색상 그룹은 처음에 모두 접힌 상태로 열어 한 화면에 전체 분류를 우선 보여준다.
- 목록의 바깥 여백과 본문 줄 수를 줄이되 체크박스·편집·닫기 같은 터치 대상은 최소 40px 수준을 유지한다.
- 검색·정렬·메모 필터는 메모 입력이나 원본 annotation을 변경하지 않는 파생 상태다.
- 검색 중에도 색상 그룹과 전체 개수를 유지해 현재 필터 결과와 저장 개수를 구분한다.
- unresolved 항목은 잘못된 위치로 이동시키지 않고 `위치 확인 필요` 상태를 표시한다.
- 메모 편집기는 리더 panel history에 포함하며, 브라우저·Android Back은 메모를 먼저 닫고 주석 목록을 유지한다.
- mutation 진행 중에는 목록의 선택·이동·메모 편집·일괄 작업을 잠그고 저장 실패 시 편집기를 유지한다.

## 구현 단계

### Phase 1 — 팔레트와 조회 정책

상태: 구현·단위검증 완료

- 팔레트 기본값·검증·owner별 localStorage 저장
- 원문·메모·장·팔레트 라벨/의미 검색
- 세 정렬 정책과 note-only 필터
- 안정적인 다섯 색 그룹 순서

### Phase 2 — 로컬 mutation 확장

상태: 구현·단위검증 완료

- note-only 원자 갱신
- 복수 annotation 색상 변경·삭제
- 색상 제한 위반 시 전체 작업 거부
- owner/book 격리와 batch 실행 취소 기반

### Phase 3 — 리더 UI 연결

상태: 구현·production 브라우저 회귀검증 완료

- 책갈피 모달 상단의 `책갈피 / 주석` 탭과 주석 개수 badge
- 색상별 접이식 목록, 검색·정렬·메모 필터
- 항목별 메모 편집기와 하이라이트 클릭 메뉴의 메모 진입
- 선택 항목 일괄 색상 변경·2단계 삭제 확인
- 팔레트 의미 설정과 목록·선택 메뉴 label 반영
- 범위 이동 후 임시 overlay 강조

### Phase 4 — 릴리스 검증과 리뷰

상태: 코드 리뷰 finding 수정·재검증 완료, 실기기 검증 대기

- lint·typecheck·Node·production build
- Firestore Rules와 기존 sync 회귀
- Chromium/WebKit Playwright
- production Chrome regression
- Web GPT 리뷰 finding 수용 여부 판단과 수정
- 사용자 실기기 검증 뒤 완료 판정

## 자동검증 계획

- 팔레트: 다섯 색 보정, 길이 제한, owner 격리, 손상 JSON fallback
- 조회: 한글·영문 검색, 팔레트 의미 검색, 세 정렬, note-only, 빈 그룹
- mutation: note 보존, batch owner 격리, 20개 제한 원자 거부, batch 삭제
- mutation concurrency: 다른 탭의 note 보존, 대상 필드 value-CAS, 생성 undo 보호, batch inverse 전체 거부
- UI: 통합 진입점과 탭 전환, 기본 접힘, 메모 저장, Back 계층, 검색, 정렬, 일괄 작업, 범위 이동
- 전체 `npm run check:full`
- `git diff --check`

## 완료 조건

- 기존 책갈피와 주석의 용어·데이터는 분리되고 같은 모달 안에서 탭으로 전환된다.
- 팔레트 표시명을 바꾸면 기존 annotation의 그룹과 색상 선택 label이 함께 바뀐다.
- 총 100개 fixture에서 접기·검색·정렬·복수 선택이 기능적으로 동작한다.
- 메모 저장과 일괄 변경이 owner/book 경계를 넘지 않는다.
- 위치 이동 뒤 대상 범위가 임시 강조되고 진행률·자동 책갈피 정책은 기존 경로를 사용한다.
- 제품 코드 중요 finding이 없고 전체 자동 gate가 통과한다.
- 실제 Android/iPad/PWA 검증 결과를 자동화 결과와 별도로 기록한다.

## 실기기 테스트 계획

- Android Chrome 브라우저·PWA, iPad Safari 탭·홈 화면 PWA
- 색상당 20개, 총 100개 fixture의 목록 스크롤·접기·검색·정렬
- 긴 한글·영문·일문 메모와 소프트 키보드
- 다크·라이트·세피아·블루 테마와 화면 회전
- 목록 항목 이동 후 정확한 범위와 임시 강조
- 일괄 색상 변경 20개 제한과 일괄 삭제 실행 취소
- 기존 manual/auto bookmark 추가·이동·삭제 회귀

## 1차 실기기 UI 피드백 반영

2026-08-02 실제 모바일 화면에서 주석 관리 모달이 화면을 과도하게 차지하고, 별도 툴바 버튼과 펼쳐진 빈 색상 그룹이 공간을 낭비하는 문제가 확인됐다.

- 별도 `주석` 툴바 버튼을 제거하고 기존 책갈피 버튼을 통합 진입점으로 변경했다.
- 모달 상단에 `책갈피 / 주석` 탭을 두고 열릴 때는 기존 책갈피 화면을 기본으로 유지한다.
- 기존 주석 모달의 최대 폭·높이를 줄이고 검색·필터·그룹·항목의 세로 여백을 압축했다.
- 다섯 색상 그룹은 모두 접힌 상태로 시작하고 사용자가 선택한 그룹만 펼친다.
- 주석 원문과 메모 미리보기는 각각 최대 두 줄로 줄였다.
- 조밀한 배치에서도 닫기·체크박스·메모 편집 등 핵심 터치 영역은 40px 아래로 축소하지 않았다.
- 이번 결과는 UI 문제 발견과 코드 반영 기록이며, Android/iPad/PWA의 탭 전환·메모 편집·Back·화면 회전 기능 판정은 아직 남아 있다.

## 2차 실기기 UI 피드백 반영

통합 후에도 책갈피·주석 모달이 설정·테마 모달보다 넓고 내부 컨트롤이 크게 보인다는 실기기 피드백을 반영했다.

- 모달 최대 폭을 `576px`에서 설정 모달과 같은 `340px`로 줄였다.
- 모달 최대 높이를 `672px`에서 설정 모달과 같은 `544px`로 줄였다.
- 검색창·필터·색상 그룹은 각각 36~40px 높이로 압축했다.
- 펼친 책갈피·주석 항목의 패딩, 글자 크기, 메타데이터 간격과 모서리 반경을 줄였다.
- 닫기 버튼은 기존 크기를 유지하고 목록 선택·편집 버튼은 최소 40px를 유지한다.

## 3차 실기기 터치 피드백 반영

하이라이트를 손가락으로 탭했을 때 페이지 이동용 `pointerup`이 먼저 소비되어, 뒤따르는 annotation `click`이 차단되는 실기기 경로를 수정했다.

- 마우스 클릭은 기존 Foliate `show-annotation` 경로를 유지한다.
- 손가락·펜·마우스의 짧고 정지된 `pointerup`이 렌더링된 하이라이트 범위에 있으면 하이라이트 메뉴를 즉시 연다.
- 손가락 오차를 위해 표시 범위 바깥 6px까지 같은 하이라이트 탭으로 인정한다.
- 하이라이트를 연 터치는 페이지 이동과 링크 이동으로 전달하지 않는다.
- 하이라이트 밖의 일반 탭, 빠른 연속 페이지 탭, 긴 누르기와 드래그 텍스트 선택은 기존 경로를 유지한다.
- 이 변경은 렌더링된 Range hit-test와 메뉴 표시만 다루며 annotation 저장·undo·동기화 schema는 변경하지 않는다.

## 자동검증 결과

2026-08-02 1차 리뷰 수정과 실기기 UI 피드백 반영 후 현재 checkout에서 다음을 통과했다.

- `npm run check:full`: 최종 종료 코드 0
- ESLint: 오류 0, 기존 Foliate vendor 경고 2
- TypeScript: 통과
- Node 전체 suite: 통과
  - formats 57/57
  - storage 118/118
  - shelf 32/32
  - service worker policy 9/9
  - release 2/2
- 신규 팔레트·조회 단위 테스트: 6/6
- local annotation 집중 테스트: note·batch·owner 격리·20/100 제한·동시 탭·원자 undo·내부 anchor 보정 포함 18/18
- owner runtime 집중 테스트: 같은 owner key 재로그인 generation과 지연 async 결과 폐기 포함 4/4
- production build: 통과
- Firestore Rules: 9/9
- Playwright Chromium/WebKit 직렬 실행: 12/12
- production Chrome regression: 통과
  - 하이라이트 재실행 복원
  - 책갈피 모달의 주석 탭 진입·재진입과 별도 주석 버튼 제거
  - 다섯 색상 그룹의 기본 접힘과 선택 그룹 펼치기
  - 실제 touch pointer 연쇄와 마우스 click 모두 하이라이트 메뉴 표시
  - 하이라이트 탭이 페이지를 넘기지 않고 기존 긴 누르기 선택·일반 탭 이동을 보존
  - 메모 저장·검색
  - 메모 편집 중 Back이 편집기만 닫고 주석 목록을 유지
  - 신규 overlay 생성 실패로 `unresolved` 자동 보정 후에도 실행 취소가 DB record를 제거
  - 색상 그룹 접기
  - 모달 내부 저장 피드백·실행 취소 노출
  - 기존 리더·고정 레이아웃·PDF·Service Worker 회귀
- `git diff --check`: 통과

## 검증 중 정리한 항목

- release version·Foliate runtime·Service Worker·브라우저 fixture를 모두 `1.8.2`로 맞췄다.
- production regression의 DOM 대기식이 Element를 직접 반환해 CDP 직렬화에 실패하던 부분을 Boolean predicate로 수정했다.
- 반복 실행 프로필에서 동일 메모가 no-op이 되는 정상 동작과 실제 메모 mutation 검증을 구분하도록 고유한 회귀 메모를 사용한다.
- 일괄 작업 피드백이 주석 모달 뒤에 가려지는 자체 리뷰 finding을 수정해 모달 내부에서 실행 취소할 수 있게 했다.
- production Chrome은 최신 `next build` 산출물로 최종 통과를 확인했다.

## 1차 Web GPT 리뷰 수용 결과

2026-08-02 리뷰의 P1 1건, P2 3건, P3 2건은 모두 현재 코드에서 실제 실패 경로가 확인돼 수용했다.

- stale 전체 annotation `put`을 신규 생성에만 남기고, 색상·재선택 범위·메모는 최신 DB record의 대상 필드만 갱신한다.
- undo는 필드 inverse와 삭제 record 복원을 구분하고, 전체 batch의 충돌·중복 범위·20/100개 제한을 한 transaction에서 먼저 검증한다.
- undo는 현재 대상 필드 값이 해당 mutation 결과와 다르면 중단하는 value-CAS 방식이며, 관련 없는 최신 note·anchor·section은 보존한다.
- 필드별 revision은 아직 없으므로 같은 필드가 다른 값으로 갔다가 mutation 결과 값으로 돌아오는 ABA 변경은 감지하지 못한다. 6초 undo 범위의 낮은 확률 P3로 수용하며 1.8.2에서 schema를 확장하지 않는다.
- 신규 생성 undo의 사용자 변경 판정에서는 renderer 내부 보정 필드인 `sectionIndex`·`anchorState`를 제외한다. note·color·range·문맥·진행 위치와 `updatedAtClient` 변경은 계속 충돌로 처리한다.
- mutation 경합 시 메모 저장 성공으로 오인하지 않고 `false`와 사용자 피드백을 반환하며, 관리 UI의 변경 동작을 잠근다.
- progress 충돌 자동 해결은 owner key 문자열이 아니라 `OwnerSnapshot` generation을 transaction 전후로 검사한다. 같은 계정 logout→login 사이의 지연 결과도 폐기한다.
- 메모 편집 상태를 reader chrome history에 편입해 Back이 편집기→목록→리더 순서로 동작한다.
- 연속 위치 이동 강조는 이전 element cleanup을 즉시 실행하고 unmount에서도 inline style과 attribute를 제거한다.

## 남은 판정

- Android Chrome 브라우저·PWA 실기기 검증
- iPad Safari 탭·홈 화면 PWA 실기기 검증
- 색상당 20개·총 100개 실제 목록의 스크롤·소프트 키보드·화면 회전 체감 확인
- 실기기 결과 반영 전에는 릴리스 완료로 기록하지 않는다.
