# Security Policy

보안 문제에 실제 token, 고객정보, 카드정보, 운영 로그를 첨부하지 마세요. 공개 issue 대신 저장소 소유자에게 GitHub의 비공개 연락 수단으로 보고하십시오.

보고 내용:

- 영향 범위와 재현 조건
- 민감값을 제거한 파일/함수 위치
- 노출 여부와 예상 기간
- 즉시 필요한 credential rotation
- history 정리가 필요한지 여부

실제 secret이 노출되었다면 commit 삭제만으로 해결되지 않습니다. 먼저 폐기/회전하고, 원격 clone과 artifact를 포함한 대응 범위를 결정합니다.
