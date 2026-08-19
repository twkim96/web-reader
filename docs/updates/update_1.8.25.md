# Web Reader 1.8.25

## 목표

1.8.24에서 리더까지 확장한 글래스 메뉴 스타일을 실기기에서 비교하기 위해 표면 투명도를 한 단계 높인다.

## 변경

- 리더 글래스 surface alpha를 `0.48`에서 `0.38`로 낮춘다.
- blur `28px`, saturate `1.32`, border alpha `0.24`는 유지한다.
- 모던 스타일은 1.8.24의 기존 리더 surface를 그대로 유지한다.
- 책장 글래스 스타일은 변경하지 않는다.

이 값은 실기기 비교용이며 필요하면 Git 롤백 또는 alpha 재조정으로 즉시 되돌릴 수 있다.

## 버전/캐시

- 앱 버전: `1.8.25`
- Service Worker cache: `pc-reader-v1.8.25`
- Foliate renderer 코드는 변경하지 않아 runtime revision은 `1.8.22.1`을 유지한다.
