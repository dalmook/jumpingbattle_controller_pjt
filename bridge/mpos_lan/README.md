# MPOS LAN Adapter

이 디렉터리는 vendor DLL을 감싸는 Python adapter, gateway, model, 예외, 로컬 transaction store를 포함합니다.

## 필요한 외부 파일

vendor/FDK_Module_64bit.dll과 vendor header는 라이선스와 공급 경로가 확인된 정식 MPOS 배포물에서 별도로 받습니다. GitHub에는 포함하지 않습니다. 파일명과 architecture가 config의 dll_path와 맞아야 합니다.

## 개발 설정

    copy config.example.json config.json

config.json, data/*.db, logs/*는 Git에서 제외됩니다. 예제의 192.0.2.54는 문서용 TEST-NET 주소이므로 실제 장비와 통신하지 않습니다.

## 상태 원칙

- APPROVED: 승인 원장이 확인된 terminal 성공
- DECLINED, USER_CANCELLED: 명확한 terminal 실패
- UNKNOWN: 전송 가능성이 있으나 결과를 확정하지 못함
- UNKNOWN은 동일 금액을 자동으로 다시 승인하지 않음
- transaction UUID로 로컬/Cloud 기록을 reconciliation

실카드 승인·취소는 unit test 범위가 아니며 별도 승인이 필요합니다.
