# 주석과 읽기 도구

## 선택·하이라이트·메모

텍스트 리더의 선택 메뉴에서 복사·공유·하이라이트·번역·사전·선택 TTS를 사용할 수 있습니다. PDF·압축 도서의 고정 레이아웃에는 이 선택/주석/TTS 경로를 활성화하지 않습니다. Clipboard·Web Share·브라우저 번역·음성은 브라우저 지원과 사용자 제스처에 영향을 받습니다.

주석은 도서·section·range CFI, 인용문과 앞뒤 문맥, 색·메모·진행률·시각을 저장합니다. 위치 복원 때 실제 텍스트 문맥이 맞는지 확인하고 맞지 않으면 `unresolved`로 유지합니다. 잘못된 곳으로 앵커를 임의 이동하거나 자료를 버리지 않습니다. 색별 이름/의미를 편집할 수 있으며 팔레트는 별도로 동기화합니다.

현재 주석은 책당 100개, 색당 20개로 제한합니다. 인용문·메모·CFI 등의 정확한 크기 제한은 [annotationPolicy.ts](../../src/lib/annotationPolicy.ts)와 동기화 schema가 기준입니다. 생성·삭제·필드 편집과 undo는 비동기 저장 결과 및 이후 편집을 보존해야 합니다.

## 저장·검색·내보내기

로그인 계정의 주석·팔레트는 IndexedDB에 먼저 저장하고 outbox/revision/receipt transaction으로 동기화합니다. 도서별 aggregate는 수량·중복 범위·삭제 generation을 검증합니다. 충돌·권한/용량 실패를 일반 성공으로 처리하지 않습니다. 삭제 marker와 tombstone을 제거하면 예전 원격 데이터가 되살아날 수 있으므로 [복구 가이드](../operations/deployment-and-recovery.md)를 따릅니다.

도서 안과 라이브러리 전체에서 인용문·메모·장·팔레트 의미를 검색하고 색·메모 여부·정렬로 찾을 수 있습니다. 라이브러리 검색 결과 이동은 기존 도서 열기/위치 복원 경로를 사용합니다. 내보내기는 Markdown과 버전이 있는 JSON(`web-reader-annotations`)을 지원합니다. JSON export가 IndexedDB/도서 파일을 포함하는 전체 백업이라는 뜻은 아닙니다.

## 번역·사전·TTS

번역은 브라우저 내장 Translator, Google Translate, Papago 경로를 선택합니다. 자동 모드에서는 브라우저 기능과 언어를 확인하고 외부 경로를 사용할 수 있습니다. 사전은 Naver Dictionary와 Wiktionary를 제공합니다. 외부 경로는 선택 텍스트를 포함한 URL을 열므로 사용자 동작 없이 자동 전송하는 처리로 바꾸지 않습니다. 언어·문자 수 제한은 [readerLanguageTools.ts](../../src/lib/readerLanguageTools.ts)가 기준입니다.

TTS는 `speechSynthesis` 기반으로 선택 구간과 현재 위치/장의 본문을 읽습니다. 음성·속도·장 끝 중지/다음 장·취침 타이머를 제공합니다. 재생 위치는 실제 발화 시작/진행과 연결하며 도서 교체·수동 이동·메뉴 열기·숨김/복귀·취소에는 기존 재생 수명을 정리합니다. 기기별 음성·문장 경계·백그라운드 지원은 동일하지 않으므로 자동검증만으로 Android/iPad 음성 동작을 완료 판정하지 않습니다.

## 코드와 검증

- 선택/앵커: `useReaderTextSelection`, `TextSelectionMenu`, [useReaderAnnotations.ts](../../src/hooks/reader/useReaderAnnotations.ts), `annotationOverlay`, `annotationPolicy`
- 저장/동기화: `localAnnotations`, `useAnnotationSync`, `annotationSyncSchema`, `annotationSyncTransaction`, `annotationBookDeletion`, `localAnnotationPalette`
- 검색/내보내기: `LibraryAnnotationModal`, `AnnotationModal`, [annotationQuery.ts](../../src/lib/annotationQuery.ts), [annotationExport.ts](../../src/lib/annotationExport.ts), `annotationExportDelivery`
- 언어/음성: `useReaderLanguageTools`, `browserTranslator`, [useReaderTts.ts](../../src/hooks/reader/useReaderTts.ts), `readerTts`, `readerTtsCursor`
- 관련 검증: `npm run test:storage`, `npm run test:shelf`, `npm run test:formats`, `npm run test:rules` 중 변경 영역을 선택합니다. 기기별 수용 확인은 [TODO](../TODO.md)에 있습니다.
