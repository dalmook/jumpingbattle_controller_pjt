# Jumping Battle Operations

Jumping Battle 매장의 예약, 결제, 키오스크, 운영자 화면, 원격 제어를 하나의 흐름으로 연결하는 운영 시스템의 개발자 공유본입니다. 실제 운영 코드를 기준으로 만들었으며 핵심 비즈니스 로직을 축약하거나 데모 구현으로 대체하지 않았습니다.

> 이 저장소에는 운영 비밀번호, 토큰, PIN, 고객 개인정보, 카드 승인정보, 운영 DB, SQLite, 로그, 백업, 세션 덤프, 벤더 DLL이 포함되지 않습니다. 예제값은 실제 운영에 사용할 수 없습니다.

## 처음 읽는 순서

1. docs/ARCHITECTURE.md — 전체 데이터와 제어 흐름
2. docs/MODULE_MAP.md — 기능별 코드 위치
3. docs/BRANCH_CONFIGURATION.md — 공통 Core와 지점별 차이
4. docs/DEVELOPMENT.md — clone 후 로컬 실행
5. docs/TESTING.md — 자동 검증과 실장비 경계
6. docs/DEPLOYMENT.md — D1, Sites, Bridge, Collector 배포 순서
7. docs/TROUBLESHOOTING.md — 대표 장애 진단
8. docs/SECURITY_AND_DATA_BOUNDARIES.md — 공유 금지 데이터와 비밀 관리
9. docs/SOURCE_SNAPSHOT.md — 이 공유본의 출처와 제외 범위

## 주요 구성

- Kiosk: 현장 이용, 네이버 예약 찾기, 혜택, 부가상품, 분할 결제, 준비와 게임 시작
- Admin / POS V2: 예약, 회원, 매출, 결제, 운영설정, 원격 제어
- Admin Remote: 방 상태, 방문 상태, Bridge 명령과 결과 확인
- Reservation / Naver: 예약 생성·변경·취소, 수집기, 재고 동기화
- Payment: quote, payment plan, allocation, attempt, reconciliation, UNKNOWN 보호
- Bridge: D1 명령 수신, Manager 제어, MPOS·주차 로컬 어댑터
- Game lifecycle: 준비, set_info, ready, start, stop, 완료
- Member / Pass / Coupon: 회원 인증, 이용권, 쿠폰, 사용·복원 원장
- Add-on sales / Parking / Notification / Operating Settings
- D1 schema와 0000–0051 migration
- 웹·D1·Bridge·Naver collector 테스트

## 구조 한눈에 보기

~~~mermaid
flowchart LR
  K["Kiosk / Admin / Reserve PWA"] --> A["App API / Worker"]
  N["Naver Collector"] --> A
  A --> D["Cloudflare D1"]
  A --> Q["Command Queue"]
  Q --> B["Store Bridge"]
  B --> M["Legacy Manager"]
  B --> P["MPOS Adapter"]
  B --> R["Parking Adapter"]
  M --> B
  P --> B
  B --> A
~~~

브라우저는 D1을 직접 수정하지 않습니다. API가 상태 전이와 금융 불변조건을 검사하고, 하드웨어 작업은 command를 통해 Bridge로 전달됩니다. 카드 결과가 불명확한 UNKNOWN 상태는 자동 재시도하지 않고 reconciliation 또는 직원 확인으로 보냅니다.

## 빠른 시작

요구사항:

- Node.js 22.13 이상
- pnpm
- Windows 10/11은 Bridge 개발에 필요
- Python 3.11 이상은 Bridge 테스트에 권장

    git clone https://github.com/dalmook/jumpingbattle_controller_pjt.git
    cd jumpingbattle_controller_pjt
    copy .env.example .env
    pnpm install --frozen-lockfile
    pnpm test
    pnpm dev

.env의 placeholder를 개발용 값으로 바꾸되 실제 운영 토큰이나 고객 데이터를 사용하지 마세요. 자세한 내용은 docs/DEVELOPMENT.md를 따릅니다.

## 저장소 지도

| 경로 | 역할 |
| --- | --- |
| app/ | 화면, PWA, API route, Kiosk/Admin UI |
| db/ | D1 조회·명령, 상태 전이, 금융 원장과 정책 |
| drizzle/ | 순서가 보존된 D1 migration |
| worker/ | Cloudflare Worker 진입점 |
| bridge/ | 매장 PC Bridge와 로컬 어댑터 |
| naver-collector/ | Chrome 확장 기반 Naver 수집·재고 동기화 |
| scripts/ | collector 빌드와 제한된 migration 도구 |
| tests/ | 웹, D1, 상태 머신, migration 회귀 테스트 |
| public/ | PWA 아이콘과 공개 UI 자산 |
| docs/ | 개발자 문서 |

## 설정 원칙

현재 코드는 완전히 지점 독립적인 구조가 아닙니다. 공유본은 동작 구조를 보존하면서 운영 URL, 장비 ID, 네이버 사업/상품 ID, 주차 식별자, Manager 설치 경로를 명시적인 예제값으로 바꿨습니다. 방·난이도·가격처럼 코드와 D1 설정에 걸쳐 있는 값은 docs/BRANCH_CONFIGURATION.md에서 변경 지점을 설명합니다.

## 안전 원칙

- 결제 UNKNOWN 또는 승인 여부가 불명확하면 같은 transaction UUID로 상태를 조회하고 자동 재승인하지 않습니다.
- 운영 DB와 로컬 SQLite를 개발 데이터로 복사하지 않습니다.
- Bridge는 armed=false로 시작하고 simulate 또는 mock 검증 뒤에만 장비를 연결합니다.
- migration은 번호 순서대로 적용하고 기존 migration을 수정하지 않습니다.
- 운영 배포와 실카드 테스트는 별도의 승인 절차입니다.

## 라이선스

현재 저장소는 비공개 개발 공유를 전제로 합니다. 외부 공개 또는 재배포 전에 제품 코드와 벤더 연동부의 라이선스 정책을 별도로 확정해야 합니다.
