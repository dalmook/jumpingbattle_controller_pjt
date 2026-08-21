# Testing

## 기본 검증

    pnpm test
    pnpm lint
    pnpm run build

pnpm test는 먼저 production build를 수행한 뒤 예약, 가격, 결제, 분할결제, reconciliation, 회원, 이용권, 쿠폰, Kiosk, 원격제어, 주차, migration, rendered HTML, Naver collector harness를 실행합니다.

## 선택 테스트

    pnpm run test:kiosk-operating-flow
    pnpm run test:local-direct

## Bridge

    python -m pip install -r bridge\requirements.txt
    python -B -m unittest discover -s bridge -p "test_*.py"

-B는 __pycache__ 생성을 막습니다. 테스트는 장비 없이 실행되는 mock 경로여야 합니다.

## 변경별 최소 회귀

| 변경 | 필수 테스트 |
| --- | --- |
| Reservation/availability | reservation-time, availability, import-source-state |
| Kiosk 상태 | kiosk-flow, kiosk-cleanup, kiosk-checkout-cancel |
| Payment | split/group/payment-ui/reconciliation/transport |
| Member/Pass/Coupon | members, member-benefits, member-coupons, pass-use |
| Bridge control | bridge-capabilities, control-readiness, remote-operations, Python bridge tests |
| D1 schema | 해당 migration test와 이전 migration 회귀 |
| Naver | state-harness와 import-source-state |
| Parking | parking-registration와 Python parking tests |

## 자동 테스트가 증명하지 않는 것

- 실제 MPOS 승인·거절·사용자 취소
- 승인 직후 네트워크 단절과 VAN reconciliation
- Legacy Manager UI와 실제 set_info/start/stop
- Naver 로그인 cookie와 운영 business 권한
- 실제 주차 계정과 할인 코드
- 실키오스크 해상도, 터치, 브라우저 정책

이 항목은 별도 승인된 실장비 검증표에서만 수행합니다. 카드 결과가 불명확하면 재시도하지 않고 UNKNOWN/reconciliation 절차로 이동합니다.

## Lint baseline

공유 시점 pnpm lint는 최신 React hook/purity 규칙을 중심으로 53 errors, 28 warnings의 기존 부채가 있습니다. 이번 공유 작업에서는 동작 중인 제품 코드를 대량 변경하지 않았습니다. CI는 lint 결과를 표시하되 비차단으로 두고, production build와 전체 회귀 테스트 및 Bridge 테스트를 차단 조건으로 사용합니다. 별도 lint 정리 PR에서 기능 회귀를 확인하며 줄여야 합니다.

## CI

.github/workflows/ci.yml은 Node build/test와 Python Bridge unit test를 분리합니다. 벤더 DLL과 운영 secret 없이 통과해야 공유 가능한 코드입니다.
