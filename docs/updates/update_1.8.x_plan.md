# Web Reader 1.8.x 전체 개발 계획

작성일: 2026-07-27

기준 버전: `1.7.10`

기준 커밋: `0101604`

전체 상태: 1.8.13 동기화 invariant 안정화 뒤 1.8.14에서 compact 공개 catalog와 통합 책장 필터를 구현했다. 1.8.15 요청형 metadata crawler, Firebase on-demand/delta, shared 요청 UI와 optional NovelPia 인증 provider는 full gate, 최소권한 Admin secret, Rules/index, production ready/not-found·delta/cache 및 후속 shelf/reader 보정까지 코드 릴리스를 마쳤다. 1.8.16은 Muzio mini-player형 floating dock을 시작으로 책장·모달·리더 UI 밀도와 반응형 배치를 정리했고, 1.8.17은 Android foreground 직후 원격 진행률 이동의 false-success와 reflow 경합을 막았다. 1.8.18은 actual revision conflict까지 preview→stable navigation→CAS finalize로 통일하고 user-intent abort·rollback·target pagination invariant를 닫았고, 1.8.19는 iPad에서 큰 TXT→EPUB section의 챕터 경계 탭 이동이 blank sentinel range scan 때문에 지연되는 경로를 제거했다. 1.8.20은 남은 iPad cold-open 지연을 단계별로 계측하고 cloud first-open의 pre-view paginator 역참조를 방어했으며, 1.8.21은 RIDIBatang stabilization을 font load/frame/expand/Range geometry 단계로 분해해 실기기에서 9.851초가 hidden iframe frame wait에 집중됨을 확인했다. 1.8.22는 staging pagination의 frame wait를 visible host renderer로 이동해 iPad WebKit의 hidden-subframe rAF throttle을 제거했고, 1.8.23은 리더 진행바의 native range pointer 동작을 좌표 기반 pointer layer로 통일해 iPad의 2회 탭 및 thumb-only drag 차이를 제거했으며, 1.8.24는 책장 전용이던 글래스/모던 메뉴 스타일을 리더 상·하단 chrome에도 공유했고, 1.8.25는 글래스 투명도를 실기기 비교용으로 높였다. 1.8.26은 1.8.23 진행바 pointer 변경 뒤 Android 짧은 탭에서 확인 모달이 즉시 닫히는 ghost click 경로를 차단한다.

## 1. 문서의 역할

이 문서는 Web Reader 1.8.x 전체 개발 방향, 버전 간 의존성, 호환성 계약, 공통 검증 기준을 정의하는 마스터 계획이다.

- 실제 구현을 시작할 때마다 `docs/updates/update_1.8.0.md`, `docs/updates/update_1.8.1.md`와 같은 개별 버전 문서를 새로 만든다.
- 개별 버전 문서는 해당 릴리스의 실제 기준 커밋, 수용·보류·제외 항목, 구현 phase, 완료 조건, 자동검증과 실기기 증거를 기록하는 실행 문서다.
- 이 마스터 계획은 전체 순서와 경계를 관리하고, 개별 버전 문서는 실제 구현 범위의 최종 기준이 된다.
- 코드가 작성됐다는 이유만으로 상태를 완료로 바꾸지 않는다. 자동검증·리뷰와 해당 버전의 실기기 검증이 기본 완료 조건이다.
- 사용자가 여러 버전의 실기기 검증을 명시적으로 통합 이관한 경우 코드 릴리스 마감과 실기기 검증 완료를 분리해 기록한다.
- 사용자 실기기 검증 또는 명시적인 검증 이관 요청 전에는 커밋·푸시를 완료 조건으로 간주하지 않는다.

## 2. 개발 목표

1.8.x의 목표는 기존의 안정적인 읽기·복구·기기간 진행률 동기화를 유지하면서 Web Reader를 다음 흐름을 갖는 독서 도구로 확장하는 것이다.

```text
텍스트 선택
  -> 하이라이트와 메모
  -> 기기 간 주석 동기화
  -> 검색과 내보내기
  -> 번역·사전·TTS
  -> 신뢰 가능한 독서 통계
```

개발 원칙은 다음과 같다.

- 한 버전에는 코드 경계와 실기기 실패 원인이 유사한 기능만 묶는다.
- 선택, 로컬 주석, 원격 동기화, 외부 제공자, TTS, 통계를 한 패치에서 동시에 바꾸지 않는다.
- 기존 진행률·책갈피·자동 복구 계약을 새 기능 때문에 재작성하지 않는다.
- 고위험 버전은 실제 독서 안정화 기간을 거친 뒤 다음 기능으로 넘어간다.
- 실기기에서 발견된 결함은 다음 기능과 합치지 않고 안정화 전용 패치로 먼저 처리한다.

## 3. 예정 릴리스 순서

