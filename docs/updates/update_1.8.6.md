# Web Reader 1.8.6 선택·현재 위치 기본 TTS

작성일: 2026-08-09

기준 커밋: `6a2424f` (`feat(reader): complete 1.8.5 language tools`)

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

상태: 외부 코드 리뷰 finding 수정·전체 자동검증 완료, 코드 릴리스 마감 — 실기기 검증은 1.8.10 누적 안정화로 이관

## 목표

브라우저 Web Speech API를 이용해 사용자가 선택한 텍스트 전체 또는 현재 읽기 위치의 한 문장을 듣고, 문장 단위로 제어한다. 저장 annotation과 진행률 경로를 사용하지 않는 임시 queue·overlay로 구현한다.

## 포함

- 선택한 텍스트의 문장 queue 재생
- 현재 viewport 위치의 한 문장 재생
- 재생·일시정지·재개·중지
- 이전·다음 문장 수동 이동
- 선택 queue 안에서만 다음 문장 자동 재생
- 한국어·영어·일본어·자동 언어 설정
- 기기 voice 선택과 0.5~2.0 배속 설정
- `voiceschanged` 기반 voice 목록 갱신
- 현재 발화 문장의 Foliate 임시 overlay
- 책 전환·reader 종료·수동 페이지 이동 시 speech·overlay cleanup
- 미지원·빈 텍스트·speech error 상태 안내

## 제외

- 현재 장 전체 자동 queue
- TTS가 만드는 자동 페이지 이동
- TTS cursor·queue 영속 저장
- background·lock-screen 재생 보장
- cloud TTS와 API key
- 저장 하이라이트·메모 변경

## 핵심 계약

- `speechSynthesis.cancel()`은 reader가 소유한 utterance generation을 먼저 폐기한 뒤 호출해 cancel error continuation을 무시한다.
- TTS 문장 강조는 IndexedDB·outbox·Firestore에 저장하지 않는다.
- 임시 overlay는 별도 annotation id를 사용하고 기존 하이라이트 draw·tap·undo 계약에 참여하지 않는다.
- current-position TTS는 현재 문장 하나에서 끝나며 다음 문장은 사용자가 직접 누른다.
- selection TTS만 선택 범위 안에서 다음 문장으로 자동 진행한다.
- TTS 시작·문장 이동은 `goTo`, progress save, bookmark API를 호출하지 않는다.
- voice URI는 기기별 localStorage 설정이며 동기화 데이터에 포함하지 않는다.

## 구현 단계

1. 문장 분할·DOM Range queue·언어·voice 선택 pure policy
2. Web Speech adapter와 voice lifecycle
3. Foliate 임시 overlay adapter
4. `useReaderTts` generation·queue·cleanup
5. 선택 메뉴·reader toolbar·TTS controls
6. ViewerSettings migration과 1.8.6 release 표기
7. Node·production browser·전체 release gate
8. 외부 코드 리뷰 대기 전환

## 완료 조건

- 선택 듣기는 선택 범위 밖 문장을 발화하지 않는다.
- 현재 위치 듣기는 현재 viewport의 문장을 고르고 자동으로 다음 페이지로 이동하지 않는다.
- pause·resume·previous·next·stop이 한 utterance generation만 제어한다.
- 늦게 도착한 `end`, `error`, `voiceschanged`가 종료된 reader 상태를 되살리지 않는다.
- reader 종료·책 전환·수동 위치 이동 뒤 음성과 임시 overlay가 남지 않는다.
- TTS 전후 CFI·진행률·책갈피·저장 annotation이 바뀌지 않는다.
- voice가 늦게 로드되거나 선택 voice가 사라져도 언어에 맞는 fallback을 사용한다.

## 자동검증 계획

- 한글·영문·일문·혼합 문장 분할과 긴 문장 chunk
- 선택 Range queue 경계와 현재 위치 initial index
- voice 정렬·선택·언어 fallback·rate migration
- speech start·pause·resume·cancel·end·error generation
- 임시 overlay 생성·문장 교체·cleanup
- 선택 듣기와 현재 위치 듣기의 reader 위치 불변
- 44px controls와 좁은 viewport 배치
- `npm run check:full`
- `git diff --check`

## 구현 결과

- `Intl.Segmenter`와 punctuation fallback을 사용하는 문장 분할 정책을 추가하고, 긴 문장은 브라우저 발화 한도를 고려해 최대 1,000자 단위로 나눈다.
- EPUB DOM의 text node와 문장 offset을 Range로 다시 연결해 선택 범위 밖 문장을 queue에 넣지 않으며, 현재 위치 모드는 현재 section의 anchor 문장을 고른다.
- Web Speech adapter가 발화 언어·기기 voice·0.5~2.0배 속도를 적용하고 `voiceschanged` 뒤 voice UI를 자동 갱신한다.
- 선택 메뉴의 `듣기`는 선택 queue 안에서만 자동 진행하며, reader toolbar의 `듣기`는 현재 문장 하나를 읽고 다음 문장은 수동으로 이동한다.
- 재생·일시정지·재개·이전·다음·중지 controls와 현재 문장·queue 위치·오류 상태를 표시한다.
- 현재 발화 Range는 저장 annotation과 다른 임시 Foliate overlay로 표시하며, hit-test에서 제외해 형광펜 메뉴나 링크 동작을 가로채지 않는다.
- generation을 폐기한 뒤 browser speech callback을 처리해 이전 `end`·`error`가 새 queue를 변경하지 못하게 한다.
- 수동 reader 이동, 책 전환, reader 종료, 브라우저 뒤로가기, 번역·사전·설정·책갈피 등 다른 reader panel 진입 시 speech와 임시 overlay를 정리한다.
- TTS 경로는 `goTo`, 진행률 저장, 책갈피, annotation IndexedDB·outbox·Firestore를 호출하지 않는다.
- 앱·Service Worker·Foliate runtime release 표기를 1.8.6으로 맞췄다.

