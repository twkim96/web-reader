# Web Reader 1.8.10 — TXT 목차 개선·누적 실사용 안정화

작성일: 2026-08-12

기준 커밋: `62ffb3c`

상위 계획: [update_1.8.x_plan.md](./update_1.8.x_plan.md)

이전 버전: [update_1.8.9.md](./update_1.8.9.md)

상태: TXT 목차 개선 및 hotfix.1~10 누적 안정화 구현, 전체 자동 gate 및 Rules 배포 완료. 누적 실사용 검증 진행

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
- [hotfix.1](./update_1.8.10-hotfix.1.md)에서 동일 session ID의 유효한 remote·local payload 충돌이 전체 통계 동기화를 막지 않도록 remote immutable 기록으로 수렴시켰다.
- [hotfix.2](./update_1.8.10-hotfix.2.md)에서 Android의 불안정한 `document.hasFocus()` 때문에 실제 터치 중에도 화면 독서 session이 시작되지 않던 경로를 실제 reader 입력·명시적 blur 상태로 분리했다.
- [hotfix.3](./update_1.8.10-hotfix.3.md)에서 리더에 계속 머물 때 통계가 최대 5분 동안 확정되지 않던 지연을 줄여 새 session을 1분마다 확정·동기화한다.
- [hotfix.4](./update_1.8.10-hotfix.4.md)에서 일반 화면 독서의 진행률 render가 활동 시각을 0으로 되돌려 최초 약 90초 이후 session을 폐기하던 상태 전이 결함을 수정했다.
- [hotfix.5](./update_1.8.10-hotfix.5.md)에서 통계 모달을 열 때 서버 증분 조회를 즉시 요청하고, 닫기 왼쪽에 수동 새로고침 아이콘과 마지막 서버 확인 시각을 추가했다.
- [hotfix.6](./update_1.8.10-hotfix.6.md)에서 책장·리더 검색 입력부를 모바일 48px, iPad·PC 68px로 줄여 키보드가 열린 좁은 화면의 독서·검색 결과 공간을 확보했다.
- [hotfix.7](./update_1.8.10-hotfix.7.md)에서 라이브러리 전체 주석 창을 통계 모달과 같은 폭·높이 정책으로 줄이고, 리더 하단 누적 독서 시간과 도서별 시작·완료일, 재독 회차, `전체 | 현재 | 완료` 필터를 추가했다.
- [hotfix.8](./update_1.8.10-hotfix.8.md)에서 높은 진행률 우선 규칙을 실제 outbox revision conflict로만 제한하고, 일반 원격 위치 수신은 진행 방향과 무관하게 처리하면서 원격 승자의 단일 화면 이동 계약을 유지했다.
- [hotfix.9](./update_1.8.10-hotfix.9.md)에서 모든 회차를 도서별 독립 번호로 명확히 표시하고 전역 회차 요약을 제거했으며, iPad 리더 메뉴를 Foliate iframe 내부 여백까지 포함한 실제 글자 끝선에 맞췄다.
- [hotfix.10](./update_1.8.10-hotfix.10.md)에서 99% 도달과 완료 확정을 분리하고, 사용자가 완료한 뒤 99% 미만의 실제 독서 기록이 생길 때만 다음 회차를 시작하도록 변경했다.
- Android·iPad 동일 Firebase 계정에서 양쪽의 신규 session이 오늘·주간·월간·도서별 통계로 수렴하는지 확인한다.
- 최소 2~3일 실제 독서에서 데이터 손실, 삭제 부활, 이유 없는 자동 이동, 반복 충돌 모달이 재현되지 않아야 한다.

## 3. 완료 조건

- `npm run check:full`과 `git diff --check` 통과
- 외부 최종 코드 리뷰의 P0~P2 종료
- 누적 실사용 항목을 통과·보류·제외 중 하나로 판정
- 알려진 제한과 retention observe-only 정책 문서화
- 마지막 hotfix의 clean checkout·CI·배포 상태 확인 뒤 1.8.x 종료 판정
