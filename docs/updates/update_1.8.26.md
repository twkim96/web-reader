# Web Reader 1.8.26

## 목표

1.8.23 진행바 pointer 입력 통일 이후 Android Chrome/PWA에서 진행률 트랙을 짧게 탭하면 이동 확인 모달이 나타난 직후 사라지는 회귀를 수정한다. iPad/PC, 길게 누르기, 드래그는 정상이다.

## 원인

진행률 탭은 `pointerup`에서 즉시 pending move를 만들고 확인 모달을 렌더한다. Android는 같은 짧은 탭의 후속 합성 `click`을 새로 렌더된 backdrop에 전달할 수 있다. 기존 모달은 backdrop의 단순 `click`만으로 취소했기 때문에 모달이 열린 직후 다시 닫힐 수 있었다.

## 수정

- backdrop dismiss를 단순 `click`에서 pointer-origin 기반으로 변경한다.
- backdrop 자체에서 `pointerdown`이 시작되고 같은 pointer가 backdrop에서 `pointerup`된 경우에만 취소한다.
- 모달이 열린 뒤 도착한 고아/ghost `click`은 취소 조건이 되지 않는다.
- 취소/확인 버튼, drag, long-press, iPad/PC 진행바 동작은 변경하지 않는다.

## 회귀 검증

- progress track 짧은 탭이 한 번에 pending move를 만든다.
- pending modal 직후 backdrop에 `click`만 도착해도 pending move가 유지된다.
- 실제 backdrop pointer-down/up은 정상적으로 취소한다.
- 기존 임의 위치 drag와 메뉴 스타일 회귀를 유지한다.

## 버전/캐시

- 앱 버전: `1.8.26`
- Service Worker cache: `pc-reader-v1.8.26`
- Foliate 코드 자체는 변경하지 않아 runtime revision은 기존 값을 유지한다.
