# Branch Configuration

## 분리 관점

- Common Core: 예약, Visit, 결제 원장, 상태 전이, command, reconciliation
- Branch Configuration: 방, 난이도, 가격, 운영시간, 결제수단, Naver/주차/Manager mapping
- External Adapter: Naver collector, MPOS LAN, 주차 HTTP, Legacy Manager

현재 코드는 이 세 층이 완전히 분리되어 있지 않습니다. 이번 공유본은 대규모 리팩터링을 하지 않고 실제 위치를 문서화했습니다.

## 지점별 변경 지점

| 항목 | 현재 주요 위치 | 저장 방식 | 새 지점 작업 |
| --- | --- | --- | --- |
| 지점명/PWA | app/layout.tsx, 각 manifest, metadata | 코드 | 표시명과 scope 검토 |
| 방 구성/순서 | app/reservation-config.ts, Admin의 일정 상수 | 코드 | 모든 소비자와 테스트 동시 변경 |
| 난이도/맵 | app/reservation-config.ts, Bridge Manager mapping | 코드 + Manager | stable code 기준 매핑 |
| 가격 | db/pricing.ts, Admin settings, D1 | D1 중심 + fallback | 기본값과 운영 row 구분 |
| 결제수단 | db/kiosk-payment-settings.ts | D1 | 카드/현금/계좌/혜택 정책 |
| 계좌 | D1 kiosk payment settings | D1 snapshot | 환경이나 migration에 실계좌 금지 |
| Naver | db/naver-stock.ts, naver-collector/sw.js | 코드/확장 설정 | business와 biz item ID 설정 |
| Parking | app/parking-config.ts, bridge/parking_service.py | 코드 + env | 허용 host와 매장 식별자 |
| 게임시간/자동종료 | reservation-config, remote-operations, Bridge | 코드 + Manager | 세 계층의 시간 의미 일치 |
| Manager mapping | bridge/jumping_bridge.py, bridge config | config + adapter | 방/맵 stable ID 검증 |
| Agent/Kiosk ID | db/control.ts, Bridge config, Kiosk session | config + fallback | 지점 고유 ID로 교체 |
| 알림 | db/push-notifications.ts, notification settings | env + D1 | VAPID와 수신 정책 분리 |

## 새 지점 추가 순서

1. 새 지점용 운영 DB와 Sites 프로젝트를 별도로 만듭니다.
2. .env와 Bridge config를 새 값으로 생성합니다. 기존 지점 파일을 복사해 커밋하지 않습니다.
3. app/reservation-config.ts의 방·난이도·운영시간을 검토합니다.
4. Admin 일정표의 방 순서와 Kiosk 추천/자동배정을 함께 검토합니다.
5. Naver business/biz item mapping을 새 지점 값으로 넣은 collector 설치본을 빌드합니다.
6. 주차 host/lot/member 정책을 별도 설정합니다.
7. Bridge의 agent ID, Manager 경로, room/map mapping을 진단 모드에서 확인합니다.
8. 가격과 결제수단은 D1 운영 설정에서 입력합니다.
9. Mock 결제와 simulate control을 통과한 뒤 제한된 실장비 검증을 합니다.
10. 웹, migration, Bridge, collector 버전을 한 배포 기록에 남깁니다.

## 현재 기술부채

- 방 코드와 순서가 UI/API/test 여러 곳에 중복되어 있습니다.
- 일부 외부 endpoint 허용 규칙이 코드 상수입니다.
- Naver business/biz item은 collector와 서버가 함께 알아야 합니다.
- Manager의 room/map mapping은 Legacy 프로그램의 구조와 결합되어 있습니다.
- 일부 지점 fallback이 migration에 들어 있어 새 지점에서는 새 migration 또는 seed 정책이 필요합니다.

향후 개선은 StoreProfile 하나를 Source of Truth로 두고 schema validation을 추가하는 방향이 적합합니다. 다만 결제 원장과 기존 migration을 한 번에 재작성하면 안 됩니다.
