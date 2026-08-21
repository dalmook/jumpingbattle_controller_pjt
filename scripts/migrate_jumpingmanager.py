#!/usr/bin/env python3
"""Read-only Firebase member extractor and guarded POS V2 migration client."""

from __future__ import annotations

import argparse
import http.cookiejar
import json
import os
import re
import sys
import urllib.parse
import urllib.error
import urllib.request
from collections import Counter
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
LEGACY_APP = ROOT / "legacy" / "research" / "jumpingmanager" / "app.js"
DEFAULT_SITE = "https://your-site.example"


def project_id() -> str:
    raw = LEGACY_APP.read_bytes()
    text = raw.decode("utf-16" if raw.startswith((b"\xff\xfe", b"\xfe\xff")) else "utf-8")
    match = re.search(r"projectId\s*:\s*['\"]([^'\"]+)['\"]", text)
    if not match:
        raise RuntimeError("Legacy Firebase projectId를 소스에서 찾지 못했습니다.")
    return match.group(1)


def decode_firestore(value: Any) -> Any:
    if not isinstance(value, dict):
        return value
    scalar = {
        "stringValue": str,
        "integerValue": int,
        "doubleValue": float,
        "booleanValue": bool,
        "timestampValue": str,
        "nullValue": lambda _: None,
    }
    for key, caster in scalar.items():
        if key in value:
            return caster(value[key])
    if "mapValue" in value:
        return {key: decode_firestore(item) for key, item in value["mapValue"].get("fields", {}).items()}
    if "arrayValue" in value:
        return [decode_firestore(item) for item in value["arrayValue"].get("values", [])]
    if "referenceValue" in value:
        return str(value["referenceValue"])
    return value


def fetch_legacy_members() -> list[dict[str, Any]]:
    pid = project_id()
    base = f"https://firestore.googleapis.com/v1/projects/{urllib.parse.quote(pid)}/databases/(default)/documents/members"
    documents: list[dict[str, Any]] = []
    token = ""
    while True:
        query = {"pageSize": "300"}
        if token:
            query["pageToken"] = token
        request = urllib.request.Request(f"{base}?{urllib.parse.urlencode(query)}", headers={"accept": "application/json"})
        with urllib.request.urlopen(request, timeout=30) as response:
            payload = json.load(response)
        documents.extend(payload.get("documents", []))
        token = str(payload.get("nextPageToken", ""))
        if not token:
            break
    result = []
    for document in documents:
        fields = {key: decode_firestore(value) for key, value in document.get("fields", {}).items()}
        fields["legacyId"] = str(document.get("name", "")).rsplit("/", 1)[-1]
        result.append(fields)
    return result


def normalized_phone(value: Any) -> str:
    digits = re.sub(r"\D", "", str(value or ""))
    if digits.startswith("82"):
        digits = "0" + digits[2:]
    return digits


def pass_product(name: str) -> tuple[str, str]:
    normalized = re.sub(r"\s+", "", name)
    known = {
        "청소년10회권": ("YOUTH_PASS_10", "youth"),
        "청소년20회권": ("YOUTH_PASS_20", "youth"),
        "10회권": ("ADULT_PASS_10", "adult"),
        "20회권": ("ADULT_PASS_20", "adult"),
        "스탬프적립쿠폰": ("LEGACY_STAMP_REWARD", "other"),
        "평일이용권": ("LEGACY_WEEKDAY", "other"),
        "무료권": ("LEGACY_FREE_GAME", "other"),
    }
    if normalized in known:
        return known[normalized]
    token = re.sub(r"[^A-Za-z0-9가-힣]", "", normalized)[:30] or "UNKNOWN"
    return f"LEGACY_OTHER_{token}", "other"


