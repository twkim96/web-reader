# 리더와 진행률

## 읽기와 시작 위치

`EpubReader`는 EPUB/TXT·PDF·이미지 압축 도서의 공통 화면입니다. EPUB/TXT에는 페이지·스크롤 이동, 목차·본문 검색·CFI/% 이동과 본문 스타일을 제공합니다. PDF와 이미지 압축 도서는 고정 레이아웃 경로를 사용하며 텍스트 선택·주석·TTS를 활성화하지 않습니다. 고정 레이아웃 확대·이동 제스처의 시각 계약은 [화면 사양](interface.md)에 있습니다.

저장된 위치를 여는 것만으로 진행률이나 `lastRead`를 갱신하지 않습니다. EPUB CFI 이동은 목표 좌표와 실제 도달 여부를 확인해야 합니다. 좌표가 없는 목표나 존재하지 않는 CFI 범위를 첫 페이지의 성공으로 바꾸지 않습니다. 로딩 중에 저장 위치·대체 앵커를 최대 두 차례 순회하고 복원에 실패하면 오류를 알린 뒤 서재로 돌아갑니다. 읽기를 시작한 후 지연된 재시도로 사용자를 이동시키지 않습니다.

리더는 활성 계정의 로컬 진행률 복원이 끝난 뒤에만 생성합니다. 느린 인증으로 임시 게스트 서재가 먼저 열렸더라도 로그인 계정으로 전환해 진행률을 읽는 동안에는 로딩 화면을 표시합니다. 복원 전의 빈 CFI를 리더 시작 위치로 고정하지 않습니다. 이 준비 조건은 첫 자동 열기와 계정 전환 뒤 이미 열려 있던 도서의 재생성 모두에 적용합니다.

저장 진행률이 5% 이상인데 복원 직후 실제 진행률이 0.1% 이하라면, 엔진이 이동 성공을 반환해도 복원 거부로 처리하고 같은 대체 앵커·재시도 경로를 사용합니다. 정상적인 첫 위치 저장·열기는 허용합니다. CFI와 진행률이 이미 함께 0%로 덮인 기록은 이 검사만으로 복구할 수 없습니다.