| 예정 버전 | 기능 묶음 | 주 검증 대상 | 위험도 | 상태 |
| --- | --- | --- | --- | --- |
| 1.8.0 | 텍스트 선택 기반·복사·공유 | iPad 선택과 탭 이동 충돌 | 중상 | 개발·리뷰·푸시 완료, 실기기 검증 진행 |
| 1.8.1 | 로컬 범위 하이라이트 엔진 | 저장·복원·기존 책갈피 호환 | 높음 | 개발·3차 리뷰·full gate·push 완료, 실기기 검증 대기 |
| 1.8.1-hotfix.1 | 진행률 충돌 알림 안정화 | revision 보호·안전한 자동 원격 채택 | 중상 | 구현·full gate 완료, 실기기 검증 대기 |
| 1.8.1-hotfix.2 | 동시 읽기 근접 위치 경합 안정화 | 양기기 동시 저장·활성 리더 저장 완료 판정 | 중상 | `1740956` 구현·full gate·push 완료, 실기기 검증 대기 |
| 1.8.2 | 메모·팔레트·주석 관리 UI | 5색·대량 목록·검색·정렬 | 중간 | 개발·리뷰·full gate·push 완료, 실기기 검증은 1.8.3 이후 통합 수행 |
| 1.8.3 | 하이라이트·메모·팔레트 동기화 | PC↔iPad·오프라인·충돌 | 매우 높음 | 개발·2차 재리뷰·full gate 완료, 통합 실기기 검증 대기 |
| 1.8.3-hotfix.1 | 동기화 데이터 안전성 보강 | 로컬 ID·삭제 generation·aggregate 크기·누적 read | 높음 | 누적 hotfix commit `4e9264a` 완료, push·Rules·실기기 검증 대기 |
| 1.8.3-hotfix.2 | 충돌 해결 일관성 보강 | canonical local·일회성 progress command·UI gating·generation barrier | 높음 | 누적 hotfix commit `4e9264a` 완료, push·Rules·실기기 검증 대기 |
| 1.8.4 | 라이브러리 전체 주석 검색·내보내기 | 대량 조회·파일 저장·공유 | 중간 | 코드·전체 자동검증·외부 리뷰 완료, hotfix.1·실기기 검증 대기 |
| 1.8.4-hotfix.1 | 동기화 충돌·대량 주석 안정화 | reset·revision chain·멱등성·hidden modal | 높음 | `d5eaa4b` 코드·전체 자동검증·커밋 완료, 누적 실사용 검증 대기 |
| 1.8.5 | 번역·사전 다중 경로 | 제공자 지원 차이와 fallback | 중간 | 외부 리뷰 finding 수정·full gate 완료, 코드 릴리스 마감·실기기는 1.8.9 이관 |
| 1.8.6 | 선택·현재 위치 기본 TTS | 기기별 음성·재생 제어 | 중간 | 외부 리뷰 finding 수정·full gate 완료, 코드 릴리스 마감·실기기는 1.8.9 이관 |
| 1.8.7 | 현재 장 연속 TTS | 문장 추적·자동 이동·복귀 | 높음 | 1차 외부 리뷰 finding 수정·full gate 완료, 재리뷰 대기·실기기는 1.8.9 이관 |
| 1.8.8 | 독서 통계 | 활성 시간과 기기 중복 정확성 | 높음 | hotfix.3~7 구현·check·Rules·Playwright 완료, production Chrome P3와 실기기는 1.8.9 이관 |
| 1.8.8-hotfix.1 | 리더 이동·충돌 모달 안전성 | navigation commit·reader 차단·외부 링크 opener | 높음 | 구현·full gate 완료, 재리뷰 대기 |
| 1.8.8-hotfix.2 | 통계 복원·집계 안정성 | malformed 격리·exact cursor·canonical date·health 분리 | 높음 | 구현·full gate 완료, 재리뷰 대기 |
| 1.8.8-hotfix.3 | 원격 이동·TTS 통계 경계 | 2단계 progress commit·연속 TTS·fixed activity | 높음 | 구현·check·Rules·Playwright 완료, production Chrome P3 이관 |
| 1.8.8-hotfix.4 | 수동 이동·날짜 집계 | navigation commit·자정 분할·listener 수명·slider modal | 높음 | 구현·check·Rules·Playwright 완료, production Chrome P3 이관 |
| 1.8.8-hotfix.5 | 부트스트랩·진단·통계 방어 | guest fast path·conflict diff·clock read·긴 cursor | 중상 | 구현·check·Rules·Playwright 완료, production Chrome P3 이관 |
| 1.8.8-hotfix.6 | 충돌 확정 동시성 방어 | empty intent·remote head 단조성·4개 target resolver | 높음 | 구현·check·Rules·Playwright 완료, 외부 재리뷰·실기기 대기 |
| 1.8.8-hotfix.7 | 통계·이동 재시도 정확성 | TTS playing 시간·single-flight·frozen bookmark·timestamp quarantine | 높음 | 구현·check·Rules·Playwright 완료, 외부 재리뷰·실기기 대기 |
| 1.8.9 | 실기기 전 선행 안정화·누적 실사용 | multi-tab leader·retention 계측 뒤 PC·iPad·PWA 회귀 | 매우 높음 | 코드·자동검증 개발선 종료, 남은 실사용 검증은 1.8.10 이관 |
| 1.8.9-hotfix.1 | Phase A 경합 후속 안정화 | remote command head·lease transaction·짧은 TTS·gate fixture | 매우 높음 | 리뷰 finding 구현·전체 자동검증 완료, 재리뷰 대기 |
| 1.8.9-hotfix.2 | 원격 command·주석 generation·TTS 계측 안정화 | exact head·obsolete rollback·삭제 부활 방지·actual-playing·진단 export | 매우 높음 | 리뷰 finding 구현·전체 자동검증 완료, 재리뷰 대기 |
| 1.8.9-hotfix.3 | 삭제 generation·command 취소·TTS 시간축 정합성 | 공통 hydration fence·IDB transaction abort·wall-clock active interval | 매우 높음 | P1 3건 구현·전체 자동검증 완료, 재리뷰 대기 |
| 1.8.9-hotfix.4 | live generation·TTS 위치·crash journal | marker-only reconcile·progress fence·active-gap recovery | 매우 높음 | 기존 finding 수정 확인·production Chrome 3회 연속 완주, 신규 P2는 hotfix.5 후속 |
| 1.8.9-hotfix.5 | marker transaction·TTS pending durability | 다중 탭 stale edit linearization·TTS 직전 사용자 위치 저장 | 매우 높음 | P2 2건 구현·전체 자동검증 완료, 외부 재리뷰 대기 |
| 1.8.9-hotfix.6 | 로그아웃·모바일 책장 안정화 | owner/auth 전환·320px 액션 배치 | 중간 | `64ac57c` 구현·전체 자동검증 완료, 배포 실기기 확인 대기 |
| 1.8.9-hotfix.7 | 태블릿 가로 리더 안정화 | 본문 바깥 탭·선택형 2페이지·회전 재배치 | 중간 | 구현·전체 자동검증 완료, 태블릿 실기기 확인 대기 |
| 1.8.10 | TXT 목차 개선·누적 실사용 안정화 | 새 TXT 첫 구절 목차·PC/iPad/PWA 장기 사용 | 높음 | TXT 목차 구현·전체 gate 완료, 외부 리뷰·실사용 진행 중 |
| 1.8.11 | 도서 정보·플랫폼 메타데이터 | 길게 누르기 정보창·범위별 삭제·리더 정보 진입·독서 인증·읽기 전용 메타데이터 조회 | 중간 | Phase A~G 구현, 자동검증·게시·실기기 확인 진행 중 |
| 1.8.12 | 동기화 안정화·도서 오픈 경합 | canonical bookmark 수신·adoption-first resume·초기 pagination·foreground reconciliation·도서정보 이미지 clipboard·탭→스크롤 폭 복구 | 매우 높음 | 두 외부 리뷰 및 후속 UI/layout 수정 구현·full gate 완료, 전체 재리뷰 finding은 1.8.13으로 이관 |
| 1.8.13 | 동기화 invariant 안정화 | listener zero-authoritative 복구·navigation retry·aggregate lost-update 방지·settled revision·durable commit/convergence 분리·guest stale-save 방어·debug trace | 매우 높음 | `0cedf03` 재리뷰 guest/local P1까지 후속 수정·최종 full gate 완료, pending overlay 선택 보류·실기기 검증 단계 |
| 1.8.14 | 통합 책장 필터·공개 catalog | compact generation·태그 검색·출처/장르/태그 필터·통합 인기순·grid/list metadata | 중상 | `29d1bec`까지 구현·full gate·Firebase/catalog·Vercel·GitHub CI·실제 list 5개/정보창 전체 tag 검증 완료, 실제 모바일·iPad/PWA 대기 |
| 1.8.15 | 요청형 메타데이터 수집 | Vercel crawler·Firebase on-demand/delta·정보창 요청 UI·optional NovelPia auth provider | 높음 | `21983a0` full gate·Rules/index·Admin secret·CI·Vercel production·실제 요청/delta/cache 완료, Android/iPad/PWA 대기 |
| 1.8.16 | 반응형 UI 정리 | Muzio mini-player형 dock·책장/모달/리더 밀도·모바일 safe area | 중간 | Phase A dock 스타일 이식·자동검증 완료, 실제 Android/iPad/PWA 확인 대기 |
| 1.8.17 | foreground 원격 진행률 이동 안정화 | paginator lock false-success·resume reflow·canonical adoption barrier | 높음 | `ddb5c10` 코드·전체 check·집중 Chromium/WebKit 회귀·push 완료, Android Chrome/PWA 실기기 재검증은 1.8.18에 통합 |
| 1.8.18 | 원격 conflict navigation transaction 안정화 | active conflict preview/finalize·user-intent abort·target-aware stable navigation·rollback/lock cleanup | 매우 높음 | `30a6aa5` 코드·전체 `npm run check`·집중 Chromium/WebKit 회귀·push 완료, 실기기 검증은 후속 안정화 버전과 통합 |
| 1.8.19 | iPad EPUB 챕터 경계 탭 이동 최적화 | blank sentinel 우회·outgoing ResizeObserver range scan 제거·prev/failure recovery | 중상 | `c802632` 코드·전체 `npm run check`·집중 Chromium/WebKit 회귀·push 완료, iPad 실기기 재검증은 1.8.20과 통합 |
| 1.8.20 | iPad EPUB cold-open 계측·pre-view 안정화 | IDB/ZIP/EPUB/font/section 단계 timing·진단 export·`#view.element` pre-view 방어 | 중상 | `9d76087` 구현·전체 `npm run check`·push 완료, 실기기 진단에서 `ridi-font` 9.745초 병목 확인 |
| 1.8.21 | iPad RIDIBatang stabilization 세부 계측 | iframe `fonts.load`·frame·expand·content/root rect timing 분리 | 중간 | `8b1ebce` 구현·전체 `npm run check`·push 완료, iPad 진단에서 font frame wait 9.851초·font load 0ms·expand 5ms 확인 |
| 1.8.22 | iPad hidden iframe rAF throttle 제거 | reader-font/section-end/stable pagination의 staging frame을 visible host renderer로 이동 | 중상 | `512b725` 구현·전체 `npm run check`·집중 Chromium/WebKit 8건·push 완료, iPad 동일 긴 section 재검증 대기 |
| 1.8.23 | iPad 리더 진행바 pointer 입력 통일 | 1회 트랙 탭 commit·임의 위치 drag·native range pointer 우회·키보드 semantics 보존 | 중간 | 구현·단위/React DOM 회귀·전체 `npm run check`·SW Chromium/WebKit 4건 완료, iPad 실기기 검증 대기 |
| 1.8.24 | 책장/리더 메뉴 스타일 통합 | 글래스/모던 설정 공유·리더 제목/X/하단 버튼 surface·기존 리더=모던 보존 | 중간 | 구현·typecheck·ReaderToolbar React DOM 2건·release 3건·전체 `npm run check` 완료, 실기기 확인 대기 |
| 1.8.25 | 리더 글래스 투명도 실기기 비교 | reader glass alpha 0.48→0.38·blur/border 유지·모던 불변 | 낮음 | 테스트용 조정·SW/cache bump·자동검증 후 실기기 비교 |
| 1.8.26 | Android 진행률 확인 모달 ghost-click 방어 | 짧은 progress tap 후 합성 click·backdrop dismiss·drag/long-press 보존 | 중간 | pointer-origin backdrop dismiss로 수정·React DOM 회귀·전체 `npm run check` 완료, Android 실기기 재검증 대기 |

