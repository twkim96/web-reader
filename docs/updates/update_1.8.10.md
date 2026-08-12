# Web Reader 1.8.10 — TXT 목차 개선·누적 실사용 안정화

작성일: 2026-08-12

기준 커밋: `62ffb3c`

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

이전 버전: [update_1.8.9.md](./update_1.8.9.md)

상태: TXT 목차 개선 구현·전체 자동 gate 완료. 외부 코드 리뷰와 누적 실사용 검증 대기

## 버전 운영 원칙

- 실기기 테스트는 실제 독서와 병행하므로 일정을 이유로 추가 개발 전체를 멈추지 않는다.
- 새 개발은 영향 범위가 작고 독립 검증 가능한 편의성 개선만 포함한다.
- 실사용에서 재현된 결함은 원인별 `1.8.10-hotfix.N` 문서와 patch로 분리한다.
- 데이터 손실, 삭제 부활, 잘못된 자동 이동, 반복 충돌 알림은 다른 편의성 작업보다 먼저 수정한다.
- 1.8.9에서 남은 실기기 항목은 완료로 간주하지 않고 그대로 이어받는다.

## 1. TXT→EPUB 목차 첫 구절 표시

기존 TXT 변환은 약 3만 자 단위로 챕터를 나누고 모든 목차를 `Chapter N`으로 표시했다. 1.8.10부터 새로 변환하는 TXT는 다음 형식으로 표시한다.

```text
1. 첫 장의 시작 구절 일부…
2. 둘째 장은 전혀 다른 구절로…
```

구현 계약:

- 챕터 순서를 보존하기 위해 앞에 1부터 시작하는 번호를 유지한다.
- 챕터 시작부의 공백·줄바꿈은 한 칸으로 정규화한다.
- 처음 20 grapheme까지만 사용하고 더 길면 말줄임표를 붙인다.
- 한글 조합 문자·이모지 중간이 깨지지 않게 `Intl.Segmenter`를 우선 사용한다.
- 비어 있는 챕터는 기존 `Chapter N`으로 fallback한다.
- nav.xhtml과 각 챕터 `<title>`에는 XML escape한 같은 label을 사용한다.
- 이미 로컬에 저장된 TXT 변환 EPUB은 검사·마커·자동 재변환하지 않는다.
- 기존 도서에 새 목차가 필요하면 사용자가 삭제 후 원본 TXT를 다시 가져온다.

자동검증:

- `npm run check:full`: 통과
- ESLint: 오류 0, 기존 Foliate vendor 경고 2
- TypeScript·production build: 통과
- Node: formats 63/63, drive 49/49, archives 33/33, storage 255/255, shelf 66/66, Service Worker 9/9, release 3/3 — 합계 478/478
- Firestore Rules: 27/27
- Chromium/WebKit Playwright: 14/14
- production Chrome regression: 통과
- 20-grapheme 절단, 공백 정규화, 빈 내용 fallback 확인
- 새 EPUB의 목차·챕터 title과 XML escape 확인
- package·lockfile·Service Worker·Foliate runtime을 1.8.10으로 일괄 갱신하고 정합성 확인
- `git diff --check`: 통과

## 2. 1.8.9에서 이관한 누적 실사용 검증

- PC Chrome, iPad Safari 탭, iPad 홈 화면 PWA에서 실제 독서를 계속한다.
- 선택·하이라이트·메모·팔레트·책갈피·검색·내보내기·번역·TTS·통계를 한 흐름으로 반복한다.
- 양기기 동시 로그인, offline 편집, background, 강제 종료, PWA update 뒤 progress·bookmark·annotation·palette·statistics를 비교한다.
- 선택·현재 위치·현재 장 TTS를 20~30분 이상 재생하고 pause/resume/chapter transition과 통계 분리를 확인한다.
- 로그인 계정 로그아웃 성공·실패, 모바일 책장 액션 배치, 태블릿 가로 여백 탭과 2페이지 회전을 확인한다.
- Firestore Rules 배포 뒤 독서 통계 권한 경고가 사라지고 기존 pending session이 동기화되는지 확인한다.
- 최소 2~3일 실제 독서에서 데이터 손실, 삭제 부활, 이유 없는 자동 이동, 반복 충돌 모달이 재현되지 않아야 한다.

## 3. 완료 조건

- `npm run check:full`과 `git diff --check` 통과
- 외부 최종 코드 리뷰의 P0~P2 종료
- 누적 실사용 항목을 통과·보류·제외 중 하나로 판정
- 알려진 제한과 retention observe-only 정책 문서화
- 마지막 hotfix의 clean checkout·CI·배포 상태 확인 뒤 1.8.x 종료 판정