재현한 렌더러 실패 경로에 대한 방어가 구현되어 있지만 실제 사용자 도서의 간헐적 첫 페이지 열기 원인은 아직 확정하지 않았습니다. 재발 시 필요한 최소 기록은 [진단](reading-statistics.md#진단)에 있습니다.

## 저장·책갈피

실제 사용자 이동 후 유한한 진행률만 저장합니다. 일반 페이지/스크롤 이동은 멈춘 뒤 저장하고 연속 이동에도 저장 간격 상한을 둡니다. 명시적 이동은 이동 후 위치가 안정화된 뒤 저장하며, 화면 숨김·종료는 남은 일반 저장을 flush합니다. 정확한 타이밍 값은 `useReaderProgressSave`의 상수를 기준으로 합니다.

외부 flush와 현재 위치의 강제 저장도 미저장 사용자 이동이 있어야 기록합니다. 저장할 변경이 없으면 flush는 성공으로 반환하되 복원·레이아웃 변경으로 관측된 위치를 저장하지 않습니다. 임시 이동 확인은 별도의 명시적 확정 경로이며 이 제한 때문에 차단하지 않습니다.

저장 직전에 리더 생성 당시의 owner와 generation이 여전히 활성인지 확인합니다. 계정 전환 후 이전 리더의 종료 저장·대기 저장이 새 계정 진행률에 들어가지 않아야 하며, 같은 계정으로 돌아와도 이전 generation의 저장 요청은 되살리지 않습니다.

목차·검색·책갈피·CFI/% 이동은 **이동 후 위치**를 최신 진행률로 사용합니다. 이동 전 위치는 필요할 때 로컬 자동 책갈피에만 남깁니다. 수동 책갈피는 Firebase 계정으로 동기화하고 자동 책갈피는 기기 로컬 기록으로 유지합니다. 원격 수동 책갈피 갱신은 로컬 자동 책갈피를 지우지 않습니다.

## 진행률 슬라이더의 임시 이동

드래그 중에는 독립 소스로 본문/페이지 미리보기를 추출합니다. EPUB/TXT는 장 내부 문자 비율을 사용하므로 실제 페이지 첫 문장과 정확히 같지는 않습니다. PDF·압축 도서는 페이지 이미지를 보여 줍니다. 추출 요청은 지연·직렬 실행·취소와 URL 해제로 오래된 결과와 자원 누적을 막습니다.

슬라이더를 놓으면 본문은 선택 위치로 이동하고 확인 패널을 표시합니다. 확인 전에는 새 위치를 저장·동기화하지 않으며, 자동/강제/종료 저장과 외부 flush·원격 위치 채택을 막습니다. 다른 리더 메뉴 이동도 같은 임시 세션에서 직렬로 처리합니다. 여러 번 움직여도 최초 출발 위치를 유지합니다.

- 확인: 실제 임시 위치 저장에 성공한 뒤 임시 상태를 종료합니다. 최초 출발 위치와 5%p를 초과해 달라졌다면 출발 위치의 자동 책갈피를 남깁니다.
- 취소: 최초 CFI/진행률 복원에 성공한 뒤 임시 상태를 종료하고 기존 대기 저장을 복구합니다.
- 실패: 재시도할 수 있게 임시 상태와 오류를 유지합니다. 수동 책갈피 편집은 독립적으로 보존합니다.

확인 패널은 바깥 클릭으로 닫히지 않는 비모달 안내이며 배경 메뉴·키보드 포커스를 가두지 않습니다. 진행바의 정밀 입력은 `ReaderToolbar`의 pointer layer가 담당하며 수직 감도 전환 중 위치가 튀지 않아야 합니다.

## 동기화와 충돌

진행 상태의 소유자는 Firebase UID입니다. Drive 연결·해제·계정 교체는 진행률 listener/outbox/conflict를 바꾸지 않습니다. 저장 이벤트는 IndexedDB outbox를 거쳐 Firestore revision 비교와 event receipt가 있는 transaction으로 적용됩니다. 같은 이벤트 재시도는 중복 적용하지 않고 초기화·삭제는 tombstone으로 표현합니다.

다른 기기의 최신 진행률은 사용자 활동과 현재 위치·충돌 상태를 함께 판단합니다. 안전한 근접/동등 위치만 정책에 따라 조용히 정리하고, 명시적 결정이 필요한 위치는 확인을 요청합니다. 원격 이동은 preview → 안정된 실제 이동 → revision 확인/확정 순서를 지킵니다. 실패·사용자 입력 중단·더 최신 원격 revision에는 rollback/재평가가 필요합니다. 수락한 원격 이동은 이동 후 위치를 현재 기기가 이어받으며, 이전 위치를 최신 진행률로 되쓰지 않습니다.

## 코드와 검증

- 엔진: [openFoliateBook.ts](../../src/hooks/foliate/openFoliateBook.ts), `useFoliateNavigation`, `useFoliateLayout`, [paginator.js](../../public/foliate-js/paginator.js)
- 저장/임시 이동: [useReaderProgressSave.ts](../../src/hooks/reader/useReaderProgressSave.ts), [useReaderProgressSlider.ts](../../src/hooks/reader/useReaderProgressSlider.ts), `useReaderBookmarks`, `ReaderToolbar`, `ProgressContentPreview`
- 원격: `useProgressActions`, `useProgressSync`, `useRemoteProgressPrompt`, `remoteProgressAdoption`, [syncConflictPolicy.ts](../../src/lib/syncConflictPolicy.ts), `progressSyncTransaction`, `syncOutboxV5`
- 관련 검증: `npm run test:storage`, `npm run test:shelf`, `npm run test:shelf-ui`, `npm run test:epub-sandbox`; 실제 두 기기/foreground 확인은 [TODO](../TODO.md)에 있습니다.
