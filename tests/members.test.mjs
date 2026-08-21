import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { formatMemberPhone, getVehicleLast4, normalizeMemberPhone } from "../app/admin/v2/member-utils.ts";

test("member phone is normalized for duplicate detection and search", () => {
  assert.equal(normalizeMemberPhone("010-1234-5678"), "01012345678");
  assert.equal(normalizeMemberPhone("+82 10 1234 5678"), "01012345678");
  assert.equal(formatMemberPhone("01012345678"), "010-1234-5678");
});

test("member phone normalization is bounded", () => {
  assert.equal(normalizeMemberPhone("010123456789999"), "01012345678");
  assert.equal(normalizeMemberPhone("abc"), "");
});

test("member vehicle number supplies the last four digits when linked", () => {
  assert.equal(getVehicleLast4("12가3456"), "3456");
  assert.equal(getVehicleLast4("경기 12가 9876"), "9876");
  assert.equal(getVehicleLast4("123"), "");
});

test("member list loads the migrated roster and searches team names", async () => {
  const [membersSource, pageSource, migrationSource] = await Promise.all([
    readFile(new URL("../db/members.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/admin/v2/PosV2.tsx", import.meta.url), "utf8"),
    readFile(new URL("../scripts/migrate_jumpingmanager.py", import.meta.url), "utf8"),
  ]);
  assert.match(membersSource, /m\.team_name LIKE/);
  assert.match(membersSource, /ORDER BY m\.name COLLATE NOCASE ASC/);
  assert.match(membersSource, /vehicle_last4 = CASE WHEN/);
  assert.match(membersSource, /limit = 200/);
  assert.match(pageSource, /limit=200/);
  assert.match(pageSource, /이름, 팀명, 전화번호, 이메일, 차량번호 검색/);
  assert.match(pageSource, /기본정보 수정/);
  assert.match(pageSource, /updateMemberFromForm/);
  assert.match(pageSource, /remoteSelection\.reservation\?\.vehicleLast4/);
  assert.match(migrationSource, /"email": str\(source\.get\("email"\)/);
  assert.match(migrationSource, /--refresh-profiles/);
});