예정 버전 번호는 기능 순서를 설명하기 위한 슬롯이다. 앞 버전 출시 후 안정화 패치가 필요하면 다음 patch 번호를 안정화 전용으로 사용하고 이후 기능 번호를 순서대로 미룬다. 결함 수정과 다음 기능을 한 릴리스에 합치지 않는다.

## 4. 1.7.x에서 반드시 보존할 계약

### 4.1 저장소 역할

- Google Drive는 도서 원본 저장소다.
- IndexedDB는 도서 캐시, 로컬 진행률, 자동 책갈피, 오프라인 작업 큐를 담당한다.
- Firebase/Firestore는 진행률, 수동 책갈피와 1.8.x에서 추가될 동기화 데이터를 담당한다.
- 도서 원본을 주석 동기화나 통계 때문에 Firestore에 복제하지 않는다.

### 4.2 진행률과 책갈피

- 기존 `UserProgress`와 progress v2 문서의 의미를 유지한다.
- 기존 수동 책갈피는 위치 책갈피로 계속 열고 이동·삭제할 수 있어야 한다.
- 기존 수동 책갈피를 범위 하이라이트로 자동 변환하지 않는다.
- 자동 책갈피는 대량 이동·원격 채택 전 위치를 복구하기 위한 로컬 전용 기록으로 유지한다.
- 하이라이트 수 증가가 진행률 문서의 bookmark 배열 크기나 저장 빈도를 증가시키지 않게 한다.

### 4.3 동기화 안전성

- 기존 revision chain, immutable receipt, tombstone, lease epoch, outbox 충돌 보존 계약을 유지한다.
- warm cache snapshot을 authoritative server snapshot처럼 채택하지 않는다.
- owner 전환 뒤 이전 owner의 늦은 callback과 응답은 새 owner 상태를 변경하지 못해야 한다.
- 읽기 수신 장애는 복구 가능 상태와 schema·permission 차단 상태를 구분한다.
- 새 mutation은 서버 반영이 확인되지 않았는데 성공한 것처럼 표시하지 않는다.

### 4.4 기존 리더 동작

- 페이지·스크롤·좌우·전체 방향 탐색 모드를 유지한다.
- TOC, 검색, 퍼센트·CFI 이동, 진행률 슬라이더와 원격 진행률 채택의 저장 정책을 유지한다.
- 폰트, 줄 간격, 문단 간격, 여백, 정렬, 테마와 사용자 정의 테마를 유지한다.
- 로컬·Drive EPUB과 TXT 원본의 TXT-to-EPUB 경로를 유지한다.
- 텍스트 선택이 불가능한 이미지·고정 레이아웃 형식에서는 관련 액션을 숨기거나 명확히 비활성화한다.

## 5. 주석 도메인 기본 계약

하이라이트는 기존 책갈피에 필드를 추가한 형태가 아니라 별도의 주석 도메인으로 설계한다.

초기 논리 모델은 다음 정보를 보존해야 한다.

```ts
type Annotation = {
  id: string;
  bookId: string;
  type: 'highlight';
  sectionIndex: number;
  rangeCfi: string;
  quote: string;
  prefix: string;
  suffix: string;
  colorId: string;
  note: string;
  progressPercent: number | null;
  chapter: string;
  createdAtClient: number;
  updatedAtClient: number;
  anchorState: 'active' | 'unresolved';
};
```

실제 필드명과 길이 제한은 `update_1.8.1.md`와 `update_1.8.3.md`에서 현재 Foliate CFI, IndexedDB, Firestore Rules 제약을 다시 확인해 확정한다.

기본 정책은 다음과 같다.

- `rangeCfi`는 정확한 범위 이동과 렌더링을 위한 1차 anchor다.
- `quote`, `prefix`, `suffix`는 CFI 복원이 실패하거나 도서 내용이 미세하게 변한 경우의 검증·복구 자료다.
- 색상은 raw HEX만 저장하지 않고 안정적인 `colorId`로 저장한다.
- 팔레트 의미 변경은 과거 모든 하이라이트에 반영되도록 사용자별 팔레트 설정에서 관리한다.
- 색상은 시각적 구분 수단이면서 라벨·개수·메모 표시를 함께 제공해 색상만으로 의미를 전달하지 않는다.
- 색상은 5개, 색상당 최대 20개, 책당 최대 100개를 기본 제품 계약으로 한다.
- 제한 도달 시 오래된 항목을 자동 삭제하지 않는다. 추가를 막고 해당 색상의 정리 화면으로 안내한다.
- 겹치는 선택은 자동 병합하지 않고 기존 범위 확장 또는 별도 생성 여부를 명시적으로 결정한다.

## 6. 공통 UI·개인정보 원칙

- 짧은 탭은 기존 탐색, 길게 누르기와 선택 손잡이 조작은 텍스트 선택으로 판정한다.
- non-collapsed selection이 있거나 선택 손잡이를 조작 중일 때는 탭·스와이프 페이지 이동을 억제한다.
- 선택 액션 메뉴는 selection rect, viewport, safe area와 소프트 키보드를 고려해 위·아래 방향을 자동 전환한다.
- 기본 브라우저 선택 기능을 완전히 제거하지 않고 복구·접근성 fallback으로 남긴다.
- 생성·삭제·색상 변경처럼 되돌릴 수 있는 작업은 실행 취소 경로를 제공한다.
- 선택 원문은 사용자가 번역·사전·공유를 명시적으로 실행할 때만 외부 제공자에 전달한다.
- 외부 전달 전 현재 제공자와 네트워크 필요 여부를 UI에서 식별할 수 있어야 한다.
- TTS의 현재 문장 강조는 저장되는 하이라이트와 다른 임시 오버레이로 표현한다.

