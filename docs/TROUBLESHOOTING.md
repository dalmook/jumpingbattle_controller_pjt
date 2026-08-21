# Troubleshooting

## 화면은 열리지만 데이터가 없다

1. API 응답 status와 error code 확인
2. D1 DB binding 이름 확인
3. migration 0000–0051 적용 여부 확인
4. 인증 session과 env 확인
5. 운영 DB를 로컬로 복사하지 말고 가상 fixture로 재현

## Bridge가 offline이다

- agent ID와 token이 cloud 설정과 같은지 확인
- heartbeat 시간과 capability 확인
- server URL, 방화벽, 시스템 시간 확인
- bridge-state.json을 임의 삭제하기 전에 처리 중 command가 없는지 확인
- armed와 simulate는 연결 여부와 별개임

## set_info 또는 start가 안 된다

- Visit/Game/Room 상태와 command ID 확인
- target agent와 room이 생성 시 고정되었는지 확인
- ACK와 실제 Manager 관측 결과를 구분
- Manager 창 제목, 설치 경로, room/map stable mapping 확인
- 결제 완료 guard와 unresolved UNKNOWN 여부 확인

## 카드 결제가 UNKNOWN이다

- 같은 결제를 새 attempt로 자동 재실행하지 않음
- transaction UUID, dispatch 시각, Bridge local transaction store, MPOS 승인내역을 대조
- USER_CANCELLED/DECLINED terminal 결과와 network timeout을 구분
- 승인 여부가 확인될 때까지 직원 확인/reconciliation 유지
- 운영 로그를 GitHub issue에 첨부하지 않음

## Naver 예약이 누락되거나 취소가 남는다

- collector service worker와 alarm 상태
- Partner 로그인/session 만료
- outbox와 import source state
- Naver 상태 mapping과 cancellation event
- business ID와 room별 biz item ID
- site import endpoint와 agent token
- 동기화 지연 중 기존 Visit/Hold가 있는지 확인

## 주차가 실패한다

- 주차 계정은 Store Bridge에만 설정
- base URL, lot area, member ID 확인
- dry run인지 확인
- session expired와 ambiguous result 구분
- 불명확한 save 응답 뒤 할인내역을 재조회하고 무조건 재등록하지 않음

## Kiosk가 다음 고객을 받지 못한다

- active Visit, Hold, Payment, Attempt, pending command 확인
- UNKNOWN/PROCESSING은 금융 보호 상태일 수 있음
- USER_CANCELLED/DECLINED terminal인지 확인
- admin cleanup policy가 삭제를 막는 이유 확인
- 브라우저 reset만 하고 D1 원장을 남겨두는 조치를 피함

## 빌드 실패

- Node 22.13 이상
- pnpm lockfile 그대로 설치
- .openai/hosting.json 존재와 DB binding 확인
- 생성 폴더 .next, .vinext, dist, .wrangler를 삭제할 때 작업 루트가 맞는지 먼저 확인
