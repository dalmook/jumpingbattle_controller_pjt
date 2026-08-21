# Development

## 요구사항

- Node.js 22.13 이상
- pnpm
- Git
- Bridge 작업 시 Windows 10/11과 Python 3.11 이상
- 실제 MPOS/Manager/주차 계정은 일반 개발에 필요하지 않음

## 설치

    git clone https://github.com/dalmook/jumpingbattle_controller_pjt.git
    cd jumpingbattle_controller_pjt
    copy .env.example .env
    pnpm install --frozen-lockfile

.env에는 개발 전용 값만 넣습니다. 최소한 세션 secret, operator PIN, agent token을 placeholder가 아닌 개발값으로 바꾸되 운영값을 재사용하지 않습니다.

## 웹 개발

    pnpm dev

Vinext/Vite/Cloudflare local 환경을 사용합니다. 로컬 D1 및 Wrangler 상태는 .wrangler 아래에 생성되며 Git에서 제외됩니다. .openai/hosting.json은 공개 가능한 placeholder 파일입니다. 실제 Sites project ID를 커밋하지 마세요.

## 빌드

    pnpm run build

## 환경변수

| 변수 | 용도 |
| --- | --- |
| JUMPING_AGENT_TOKEN | Cloud와 Bridge/collector 사이 인증 |
| JUMPING_AGENT_ID | 지점 Bridge 식별자 |
| JUMPING_OPERATOR_PIN | Admin 로그인 PIN |
| JUMPING_SESSION_SECRET | 세션 서명 |
| PAYMENT_EXPLICIT_EXECUTION_V2 | 결제 실행 경로 feature flag |
| PAYMENT_TRANSPORT | Cloud 또는 local transport 선택 |
| LOCAL_PAYMENT_BRIDGE_URL | 로컬 결제 서버 주소 |
| WEB_PUSH_VAPID_* | Push 서명 |
| PARKING_* | Store Bridge 전용 주차 설정 |

PARKING_USER_ID와 PARKING_PASSWORD는 cloud hosting에 넣지 않고 Store Bridge 환경에만 둡니다.

## Bridge 개발

    copy bridge\bridge-config.example.json bridge\bridge-config.json
    python -B bridge\jumping_bridge.py --config bridge\bridge-config.json

안전한 첫 설정:

- armed=false
- simulate=true
- mpos_enabled=false
- local_payment_enabled=false

bridge-config.json, bridge-state.json, 로컬 transaction DB와 로그는 Git에서 제외됩니다. Manager 설치 경로는 개발 PC 경로로 바꿉니다.

## MPOS adapter

공유본에는 벤더 DLL과 header가 없습니다. bridge/mpos_lan/vendor/README.md를 읽고 정식 배포물에서 별도로 준비합니다. DLL이 없는 상태에서는 mock/unit test만 실행합니다. 실제 카드 승인·취소는 자동화 테스트에 넣지 않습니다.

## Naver collector

    pnpm run build:naver-collector

이 명령은 .env의 JUMPING_AGENT_TOKEN을 runtime 설치본에 주입해 work/runtime/naver-collector에 생성합니다. 해당 폴더는 Git에서 제외됩니다. naver-collector/sw.js의 business ID, biz item ID, Apps Script URL은 예제값이므로 지점별 빌드 파이프라인에서 주입하거나 배포 전 별도 검토해야 합니다.

## 데이터

운영 D1 dump, 고객 CSV, 로컬 SQLite를 개발 환경에 복사하지 않습니다. 테스트 fixture는 가상 이름·전화번호·승인번호만 사용합니다.