def pass_count(value: Any) -> int:
    if isinstance(value, dict):
        value = value.get("count", 0)
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def transform_member(source: dict[str, Any]) -> dict[str, Any]:
    legacy_id = str(source.get("legacyId", ""))
    phone = normalized_phone(source.get("phone") or legacy_id)
    passes: list[dict[str, Any]] = []
    for batch_id, raw in (source.get("passBatches") or {}).items():
        if not isinstance(raw, dict):
            continue
        count = pass_count(raw)
        if count <= 0:
            continue
        name = str(raw.get("name") or "이름 미상 이용권")
        code, age_group = pass_product(name)
        passes.append({"sourceReference": f"batch:{batch_id}", "name": name, "productCode": code, "ageGroup": age_group, "remainingUses": count, "expiresAt": raw.get("expireAt")})
    for key, raw in (source.get("passes") or {}).items():
        count = pass_count(raw)
        if count <= 0:
            continue
        name = str(key)
        code, age_group = pass_product(name)
        expires_at = raw.get("expireAt") if isinstance(raw, dict) else None
        passes.append({"sourceReference": f"legacy:{key}", "name": name, "productCode": code, "ageGroup": age_group, "remainingUses": count, "expiresAt": expires_at})
    for field, name, code in (
        ("freeCredits", "기존 무료권", "LEGACY_FREE_GAME"),
        ("freeWeekday", "기존 평일이용권", "LEGACY_WEEKDAY"),
    ):
        count = pass_count(source.get(field))
        if count > 0:
            passes.append({"sourceReference": f"field:{field}", "name": name, "productCode": code, "ageGroup": "other", "remainingUses": count, "expiresAt": None})
    notes = [str(source.get("note") or "").strip()]
    free_slush = pass_count(source.get("freeSlush"))
    if free_slush:
        notes.append(f"기존 무료 슬러시 {free_slush}개")
    return {
        "legacyId": legacy_id,
        "name": str(source.get("name") or "이름 미상").strip()[:40],
        "phone": phone,
        "team": str(source.get("team") or "").strip(),
        "email": str(source.get("email") or "").strip(),
        "car": str(source.get("car") or "").strip(),
        "note": " · ".join(part for part in notes if part),
        "createdAt": source.get("createdAt"),
        "updatedAt": source.get("updatedAt"),
        "stamp": pass_count(source.get("stamp")),
        "passes": passes,
    }


def local_preview(members: list[dict[str, Any]]) -> dict[str, Any]:
    phones = [normalized_phone(item.get("phone")) for item in members]
    duplicate_groups = sum(1 for _, count in Counter(phones).items() if count > 1)
    return {
        "total": len(members),
        "invalidPhone": sum(1 for phone in phones if len(phone) < 9),
        "duplicatePhoneGroups": duplicate_groups,
        "stampHolders": sum(1 for item in members if int(item.get("stamp") or 0) > 0),
        "passHolders": sum(1 for item in members if item.get("passes")),
        "passBalances": sum(sum(int(p["remainingUses"]) for p in item.get("passes", [])) for item in members),
        "teamProfiles": sum(1 for item in members if str(item.get("team") or "").strip()),
        "emailProfiles": sum(1 for item in members if str(item.get("email") or "").strip()),
        "vehicleProfiles": sum(1 for item in members if str(item.get("car") or "").strip()),
    }


