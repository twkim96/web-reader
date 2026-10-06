# 독서 통계

## 시간·날짜·회독

화면 독서와 TTS 시간을 구분해 도서별·날짜별·기간별로 집계합니다. 단순히 책이 열린 시간 전체를 독서 시간으로 세지 않습니다. 화면 독서는 실제 활동·가시성·포커스·idle 경계를 적용하고 모바일 포커스 차이는 별도 정책으로 처리합니다. TTS는 실제 발화 구간을 사용하며 대기·일시정지·숨김·임시 이동을 읽은 시간으로 누적하지 않습니다.

세션은 주기적 checkpoint와 로컬 draft로 복구합니다. owner/device/session 경계가 다른 draft를 덮거나, 저장 중 새 활동을 잃거나, 복구 때 같은 시간을 중복 집계하지 않아야 합니다. UTC 및 기기 시간 보정과 저장한 timezone offset으로 날짜 경계를 다룹니다. 정확한 세션 상한/idle/checkpoint 기준은 [readingStatistics.ts](../../src/lib/readingStatistics.ts)가 담당합니다.

끝에 도달한 진행률은 완독 후보일 뿐입니다. 사용자가 완독을 확인해야 회독이 닫힙니다. 두 기기의 동시 확인은 같은 논리적 회독으로 합치고 확인 기록이 새 독서 시간을 만들지 않습니다. 기간별 목록은 해당 기간에 실제 집계 시간이 있는 회독을 표시하며 시간 배분과 진행률/완독 사실은 구분합니다.

통계의 회독 숨기기는 기기별 localStorage 표시 정책입니다. 숨긴 session은 합계·도서/리더 누적 시간·export에서 제외하지만 원본 세션을 삭제하거나 다른 기기의 표시 정책으로 전송하지 않습니다. `readingStatisticsSessionVisibility`가 이 경계를 담당합니다.

## 저장·동기화·출력

세션은 계정별 IndexedDB에 보관하고 Firebase UID의 `readingStatsV1`으로 동기화합니다. 동기화 coordinator와 lease는 여러 탭의 같은 기록 처리 경합을 제어합니다. 실패한 전송은 기록을 없애지 않고 재시도 대상으로 남깁니다. 화면이 닫힌 뒤 복귀, 오프라인, 계정 전환은 세션 소유권을 유지해야 합니다.

통계 화면에서 Markdown·JSON과 지원되는 브라우저의 공유/독서 인증 이미지 기능을 제공합니다. 이 출력은 본문·전체 IndexedDB·인증정보의 백업이 아닙니다. 출력 파일의 계약은 `readingStatisticsExport`와 delivery 코드가 담당합니다.

## 진단

통계 화면의 **진단**은 저장소/동기화 요약 JSON을 내보냅니다. 본문과 메모를 넣지 않습니다. 시작 위치 복원 거부가 발생한 열기만 최근 8건, 직렬화 크기 제한 안에서 `readerResumeFailures`로 보관·출력합니다. 결과·시도 횟수·해시화한 목표·페이지/좌표 유무·화면 크기만 기록하고 원본 CFI·도서 ID·제목은 남기지 않습니다. 정상 열기는 이 실패 기록을 쓰지 않습니다.

진단의 `appBuild`는 앱 버전과 빌드 식별자입니다. 열기 성능 버퍼에는 해시화한 도서·목표·앵커, 요청 진행률과 실제 열린 진행률·페이지를 포함합니다. 진행률 불일치로 거부된 복원은 `readerResumeFailures`의 `progress-mismatch` 사유와 요청·최종 실제 진행률로 남깁니다. 정상 열기마다 영구 기록을 추가하지 않습니다.

Bootstrap 추적은 `?readerDebug=1` 또는 `reader_bootstrap_trace_v1` 설정으로 켜는 제한된 메모리 버퍼입니다. 열기 성능 추적(`readerOpenPerformanceTrace`)은 느린 cold-open 재현을 위해 debug 설정 없이 제한된 메모리 버퍼에 유지합니다. phase·시간·개수·크기와 해시화된 목표만 기록하며 본문·제목·원본 CFI는 넣지 않습니다. 실패 기록과 항상 실행되는 전체 로그를 혼동하지 않습니다. 진단에서 오래된 receipt/tombstone/이전 namespace가 보이더라도 삭제 가능하다는 뜻은 아닙니다. 정리 승인 조건은 [운영 가이드](../operations/deployment-and-recovery.md#저장과-복구)에 있습니다.

## 코드와 검증

- 수집/복구: [useReadingSessionTracker.ts](../../src/hooks/reader/useReadingSessionTracker.ts), `readingStatisticsDraft`, `readingStatisticsSessionVisibility`, `localReadingStatistics`
- 집계/회독: [readingStatistics.ts](../../src/lib/readingStatistics.ts), `readingStatisticsClock`
- 전송: `useReadingStatisticsSync`, `readingStatisticsSyncCoordinator`, `readingStatisticsSyncLease`, `readingStatisticsWake`
- UI/진단: [LibraryReadingStatisticsModal.tsx](../../src/components/LibraryReadingStatisticsModal.tsx), `storageMaintenanceDiagnostics`, [readerBootstrapTrace.ts](../../src/lib/readerBootstrapTrace.ts)
- 관련 검증: `npm run test:storage`, `npm run test:shelf`, `npm run test:browser:ci`와 실제 날짜/두 기기/백그라운드 수용 확인은 [TODO](../TODO.md)에서 구분합니다.
