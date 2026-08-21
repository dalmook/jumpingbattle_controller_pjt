import { headers } from "next/headers";
import { formatMemberPhone, normalizeMemberPhone } from "@/app/admin/v2/member-utils";
import { getMemberBenefits } from "./member-benefits";
import { getD1 } from "./control";
import {
  createMemberPasswordSalt,
  deriveMemberPasswordHash,
  MEMBER_PASSWORD_ITERATIONS,
} from "./member-password";
import { ensureMemberSchema, getMember, updateMember } from "./members";

const MEMBER_COOKIE = "__Host-jumping_member";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;
const PASSWORD_ITERATIONS = MEMBER_PASSWORD_ITERATIONS;
const TERMS_VERSION = "2026-08-12";
const AUTH_WINDOW_SECONDS = 15 * 60;
const AUTH_MAX_ATTEMPTS = 5;

export type CustomerMemberSession = {
  sessionId: string;
  memberId: string;
  name: string;
  phone: string;
};

export type CustomerMemberDashboard = {
  member: {
    id: string;
    name: string;
    phone: string;
    teamName: string;
    createdAt: string;
  };
  stamp: { balance: number; goal: number };
  passes: Array<{
    id: string;
    productName: string;
    remainingUses: number;
    purchasedUses: number;
    expiresAt: string;
    status: string;
    usable: boolean;
  }>;
  coupons: Array<{
    id: string;
    couponType: string;
    productName: string;
    expiresAt: string;
    status: string;
    usable: boolean;
    conditions: string;
  }>;
  recentVisits: Array<{
    id: string;
    date: string;
    time: string;
    roomCode: string;
    teamName: string;
    people: number;
    status: string;
  }>;
};

type CredentialRow = {
  member_id: string;
  name: string;
  phone: string;
  password_hash: string;
  password_salt: string;
  password_iterations: number;
};

let schemaReady: Promise<void> | null = null;

