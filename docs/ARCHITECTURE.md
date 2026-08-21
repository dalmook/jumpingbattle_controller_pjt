# Architecture

## 목적과 경계

이 시스템은 고객용 Kiosk/예약 PWA, 직원용 Admin/POS, Cloudflare D1, 매장 Windows Bridge, Legacy Manager, MPOS, Naver Partner, 주차 서비스 사이의 상태를 조정합니다. 결제와 게임 제어는 브라우저의 화면 상태가 아니라 서버 원장과 명령 결과가 기준입니다.

## 논리 구조

~~~mermaid
flowchart TB
  subgraph Client
    K["Kiosk"]
    C["Customer Reserve / Member"]
    A["Admin / POS V2 / Remote"]
  end
  subgraph Cloud
    API["App Router APIs"]
    CORE["Domain services in db/"]
    D1[("D1")]
    CMD["commands"]
    PUSH["Push notifications"]
  end
  subgraph Store
    BR["Python Bridge"]
    MAN["Legacy Manager"]
    MP["MPOS LAN + vendor DLL"]
    PK["Parking HTTP adapter"]
  end
  subgraph External
    NAV["Naver Partner"]
    COL["Chrome Collector"]
  end

  K --> API
  C --> API
  A --> API
  API --> CORE
  CORE --> D1
  CORE --> CMD
  CMD --> BR
  BR --> MAN
  BR --> MP
  BR --> PK
  BR --> API
  CORE --> PUSH
  NAV --> COL
  COL --> API
  API --> COL
~~~

## Source of Truth

| 영역 | 기준 |
| --- | --- |
| Reservation, Visit, Hold, Payment, Attempt, Allocation | D1 |
| 브라우저 화면과 입력 중 draft | Browser local React state |
| command 요청·claim·ACK·result | D1 commands 및 관련 trace |
| 카드 승인 여부 | MPOS/VAN 결과와 D1 payment attempt reconciliation |
| 로컬 중복방지·장비 처리 흔적 | Bridge local transaction store |
| 게임 실제 실행 상태 | Manager 관측값을 Bridge가 정규화한 room state |
| Naver 예약 원본 | Naver Partner, 내부 반영 결과는 D1 |
| 주차 실제 할인 | 주차 서비스 결과, D1에는 요청·표시 상태 |
| 운영 설정 | D1 설정 테이블과 일부 지점별 코드 상수 |

## 예약에서 게임 시작까지

~~~mermaid
sequenceDiagram
  participant UI as Kiosk/Admin
  participant API as API
  participant DB as D1
  participant Bridge
  participant Manager
  UI->>API: 예약 선택 또는 현장 방문 생성
  API->>DB: Reservation/Visit/Hold
  UI->>API: quote, checkout, payment plan
  API->>DB: Payment/Allocation/Attempt
  API->>Bridge: 카드 또는 제어 command
  Bridge-->>API: ACK/result
  API->>DB: ledger와 상태 전이
  UI->>API: ready
  API->>Bridge: set_info
  Bridge->>Manager: 팀/인원/난이도
  Manager-->>Bridge: 적용 확인
  UI->>API: start
  API->>Bridge: start command
  Bridge->>Manager: 게임 시작
  Manager-->>Bridge: room running 관측
~~~

## 금융 불변조건

- 예약금, 혜택, 쿠폰, 이용권, 현장 결제는 서로 다른 allocation으로 추적합니다.
- 완료된 분할 결제는 다음 split 실패 시에도 보존합니다.
- USER_CANCELLED와 DECLINED는 명확한 terminal 결과로 취급할 수 있지만, dispatch 후 결과가 불명확하면 UNKNOWN으로 격리합니다.
- UNKNOWN은 승인 가능성이 남아 있으므로 새 승인 자동 실행과 무조건 reset을 금지합니다.
- 금융 상태를 화면의 remaining 숫자만으로 판정하지 말고 Payment/Attempt/Allocation 원장을 함께 확인합니다.

## 제어 불변조건

- command는 생성 시 target agent와 room을 고정합니다.
- Bridge ACK만으로 실제 게임 실행을 확정하지 않고 Manager 관측 결과를 확인합니다.
- set_info, ready, start는 각각 Visit/Game/Room/결제 guard를 통과해야 합니다.
- 동일 명령의 중복 생성과 늦은 ACK가 새 방문을 오염시키지 않도록 command ID와 visit ID를 유지합니다.

## 배포 단위

1. D1 migration
2. 웹/Sites 코드
3. Store Bridge 패키지와 config
4. Naver collector 확장
5. 필요 시 Manager mapping

각 단위의 버전과 호환성을 기록해야 하며, 웹만 새 버전이고 Bridge가 이전 버전인 상태를 정상으로 가정하면 안 됩니다.