## 1.8.0 — 텍스트 선택 기반

상태: 개발·리뷰·커밋·푸시 완료, 실기기 검증 진행 — 세부 실행 문서 `update_1.8.0.md`

### 목표

탭 이동을 유지하면서 iPad Safari와 PC Chrome에서 텍스트를 길게 눌러 안정적으로 선택하고, 이후 모든 선택 기능이 공통으로 사용하는 액션 메뉴 계약을 만든다.

### 포함

- reflow EPUB/TXT 문서의 텍스트 선택 감지
- 탭·스와이프 탐색과 long-press selection arbitration
- iframe selection range와 화면 좌표 변환
- 선택 액션 메뉴의 위치·반전·닫기 정책
- 복사
- 지원 환경의 시스템 공유
- 바깥 탭, 스크롤, 페이지 이동, `Escape`에 따른 정리
- 선택 불가능 형식의 기능 숨김·비활성화

### 제외

- 하이라이트 저장
- 메모
- 번역·사전
- TTS
- IndexedDB·Firestore schema 변경

### 주요 영역

- `src/components/EpubReader.tsx`
- `src/hooks/foliate/useFoliateView.ts`
- `src/hooks/foliate/types.ts`
- `src/lib/readerNavigation.ts`
- 신규 selection hook과 action menu component
- 필요한 경우에만 `public/foliate-js` adapter event

### 완료 조건

- 네 탐색 모드에서 짧은 탭은 기존 동작을 유지한다.
- 선택이 시작된 뒤 탭·스와이프가 페이지를 이동시키지 않는다.
- 선택 손잡이 이동 후 메뉴가 현재 범위 근처에 다시 배치된다.
- 복사·공유 뒤 selection cleanup 정책이 일관된다.
- 기존 reader chrome, 링크, 검색과 키보드 탐색 회귀가 없다.

### 실기기 게이트

- PC Chrome
- iPad Safari 브라우저 탭
- iPad 홈 화면 PWA
- 단어·문장·여러 문단·페이지 경계 선택
- 화면 상하단·좌우단 selection과 회전
- 모달·툴바·소프트 키보드와의 중첩

## 1.8.1 — 로컬 범위 하이라이트 엔진

상태: 개발·Web GPT 3차 리뷰·full gate·commit·push 완료, 실기기 검증 대기 — 세부 실행 문서 `update_1.8.1.md`

### 목표

1.8.0의 선택 범위를 5색 하이라이트로 저장·복원하고, 기존 수동·자동 책갈피를 변경하지 않는 로컬 주석 기반을 완성한다.

### 포함

- annotation type과 validation
- 범위 CFI·원문·앞뒤 문맥 생성
- IndexedDB annotation store와 migration
- Foliate annotation overlay 연결
- 5색 생성·색상 변경·삭제
- 실행 취소
- 겹치는 범위 처리
- 책 재진입·레이아웃 변경 후 복원
- 기존 수동·자동 책갈피 UI와 저장 정책 회귀 보호

### 제외

- 원격 동기화
- 메모와 관리 목록
- 팔레트 의미 편집
- 전체 라이브러리 검색

### 주요 영역

- `src/types.ts`
- `src/lib/localDB.ts`, `src/lib/localDBV5.ts`, `src/lib/localDBSchema.ts`
- 신규 annotation schema·repository·anchor policy
- 신규 `useReaderAnnotations`
- `src/hooks/foliate/types.ts`
- Foliate `addAnnotation`, `deleteAnnotation`, `draw-annotation`, `create-overlay` adapter

### 완료 조건

- 생성·변경·삭제가 원자적으로 로컬 저장된다.
- 앱 강제 종료와 재실행 뒤 같은 범위가 복원된다.
- 폰트·줄 간격·여백·테마·탐색 모드 변경 후 하이라이트가 다시 그려진다.
- 복원이 실패한 annotation은 조용히 잘못된 위치에 칠하지 않고 검토 가능 상태로 남는다.
- 기존 manual bookmark와 auto bookmark의 저장·이동·제한 정책이 변하지 않는다.

### 실기기 게이트

- 온라인·오프라인 생성·수정·삭제
- 종료·재실행·PWA update 전후 복원
- 중복·부분 중첩·포함 범위
- 5색 각각 제한 도달
- 기존 1.7.x 진행률·책갈피가 있는 도서
- 최소 2~3일 실제 독서 안정화

## 1.8.2 — 메모·팔레트·주석 관리 UI

상태: 개발·리뷰·full gate·commit·push 완료, 실기기 검증은 1.8.3 이후 통합 수행 — 세부 실행 문서 `update_1.8.2.md`

### 목표

로컬 하이라이트를 메모 가능한 주석으로 확장하고, 색상별로 찾고 정리할 수 있는 관리 화면을 제공한다.

### 포함

- 하이라이트 메모 작성·편집
- 5색 팔레트 의미와 표시명 설정
- 색상별 접기·펼치기
- 색상별 현재 개수와 최대 개수
- 책 내부 하이라이트·메모 검색
- 독서 순서·최근 생성순·최근 수정순 정렬
- 메모 있는 항목만 보기
- 항목 이동 후 임시 강조
- 선택 항목의 일괄 색상 변경·삭제
- 팔레트의 로컬 저장

### 제외

- 기기 간 동기화
- 라이브러리 전체 검색
- 내보내기
- 번역 결과 UI

### 주요 영역

- 신규 annotation modal·list·editor components
- `src/components/BookmarkModal.tsx`와의 역할 분리 또는 안전한 통합
- `src/components/SettingsModal.tsx`
- `src/hooks/useViewerSettings.ts` 또는 별도 annotation palette settings
- annotation query·sort utilities

### 완료 조건

- 기존 책갈피와 새 하이라이트의 용어와 목록이 혼동되지 않는다.
- 총 100개 데이터에서 접기·검색·정렬·이동이 iPad에서 실사용 가능하다.
- 메모 저장 중 소프트 키보드와 reader chrome이 입력을 방해하지 않는다.
- 팔레트 이름을 바꾸면 과거 항목의 그룹 라벨이 일관되게 변경된다.

### 실기기 게이트

- 색상당 20개, 총 100개 fixture
- 긴 한글·영문·일문 메모
- 다크·라이트·세피아·블루 테마
- iPad 소프트 키보드와 화면 회전
- 목록 항목에서 정확한 범위 이동

## 1.8.3 — 하이라이트·메모·팔레트 동기화

상태: 개발·2차 재리뷰·full gate 완료, 통합 실기기 검증 대기 — 세부 실행 문서 `update_1.8.3.md`

### 목표

기존 progress/bookmark v2를 변경하지 않고 annotation과 사용자 팔레트를 PC와 iPad 사이에서 오프라인 우선 방식으로 동기화한다.

### 포함

- annotation 전용 Firestore payload·head·receipt schema
- annotation 전용 Rules validation과 ownership
- annotation target의 outbox enqueue·claim·acknowledge·conflict
- revision transaction과 tombstone
- active-book annotation snapshot listener
- generation isolation과 authoritative snapshot hydration
- 로컬 annotation의 최초 멱등 업로드
- 원격 생성·색상·메모·삭제 반영
- 사용자별 annotation palette 동기화
- sync health와 재시도 상태 통합

### 제외

- 기존 수동 책갈피의 annotation 변환
- 서로 다른 메모 문자열의 자동 병합
- 모든 책의 annotation listener 상시 실행
- 목록·검색·내보내기 UX 확장
- 번역·TTS

### 충돌 기본 정책