## 자동검증 결과

2026-08-09 기준 `npm run check:full`과 `git diff --check`가 통과했다.

| 검증 | 결과 |
| --- | ---: |
| ESLint | 오류 0, 기존 Foliate vendor 경고 2 |
| TypeScript | 통과 |
| formats | 58/58 |
| drive | 49/49 |
| archives | 33/33 |
| storage | 189/189 |
| shelf·설정·언어 도구·TTS policy | 51/51 |
| Service Worker | 9/9 |
| release version | 2/2 |
| Firestore Rules | 22/22 |
| Chromium·WebKit Playwright | 12/12 |
| production build | 통과 |
| production Chrome regression | 통과 |
| `git diff --check` | 통과 |

production Chrome regression은 Web Speech mock을 사용해 실제 소리를 내지 않고 선택 듣기, voice 지연 갱신, pause·resume·stop, 현재 위치 한 문장 종료, 수동 다음 문장, 임시 overlay 정리와 reader 위치 불변을 확인한다. 실제 voice 품질·user activation·백그라운드 동작은 자동검증 통과로 간주하지 않는다.

## 외부 코드 리뷰 후속 수정

리뷰의 P1 3건과 P2 4건은 현재 코드에서 재현 가능한 문제로 판단해 모두 수용했다.

- Foliate에 CFI key를 사용하지 않는 `addTransientOverlay()`·`removeTransientOverlay()`를 추가했다. TTS는 DOM Range와 전용 object key를 사용하므로 같은 CFI의 저장 하이라이트를 교체하거나 제거하지 않는다.
- transient overlay는 항상 non-interactive이며, 같은 Range에 저장 하이라이트와 함께 있어도 저장 하이라이트의 hit-test와 메뉴 동작을 유지한다.
- DOM text collector는 인라인 사이의 공백 text node, `<br>`, block·table cell 경계를 보존한다.
- `[hidden]`, `aria-hidden`, `display:none`, `visibility:hidden`, `content-visibility:hidden`, `rt`, `rp`의 텍스트는 발화 대상에서 제외한다. computed visibility는 element별로 cache한다.
- overlay 생성·제거는 완전한 best-effort 부가 경로로 분리했다. transient overlay API가 예외를 던져도 `speechSynthesis.speak()`와 controls lifecycle은 계속 진행한다.
- 자연 종료·오류·중지 시 generation을 폐기하고 overlay를 정리해 늦은 시각 효과가 다시 나타나지 않게 했다.
- 문서 끝 anchor는 첫 문장이 아니라 마지막 문장을 선택한다. stale Range 비교가 실패하면 첫 문장으로 추측하지 않고 visible anchor로 한 번 재시도한다.
- 실제 발화 시작 전에 일시정지를 눌러도 desired playback 상태를 보존하며, 늦은 `onstart`는 UI를 재생 중으로 되돌리지 않는다.
- 현재 위치 queue는 anchor 전후 최대 21문장만 DOM Range로 만들어 section 전체 문장의 live Range를 보관하지 않는다.
- 시작 전에 읽을 content·section·문장을 찾지 못한 오류는 selection menu와 독립된 reader TTS toast로 표시한다. 선택 queue 생성에 실패하면 기존 선택 메뉴도 닫지 않는다.

추가 회귀는 동일 CFI 저장 하이라이트 보존, 인라인 공백·`<br>`·table·hidden·CSS hidden·ruby text 추출, 문서 끝 anchor, 최대 21문장 window, transient overlay 예외 뒤 음성 시작, 지연 `onstart` pause, toolbar 시작 전 오류 toast를 검증한다.

## 실기기 검증 이관

다음 항목은 코드 완료 판정과 분리해 1.8.10 누적 안정화에서 확인한다.

- PC Chrome, iPad Safari, iPad 홈 화면 PWA의 voice 차이
- 한국어·영어·일본어·혼합 문장 발음과 sentence boundary
- 최초 user gesture, voice 지연 로드, 음성 다운로드 상태
- pause·resume·cancel 반복과 다른 오디오 interruption
- Bluetooth 출력 전환, background·foreground, 화면 잠금
- 책 전환·PWA update·reader 종료 중 cleanup

## 참고

Web Speech API의 `SpeechSynthesis`는 기기 voice 목록, queue, pause·resume·cancel을 제공한다. `getVoices()` 결과는 늦게 준비될 수 있으므로 `voiceschanged`를 함께 구독한다. `cancel()`은 현재 발화와 대기 queue를 즉시 제거하므로 generation 폐기와 임시 overlay 정리를 함께 수행한다.