async function initializeMemberAuthSchema() {
  await ensureMemberSchema();
  const db = getD1();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS member_credentials (
      member_id TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      password_iterations INTEGER NOT NULL DEFAULT 210000,
      terms_version TEXT NOT NULL,
      terms_agreed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      registered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at TEXT,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS member_sessions (
      id TEXT PRIMARY KEY,
      member_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS member_sessions_member_expires_idx ON member_sessions(member_id, expires_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS member_auth_rate_limits (
      client_key TEXT PRIMARY KEY,
      attempts INTEGER NOT NULL DEFAULT 0,
      window_started INTEGER NOT NULL DEFAULT 0,
      blocked_until INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS member_auth_rate_limits_blocked_idx ON member_auth_rate_limits(blocked_until)`),
  ]);
}

export async function ensureMemberAuthSchema() {
  if (!schemaReady) schemaReady = initializeMemberAuthSchema().catch((error) => {
    schemaReady = null;
    throw error;
  });
  await schemaReady;
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomHex(length: number) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes);
}

async function sha256(value: string) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function validPassword(value: string) {
  return value.length > 0;
}

function readCookie(cookieHeader: string | null, name: string) {
  if (!cookieHeader) return "";
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return "";
}

function sessionCookie(token: string) {
  return `${MEMBER_COOKIE}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Lax`;
}

export function clearMemberSessionCookie() {
  return `${MEMBER_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
}

async function createSession(memberId: string) {
  const token = randomHex(32);
  const tokenHash = await sha256(token);
  const expiresAt = new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString();
  await getD1().batch([
    getD1().prepare(`DELETE FROM member_sessions WHERE datetime(expires_at) <= CURRENT_TIMESTAMP`),
    getD1().prepare(`INSERT INTO member_sessions (id, member_id, token_hash, expires_at)
      VALUES (?, ?, ?, ?)`)
      .bind(crypto.randomUUID(), memberId, tokenHash, expiresAt),
  ]);
  return sessionCookie(token);
}

async function rateLimitKey(clientIdentity: string, normalizedPhone: string, purpose = "login") {
  return sha256(`member-${purpose}:${clientIdentity}:${normalizedPhone}`);
}

async function assertNotRateLimited(key: string) {
  const now = Math.floor(Date.now() / 1000);
  const row = await getD1().prepare(`SELECT attempts, window_started, blocked_until
    FROM member_auth_rate_limits WHERE client_key = ? LIMIT 1`)
    .bind(key).first<{ attempts: number; window_started: number; blocked_until: number }>();
  if (Number(row?.blocked_until) > now) throw new Error("MEMBER_AUTH_RATE_LIMITED");
}

async function recordLoginFailure(key: string) {
  const now = Math.floor(Date.now() / 1000);
  const current = await getD1().prepare(`SELECT attempts, window_started FROM member_auth_rate_limits
    WHERE client_key = ? LIMIT 1`).bind(key).first<{ attempts: number; window_started: number }>();
  const insideWindow = current && now - Number(current.window_started) < AUTH_WINDOW_SECONDS;
  const attempts = insideWindow ? Number(current.attempts) + 1 : 1;
  const windowStarted = insideWindow ? Number(current.window_started) : now;
  const blockedUntil = attempts >= AUTH_MAX_ATTEMPTS ? now + AUTH_WINDOW_SECONDS : 0;
  await getD1().prepare(`INSERT INTO member_auth_rate_limits
      (client_key, attempts, window_started, blocked_until, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(client_key) DO UPDATE SET attempts = excluded.attempts,
      window_started = excluded.window_started, blocked_until = excluded.blocked_until,
      updated_at = CURRENT_TIMESTAMP`)
    .bind(key, attempts, windowStarted, blockedUntil).run();
}

async function clearLoginFailures(key: string) {
  await getD1().prepare(`DELETE FROM member_auth_rate_limits WHERE client_key = ?`).bind(key).run();
}

export async function getCustomerMemberAccountState(input: { phone: string }) {
  await ensureMemberAuthSchema();
  const normalizedPhone = normalizeMemberPhone(input.phone);
  if (normalizedPhone.length < 10) throw new Error("MEMBER_PHONE_INVALID");
  const account = await getD1().prepare(`SELECT
      EXISTS(SELECT 1 FROM members m
        WHERE m.normalized_phone = ? AND m.status = 'active') AS existing,
      EXISTS(SELECT 1 FROM members m
        JOIN member_credentials c ON c.member_id = m.id
        WHERE m.normalized_phone = ? AND m.status = 'active') AS registered`)
    .bind(normalizedPhone, normalizedPhone).first<{ existing: number; registered: number }>();
  return {
    existing: Boolean(account?.existing),
    registered: Boolean(account?.registered),
  };
}

export async function registerCustomerMember(input: {
  name: string;
  phone: string;
  password: string;
  teamName?: string;
  agreed: boolean;
  createPersistentSession?: boolean;
}) {
  await ensureMemberAuthSchema();
  const name = input.name.trim().slice(0, 40);
  const normalizedPhone = normalizeMemberPhone(input.phone);
  const teamName = String(input.teamName ?? "").trim().slice(0, 80);
  if (!name) throw new Error("MEMBER_NAME_REQUIRED");
  if (normalizedPhone.length < 10) throw new Error("MEMBER_PHONE_INVALID");
  if (!validPassword(input.password)) throw new Error("MEMBER_PASSWORD_INVALID");
  if (!input.agreed) throw new Error("MEMBER_TERMS_REQUIRED");

  const db = getD1();
  const existing = await db.prepare(`SELECT m.id,
      EXISTS(SELECT 1 FROM member_credentials c WHERE c.member_id = m.id) AS registered
    FROM members m WHERE m.normalized_phone = ? AND m.status <> 'merged' LIMIT 1`)
    .bind(normalizedPhone).first<{ id: string; registered: number }>();
  if (existing?.registered) throw new Error("MEMBER_ACCOUNT_EXISTS");

  const memberId = existing?.id ?? crypto.randomUUID();
  const salt = createMemberPasswordSalt();
  const hash = await deriveMemberPasswordHash(input.password, salt);
  const statements = [];
  if (existing) {
    statements.push(db.prepare(`UPDATE members SET name = ?,
        team_name = CASE WHEN ? <> '' THEN ? ELSE team_name END,
        phone = ?, normalized_phone = ?, phone_last4 = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?`)
      .bind(name, teamName, teamName, formatMemberPhone(normalizedPhone), normalizedPhone, normalizedPhone.slice(-4), memberId));
  } else {
    statements.push(db.prepare(`INSERT INTO members (
        id, name, phone, normalized_phone, phone_last4, team_name, created_by
      ) VALUES (?, ?, ?, ?, ?, ?, 'customer-signup')`)
      .bind(memberId, name, formatMemberPhone(normalizedPhone), normalizedPhone, normalizedPhone.slice(-4), teamName));
  }
  statements.push(db.prepare(`INSERT INTO member_credentials (
      member_id, password_hash, password_salt, password_iterations,
      terms_version, terms_agreed_at, registered_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`)
    .bind(memberId, hash, salt, PASSWORD_ITERATIONS, TERMS_VERSION));
  await db.batch(statements);
  return {
    memberId,
    migrated: Boolean(existing),
    cookie: input.createPersistentSession === false ? "" : await createSession(memberId),
  };
}

export async function verifyCustomerMemberCredentials(input: {
  phone: string;
  password: string;
  clientIdentity: string;
}) {
  await ensureMemberAuthSchema();
  const normalizedPhone = normalizeMemberPhone(input.phone);
  const key = await rateLimitKey(input.clientIdentity, normalizedPhone);
  await assertNotRateLimited(key);
  const credential = await getD1().prepare(`SELECT m.id AS member_id, m.name, m.phone,
      c.password_hash, c.password_salt, c.password_iterations
    FROM members m JOIN member_credentials c ON c.member_id = m.id
    WHERE m.normalized_phone = ? AND m.status = 'active' LIMIT 1`)
    .bind(normalizedPhone).first<CredentialRow>();
  if (!credential) {
    const legacy = await getD1().prepare(`SELECT id FROM members WHERE normalized_phone = ? AND status = 'active' LIMIT 1`)
      .bind(normalizedPhone).first();
    await recordLoginFailure(key);
    if (legacy) throw new Error("MEMBER_ACCOUNT_NEEDS_ACTIVATION");
    throw new Error("MEMBER_LOGIN_INVALID");
  }
  const actual = await deriveMemberPasswordHash(
    input.password,
    credential.password_salt,
    Number(credential.password_iterations),
  );
  if (!constantTimeEqual(actual, credential.password_hash)) {
    await recordLoginFailure(key);
    throw new Error("MEMBER_LOGIN_INVALID");
  }
  await clearLoginFailures(key);
  await getD1().prepare(`UPDATE member_credentials SET last_login_at = CURRENT_TIMESTAMP,
    updated_at = CURRENT_TIMESTAMP WHERE member_id = ?`).bind(credential.member_id).run();
  return {
    memberId: credential.member_id,
    name: credential.name,
    phone: credential.phone,
  };
}

export async function loginCustomerMember(input: {
  phone: string;
  password: string;
  clientIdentity: string;
}) {
  const verified = await verifyCustomerMemberCredentials(input);
  return { memberId: verified.memberId, cookie: await createSession(verified.memberId) };
}

export async function resetCustomerMemberPassword(input: {
  name: string;
  phone: string;
  password: string;
  clientIdentity: string;
}) {
  await ensureMemberAuthSchema();
  const name = input.name.trim().slice(0, 40);
  const normalizedPhone = normalizeMemberPhone(input.phone);
  if (!name) throw new Error("MEMBER_NAME_REQUIRED");
  if (normalizedPhone.length < 10) throw new Error("MEMBER_PHONE_INVALID");
  if (!validPassword(input.password)) throw new Error("MEMBER_PASSWORD_INVALID");

  const key = await rateLimitKey(input.clientIdentity, normalizedPhone, "password-reset");
  const loginKey = await rateLimitKey(input.clientIdentity, normalizedPhone);
  await assertNotRateLimited(key);
  const member = await getD1().prepare(`SELECT m.id
    FROM members m JOIN member_credentials c ON c.member_id = m.id
    WHERE m.normalized_phone = ? AND (
      TRIM(m.name) = ? COLLATE NOCASE
      OR (
        TRIM(m.name) IN ('관리자', '회원', '고객', '미상')
        AND TRIM(COALESCE(m.team_name, '')) = ? COLLATE NOCASE
      )
    )
      AND m.status = 'active' LIMIT 1`)
    .bind(normalizedPhone, name, name).first<{ id: string }>();
  if (!member) {
    await recordLoginFailure(key);
    throw new Error("MEMBER_RESET_IDENTITY_INVALID");
  }

  const salt = createMemberPasswordSalt();
  const hash = await deriveMemberPasswordHash(input.password, salt);
  const db = getD1();
  await db.batch([
    db.prepare(`UPDATE member_credentials
      SET password_hash = ?, password_salt = ?, password_iterations = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE member_id = ?`)
      .bind(hash, salt, PASSWORD_ITERATIONS, member.id),
    db.prepare(`DELETE FROM member_sessions WHERE member_id = ?`).bind(member.id),
    db.prepare(`DELETE FROM member_auth_rate_limits WHERE client_key = ?`).bind(key),
    db.prepare(`DELETE FROM member_auth_rate_limits WHERE client_key = ?`).bind(loginKey),
  ]);
  return { memberId: member.id, cookie: await createSession(member.id) };
}

export function memberClientIdentity(request: Request) {
  return request.headers.get("cf-connecting-ip")
    ?? request.headers.get("x-forwarded-for")?.split(",")[0]?.trim()
    ?? "unknown";
}

export async function getCustomerMemberSession(cookieHeader?: string | null): Promise<CustomerMemberSession | null> {
  await ensureMemberAuthSchema();
  const suppliedHeader = cookieHeader === undefined ? (await headers()).get("cookie") : cookieHeader;
  const token = readCookie(suppliedHeader, MEMBER_COOKIE);
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await getD1().prepare(`SELECT s.id AS session_id, s.member_id, m.name, m.phone
    FROM member_sessions s JOIN members m ON m.id = s.member_id
    WHERE s.token_hash = ? AND datetime(s.expires_at) > CURRENT_TIMESTAMP
      AND m.status = 'active' LIMIT 1`)
    .bind(tokenHash).first<{ session_id: string; member_id: string; name: string; phone: string }>();
  if (!row) return null;
  return { sessionId: row.session_id, memberId: row.member_id, name: row.name, phone: row.phone };
}

export async function destroyCustomerMemberSession(cookieHeader: string | null) {
  await ensureMemberAuthSchema();
  const token = readCookie(cookieHeader, MEMBER_COOKIE);
  if (token) await getD1().prepare(`DELETE FROM member_sessions WHERE token_hash = ?`).bind(await sha256(token)).run();
}

function usableStatus(status: string, expiresAt: string, remainingUses = 1) {
  const normalizedExpiry = !expiresAt
    ? ""
    : /^\d{4}-\d{2}-\d{2}$/.test(expiresAt)
      ? `${expiresAt}T23:59:59+09:00`
      : expiresAt.includes("T")
        ? expiresAt
        : `${expiresAt.replace(" ", "T")}+09:00`;
  const notExpired = !normalizedExpiry || Date.parse(normalizedExpiry) > Date.now();
  return status === "ACTIVE" && notExpired && remainingUses > 0;
}

function couponProductName(type: string, fallback: string) {
  if (type === "WEEKDAY_EVENT") return "평일 무료 이용권";
  if (type === "STAMP_REWARD") return "스탬프 적립 무료 이용권";
  return fallback || "이벤트 무료 이용권";
}

export async function getCustomerMemberDashboard(memberId: string): Promise<CustomerMemberDashboard> {
  const [member, benefits] = await Promise.all([getMember(memberId), getMemberBenefits(memberId)]);
  if (!member) throw new Error("MEMBER_NOT_FOUND");
  return {
    member: {
      id: member.id,
      name: member.name,
      phone: member.phone,
      teamName: member.teamName,
      createdAt: member.createdAt,
    },
    stamp: { balance: benefits.stampBalance, goal: benefits.settings.stampGoal },
    passes: benefits.passes.map((pass) => ({
      id: pass.id,
      productName: pass.productName,
      remainingUses: pass.remainingUses,
      purchasedUses: pass.purchasedUses,
      expiresAt: pass.expiresAt,
      status: pass.status,
      usable: usableStatus(pass.status, pass.expiresAt, pass.remainingUses),
    })),
    coupons: benefits.coupons.map((coupon) => ({
      id: coupon.id,
      couponType: coupon.couponType,
      productName: couponProductName(coupon.couponType, coupon.name),
      expiresAt: coupon.expiresAt,
      status: coupon.status,
      usable: usableStatus(coupon.status, coupon.expiresAt),
      conditions: coupon.couponType === "WEEKDAY_EVENT" ? "평일 게임 이용 시 사용 가능" : "게임 1회 무료 이용",
    })),
    recentVisits: member.reservations.slice(0, 8).map((visit) => ({
      id: visit.id,
      date: visit.scheduledDate,
      time: visit.scheduledTime,
      roomCode: visit.roomCode,
      teamName: visit.teamName,
      people: visit.totalCount,
      status: visit.status,
    })),
  };
}

export async function updateCustomerProfile(memberId: string, input: { name?: string; teamName?: string }) {
  const updated = await updateMember(memberId, {
    name: String(input.name ?? "").trim().slice(0, 40),
    teamName: String(input.teamName ?? "").trim().slice(0, 80),
  });
  if (!updated) throw new Error("MEMBER_NOT_FOUND");
  return getCustomerMemberDashboard(memberId);
}