- 다른 annotation ID는 독립 revision chain으로 처리한다.
- 동일 annotation의 동시 수정은 사용자 의도가 명확하지 않으면 기존 충돌 UI 원칙을 따른다.
- delete 대 edit를 자동 병합하지 않는다.
- 삭제 tombstone이 authoritative하게 확인되기 전에는 로컬 데이터를 영구 제거한 것으로 간주하지 않는다.
- 팔레트 충돌 정책은 단일 사용자 설정 문서 또는 독립 색상 항목 중 실제 transaction 비용과 충돌 범위를 비교해 개별 버전 문서에서 확정한다.

### 주요 영역

- 신규 annotation sync schema·policy·transaction·accumulator
- IndexedDB outbox target 확장 또는 annotation 전용 queue
- `src/hooks/useProgressSync.ts`, `src/hooks/useProgressSyncWorker.ts`
- `src/lib/snapshotListenerRecovery.ts`, `src/lib/syncHealth.ts`
- `firestore.rules`
- Rules·transaction·outbox·listener tests

### 완료 조건

- 오프라인 생성·수정·삭제가 재연결 후 한 번만 적용된다.
- receipt replay가 중복 revision을 만들지 않는다.
- 삭제된 annotation이 오래된 기기 재접속 뒤 부활하지 않는다.
- local-only auto bookmark와 기존 manual bookmark가 annotation hydration에 의해 사라지거나 변경되지 않는다.
- active book 변경과 owner 전환 뒤 stale callback이 이전 책·사용자 주석을 적용하지 않는다.
- 로컬 최초 업로드가 중단·재개돼도 중복 문서를 만들지 않는다.

### 실기기 게이트

- PC 생성 → iPad 수신, iPad 수정 → PC 수신
- 한쪽 offline edit와 다른 쪽 online delete
- 동일 메모의 양쪽 동시 수정
- background·foreground·network·token 복구
- 100개 annotation의 최초 수화 시간과 Firestore read 관찰
- 팔레트 의미 변경의 양방향 반영
- 최소 2~3일 실제 양기기 독서 안정화

## 1.8.4 — 라이브러리 전체 주석 검색·내보내기

상태: 코드·전체 자동검증 완료, 외부 리뷰 반영 hotfix.1 코드·전체 자동검증 완료 — 세부 실행 문서 `update_1.8.4.md`, `update_1.8.4-hotfix.1.md`

### 목표

동기화된 하이라이트와 메모를 책을 열지 않고 라이브러리 단위로 찾고, 사람이 읽을 수 있는 Markdown과 복구 가능한 JSON으로 내보낸다.

### 포함

- 라이브러리 전체 quote·note 검색
- 책·색상·메모 유무 필터
- 검색 결과에서 책과 범위로 이동
- 단일 책·전체 라이브러리 Markdown export
- 전체 필드를 보존하는 versioned JSON export
- 지원 환경의 파일 다운로드·시스템 공유
- offline local export

### 제외

- JSON import와 merge
- 전문 검색 서버
- 자동 백업 업로드

### 주요 영역

- annotation repository의 cross-book query
- 검색 index 또는 정규화 cache
- annotation search/export modal
- Markdown escaping과 versioned JSON serializer
- download/share adapter

### 완료 조건

- tombstone과 복원 실패 항목의 포함 정책이 명확하다.
- 따옴표·개행·Markdown 기호·emoji를 손상 없이 내보낸다.
- JSON export가 schema validator로 다시 파싱된다.
- iPad Safari/PWA에서 파일 저장 또는 공유 fallback이 동작한다.

### 실기기 게이트

- 여러 책과 100개 이상 annotation fixture
- 한글 부분 검색과 동일 문장 중복 결과
- offline 검색·내보내기
- iPad 다운로드·공유
- 결과 이동 후 원래 검색 상태 복귀

## 1.8.5 — 번역·사전 다중 경로

상태: 외부 코드 리뷰 finding 수정·전체 자동검증 완료, 코드 릴리스 마감. 실기기 검증은 1.8.9 누적 안정화로 이관 — 세부 실행 문서 `update_1.8.5.md`

### 목표

선택 텍스트를 브라우저·기기 능력에 따라 번역하거나 사전에서 찾고, 지원되지 않는 환경에서도 명확한 fallback을 제공한다.

### 포함

- translator·dictionary provider abstraction
- 브라우저 내장 기능 feature detection
- 설정 가능한 외부 번역·사전 제공자
- 시스템 기본 선택 메뉴 fallback 유지
- 원문·결과 복사
- 번역 결과를 annotation note로 저장
- 언어별 기본 사전 설정
- provider 오류·미지원·offline 상태

### 제외

- 서버에서 제공하는 무료 번역 proxy
- 앱이 API key를 보관하는 공용 번역 서비스
- 책 전체 자동 번역
- 번역 결과의 자동 영구 저장

### 주요 영역

- selection action menu
- 신규 translation/dictionary provider layer
- settings UI
- result popover/modal
- annotation note update path

### 완료 조건

- 현재 환경에서 사용할 수 없는 provider를 성공 가능한 것처럼 표시하지 않는다.
- 선택 원문은 사용자가 실행한 provider 외에는 전송하지 않는다.
- popup 차단·network failure 뒤 리더 위치와 selection 상태가 안전하게 정리된다.
- 결과를 메모로 저장하면 기존 annotation sync 계약을 사용한다.

### 실기기 게이트

- PC Chrome, iPad Safari, iPad PWA
- 한국어·영어·일본어
- 내장 API 지원·미지원 환경
- popup 차단·offline·provider 오류
- 긴 선택문 제한과 결과 복사
- 외부 페이지 왕복 후 reader 위치 유지

## 1.8.6 — 선택·현재 위치 기본 TTS

상태: 외부 코드 리뷰 finding 수정·전체 자동검증 완료, 코드 릴리스 마감. 실기기 검증은 1.8.9 누적 안정화로 이관 — 세부 실행 문서 `update_1.8.6.md`

### 목표

브라우저 Web Speech 기반으로 선택한 텍스트와 현재 위치의 짧은 구간을 안정적으로 듣고 제어한다.

### 포함

- 선택 부분 듣기
- 현재 문장 또는 현재 위치부터 듣기
- 재생·일시정지·재개·중지
- 이전·다음 문장
- voice·language·rate 설정
- 현재 발화 문장 임시 강조
- 기기별 voice 목록 갱신
- reader 종료·책 전환 시 speech cleanup

### 제외

- 장 전체 자동 큐
- 자동 페이지 이동
- TTS cursor 영속 복원
- lock-screen 재생 보장
- cloud TTS

### 주요 영역

- 신규 speech synthesis adapter
- 신규 `useReaderTts`
- reader TTS controls
- text segmentation utility
- Foliate ephemeral annotation adapter

### 완료 조건

- speech queue가 책 전환·리더 종료 뒤 남지 않는다.
- 저장된 하이라이트와 TTS 임시 강조가 서로 수정되지 않는다.
- TTS 제어가 독서 진행률이나 자동 책갈피를 잘못 생성하지 않는다.
- voice 목록이 늦게 로드되는 환경에서도 선택 UI가 갱신된다.

### 실기기 게이트

- PC Chrome과 iPad Safari voice 차이
- 한글·영문·일문 및 혼합 문장
- play·pause·resume·cancel 반복
- 블루투스 오디오 연결 변경과 다른 오디오 interruption
- 모달·앱 전환·책 전환 중 cleanup

## 1.8.7 — 현재 장 연속 TTS

상태: 구현·1차 외부 리뷰 finding 수정·전체 자동검증 완료, 재리뷰 대기. 실기기 검증은 1.8.9 누적 안정화로 이관 — 세부 실행 문서 `update_1.8.7.md`

