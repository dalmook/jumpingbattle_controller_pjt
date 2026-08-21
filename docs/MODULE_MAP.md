# Module Map

아래는 공유본 HEAD에 실제 존재하는 기능 기준입니다.

## Kiosk

- app/kiosk/KioskApp.tsx: 화면 상태, 고객 입력, 예약/현장/추가결제 흐름
- app/kiosk/kiosk-home.css 및 kiosk 관련 CSS: 세로형 키오스크 레이아웃
- app/api/kiosk/route.ts: Kiosk action 진입점
- app/api/kiosk/payment/wait/route.ts: 결제 결과 대기
- app/kiosk/admin-cleanup-policy.ts: 운영자 정리 가능 조건
- app/kiosk/payment-settings.ts: 공개 가능한 결제수단 설정 모델
- db/customer-flow.ts: Visit/Hold/Game/checkout와 주요 상태 전이
- db/kiosk-payment-settings.ts: 카드·현금·계좌와 거래별 계좌 안내 snapshot
- db/kiosk-payment-guards.ts: 결제 안전 guard

## Admin, POS V2, Admin Remote

- app/admin/ReservationsAdmin.tsx: 예약 일정, 상세, 결제, Manager 제어
- app/admin/v2/PosV2.tsx: POS V2 통합 화면
- app/admin/remote/RemoteOperationsConsole.tsx: Bridge/방/방문 원격 운영
- app/admin/kiosk/KioskOperations.tsx: Kiosk visit 조회와 복구
- app/api/admin/: 관리자 API
- db/remote-operations.ts: 원격 방문과 room 상태, command
- db/control.ts: agent heartbeat, command queue, ACK
- db/control-readiness.ts 및 db/bridge-capabilities.ts: 제어 가능성 판정

## Reservation

- app/api/reservations/route.ts: 고객 예약 API
- app/api/admin/reservations/route.ts: 운영자 예약 CRUD와 이동/복사/제어
- db/reservations.ts: 예약 원장과 조회
- db/customer-flow.ts: 예약을 Visit로 연결
- app/reservation-config.ts: 방, 난이도, 운영 시간의 현재 코드 설정
- db/availability.ts: 시간/방 가용성
- db/reservation-time.ts: 영업 시간대 계산
- db/import-source-state.ts: 외부 예약 반영 상태

## Naver Reservation

- naver-collector/manifest.json, sw.js, fast-trigger.js: Partner 화면 수집과 queue
- app/api/import/reservations/route.ts: 수집된 예약 import
- app/api/agent/naver-stock/route.ts: 재고 동기화 API
- db/naver-stock.ts: room과 Naver biz item mapping, slot
- naver-collector/state-harness.test.cjs: collector 상태 머신 회귀
- db/import-source-state.ts: 변경·취소 이벤트의 내부 반영

## Payment

- db/payments.ts: Payment와 transaction 처리
- db/payment-ledger.ts: 결제 원장과 allocation
- db/payment-intents.ts 및 db/payment-group.ts: 결제 계획과 그룹
- db/payment-reconciliation.ts: UNKNOWN과 외부 승인 매칭
- db/payment-transport.ts: Cloud/Local 전송 선택
- db/payment-latency.ts: 단계별 지연 trace
- app/api/admin/payments/route.ts: 운영자 결제 API
- app/api/agent/payment/route.ts: Bridge 결제 command
- app/api/agent/local-payment/route.ts: Local fast lane
- bridge/payment_service.py, bridge/local_payment_server.py: Store 결제 실행
- bridge/mpos_lan/: MPOS LAN adapter와 transaction store

## Bridge와 Manager Control

- bridge/jumping_bridge.py: polling, heartbeat, command dispatch, Manager 제어
- bridge/control_latency.py, bridge/latency_trace.py: 제어 지연 관측
- db/control.ts: Cloud command queue
- db/remote-operations.ts: set_info/start/stop와 room 상태
- app/api/agent/ack/route.ts, control/route.ts, heartbeat/route.ts: agent protocol

## Game Lifecycle

- db/customer-flow.ts: Visit 및 CustomerVisitGame lifecycle
- db/remote-operations.ts: PREPARING, READY, START와 command
- app/api/agent/auto-complete.ts: Manager 관측 기반 완료
- db/game-history.ts: 완료 게임 기록
- app/admin/game-history/: 조회와 CSV

## Parking

- app/parking-config.ts: 고객 브라우저 URL 허용 규칙
- db/parking.ts: 요청 상태와 운영 설정
- app/api/parking/register/route.ts: 고객 요청
- app/api/agent/parking/route.ts: Bridge 작업
- bridge/parking_service.py: 인증, 검색, 할인, 결과 검증
- bridge/test_parking_service.py 및 tests/parking-registration.test.mjs

## Member, Pass, Coupon

- db/members.ts, member-auth.ts, member-password.ts
- db/member-benefits.ts: 이용권/쿠폰 조회와 사용·복원
- app/api/member/: 고객 회원 API
- app/api/admin/members/ 및 member-benefits/: 운영자 API
- tests/members.test.mjs, member-benefits, member-coupons, pass-use, pass-purchase-credit

## Add-on Sales

- db/add-on-sales.ts
- app/add-on-allocation.ts
- app/api/admin/add-on-sales/
- tests/add-on-allocation.test.mjs

## Notification

- db/notifications.ts, db/push-notifications.ts
- app/admin/notifications/
- app/api/admin/notifications/
- app/api/push/ 및 app/api/agent/push-briefing/

## Operating Settings

- app/admin/settings/
- app/api/admin/settings/
- db/pricing.ts
- db/kiosk-payment-settings.ts
- db/parking.ts
- db/notification-schedule.ts

## D1와 Migration

- db/schema.ts: Drizzle schema
- drizzle/0000부터 0051까지: 운영 순서를 가진 SQL migration
- tests/migration-*.test.mjs: migration 회귀
- drizzle.config.ts: SQLite/D1 dialect 설정

기존 migration 파일은 수정하지 말고 새 번호를 추가합니다. 코드가 migration보다 먼저 배포되어 새 column을 요구하지 않도록 호환 순서를 설계해야 합니다.
