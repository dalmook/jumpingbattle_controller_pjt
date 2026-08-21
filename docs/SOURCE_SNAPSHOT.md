# Source Snapshot

## 기준

- Source branch: codex/kiosk-production-rollout
- Source HEAD: c412a1fa3c4c55e80a365b3121d1e03c9ea461ed
- Source commit time: 2026-08-21 18:09:57 +09:00
- Snapshot date: 2026-08-21
- Publication model: 원본 Git 이력을 복제하지 않은 clean snapshot

원본 작업 트리는 clean하지 않았습니다. 사용자 미커밋 내용을 삭제하거나 되돌리지 않았고, 공유 대상 제품 소스는 작성 시점의 working tree 내용을 사용했습니다. 운영 원본에는 쓰기, checkout, reset, staging, commit을 수행하지 않았습니다.

## 포함한 현재 수정 소스

공유 시점 working tree에서 변경되어 있던 제품 소스와 테스트 중 다음 영역은 현재 내용으로 포함했습니다.

- bridge/jumping_bridge.py
- bridge/test_bridge.py
- db/control.ts
- db/remote-operations.ts
- naver-collector/manifest.json
- naver-collector/state-harness.test.cjs
- naver-collector/sw.js
- tests/remote-operations.test.mjs

운영 handoff/incident 문서와 로컬 launcher는 공유용 문서와 example launcher로 대체했습니다.

## 제외

- 기존 root 운영 분석/incident/handoff Markdown
- backup_phase2_success
- bridge runtime config와 rollback script
- MPOS vendor DLL/header
- 운영 Sites project ID
- 운영 endpoint, agent/kiosk ID, LAN IP, Manager path
- Naver 사업/상품 ID와 Apps Script deployment ID
- 운영 DB, SQLite, 로그, session, credential
- 원본 Git history

## 의미

이 저장소의 첫 commit은 원본 HEAD와 동일한 commit이 아닙니다. 제품 로직 snapshot의 출처만 위 commit으로 기록하며, 민감 운영 이력을 연결하지 않습니다.
