import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("customer member auth claims legacy members and protects credentials", async () => {
  const [auth, passwordHash, registerRoute, loginRoute, resetRoute, accountStatusRoute] = await Promise.all([
    readFile(new URL("../db/member-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../db/member-password.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/member/auth/register/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/member/auth/login/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/member/auth/reset-password/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/member/auth/account-status/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(passwordHash, /PBKDF2/);
  assert.match(passwordHash, /MEMBER_PASSWORD_ITERATIONS = 210_000/);
  assert.match(passwordHash, /PBKDF2_RUNTIME_MAX_ITERATIONS = 100_000/);
  assert.match(passwordHash, /CHUNKED_PASSWORD_SALT_PREFIX = "v2\$"/);
  assert.match(passwordHash, /Math\.min\(remaining, PBKDF2_RUNTIME_MAX_ITERATIONS\)/);
  assert.match(auth, /HttpOnly; Secure; SameSite=Lax/);
  assert.match(auth, /WHERE m\.normalized_phone = \?/);
  assert.match(auth, /migrated: Boolean\(existing\)/);
  assert.match(auth, /MEMBER_ACCOUNT_EXISTS/);
  assert.match(auth, /MEMBER_AUTH_RATE_LIMITED/);
  assert.match(auth, /member_sessions/);
  assert.match(registerRoute, /set-cookie/);
  assert.match(loginRoute, /MEMBER_ACCOUNT_NEEDS_ACTIVATION/);
  assert.match(auth, /resetCustomerMemberPassword/);
  assert.match(auth, /TRIM\(m\.name\) = \? COLLATE NOCASE/);
  assert.match(auth, /TRIM\(m\.name\) IN \('관리자', '회원', '고객', '미상'\)/);
  assert.match(auth, /TRIM\(COALESCE\(m\.team_name, ''\)\) = \? COLLATE NOCASE/);
  assert.match(auth, /\.bind\(normalizedPhone, name, name\)/);
  assert.match(auth, /DELETE FROM member_sessions WHERE member_id = \?/);
  assert.match(auth, /"password-reset"/);
  assert.match(resetRoute, /resetCustomerMemberPassword/);
  assert.match(resetRoute, /set-cookie/);
  assert.match(accountStatusRoute, /getCustomerMemberAccountState/);
  assert.match(auth, /JOIN member_credentials c ON c\.member_id = m\.id/);
  assert.match(auth, /existing: Boolean\(account\?\.existing\)/);
  assert.match(auth, /registered: Boolean\(account\?\.registered\)/);
  assert.match(auth, /function validPassword\(value: string\) \{\s*return value\.length > 0;/);
  assert.doesNotMatch(registerRoute, /8자 이상|72자 이하/);
  assert.doesNotMatch(resetRoute, /8자 이상|72자 이하/);
});

test("customer MY keeps benefits explicit and has no web purchase action", async () => {
  const [auth, portal, portalEntry, memberPage, layout, manifest, reserve] = await Promise.all([
    readFile(new URL("../db/member-auth.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/member/MemberPortal.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/member/MemberPortalV127.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/member/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/member/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/member/manifest.webmanifest/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/reserve/ReserveForm.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(auth, /평일 무료 이용권/);
  assert.match(auth, /스탬프 적립 무료 이용권/);
  assert.match(auth, /이벤트 무료 이용권/);
  assert.match(portal, /STEP 1/);
  assert.match(portal, /STEP 2/);
  assert.match(portal, /STEP 3/);
  assert.match(portal, /비밀번호 확인/);
  assert.match(portal, /비밀번호 찾기/);
  assert.match(portal, /새 비밀번호 저장/);
  assert.match(portal, /\/api\/member\/auth\/account-status/);
  assert.match(portal, /기존에 가입된 계정을 찾았어요/);
  assert.doesNotMatch(portal, /8자 이상/);
  assert.doesNotMatch(portal, /← 오늘 예약/);
  assert.match(portal, /openSignupOrReset/);
  assert.match(portal, /휴대폰 번호를 확인했어요/);
  assert.match(portalEntry, /import MemberPortal from "\.\/MemberPortal"/);
  assert.match(memberPage, /\.\/MemberPortalV127/);
  assert.match(portal, /팀명\s*<small>선택/);
  assert.match(portal, /최근 이용내역/);
  assert.match(portal, /가입일/);
  assert.doesNotMatch(portal, /구매하기<\/button>|\/api\/member\/purchase/);
  assert.match(layout, /manifest: "\/member\/manifest\.webmanifest"/);
  assert.match(layout, /\/member-og\.png/);
  assert.match(manifest, /display: "standalone"/);
  assert.match(manifest, /scope: "\/member"/);
  assert.match(reserve, /href="\/member"/);
});
