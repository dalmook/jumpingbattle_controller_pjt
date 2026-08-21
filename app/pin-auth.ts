import { env } from "cloudflare:workers";
import { headers } from "next/headers";

export type Operator = {
  displayName: string;
  email: string;
};

const COOKIE_NAME = "__Host-jumping_operator";
const SESSION_VERSION = "v1";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 12;
const KIOSK_DEVICE_COOKIE_NAME = "__Host-jumping_kiosk_device";
const KIOSK_DEVICE_VERSION = "kiosk-v1";
const KIOSK_DEVICE_MAX_AGE_SECONDS = 60 * 60 * 24 * 180;

type PinEnv = {
  JUMPING_OPERATOR_PIN?: string;
  JUMPING_SESSION_SECRET?: string;
};

function getPinEnv(): PinEnv {
  return env as unknown as PinEnv;
}

function constantTimeEqual(left: string, right: string) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function hmac(value: string) {
  const secret = getPinEnv().JUMPING_SESSION_SECRET ?? "";
  if (secret.length < 32) return null;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(value));
  return Array.from(new Uint8Array(signature), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function readCookie(cookieHeader: string | null, name: string) {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    return decodeURIComponent(part.slice(separator + 1).trim());
  }
  return null;
}

export async function isValidOperatorPin(pin: string) {
  const configured = getPinEnv().JUMPING_OPERATOR_PIN ?? "";
  return /^\d{4}$/.test(configured) && constantTimeEqual(pin, configured);
}

export async function createOperatorSessionCookie() {
  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_MAX_AGE_SECONDS;
  const payload = `${SESSION_VERSION}.${expiresAt}`;
  const signature = await hmac(payload);
  if (!signature) throw new Error("PIN 로그인 보안 설정이 준비되지 않았습니다.");
  const token = `${payload}.${signature}`;
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearOperatorSessionCookie() {
  return `${COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export async function hasOperatorSession() {
  const requestHeaders = await headers();
  const token = readCookie(requestHeaders.get("cookie"), COOKIE_NAME);
  if (!token) return false;

  const [version, expiryText, suppliedSignature, ...extra] = token.split(".");
  if (
    version !== SESSION_VERSION ||
    extra.length > 0 ||
    !/^\d+$/.test(expiryText ?? "") ||
    !suppliedSignature
  ) {
    return false;
  }

  const expiresAt = Number(expiryText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) {
    return false;
  }

  const expectedSignature = await hmac(`${version}.${expiryText}`);
  return Boolean(
    expectedSignature && constantTimeEqual(suppliedSignature, expectedSignature),
  );
}

export async function createKioskDeviceCookie() {
  const expiresAt = Math.floor(Date.now() / 1000) + KIOSK_DEVICE_MAX_AGE_SECONDS;
  const payload = `${KIOSK_DEVICE_VERSION}.${expiresAt}.${crypto.randomUUID()}`;
  const signature = await hmac(payload);
  if (!signature) throw new Error("키오스크 기기 보안 설정이 준비되지 않았습니다.");
  return `${KIOSK_DEVICE_COOKIE_NAME}=${encodeURIComponent(`${payload}.${signature}`)}; Path=/; Max-Age=${KIOSK_DEVICE_MAX_AGE_SECONDS}; HttpOnly; Secure; SameSite=Strict`;
}

export function clearKioskDeviceCookie() {
  return `${KIOSK_DEVICE_COOKIE_NAME}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict`;
}

export async function hasKioskDeviceSession(request?: Request) {
  const cookieHeader = request ? request.headers.get("cookie") : (await headers()).get("cookie");
  const token = readCookie(cookieHeader, KIOSK_DEVICE_COOKIE_NAME);
  if (!token) return false;
  const [version, expiryText, deviceId, suppliedSignature, ...extra] = token.split(".");
  if (version !== KIOSK_DEVICE_VERSION || extra.length > 0 || !/^\d+$/.test(expiryText ?? "") || !deviceId || !suppliedSignature) return false;
  const expiresAt = Number(expiryText);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return false;
  const expectedSignature = await hmac(`${version}.${expiryText}.${deviceId}`);
  return Boolean(expectedSignature && constantTimeEqual(suppliedSignature, expectedSignature));
}

export async function fingerprintPinClient(value: string) {
  return hmac(`pin-client:${value}`);
}