class PosClient:
    def __init__(self, site: str, pin: str):
        jar = http.cookiejar.CookieJar()
        self.opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
        self.site = site.rstrip("/")
        self.post("/api/pin-login", {"pin": pin})

    def post(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        request = urllib.request.Request(self.site + path, data=body, headers={
            "content-type": "application/json",
            "accept": "application/json",
            "origin": self.site,
            "referer": self.site + "/admin/v2",
            "user-agent": "Mozilla/5.0 JumpingBattleMigration/1.0",
        }, method="POST")
        try:
            with self.opener.open(request, timeout=90) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            detail = error.read().decode("utf-8", errors="replace")[:500]
            raise RuntimeError(f"POS API {path} 응답 {error.code}: {detail}") from error


def write_report(local: dict[str, Any], target: dict[str, Any] | None, report_path: Path) -> None:
    lines = [
        "# Legacy Member Migration Report",
        "",
        "## Firebase read-only snapshot",
        "",
        f"- Legacy members: {local['total']}",
        f"- Invalid phones: {local['invalidPhone']}",
        f"- Duplicate phone groups: {local['duplicatePhoneGroups']}",
        f"- Stamp holders: {local['stampHolders']}",
        f"- Pass holders: {local['passHolders']}",
        f"- Remaining pass uses: {local['passBalances']}",
        f"- Team profiles: {local['teamProfiles']}",
        f"- Email profiles: {local['emailProfiles']}",
        f"- Vehicle profiles: {local['vehicleProfiles']}",
        "",
        "## POS V2 preview",
        "",
    ]
    if target:
        for key in ("total", "create", "merge", "skip", "conflict", "error", "stampHolders", "passHolders"):
            lines.append(f"- {key}: {target.get(key, 0)}")
    else:
        lines.append("- Target preview pending: set `JUMPING_OPERATOR_PIN` and rerun dry-run after deployment.")
    lines += ["", "No personal member data or credentials are included in this report.", ""]
    report_path.write_text("\n".join(lines), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    mode.add_argument("--verify", action="store_true")
    mode.add_argument("--refresh-profiles", action="store_true")
    parser.add_argument("--site-url", default=DEFAULT_SITE)
    parser.add_argument("--report", default=str(ROOT / "LEGACY_MEMBER_MIGRATION_REPORT.md"))
    args = parser.parse_args()

    pin = os.environ.get("JUMPING_OPERATOR_PIN", "").strip()
    if args.verify:
        if not pin:
            raise RuntimeError("--verify requires JUMPING_OPERATOR_PIN")
        stats = PosClient(args.site_url, pin).post(
            "/api/admin/legacy-migration", {"action": "verify"}
        )["stats"]
        print(
            "Verification: "
            f"mapping={stats['mappingRows']} "
            f"members={stats['memberRows']} "
            f"teams={stats['teamProfiles']} "
            f"emails={stats['emailProfiles']} "
            f"vehicles={stats['vehicleProfiles']} "
            f"stamps={stats['stampLedgerRows']} "
            f"stampBalance={stats['stampBalance']} "
            f"passes={stats['memberPassRows']} "
            f"remainingUses={stats['remainingPassUses']} "
            f"passLedgerRows={stats['passLedgerRows']} "
            f"passLedgerBalance={stats['passLedgerBalance']} "
            f"backups={stats['backupRows']}"
        )
        return 0

    source = fetch_legacy_members()
    members = [transform_member(item) for item in source]
    local = local_preview(members)
    print(f"Legacy 전체 회원: {local['total']}")
    print(f"전화번호 오류: {local['invalidPhone']}")
    print(f"전화번호 중복 그룹: {local['duplicatePhoneGroups']}")
    print(f"스탬프 보유: {local['stampHolders']}")
    print(f"다회권 보유: {local['passHolders']}")
    print(f"팀명 보유: {local['teamProfiles']}")
    print(f"이메일 보유: {local['emailProfiles']}")
    print(f"차량번호 보유: {local['vehicleProfiles']}")

    target = None
    if pin:
        client = PosClient(args.site_url, pin)
        target = client.post("/api/admin/legacy-migration", {"action": "preview", "members": members})["preview"]
        print(f"신규 생성: {target['create']}")
        print(f"기존 회원 병합: {target['merge']}")
        print(f"재실행 건너뜀: {target['skip']}")
        print(f"충돌: {target['conflict']}")
        print(f"오류: {target['error']}")
    elif args.apply or args.refresh_profiles:
        raise RuntimeError("이 작업에는 JUMPING_OPERATOR_PIN 환경변수가 필요합니다.")
    else:
        print("POS V2 대상 Preview: 인증 PIN이 없어 이번 실행에서는 생략")

    if args.dry_run or args.apply:
        write_report(local, target, Path(args.report))
    if args.refresh_profiles:
        backup = client.post("/api/admin/legacy-migration", {"action": "backup"})["backup"]
        if not backup.get("id"):
            raise RuntimeError("프로필 보강 전 백업에 실패했습니다.")
        result = client.post("/api/admin/legacy-migration", {"action": "refresh_profiles", "backupId": backup["id"], "members": members})["result"]
        print(f"Profile refresh: updated={result['updated']} missingMapping={result['missingMapping']} missingMember={result['missingMember']}")
        stats = client.post("/api/admin/legacy-migration", {"action": "verify"})["stats"]
        print(f"Profile verification: teams={stats['teamProfiles']} emails={stats['emailProfiles']} vehicles={stats['vehicleProfiles']}")
        return 0
    if args.apply:
        if target and (target["conflict"] or target["error"]):
            raise RuntimeError("충돌 또는 오류가 있어 실제 마이그레이션을 중단했습니다.")
        backup = client.post("/api/admin/legacy-migration", {"action": "backup"})["backup"]
        if not backup.get("id"):
            raise RuntimeError("백업 실패로 마이그레이션을 중단했습니다.")
        result = client.post("/api/admin/legacy-migration", {"action": "apply", "backupId": backup["id"], "members": members})["result"]
        print(f"Migration 완료: created={result['created']} merged={result['merged']} skipped={result['skipped']}")
        try:
            stats = client.post("/api/admin/legacy-migration", {"action": "verify"})["stats"]
            print(f"검증: mapping={stats['mappingRows']} members={stats['memberRows']} stamps={stats['stampLedgerRows']} passes={stats['memberPassRows']} remainingUses={stats['remainingPassUses']}")
        except RuntimeError as error:
            if "지원하지 않는" not in str(error):
                raise
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(f"Migration 실패: {exc}", file=sys.stderr)
        raise SystemExit(1)
