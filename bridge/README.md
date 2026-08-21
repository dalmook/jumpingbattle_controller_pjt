# Store Bridge

Bridge는 Cloud command를 매장 Windows PC에서 받아 Legacy Manager, MPOS LAN, 주차 서비스에 전달하고 결과를 다시 서버에 보고합니다.

## 구성

- jumping_bridge.py: heartbeat, command poll/claim/ACK, Manager 제어
- payment_service.py: 카드 요청의 idempotency와 결과 정규화
- local_payment_server.py: 승인된 local fast lane
- parking_service.py: 주차 검색·할인·검증
- control_latency.py, latency_trace.py: 지연 관측
- mpos_lan/: MPOS adapter와 로컬 transaction store
- test_*.py: 장비 없는 회귀 테스트

## 시작

    copy bridge-config.example.json bridge-config.json
    python -B jumping_bridge.py --config bridge-config.json

처음에는 armed=false, simulate=true, mpos_enabled=false를 사용합니다. bridge-config.json은 커밋하지 않습니다.

## 안전

- command ID와 target agent를 변경하지 않습니다.
- 결과가 불명확한 카드 요청은 UNKNOWN으로 반환하고 자동 재승인하지 않습니다.
- Manager ACK와 실제 room 상태를 구분합니다.
- 로컬 DB와 로그에는 최소 정보만 남기며 GitHub에 올리지 않습니다.
- vendor DLL은 이 저장소에 포함되지 않습니다.
