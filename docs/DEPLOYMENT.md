# Deployment

이 문서는 절차를 설명할 뿐 운영 배포 권한을 부여하지 않습니다.

## 배포 단위와 순서

1. 변경 영향과 호환 matrix 확정
2. D1 migration 검토 및 백업 정책 확인
3. web/Sites 배포
4. Bridge 버전 배포
5. Naver collector 설치본 배포
6. heartbeat, capability, migration, 화면 read-only 확인
7. 승인된 smoke test
8. rollback 기준 기록

## D1

- drizzle migration은 번호 순서대로 적용합니다.
- 이미 배포된 migration 파일을 고치지 않습니다.
- 새 코드는 구 schema와의 배포 순서를 고려합니다.
- 운영 D1 dump를 GitHub artifact로 올리지 않습니다.
- migration 전후 row count와 중요 invariant를 기록하되 개인정보를 로그에 넣지 않습니다.

## Web / Sites

.openai/hosting.json의 placeholder를 실제 배포 도구가 관리하는 프로젝트 설정과 연결합니다. 실제 project ID, environment secret, D1 credential은 저장소에 커밋하지 않습니다. 기존 Sites 프로젝트와 DB binding을 새 프로젝트로 바꾸지 않았는지 확인합니다.

배포 전:

    pnpm install --frozen-lockfile
    pnpm test
    pnpm lint
    pnpm run build

## Bridge

- bridge-config.example.json을 복사해 배포 PC 전용 bridge-config.json을 만듭니다.
- armed=false로 설치하고 diagnose와 simulate를 먼저 실행합니다.
- agent ID, server URL, Manager path, room/map mapping, MPOS address를 확인합니다.
- vendor DLL은 정식 공급 경로에서 별도 배포합니다.
- 이전 Bridge 패키지를 보관하되 GitHub에 운영 config/state/log를 올리지 않습니다.
- 웹과 Bridge의 capability 호환을 확인한 뒤 armed를 전환합니다.

## Naver collector

- 지점 business ID와 biz item mapping을 확인합니다.
- 빌드 시 agent token을 주입한 설치본은 비밀 artifact입니다.
- Chrome storage, cookies, session dump를 첨부하지 않습니다.
- 취소/변경/재고 동기화는 테스트 계정 또는 승인된 운영 절차로 검증합니다.

## 결제 배포 안전

- transaction UUID와 완료 split은 유지합니다.
- UNKNOWN 또는 dispatch ambiguity에 자동 retry를 추가하지 않습니다.
- schema, API, Bridge의 status enum을 같은 릴리스에서 검토합니다.
- 실카드 테스트는 mock, status, 소액 승인, 취소 순서의 별도 승인 절차를 사용합니다.

## Rollback

DB migration을 되돌리기보다 이전 코드가 새 schema에서 안전하게 동작하도록 forward-compatible migration을 선호합니다. 결제 원장이나 command row를 삭제하는 rollback은 금지합니다. Bridge rollback 시에도 처리 중 attempt와 command를 먼저 확인합니다.
