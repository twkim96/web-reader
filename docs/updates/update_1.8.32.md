# Web Reader 1.8.32 — 메뉴 글래스 재질 개편

작성일: 2026-08-22

기준 커밋: `48456000a6b99e1fcb0533c410408403e098b671`

상위 계획: `docs/updates/update_1.8.x_plan.md`

## 목표

책장과 리더가 공유하는 메뉴 스타일을 `표준 / 글래스 / 모던` 3종으로 확장한다.

- `표준`은 1.8.31까지의 기존 글래스 외형을 그대로 보존한다.
- 새 `글래스`는 ci.me 상단 바에서 확인한 저투명·저블러 유리 재질을 사용한다.
- `모던`은 기존 Muzio 계열 외형과 동작을 그대로 유지한다.
- 메뉴 버튼, 액션, 순서, 크기, 배치와 PC/모바일 전환 동작은 변경하지 않는다.

## 리뷰 판정

| 항목 | 판정 | 계약 |
| --- | --- | --- |
| 메뉴 스타일 3종 | 수용 | `glass / standard / modern` |
| 기존 글래스의 표준화 | 수용 | 기존 책장·리더 글래스 구현을 `standard` 분기로 이동 |
| ci.me 재질의 새 글래스 | 수용 | 20% dark surface, 4px blur, 10% shadow, 1px gradient rim |
| 기본 메뉴 스타일 | 수용 | 새 설치·누락·잘못된 값은 `standard` |
| 기존 `glass` 저장값 마이그레이션 | 제외 | 개인용 앱이므로 별도 migration marker나 rewrite를 만들지 않음 |
| 버튼·메뉴 구조 복제 | 제외 | 현재 앱의 버튼·메뉴 DOM과 동작을 그대로 유지 |
| 모던 재설계 | 제외 | 기존 `shelf-muzio-dock`과 reader modern surface 유지 |

## 재질 계약

새 글래스 표면은 다음 값을 기준으로 한다.

- background: `rgba(20, 21, 23, 0.20)`
- backdrop blur: `4px`
- shadow: `0 4px 12px rgba(20, 21, 23, 0.10)`
- rim: 1px, 164deg white gradient
- Safari/PWA: `-webkit-backdrop-filter`와 `-webkit-mask-composite` fallback 포함
- 기존 요소의 border radius, width, height, padding, gap은 유지

## 명시적 제외

- 책장/리더 메뉴 액션 추가·삭제·재정렬
- 모바일 bottom dock과 desktop top dock 전환 로직 변경
- 리더 진행률·검색·책갈피·TTS 동작 변경
- 독서 테마와 커스텀 테마 데이터 구조 변경
- 저장값 schema version 또는 일회성 migration
- 외부 아이콘·이미지·스크립트 반입

## Phase 1 — 설정 계약 확장

상태: 완료

- `ShelfDockStyle`을 `glass | standard | modern`으로 확장한다.
- 기본값과 invalid fallback을 `standard`로 바꾼다.
- 테마 모달을 `표준 / 글래스 / 모던` 3개 선택지로 바꾸고 PC·모바일 모두 한 줄에 배치한다.
- 기존 `glass` 값은 그대로 새 글래스로 해석한다.

## Phase 2 — 공용 글래스 재질

상태: 완료

- 전역 CSS에 책장·리더가 함께 쓰는 글래스 surface class를 추가한다.
- 1px gradient rim은 pseudo-element로 만들고 현재 border radius를 상속한다.
- blur 미지원 환경에서도 반투명 배경은 남도록 한다.

## Phase 3 — 책장·리더 적용

상태: 완료

- 책장 dock에서 기존 glass branch를 `standard`로 이동한다.
- 새 glass branch에는 공용 글래스 surface만 적용한다.
- 리더 top chrome과 bottom toolbar의 모든 surface에 같은 분기를 적용한다.
- modern 분기는 수정하지 않는다.

## Phase 4 — 버전·검증

상태: 완료

- app/service-worker/Foliate runtime cache를 `1.8.32`로 맞춘다.
- 설정 정규화, reader surface, shelf browser regression과 release version 검증을 갱신한다.

## 완료 조건

- 설정 화면에 `표준 / 글래스 / 모던`이 한 줄로 표시된다.
- 초기값과 invalid 저장값은 `standard`다.
- 기존 `glass` 저장값은 migration 없이 새 글래스를 선택한다.
- 표준은 기존 글래스의 책장·리더 재질을 유지한다.
- 새 글래스는 책장·리더 모두 20% surface, 4px blur, gradient rim을 사용한다.
- 모던 외형과 메뉴 버튼/배치/동작에 회귀가 없다.
- app/service-worker/Foliate runtime release version이 `1.8.32`로 일치한다.

## 자동검증 계획

- `npm run test:shelf`
- `npm run test:shelf-ui`
- `npm run test:release`
- `npm run typecheck`
- `npm run build`
- 관련 browser regression으로 PC top dock과 390px bottom dock의 3개 스타일 전환 확인
- `git diff --check`

## 실기기 테스트 계획

- PC Chrome: 책장 top dock 3종 전환과 저장 확인
- Android/모바일 Chrome: bottom dock의 형태·버튼 수·가로 overflow 불변 확인
- iPad Safari/PWA: blur와 gradient rim, safe-area, reader top/bottom chrome 확인
- 다크·라이트·세피아에서 아이콘과 텍스트 대비 확인

## 구현 결과

- `ShelfDockStyle`을 `glass | standard | modern`으로 확장하고 기본값과 invalid fallback을 `standard`로 변경했다.
- 별도 migration 없이 기존 저장값 `glass`는 새 저블러 글래스로, 기존 외형은 새 값 `standard`로 연결했다.
- 테마 모달의 선택지를 `표준 / 글래스 / 모던` 순서의 3열 grid로 바꿨다.
- 책장 top/bottom dock과 리더 top/bottom surface에 공용 `viewer-cime-glass` 재질을 적용했다.
- 기존 글래스의 책장 24px blur와 리더 28px blur surface는 `standard` 분기로 보존했고 `modern` 분기는 유지했다.
- app, service worker, Foliate runtime cache 버전을 `1.8.32`로 맞췄다.

## 자동검증 결과

- `npm run check`: 통과
  - ESLint 오류 0건, 기존 경고 4건
  - TypeScript, 전체 Node 회귀, Next.js production build 통과
- `npm run test:browser:ci`: 통과
  - 3종 선택, 글래스 20% surface/4px blur/gradient rim, 표준 24px blur, 모던, service worker `pc-reader-v1.8.32` 확인
- 집중 검증 `npm run test:shelf`, `npm run test:shelf-ui`, `npm run test:release`: 통과
- 로컬 브라우저 시각 확인:
  - PC: `표준 / 글래스 / 모던`의 top 좌표가 모두 같고 3열 유지
  - 390px: 세 선택지의 top 좌표가 모두 같고 약 97px씩 3열 유지
  - 새 글래스 computed style이 `rgba(20, 21, 23, 0.2)`, `blur(4px)`, 164deg rim과 일치
- `git diff --check`: 통과

## 실기기 검증 결과

자동 브라우저 검증 완료. Android Chrome과 iPad Safari/PWA 실기기 검증은 대기.

## 보류·후속 버전

- 실제 iPad/PWA blur와 mask 합성은 자동 브라우저 검증과 별도로 실기기 확인한다.
