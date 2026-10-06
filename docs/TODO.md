# 남은 작업

현재 구현과 릴리스 기록을 대조해 남은 작업만 모았습니다. 코드 릴리스·자동검증 완료와 실제 계정/기기 수용 확인은 별개입니다. 이 목록의 작성은 아래 작업의 실행을 뜻하지 않습니다. 과거 버전 기록과 anchor는 그대로 보존합니다.

## 기존 전체 lint 실패

- `tests/remoteProgressPrompt.test.mjs`의 두 test harness가 render 중 외부 `state`를 대입해 `react-hooks/globals` 오류를 냅니다. 초기화 과정에서 해당 파일 ESLint를 다시 실행해 동일한 2건을 확인했습니다. [기존 기록](updates/update_1.8.37.md#시작-위치-복원-검증과-경량-진단)에도 전체 lint 실패로 남아 있습니다.
- [커밋 `05307e3`의 run 37410255063](https://github.com/twkim96/web-reader/actions/runs/37410255063)에서도 `static-node-build` job이 같은 파일의 202·428행 오류 2건으로 실패했습니다.
- 다음 작업: 테스트의 관찰 방법을 React 수명에 맞게 정리하고 기존 원격 이동·owner 전환 회귀를 유지합니다. 제품 코드나 assertion을 약화해 우회하지 않습니다.
- 완료 조건: 해당 파일 lint와 관련 회귀가 통과하고, 이후 필요한 전체 gate의 결과를 기록합니다.

## 기존 브라우저 CI 실패

- [문서 초기화 커밋 `0d52154`의 run 37394612095](https://github.com/twkim96/web-reader/actions/runs/37394612095)와 [직전 커밋 `11bc6f9`의 run 37162191819](https://github.com/twkim96/web-reader/actions/runs/37162191819)의 `browser-regression` job은 모두 실패로 종료됐습니다. 두 실행의 로그에서 같은 증상을 확인했으며 문서 이관 이전부터 있던 미해결 실패로 보존합니다.
- 관측 증상: [tests/browserRegression.mjs:3411](https://github.com/twkim96/web-reader/blob/0d52154b6ff42718eb4e2257487e8df63cb9b67d/tests/browserRegression.mjs#L3411)의 `selectionActions.flowAfterScrollMode` assertion에서 기대값은 `scrolled`, 실제값은 `paginated`입니다. 제품 버그인지 테스트·실행 환경 문제인지는 아직 미확정입니다.
- [커밋 `05307e3`의 run 37410255063](https://github.com/twkim96/web-reader/actions/runs/37410255063)도 완료·실패 상태이며 `browser-regression` job 로그에서 같은 assertion과 기대값/실제값을 확인했습니다.
- 다음 작업: CI의 스크롤 모드 전환 순서와 renderer 상태 반영·관찰 시점을 재현하고 [읽기 사양](SPEC/reader-and-progress.md#읽기와-시작-위치)과 대조해 원인을 구분합니다.
- 완료 조건: 원인과 대응 근거를 기록하고, 의도한 스크롤 모드 전환 계약을 유지한 관련 회귀와 해당 `browser-regression` CI job의 통과 실행 링크를 남깁니다.

## 누적 다중 기기·실사용 수용 확인

- [1.8.9 Phase B](updates/update_1.8.9.md#phase-b--누적-실기기-검증-이관) → [1.8.10 누적 검증](updates/update_1.8.10.md#2-189에서-이관한-누적-실사용-검증)의 이관 작업입니다. [1.8.36](updates/update_1.8.36.md)은 실제 두 기기·OAuth·Android/iPad PWA 확인을 자동검증과 분리합니다.
- 다음 작업: 같은 Firebase 계정으로 PC Chrome·Android·iPad Safari 탭/PWA에서 진행률·수동 책갈피·주석·팔레트·통계를 비교합니다. offline 편집·다중 탭·background/강제 종료·재접속·PWA update, 선택→메모→검색/내보내기와 20~30분 TTS의 pause/resume/장 전환을 포함합니다.
- 날짜 경계·시간대/시계 차이의 통계, 장기 `activeIntervals`의 모달/기간 변경/export 비용, 회독 완료 동시 확인을 확인합니다. 지원하지 않는 PDF/이미지 도서의 텍스트 도구는 해당 없음으로 기록합니다.
- [hook 분리 이후 위치 정밀도 후속](updates/refactor-phase-plan.md#post-refactor-improvement-1-precision-progress-sync)에 남은 실제 기기 확인도 포함합니다. 최신 빌드에서 `anchorCfi`가 있는 EPUB/TXT 위치의 다른 기기 시작 문장 복원과 `cfi`만 있는 이전 기록의 정상 열기를 확인합니다.
- 완료 조건: 최소 2~3일 실제 독서에서 데이터 손실·삭제 부활·이유 없는 이동·반복 충돌이 없는지 확인하고, 이관 항목별 통과/보류/제외 및 기기·빌드·제한을 기록합니다. 자동 회귀와 실제 production 동기화 결과를 구분합니다.

## 실제 로그인·Drive 재연결

- [1.8.35](updates/update_1.8.35.md#검증-결과)의 인증 실사용 재확인은 아직 대기입니다. state fallback과 logout disposer 수정은 구현되어 있으나 실제 첫 callback의 성공 근거를 대신하지 않습니다.
- 다음 작업: 배포 브라우저/PWA/WebView에서 로그아웃 성공·실패, Firebase 재로그인, 첫 Drive 연결과 token 만료 뒤 redirect 재연결을 확인합니다. 앱 origin·Firebase helper·state 소비를 비교하고 비밀값을 기록하지 않습니다.
- 완료 조건: 기존 오류 화면/상태 불일치가 재현되는지 판정하고, Drive 목록 복구·로컬 서재 보존·Firebase 상태 유지 결과를 기록합니다.

## 실제 도서 삭제

- [hook 분리 이후 도서 삭제 후속](updates/refactor-phase-plan.md#post-refactor-improvement-2-cloud-shelf-book-delete)은 구현 뒤 Vercel/기기 확인 대상으로 남겼습니다. 당시 입력 방식이 아니라 [현재 삭제 메뉴·데이터 계약](SPEC/library-and-files.md#캐시삭제-계약)을 기준으로 확인합니다.
- 다음 작업: 실제 로컬/클라우드 서재에서 삭제 취소, 기기 사본만 삭제, Drive 도서 전체 삭제와 확인 뒤 Drive token 만료를 확인합니다. Drive 원본·기기 캐시·계정 진행률/주석의 유지·삭제 범위와 실패 시 후속 단계 중단을 구분합니다.
- 완료 조건: 실제 기기/빌드·선택한 삭제 범위별 결과를 기록하고, 취소·인증 실패에서 기존 데이터를 잃지 않는지 확인합니다. 자동 회귀를 실제 Drive 삭제 성공으로 판정하지 않습니다.

## 실제 리더 입력·형식·cold-open

- [1.8.37](updates/update_1.8.37.md#검증)의 Android/iPad 터치·PDF 확인, [1.8.33](updates/update_1.8.33.md#실기기-검증-상태)의 관성 스크롤·장 경계, [1.8.20](updates/update_1.8.20.md#실기기-확인-방법)/[1.8.22](updates/update_1.8.22.md)의 같은 긴 EPUB cold-open 재확인을 함께 진행합니다. 이전 [1.6.0](updates/update_1.6.0.md)/[1.6.6](updates/update_1.6.6.md)의 형식별 기기 확인도 최신 빌드에서 판정합니다.
- 다음 작업: 임시 슬라이더 연속 이동·정밀 감도·확인/취소·메뉴 이동·미리보기, TXT/EPUB 페이지·스크롤 경계, PDF/ZIP/CBZ/7z의 첫 열기·저장 위치·확대/pan·회전·재열기를 확인합니다. 같은 긴 EPUB의 느린/빠른 section 진단 JSON을 비교합니다.
- 320px 액션 배치, long press와 스크롤 구분, 키보드/safe-area, 가로 여백 탭과 선택적 두 페이지 회전도 확인합니다. [키트의 Safari blur 제한](../ui-kit/README.md#1837-공통-ui-갱신)은 앱 portal 모달과 구분해 기기에서 판정합니다.
- 완료 조건: 실제 기기/OS/브라우저/PWA·빌드별 결과와 cold-open 비교를 남기고 미확인/생략을 명시합니다.

## 카탈로그·표지의 남은 운영 확인

- [1.8.14 남은 기기 게이트](updates/update_1.8.14.md#남은-실제-기기-게이트)의 모바일/PWA 재실행·완전 offline 및 다음 generation의 게시 중 단절/manifest rollback이 남아 있습니다. [1.8.15](updates/update_1.8.15.md)의 public 요청·저장/delta·배포 확인은 당시 완료 기록이 있습니다.
- 다음 작업: 실제 모바일/PWA에서 정보창 요청·표시와 cached second load/offline을 확인합니다. 다음 실제 카탈로그 변경 때 immutable generation 전환·게시 단절·직전 manifest 복귀를 검증합니다. [1.8.29](updates/update_1.8.29.md)/[1.8.30](updates/update_1.8.30.md)의 TXT·fallback 표지가 성공한 도서 열기→서재 복귀 뒤 로컬 캐시에서 유지되는지 확인합니다.
- 완료 조건: 모바일/PWA 결과, 카탈로그 failure-path 게시/복귀 증거, 표지 lifecycle 결과를 각각 기록합니다. 게시기 자동검증을 실제 운영 장애 경로 통과로 간주하지 않습니다.

## 간헐적 EPUB 첫 페이지 열기의 실제 원인

- [1.8.37의 방어와 진단](updates/update_1.8.37.md#시작-위치-복원-검증과-경량-진단)은 좌표 없는 CFI/실제 이동 거부를 재현한 결과입니다. 특정 사용자 도서의 간헐적 원인은 미확정입니다.
- 재방문 조건: 문제가 다시 발생하면 통계 화면의 진단 JSON에서 `readerResumeFailures`를 확보하고 해당 도서·기기·저장 위치 조건으로 재현합니다. 정상 읽기 전체 로그를 상시 추가하지 않습니다.
- 완료 조건: 실제 trigger를 특정해 회귀로 검증하거나 확보한 제한적 증거와 아직 미확정인 범위를 명시합니다.

## 조건부 보류와 완료 근거 확인

- **독서 데이터 Retention/compaction:** [1.8.9 보류 판정](updates/update_1.8.9.md#현재-보류-판정)에 따라 observe-only입니다. 실데이터·90일 offline 복귀, authoritative snapshot/통계 동등성·rollback·구버전 재접속 증거, server watermark와 export/계정 삭제 호환성이 갖춰질 때 migration 여부를 검토합니다. 기준은 [planStorageMaintenanceMigrationV1](../src/lib/storageMaintenanceDiagnostics.ts)이며 자동 삭제는 활성화하지 않습니다.
- **카탈로그 delta compaction:** [1.8.15 보류·후속 버전](updates/update_1.8.15.md#보류후속-버전)의 별도 후속입니다. 재방문 조건은 요청형 delta가 크기 한도에 가까워질 때이며, 그때 Firestore on-demand 원본에서 base catalog를 재생성하는 별도 compaction release를 계획합니다. 후속 완료·폐기의 명시적 근거는 찾지 못해 조건부 보류로 보존합니다. 독서 데이터 Retention/compaction과 별개이며 즉시 구현할 작업으로 전환하지 않습니다.
- **NovelPia 인증 대상:** [1.8.15 Phase G](updates/update_1.8.15.md#phase-g--optional-auth-provider)의 코드는 완료되어 public-only 릴리스와 분리되어 있습니다. 실제 필요와 계정 설정이 생기면 CAPTCHA·성인 모드·session 검증과 secret 비노출을 별도 수용 확인합니다. 그 전에는 인증 대상 성공으로 판정하지 않습니다.
- **도서 정보 외부 리뷰 완료 근거:** [1.8.11의 대기 상태](updates/update_1.8.11.md)와 후속 전체 리뷰 기록을 대조해 이 gate의 완료/이관 근거를 확인합니다. 이번 문서 대조에서 기능에 연결된 명시적인 sign-off는 찾지 못했습니다. 완료 증거가 있으면 이 항목을 제거하고, 없다면 필요한 리뷰 범위를 확인해 남깁니다.
- **대형 파일 Worker·ready queue:** [1.7.8 보류 가이드](updates/update_1.7.8.md#보류-가이드)에 따라 실제 TXT/대량 이미지의 시간·메모리·취소 지연을 계측한 뒤 추가 Worker 이관을 재검토합니다. 현재 7z Worker나 Apple 모바일 ZIP 대체 경로를 미구현으로 취급하지 않습니다. 수천 건 outbox fixture에서 claim 비용이 문제가 될 때만 별도 ready queue를 검토합니다.
- **추가 진단 UI·복구 journal:** [1.7.9](updates/update_1.7.9.md#보류-가이드)의 추가 audit/진단 UI는 구체적 필요와 개인정보·보존 정책이 정해지면 재검토합니다. [1.7.6 리뷰 판정](updates/update_1.7.6.md#리뷰-판정)의 paused/dead-letter UI는 오류 분류 안정화, [1.8.12 보류 항목](updates/update_1.8.12.md)의 추가 충돌 계측은 리뷰/기기 증거가 조건입니다. iPad suspension이 IndexedDB commit을 끊는 증거가 있을 때만 일반 복구 journal을 검토합니다. 이미 구현된 통계 draft·경량 진단을 중복 구축하지 않습니다.
- **CSP 강제:** [1.7.8 보류 가이드](updates/update_1.7.8.md#보류-가이드)의 report-only 위반 수집, Google/Firebase/Drive/blob-worker 허용 경로 정리와 기기 확인을 먼저 수행해야 합니다. 호환성 근거 없이 CSP enforcement를 활성화하지 않습니다.
- **동기화 검증 환경·책갈피 깜빡임:** [1.8.13](updates/update_1.8.13.md#phase-f--observability와-multi-context-gate)의 격리 Auth/Firestore 다중 context 검증은 당시 emulator 세팅 부족으로 제한됐습니다. Rules emulator 통과와 구분해 해당 경로의 완료 근거/필요 설정을 확인합니다. 같은 문서의 별도 책갈피 optimistic overlay는 실제 기기에서 의미 있는 깜빡임이 확인될 때만 재검토합니다.
- **기타 사용 근거가 필요한 확장:** [1.8.14 보류·후속](updates/update_1.8.14.md#보류후속-버전)의 추가 태그/필터와 [1.7.7 리뷰 판정](updates/update_1.7.7.md#리뷰-판정)의 추가 삭제 saga/복구 확장은 구체적 사용·보존/내보내기 요구가 생길 때 원 계획과 최신 구현을 먼저 대조합니다. 확정된 미완료 구현으로 간주하지 않습니다.