### 목표

기본 TTS 위에서 현재 장을 문장 단위로 연속 재생하고, 발화 위치에 맞춰 화면을 이동·복원한다.

### 포함

- 현재 장 전체 text traversal
- sentence/paragraph chunk queue
- 현재 발화 범위 추적
- 다음 문장과 다음 화면 자동 이동
- 장 끝 동작 설정
- 마지막 TTS cursor 저장·복원
- 10·20·30분 sleep timer
- background → foreground 상태 재검증
- 실패 chunk 재시도·건너뛰기

### 제외

- OS lock-screen media control 보장
- 다음 책 자동 재생
- cloud voice와 audio file cache
- TTS 재생 시간을 독서 통계에 합치는 최종 정책

### 주요 영역

- chapter text walker와 segmentation
- TTS queue state machine
- CFI↔sentence cursor mapping
- reader navigation와 progress save policy
- visibility/page lifecycle handling

### 완료 조건

- 긴 장을 작은 chunk로 재생하고 queue 중복·정지가 없다.
- 자동 이동이 auto bookmark 폭증이나 잘못된 progress write를 만들지 않는다.
- 사용자가 수동 탐색하면 자동 이동과 TTS cursor의 우선순위가 명확하다.
- background 복귀 시 실제 speech 상태를 다시 확인하고 UI만 재생 중으로 남지 않는다.

### 실기기 게이트

- 20~30분 이상의 긴 장
- 네 탐색 모드와 화면 회전
- 글자 크기·줄 간격 변경
- background·foreground·화면 잠금 후 실제 지원 범위 기록
- sleep timer
- 최소 2~3일 실제 듣기 안정화

## 1.8.8 — 독서 통계

상태: 전체 리뷰 후속을 `update_1.8.8-hotfix.1.md`와 `update_1.8.8-hotfix.2.md`로 분리 구현하고 full gate 완료, 외부 재리뷰 대기. 실기기 검증은 1.8.9 누적 안정화로 이관 — 본 버전 문서 `update_1.8.8.md`

### 목표

진행률 write 횟수가 아니라 실제 활성 독서 세션을 바탕으로 책별·일별·주별 통계를 계산한다.

### 포함

- active reading session 시작·중단·종료
- 책별 읽은 시간과 읽은 날짜
- 일·주·월 집계
- 진행률 변화와 완독 기록
- 화면 독서와 TTS 듣기 시간 분리
- 기기 간 session ID와 중복 제거
- offline session 업로드
- 통계 Markdown·JSON export

### 제외

- 건강·집중도 추정
- 백그라운드에 둔 시간의 독서 시간 포함
- 경쟁·소셜 기능
- 기존 progress timestamp로 과거 시간을 역산

### 주요 영역

- reading session local schema
- activity·visibility·reader lifecycle tracker
- session sync와 aggregate policy
- statistics query·UI·export

### 완료 조건

- 화면을 켜 둔 채 입력이 없는 시간을 무제한 누적하지 않는다.
- background, 책 전환, 리더 종료, 브라우저 종료 경계가 멱등적이다.
- PC와 iPad 동시 실행을 하나의 세션으로 잘못 합치거나 두 배로 집계하지 않는다.
- 자정·시간대·기기 시각 변경 정책이 테스트로 고정된다.

### 실기기 게이트

- 짧은 세션·장시간 idle·background
- 자정 통과와 시간대 변경
- PC와 iPad 동시 독서
- offline session 재연결
- TTS만 재생한 시간 분리
- 빠른 앱 종료와 재실행
- 최소 2~3일 실제 사용 후 수기 시간과 비교

### 전체 리뷰 후속 패치

- `1.8.8-hotfix.1`: remote navigation commit 결과, 충돌 모달 reader 차단·접근성, EPUB 외부 링크 opener 차단
- `1.8.8-hotfix.2`: malformed 통계 격리, nanosecond cursor·7일 full audit, canonical date aggregation, 통계 health 분리
- `1.8.8-hotfix.3`: 원격 progress 2단계 commit, pending save rollback, 연속 TTS 통계, fixed-layout activity
- `1.8.8-hotfix.4`: 수동 이동 commit, canonical midnight split, stale Document 정리, slider 확인 modal
- `1.8.8-hotfix.5`: guest local fast path, 충돌 diff·시각 표기, clock sample read 절감, 긴 malformed cursor
- `1.8.8-hotfix.6`: empty progress intent 확정 guard, resolver 원격 revision·accepted event 단조성
- `1.8.8-hotfix.7`: actual-playing TTS 통계, device single-flight, 이동 전 책갈피 snapshot, malformed timestamp 격리
- 장기 retention/compaction과 통계 multi-tab 단일 실행자는 기존 receipt·tombstone·offline recovery 또는 새 lease protocol을 건드리므로 1.8.9 Phase A 선행 안정화로 이관한다.

## 1.8.9 — 1.8.x 누적 실사용 안정화

상태: Phase A 구현과 hotfix.1~7 자동검증을 마치고 코드 개발선을 종료했다. 남은 장기 실사용 검증은 1.8.10으로 이관 — `update_1.8.9.md`

### 목표

새 기능 추가를 멈추고 알려진 동기화 운영 위험을 먼저 닫은 뒤 PC Chrome, iPad Safari와 홈 화면 PWA에서 1.8.x 전체 기능을 실제 독서 흐름으로 사용하면서 교차 기능 결함을 수집·수정한다.

### 포함

- 1.8.0~1.8.8 개별 문서의 미완료 실기기 항목 통합
- 실제 EPUB·TXT·PDF·압축책의 장시간 읽기
- 선택·하이라이트·메모·동기화·검색·내보내기·번역·TTS·통계 연속 사용
- PC↔iPad 동시 로그인과 offline·background·PWA update 왕복
- 실사용 재현 로그와 작은 안정화 patch
- 기능별 외부 코드 재리뷰가 필요한 수정의 구분
- 실기기 전 통계 multi-tab leader protocol 구현·검증
- retention/compaction 규모·비용·offline 복귀 계측과 migration 설계

### 제외

- 새 사용자 기능
- 검증과 무관한 대규모 UI 재설계
- 증거 없는 저장·동기화 구조 교체

### 운영 원칙

- 알려진 P0~P2와 자동검증 실패를 다음 기능으로 미루지는 않는다.
- Phase A의 코드·운영 TODO를 끝내기 전 Phase B 실기기 완료 판정을 시작하지 않는다.
- 실기기 검증 일정만 1.8.9에 모으며, 각 기능은 구현 직후 자동검증과 외부 코드 리뷰를 마친다.
- 안정화 결함은 원인과 영향 범위가 같은 것만 한 patch로 묶는다.
- 데이터 손실·삭제 부활·잘못된 자동 이동·반복 충돌 알림은 최우선으로 수정하고 전체 동기화 gate를 다시 수행한다.
- 실사용 중 발견된 편의성 제안은 결함 수정과 분리해 1.9.x 후보로 기록한다.

### 완료 조건

- 모든 개별 버전 문서의 실기기 대기 항목이 통과·보류·제외 중 하나로 판정된다.
- 최소 2~3일 양기기 실제 독서에서 데이터 손실과 반복 충돌이 재현되지 않는다.
- PWA update 전후 local mutation flush와 reader 위치 복원이 확인된다.
- 마지막 안정화 patch가 `check:full`과 외부 코드 리뷰를 통과한다.
- 남은 알려진 제한이 release note에 명시된다.

## 1.8.10 — TXT 목차 개선·누적 실사용 안정화

상태: 새로 변환하는 TXT의 목차를 `번호 + 첫 20 grapheme`으로 개선하고 전체 자동 gate를 통과했다. 기존 저장 EPUB은 변경하지 않으며 외부 리뷰·누적 실사용 검증 진행 중 — `update_1.8.10.md`

