# Contributing

1. docs/ARCHITECTURE.md와 docs/MODULE_MAP.md를 먼저 읽습니다.
2. 기능별 작은 branch와 PR을 사용합니다.
3. 기존 migration을 수정하지 않고 새 migration을 추가합니다.
4. 결제 상태/금액/transaction UUID와 완료 split을 보존합니다.
5. UNKNOWN 자동 retry, command target 재해석, 브라우저 상태만으로 결제 완료 판정을 추가하지 않습니다.
6. 실제 운영 secret, 고객정보, DB, 로그를 fixture로 사용하지 않습니다.
7. pnpm test, pnpm lint, pnpm run build와 관련 Bridge 테스트를 실행합니다.
8. 하드웨어 검증이 필요하면 PR에 미검증이라고 표시하고 별도 승인을 받습니다.

대규모 리팩터링은 기능 수정과 분리합니다. 지점 설정을 옮길 때 기존 fallback과 migration 호환성을 함께 검증합니다.
