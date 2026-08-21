# Security and Data Boundaries

## 절대 커밋 금지

- .env와 runtime secret
- API key, token, cookie, private key, session dump
- 운영 PIN, Manager/주차 계정
- 고객 전화번호, 이름이 결합된 예약/회원 export
- 실제 계좌번호
- 카드번호, 승인번호, 승인일시가 포함된 운영 거래
- 운영 D1 dump, SQLite, DB backup
- Bridge state, MPOS transaction DB, 운영 로그
- incident backup과 화면 캡처
- 벤더 DLL 또는 재배포 권한이 확인되지 않은 SDK

## 공유본의 처리

- 운영 URL과 project/agent/kiosk 식별자는 placeholder로 교체
- Naver business/biz item ID와 Apps Script deployment URL은 예제값으로 교체
- 주차 host/lot/member와 MPOS LAN 주소는 예제값으로 교체
- Manager 로컬 설치 경로는 일반 예제 경로로 교체
- 실제 운영 문서와 Git history는 이전하지 않음
- 공개 자산과 제품 소스, migration, 테스트만 새 clean history에 포함

## 과거 이력 검사 결과

원본 로컬 Git 이력에서 고신뢰 토큰, 개인키, 일반적인 cloud credential 패턴은 발견되지 않았습니다. 그러나 과거 운영 결제 분석 문서에 실제 승인정보가 포함된 이력이 확인되었습니다. 따라서 원본 이력을 rewrite하거나 push하지 않고, 검증된 현재 소스 snapshot으로 새 이력을 생성했습니다.

이 결과는 자동 검사의 한계가 있으므로 공개 전에는 GitHub secret scanning과 별도 보안 검토를 추가해야 합니다.

## 개발 규칙

- secret은 환경변수 또는 승인된 secret manager로 주입
- example 파일에는 실제처럼 보이는 값 대신 REPLACE_WITH 또는 example domain 사용
- fixture는 가상 고객과 synthetic transaction 사용
- 오류 메시지와 telemetry에 전화번호, card data, cookie를 넣지 않음
- PR에 DB dump나 로그를 올리지 않음
- secret이 커밋되면 파일 삭제만 하지 말고 즉시 폐기/회전 후 history 대응을 결정

## 권장 사전 검사

- GitHub secret scanning
- gitleaks 또는 동등한 도구의 현재 tree와 full history 검사
- 대용량/바이너리 목록 검사
- .gitignore 및 git ls-files로 runtime artifact 추적 여부 검사
- 개인정보 샘플링 검토

보안 문제는 공개 issue가 아니라 저장소 소유자에게 비공개 채널로 전달합니다.