### 포함

- 새 TXT→EPUB 변환 목차의 번호·첫 구절 표시
- 1.8.9에서 이관한 PC·iPad·PWA 누적 실사용 검증
- 실사용 결함의 `1.8.10-hotfix.N` 분리 수정

## 1.8.11 — 도서 정보·플랫폼 메타데이터

상태: 길게 누르기 도서 정보창, 범위별 삭제, 리더 정보 진입, 독서 인증 PNG와 `file_check` 최신 플랫폼 카탈로그의 Firebase 읽기 전용 bucket projection을 구현했다. `web-novel-viewer` Rules 배포와 최초 256개 bucket 게시를 완료했고 외부 리뷰·실기기 확인을 기다린다. — `update_1.8.11.md`

- 통계 모달 크기의 도서 정보창
- 제목·파일·상단 저장 상태 badge·누적 독서 시간·진행률·최근 독서 시각 표시
- 정보창 내부 읽기·2단계 영구 삭제
- 비정기 Python dry-run/apply 게시기
- 공개 단건 조회, 목록·클라이언트 쓰기 금지 Firestore Rules
- 플랫폼 badge와 수치 우선 2줄 작품 정보
- 길게 누른 개별 회차 session의 통계 숨김, 다른 회차·완료 경계·원본 session 보존 및 표시 합계 제외
- 탭·스크롤 탐색 모드 전환 시 비활성 스크롤 축을 초기화해 본문이 화면 밖으로 사라지는 문제 수정
- 책장 카드 길게 누르기의 기본 텍스트 선택을 막고 도서 정보 모달 안에서는 제목 복사를 허용
- 모달 programmatic focus의 브라우저 기본 흰 outline 제거
- 기기 사본이 있는 Drive 도서의 `로컬 삭제 / 전체 삭제 / 취소` 분기
- 리더 utility의 `듣기 → 통계 → 정보` 진입과 관리 버튼 없는 정보 모달
- 하단 작업 영역을 제외한 도서 정보 PNG 독서 인증 다운로드
- 통계 도서·회차 목록을 마지막 독서 시각의 내림차순으로 정렬
- 마지막 전체 코드 리뷰와 release candidate 판정

### 제외

- 기존 TXT 변환 EPUB 자동 탐지·마이그레이션·마커
- 실제 증거 없는 저장·동기화 대규모 구조 변경
- retention/compaction 자동 삭제 활성화

## 1.8.14 — 통합 책장 필터·공개 catalog

상태: compact public catalog publisher·검증형 cache loader, PC·모바일 통합 필터 모달, `#태그` 검색, 통합 인기순과 grid/list·정보창 metadata 표시를 구현했다. Firebase generation `6ed40232b8555a45bde9`와 Vercel production을 게시했다. 최종 태그 계약은 grid 2개·list 5개·정보창 전체이며 `29d1bec`의 full gate, GitHub CI, Vercel production과 실제 10권 list·15-tag 정보창 재확인을 완료했다. 실제 모바일·iPad/PWA·offline/generation 교체 검증은 계속 대기 — `update_1.8.14.md`

### 포함

- 기존 정렬 버튼을 대체하는 PC·모바일 통합 필터 버튼과 반응형 modal
- 시리즈·카카오·노벨피아·없음(기타), canonical genre와 raw tag 조합 필터
- 작품 수 상위 tag 15개 초기 노출과 15개 단위 더보기
- 기본 검색창의 `#태그` 결과 우선 표시와 tag filter handoff
- 플랫폼별 rank를 평균한 통합 인기순
- grid/list의 genre·대표 tag·출처별 원본 수치와 정보창 전체 tag
- immutable 24문서 generation + manifest-last CAS, point-get only Rules와 persistent Firestore cache
- 기존 상세 256 bucket, `Book`, Drive metadata와 사용자 IndexedDB 호환 유지

### 게시·실기기 게이트

- Rules·index를 먼저 배포하고 field operation 완료를 기다린 뒤 generation 24개 readback과 manifest CAS를 완료한다.
- 비로그인 production REST, SQLite 원본과 실제 카드·정보창 수치를 표본 대조한다.
- PC·모바일·iPad/PWA에서 first/cached/offline load, generation 교체와 rollback을 확인한다.

## 1.8.15 — 요청형 메타데이터 수집

상태: metadata가 완전히 비어 있는 도서의 shared 정보창 요청, Vercel server crawler, Firestore on-demand 원본·16-shard compact delta, fallback-only base+delta merge와 optional NovelPia auth provider를 구현했다. 요청 버튼은 tag·genre·source count가 모두 없을 때만 표시하고, 이후 정기 base가 보강되면 base가 과거 요청 delta보다 우선한다. 정확 파일명 alias가 없을 때 `file_check` 1.3.3의 실제 `extractCoreTitle()` 규칙으로 재조회해 관측 파일명 변형도 자동 조인한다. `21983a0` full gate와 `web-novel-viewer` Rules/index, 최소권한 Admin secret, GitHub CI, Vercel production, 실제 ready/not-found·delta/cache 요청 acceptance를 완료했다. 공개 crawler는 NovelPia 계정 env 없이 동작하고 두 credential이 모두 있을 때만 인증 fallback을 만든다. 실제 Android/iPad/PWA 표본은 후속 확인이다 — `update_1.8.15.md`

### 포함

- shared shelf/reader 도서정보의 metadata 요청 버튼과 명시적 상태 전이
- Firebase ID token 검증, alias lease, 사용자 quota와 전역 cooldown
- Series/Kakao/NovelPia 공개 crawler의 server-only TypeScript 구현
- per-title Firestore 원본과 immutable compact delta generation·manifest-last CAS
- base + delta merge 후 정보창 전체 tag, list 5개, grid 2개와 필터·검색·인기순 갱신
- exact alias 우선, vendored `file_check` 1.3.3 core-title alias fallback 자동 매칭
- 요청 crawler query에도 1.3.3 readable title을 사용하고 query/version 불일치 legacy 실패 캐시는 재수집
- 별도 mode 없이 email/password 존재 여부만 보는 optional NovelPia auth provider
- credential·cookie·원격 응답 redaction과 client bundle secret audit

### 제외

- `file_check` 실행·import, 로컬 SQLite와 Control Server 연동
- client-side crawler, 자동 대량 backfill과 사용자 tag 직접 편집
- 기존 base catalog의 요청별 in-place 수정
- CAPTCHA 우회, credential을 repo·Firestore·client cache에 저장

### release gate

- Vercel Preview에서 세 플랫폼 egress를 먼저 증명한다.
- public-only mode의 full gate와 production request 성공·재실행 cache를 확인한다.
- 실제 성인 인증은 사용자가 production sensitive env를 추가하고 새로 배포한 뒤 별도 acceptance 증거가 있을 때만 완료 처리한다.

## 1.8.16 — 반응형 UI 정리

상태: 1.8.15 코드 릴리스를 닫고 책장 dock에 Muzio mini-player의 responsive radius와 light/dark surface·border·shadow·blur를 이식했다. 기능·아이콘 순서와 접근성은 유지한다 — `update_1.8.16.md`

### 포함

- 책장 상단/하단 action dock의 공통 반투명 capsule surface
- iOS safe area와 별도 하단 여백을 합친 floating placement
- Android Chrome·Safari·PWA에서 기능을 유지하는 CSS progressive enhancement
- 후속 책장 list/grid, filter·정보창 modal과 reader chrome의 간격·밀도 정리

### 제외

