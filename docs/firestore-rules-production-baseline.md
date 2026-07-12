# Firestore production Rules 기준선

## 상태

- 프로젝트: 아직 production project ID와 배포 Rules를 확인하지 않음
- 확인 날짜: 미확인
- Rules hash: 미확인
- 1.7.0 Rules 배포: **차단**

현재 개발 환경에는 production Firebase 자격 증명이나 배포된 Rules를 읽었다는 증거가 없다. 따라서 `firestore.rules`는 demo project emulator 검증용 후보이며 production에 배포하지 않는다.

## 릴리스 전 필수 절차

1. Firebase Console 또는 권한이 있는 CLI로 실제 project ID와 현재 배포 Rules를 읽는다.
2. 원문을 별도 안전한 위치에 백업하고 확인 시각과 SHA-256을 이 문서에 기록한다.
3. 기존 1.6.x v1 읽기·쓰기·삭제가 후보 Rules에서 유지되는지 demo emulator와 staging smoke test로 확인한다.
4. v1/v2 호환 Rules를 앱보다 먼저 배포하고 본인 접근 허용·다른 UID 접근 거부를 확인한다.
5. 배포 ID와 rollback 명령을 기록한 뒤에만 1.7.0 앱 배포를 허용한다.
