# Naver Reservation Collector

Chrome Manifest V3 service worker가 Naver Partner 예약 변경을 수집하고 내부 import API로 전달하며, room별 재고를 동기화합니다.

## 파일

- manifest.json: 권한과 host permission
- sw.js: durable queue, 상태 mapping, import/stock sync
- fast-trigger.js: Partner 화면 변경 감지
- state-harness.test.cjs: service worker 상태 회귀

## 공유본 설정

sw.js와 manifest의 다음 값은 실제 운영값이 아닙니다.

- your-site.example
- REPLACE_WITH_RESERVATION_WEBAPP_ID
- REPLACE_WITH_KIOSK_WEBAPP_ID
- Naver business ID 1000000
- room별 biz item ID 1000001–1000004
- __JUMPING_AGENT_TOKEN__

지점 배포 파이프라인에서 실제 값을 주입하고, cookie/CSRF/session을 소스나 설치 ZIP에 고정하지 않습니다.

## 설치본 생성

프로젝트 root의 .env에 개발 agent token을 넣은 뒤:

    pnpm run build:naver-collector

생성 위치 work/runtime/naver-collector는 Git에서 제외됩니다. 빌드 결과에는 token이 들어가므로 비밀 artifact로 취급합니다.

## 검증

    node naver-collector/state-harness.test.cjs

고객 취소, 관리자 취소, 변경, outbox 재전송, full reconcile, session 만료를 구분합니다. 운영 Partner 계정 자동조작은 별도 승인이 필요합니다.