- Safari native control의 픽셀 단위 복제나 브라우저 user-agent 분기
- navigation action, 저장·동기화·metadata 계약 변경
- blur 지원을 전제로 한 필수 interaction 또는 polyfill

### release gate

- 320px 폭에서 action 누락·가로 overflow가 없다.
- blur 미지원 또는 투명도 감소 환경에서도 테두리·대비·터치 target이 유지된다.
- 실제 Android Chrome, iPad Safari와 PWA에서 safe area·회전·스크롤 dock 전환을 확인한다.

## 7. 공통 자동검증 게이트

각 개별 버전은 기본적으로 다음 검증을 통과해야 한다.

```bash
npm run check:full
```

현재 `check:full`은 다음을 포함한다.

- ESLint
- TypeScript typecheck
- 전체 Node 회귀 테스트
- production build
- Firestore Rules/transaction 테스트
- Playwright Chromium·WebKit 테스트
- production Chrome browser regression

변경 위험에 따라 다음을 별도로 추가한다.

- IndexedDB migration과 future-version preservation
- annotation/vocabulary/session schema validator
- outbox lease·receipt replay·tombstone·conflict
- Foliate iframe selection·overlay lifecycle
- Service Worker update 승인과 local commit drain
- release version, lockfile, Service Worker cache name과 browser fixture 일치

자동검증 결과는 개별 버전 문서에 실제 명령, 테스트 개수, build 결과, 알려진 환경성 재시도 여부와 함께 기록한다. 이전 버전의 통과 기록을 현재 버전 증거로 재사용하지 않는다.

## 8. 공통 실기기 검증 게이트

Playwright WebKit은 Desktop Safari profile이므로 실제 iPad Safari와 홈 화면 PWA를 대체하지 않는다.

### 기본 기기

- PC production Chrome
- iPad Safari 브라우저 탭
- iPad 홈 화면 PWA
- 동기화 버전에서는 PC와 iPad 동시 로그인

### 모든 버전의 공통 회귀

- 로컬 EPUB 열기·닫기
- Drive EPUB 열기·닫기
- TXT 원본 업로드·TXT-to-EPUB cache 재사용
- 마지막 위치 자동 재개
- 페이지·스크롤·좌우·전체 방향 탐색
- TOC·검색·퍼센트·CFI·슬라이더 이동
- 수동 책갈피 생성·이동·삭제
- 자동 책갈피 생성과 복구
- 원격 진행률 수신·채택·충돌
- offline → online 복귀
- background → foreground 복귀
- PWA update 승인 전후 progress·local mutation flush

### 누적 안정화 시점

- 1.8.0~1.8.8은 구현 직후 자동검증과 외부 코드 리뷰까지 완료한다.
- 일정이 필요한 실기기 항목은 삭제하지 않고 각 문서에 `1.8.9 누적 안정화로 이관` 상태로 유지한다.
- 1.8.8 코드 리뷰가 끝나면 1.8.9 feature freeze를 시작해 위 공통 회귀와 버전별 실기기 항목을 한 흐름으로 수행한다.
- 구현·리뷰 중 이미 재현된 데이터 손실, 삭제 부활, 잘못된 자동 이동, 반복 알림은 1.8.9까지 미루지 않고 즉시 수정한다.
- 누적 안정화는 최소 2~3일 실제 사용과 양기기 왕복을 기본으로 한다.

## 9. 개별 버전 문서 규칙

새 버전 작업을 시작할 때 `docs/updates/` 아래에 먼저 해당 문서를 만든다. 저장소 루트에는 새 `update*` 문서를 두지 않는다.

예:

```text
docs/updates/update_1.8.0.md
docs/updates/update_1.8.1.md
docs/updates/update_1.8.2.md
```

개별 문서는 최소한 다음 구조를 가진다.

```markdown
# Web Reader 1.8.0 제목

작성일:
기준 커밋:
상위 계획: docs/updates/update_1.8.x_plan.md

## 목표
## 리뷰 판정
## 범위
## 명시적 제외
## Phase 1 — ...
상태: 대기
## 완료 조건
## 자동검증 계획
## 실기기 테스트 계획
## 구현 결과
## 자동검증 결과
## 실기기 검증 결과
## 보류·후속 버전
```

작성·갱신 규칙은 다음과 같다.

- 시작 시점의 실제 HEAD를 기준 커밋으로 기록한다.
- 마스터 계획을 그대로 복사하지 않고 해당 버전의 실제 설계 결정과 파일 경계를 구체화한다.
- 수용·보류·제외 항목을 `리뷰 판정` 표로 고정한다.
- phase는 서로 독립적으로 검증 가능한 크기로 나눈다.
- 코드 수정 후 자동검증이 끝나도 실기기 항목은 `검증 대기`로 유지한다.
- 실기기에서 발견된 결함과 수정 결과를 같은 문서에 append하고 전체 회귀를 다시 확인한다.
- 사용자 요청에 따라 커밋·푸시한 경우 commit ID와 local/remote HEAD 확인을 기록한다.
- 릴리스가 끝나면 이 마스터 계획의 상태와 실제 다음 예정 버전을 갱신한다.

## 10. 버전 변경과 안정화 패치 정책

- 출시 전 발견된 결함은 해당 버전 문서의 phase로 해결한다.
- 출시 후 발견된 결함은 다음 patch를 안정화 전용으로 사용할 수 있다.
- 안정화 patch에는 다음 예정 기능을 끼워 넣지 않는다.
- 안정화로 버전 번호가 밀리면 이 문서의 예정 릴리스 표와 이후 개별 문서명을 함께 갱신한다.
- 실제 사용에서 필요성이 낮아진 기능은 억지로 유지하지 않고 보류 사유와 재개 조건을 기록한다.
- 범위가 커진 기능은 더 작은 patch로 분리하고 완료되지 않은 항목을 완료로 표시하지 않는다.

## 11. 주요 위험과 중단 조건

| 위험 | 주요 버전 | 중단 조건 | 대응 원칙 |
| --- | --- | --- | --- |
| 선택 손잡이와 탭 이동 충돌 | 1.8.0 | 선택 중 페이지 이동 | gesture arbitration을 먼저 수정 |
| CFI drift와 잘못된 하이라이트 | 1.8.1 | 다른 문장에 표시 | quote/context 검증, 실패 항목 분리 |
| 기존 책갈피 손실 | 1.8.1~1.8.3 | manual/auto 누락 | annotation과 bookmark 저장 경계 재검증 |
| 삭제된 주석 부활 | 1.8.3 | stale 기기 재접속 후 복원 | tombstone·authoritative hydration 수정 |
| 초기 업로드 중복 | 1.8.3 | 동일 ID·내용 중복 | event ID·receipt 멱등성 수정 |
| 번역 제공자 오동작 | 1.8.5 | 무응답·잘못된 성공 표시 | capability·fallback 상태 분리 |
| speech 상태와 UI 불일치 | 1.8.6~1.8.7 | 정지했는데 재생 표시 | 실제 synthesizer 상태 재검증 |
| TTS 자동 이동이 진행률 오염 | 1.8.7 | auto bookmark/write 폭증 | navigation save policy 분리 |
| 독서 시간 과대 집계 | 1.8.8 | idle/background 포함 | session boundary와 idle cutoff 수정 |

## 12. 현재 다음 단계

1. 실제 Android/모바일 Chrome·iPad Safari·설치형 PWA에서 1.8.14 filter 계약과 1.8.15 요청 상태·재실행을 함께 확인한다.
2. 성인 작품 인증이 필요해지면 `NOVELPIA_EMAIL`과 `NOVELPIA_PASSWORD`를 함께 sensitive env로 추가하고 CAPTCHA·adult-mode를 별도 acceptance한다. public crawler와 현재 release에는 필요 없다.
