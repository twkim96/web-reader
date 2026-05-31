# 업데이트 1.5.0

## 요약

iPad에서 챕터 전환 시 RIDI 바탕 폰트가 늦게 적용되는 현상을 줄이기 위해, 리더 본문이 원격 CDN 폰트 대신 앱에 포함된 로컬 폰트를 사용하도록 바꾸고 서비스워커 프리캐시에 해당 폰트를 추가했습니다.

## 변경 사항

- 앱 버전을 `1.5.0`으로 변경했습니다.
- Foliate 리더 본문에 주입되는 `RIDIBatang` 폰트 소스를 `/fonts/RIDIBatang.woff2` 우선, `/fonts/RIDIBatang.otf` 보조로 변경했습니다.
- 기존 클라이언트가 새 앱 셸 캐시를 받도록 서비스워커 캐시 이름을 `pc-reader-v1.5.0`으로 올렸습니다.
- `/fonts/RIDIBatang.woff2`와 `/fonts/RIDIBatang.otf`를 서비스워커 프리캐시 목록에 추가했습니다.
- 앱 전역 `@font-face`의 family 이름도 리더 본문과 동일한 `RIDIBatang`으로 정리했습니다.

## 범위

- Foliate 렌더러의 이동, 레이아웃 타이밍, 진행률 저장, 책갈피, 동기화 로직은 변경하지 않았습니다.
- 이번 릴리스는 선택한 RIDI 폰트의 원격 로딩 지연을 줄이고 오프라인/캐시 가용성을 높이는 데만 집중했습니다.

## 검증

- `./node_modules/.bin/eslint src/hooks/foliate/useFoliateLayout.ts public/sw.js` 통과.
- `npm run build` 통과.
- `npm run lint`는 기존 `public/foliate-js/vendor/zip.js` 벤더 번들 lint 오류로 실패합니다. 이번 변경 파일에서 발생한 오류는 아닙니다.
