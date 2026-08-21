// sw.js — durable reservation collector / sender
console.log("[Sheet Pusher][SW] loaded DURABLE-QUEUE", new Date().toISOString());

// ===========================
// CONFIG
// ===========================
const WEBAPP_URL =
  "https://script.google.com/macros/s/REPLACE_WITH_RESERVATION_WEBAPP_ID/exec";

const KIOSK_WEBAPP_URL =
  "https://script.google.com/macros/s/REPLACE_WITH_KIOSK_WEBAPP_ID/exec";

const JUMPING_SITE_IMPORT_URL =
  "https://your-site.example/api/import/reservations";
const JUMPING_SITE_STOCK_URL =
  "https://your-site.example/api/agent/naver-stock";
// 배포 패키지를 만들 때 매장 전용 토큰으로 교체된다. 저장소에는 비밀값을 남기지 않는다.
const JUMPING_SITE_IMPORT_TOKEN = "__JUMPING_AGENT_TOKEN__";

const BOOKING_LIST_URL = "https://partner.booking.naver.com/bizes/1000000/booking-list-view";
const NAVER_API_BASE = "https://partner.booking.naver.com/api";
const NAVER_WRITE_API_BASE = "https://api-partner.booking.naver.com/v3.1";
const BUSINESS_ID = 1000000;
const BUSINESS_TYPE_ID = 12;
const CONFIRMED_STATUS_CODE = "RC03";
const CANCELLED_STATUS_CODES = new Set(["RC04"]);
const FALLBACK_BIZ_ITEM_IDS = [1000001, 1000002, 1000003, 1000004];
const PERIOD_MINUTES = 0.5;
const TAB_LOAD_TIMEOUT_MS = 30000;
const RUN_TIMEOUT_MS = 4 * 60 * 1000;

const AUTO_ALARM = "AUTO_SEND";
const RUN_TIMEOUT_ALARM = "AUTO_RUN_TIMEOUT";
const RUN_STATE_KEY = "activeReservationRun";
const AUTOMATION_SURFACE_KEY = "reservationAutomationSurface";
const BOOKING_STATES_KEY = "bookingEventStates";
const OUTBOX_KEY = "bookingDeliveryOutbox";
const API_SNAPSHOT_KEY = "naverConfirmedBookingSnapshot";
const SEEN_BOOKINGS_KEY = "seenBookings";
const MAX_BOOKING_STATES = 3000;
const MAX_OUTBOX_EVENTS = 1000;
const NAVER_WRITE_AUTH_KEY = "naverWriteAuth";
const NAVER_MANAGED_STOCK_KEY = "naverManagedStockSlots";
const NAVER_STOCK_STATUS_KEY = "naverStockLastStatus";
const FAST_SYNC_STATE_KEY = "naverFastSyncState";
const FAST_SYNC_INTERVAL_MS = 5 * 1000;
const FAST_SYNC_HIDDEN_INTERVAL_MS = 10 * 1000;
const FAST_SYNC_MAX_BACKOFF_MS = 5 * 60 * 1000;
const FULL_RECONCILE_INTERVAL_MS = PERIOD_MINUTES * 60 * 1000;
const SLOT_MINUTES = 20;
const NAVER_CSRF_TOKEN_PATTERN = /^[0-9a-f]{128}$/i;

const ALLOWED = /^https?:\/\/(partner\.booking\.naver\.com|prod-partner\.io\.naver\.com)\/.*booking-list-view/i;

// ===========================
// Utils
// ===========================
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function retryAfterMs(response) {
  const value = String(response?.headers?.get?.("retry-after") || "").trim();
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function naverHttpError(message, response) {
  const error = new Error(message);
  error.httpStatus = Number(response?.status) || 0;
  error.retryAfterMs = retryAfterMs(response);
  return error;
}

function createRunId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function pad2(value) {
  return String(value).padStart(2, "0");
}

function formatKstDateTime(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day} ${value.hour}:${value.minute}:${value.second}`;
}

function fmtDate(date) {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

function fmtTime(date) {
  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`;
}

function readRequestHeader(headers, name) {
  const target = String(name || "").toLowerCase();
  const match = Array.isArray(headers)
    ? headers.find(header => String(header?.name || "").toLowerCase() === target)
    : null;
  return String(match?.value || "").trim();
}

async function captureNaverWriteAuth(details) {
  const csrfToken = readRequestHeader(details?.requestHeaders, "x-csrf-token");
  const role = readRequestHeader(details?.requestHeaders, "x-booking-naver-role");
  if (!csrfToken && !role) return;
  const stored = await chrome.storage.local.get(NAVER_WRITE_AUTH_KEY);
  const current = stored[NAVER_WRITE_AUTH_KEY] || {};
  await chrome.storage.local.set({
    [NAVER_WRITE_AUTH_KEY]: {
      csrfToken: csrfToken || current.csrfToken || "",
      role: role || current.role || "",
      updatedAt: Date.now()
    }
  });
}

function isNaverCsrfToken(value) {
  return NAVER_CSRF_TOKEN_PATTERN.test(String(value || "").trim());
}

async function discoverNaverCsrfFromCookies() {
  if (!chrome.cookies?.getAll) return "";
  const queries = [
    { url: "https://partner.booking.naver.com/" },
    { url: "https://api-partner.booking.naver.com/" },
    { domain: ".naver.com" }
  ];
  const candidates = [];
  for (const query of queries) {
    try {
      const cookies = await chrome.cookies.getAll(query);
      for (const cookie of cookies || []) {
        const value = String(cookie?.value || "").trim();
        if (!isNaverCsrfToken(value)) continue;
        const name = String(cookie?.name || "");
        candidates.push({
          value,
          score: /csrf|xsrf/i.test(name) ? 100 : 10
        });
      }
    } catch (error) {
      console.warn("[Naver Stock] cookie auth scan skipped:", error);
    }
  }
  candidates.sort((left, right) => right.score - left.score);
  return candidates[0]?.value || "";
}

async function discoverNaverCsrfFromOpenPage() {
  if (!chrome.tabs?.query || !chrome.scripting?.executeScript) return "";
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({ url: "https://partner.booking.naver.com/*" });
  } catch (error) {
    console.warn("[Naver Stock] partner tab lookup skipped:", error);
    return "";
  }

  for (const tab of tabs || []) {
    if (!Number.isFinite(Number(tab?.id))) continue;
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: Number(tab.id) },
        world: "MAIN",
        func: () => {
          const exactToken = /^[0-9a-f]{128}$/i;
          const embeddedToken = /(?:csrf|xsrf)[^0-9a-f]{0,80}([0-9a-f]{128})/i;
          const candidates = [];
          const add = (key, rawValue, baseScore = 0) => {
            const value = String(rawValue || "").trim();
            const keyText = String(key || "");
            if (exactToken.test(value)) {
              candidates.push({
                token: value,
                score: baseScore + (/csrf|xsrf/i.test(keyText) ? 100 : 10)
              });
            }
            const embedded = value.match(embeddedToken);
            if (embedded) candidates.push({ token: embedded[1], score: baseScore + 90 });
            if (value.startsWith("{") || value.startsWith("[")) {
              try {
                const visit = (node, depth = 0) => {
                  if (depth > 6 || node == null) return;
                  if (Array.isArray(node)) {
                    for (const item of node.slice(0, 200)) visit(item, depth + 1);
                    return;
                  }
                  if (typeof node !== "object") return;
                  for (const [childKey, childValue] of Object.entries(node)) {
                    if (typeof childValue === "string" && exactToken.test(childValue)) {
                      candidates.push({
                        token: childValue,
                        score: baseScore + (/csrf|xsrf/i.test(childKey) ? 120 : 5)
                      });
                    } else if (typeof childValue === "object") {
                      visit(childValue, depth + 1);
                    }
                  }
                };
                visit(JSON.parse(value));
              } catch (_) {
                // Storage values are frequently ordinary non-JSON strings.
              }
            }
          };

          for (const storage of [window.localStorage, window.sessionStorage]) {
            try {
              for (let index = 0; index < storage.length; index += 1) {
                const key = storage.key(index) || "";
                add(key, storage.getItem(key), 30);
              }
            } catch (_) {
              // A storage area can be unavailable while the page is navigating.
            }
          }
          try {
            for (const part of String(document.cookie || "").split(";")) {
              const separator = part.indexOf("=");
              if (separator < 0) continue;
              add(part.slice(0, separator), decodeURIComponent(part.slice(separator + 1)), 40);
            }
          } catch (_) {
            // Ignore malformed cookie values.
          }
          for (const meta of document.querySelectorAll("meta")) {
            add(meta.getAttribute("name") || meta.getAttribute("property") || "", meta.content, 50);
          }
          for (const script of document.querySelectorAll("script:not([src])")) {
            const match = String(script.textContent || "").match(embeddedToken);
            if (match) candidates.push({ token: match[1], score: 80 });
          }
          candidates.sort((left, right) => right.score - left.score);
          return { csrfToken: candidates[0]?.token || "" };
        }
      });
      const csrfToken = String(results?.[0]?.result?.csrfToken || "").trim();
      if (isNaverCsrfToken(csrfToken)) return csrfToken;
    } catch (error) {
      console.warn("[Naver Stock] page auth scan skipped:", error);
    }
  }
  return "";
}

async function fetchFreshNaverCsrfToken() {
  const response = await fetch(`${NAVER_WRITE_API_BASE}/csrf-token`, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/json; charset=UTF-8",
      "x-booking-naver-role": "NONE"
    },
    credentials: "include",
    cache: "no-store"
  });
  const text = await response.text();
  if (response.status === 401 || response.status === 403) {
    throw new Error("Naver Partner login is required to issue a fresh CSRF token.");
  }
  if (!response.ok) {
    throw new Error(`Naver CSRF token HTTP ${response.status}: ${text.slice(0, 160)}`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch (_) {
    throw new Error("Naver CSRF token response was not JSON.");
  }
  const csrfToken = String(body?.csrfToken || "").trim();
  if (!isNaverCsrfToken(csrfToken)) {
    throw new Error("Naver CSRF token response did not contain a valid token.");
  }
  return csrfToken;
}

async function refreshNaverWriteAuth() {
  const stored = await chrome.storage.local.get(NAVER_WRITE_AUTH_KEY);
  const current = stored[NAVER_WRITE_AUTH_KEY] || {};
  let csrfToken = "";
  try {
    csrfToken = await fetchFreshNaverCsrfToken();
  } catch (error) {
    console.warn("[Naver Stock] fresh CSRF token request failed:", error);
    csrfToken =
      await discoverNaverCsrfFromCookies() ||
      await discoverNaverCsrfFromOpenPage() ||
      (isNaverCsrfToken(current.csrfToken) ? current.csrfToken : "");
  }
  if (!csrfToken) return current;

  const next = {
    csrfToken,
    role: String(current.role || ""),
    updatedAt: Date.now()
  };
  await chrome.storage.local.set({ [NAVER_WRITE_AUTH_KEY]: next });
  return next;
}

if (chrome.webRequest?.onBeforeSendHeaders?.addListener) {
  chrome.webRequest.onBeforeSendHeaders.addListener(
    details => {
      captureNaverWriteAuth(details).catch(error => {
        console.warn("[Naver Stock] auth capture failed:", error);
      });
    },
    {
      urls: [
        "https://partner.booking.naver.com/*",
        "https://api-partner.booking.naver.com/*"
      ]
    },
    ["requestHeaders", "extraHeaders"]
  );
}

async function waitTabStable(tabId, timeoutMs = TAB_LOAD_TIMEOUT_MS) {
  const until = Date.now() + timeoutMs;
  let stableUrl = "";
  let stableSince = 0;

  while (Date.now() < until) {
    const tab = await chrome.tabs.get(tabId);
    const url = tab.url || "";

    if (tab.status === "complete") {
      if (url !== stableUrl) {
        stableUrl = url;
        stableSince = Date.now();
      } else if (Date.now() - stableSince >= 2000) {
        return tab;
      }
    } else {
      stableUrl = "";
      stableSince = 0;
    }
    await sleep(250);
  }
  throw new Error("탭 안정화 타임아웃");
}

function isTransientFrameError(error) {
  const message = String(error?.message || error || "");
  return /Frame with ID .* was removed|No frame with id|frame.*removed/i.test(message);
}

async function injectCollectorWithRetry(tabId, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const tab = await waitTabStable(tabId);
    if (!ALLOWED.test(tab.url || "")) {
      throw new Error(`로그인 필요 또는 지원하지 않는 주소: ${tab.url || ""}`);
    }

    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ["content.js"]
      });
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientFrameError(error) || attempt === attempts) throw error;
      console.warn(`[Auto] frame changed during injection; retry ${attempt}/${attempts}`);
      await sleep(750);
    }
  }
  throw lastError || new Error("수집 스크립트 주입 실패");
}

async function getRunState() {
  const stored = await chrome.storage.local.get(RUN_STATE_KEY);
  return stored[RUN_STATE_KEY] || null;
}

async function acquireRun(isManual) {
  const current = await getRunState();
  if (current?.expiresAt > Date.now()) return null;

  if (current?.ownedTab && current?.tabId) {
    try { await chrome.tabs.remove(current.tabId); } catch (_) {}
  }

  const run = {
    runId: createRunId(),
    isManual: Boolean(isManual),
    tabId: null,
    ownedTab: false,
    startedAt: Date.now(),
    expiresAt: Date.now() + RUN_TIMEOUT_MS
  };
  await chrome.storage.local.set({ [RUN_STATE_KEY]: run });
  return run;
}

async function updateRun(runId, patch) {
  const current = await getRunState();
  if (!current || current.runId !== runId) return null;
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ [RUN_STATE_KEY]: next });
  return next;
}

async function finishRun(tabId, reason) {
  const current = await getRunState();
  if (!current) return;
  if (tabId && current.tabId && tabId !== current.tabId) return;

  await chrome.alarms.clear(RUN_TIMEOUT_ALARM);
  await chrome.storage.local.remove(RUN_STATE_KEY);

  if (current.ownedTab && current.tabId) {
    try { await chrome.tabs.remove(current.tabId); } catch (_) {}
  }
  console.log("[Auto] finished:", reason || "done");
}

async function getSavedAutomationSurface() {
  const stored = await chrome.storage.local.get(AUTOMATION_SURFACE_KEY);
  const surface = stored[AUTOMATION_SURFACE_KEY];
  if (!Number.isInteger(surface?.tabId) || !Number.isInteger(surface?.windowId)) return null;

  try {
    const [tab] = await Promise.all([
      chrome.tabs.get(surface.tabId),
      chrome.windows.get(surface.windowId)
    ]);
    return { ...surface, tab };
  } catch (_) {
    await chrome.storage.local.remove(AUTOMATION_SURFACE_KEY);
    return null;
  }
}

async function cleanupLegacyAutomationSurface() {
  const stored = await chrome.storage.local.get(AUTOMATION_SURFACE_KEY);
  const surface = stored[AUTOMATION_SURFACE_KEY];
  await chrome.storage.local.remove(AUTOMATION_SURFACE_KEY);
  if (Number.isInteger(surface?.windowId)) {
    try { await chrome.windows.remove(surface.windowId); } catch (_) {}
  }
}

async function getCollectionTab() {
  const saved = await getSavedAutomationSurface();
  if (saved) {
    await chrome.windows.update(saved.windowId, { state: "minimized" });
    await chrome.tabs.reload(saved.tabId);
    return { tab: await chrome.tabs.get(saved.tabId), ownedTab: false };
  }

  // Keep one automation page in its own minimized popup window. Reusing this
  // page avoids a tab appearing and disappearing in the user's main window on
  // every alarm tick.
  const automationWindow = await chrome.windows.create({
    url: BOOKING_LIST_URL,
    type: "popup",
    focused: false,
    state: "minimized"
  });
  if (!Number.isInteger(automationWindow?.id)) {
    throw new Error("자동화 창을 만들지 못했습니다.");
  }
  const tabs = await chrome.tabs.query({ windowId: automationWindow.id });
  const tab = tabs[0];
  if (!Number.isInteger(tab?.id)) {
    throw new Error("자동화 탭을 찾지 못했습니다.");
  }
  await chrome.storage.local.set({
    [AUTOMATION_SURFACE_KEY]: { windowId: automationWindow.id, tabId: tab.id }
  });
  return { tab, ownedTab: false };
}

// ===========================
// Direct Naver JSON collection (no page/tab required)
// ===========================
function getKstBookingRange(date = new Date(), horizonDays = 14) {
  const dateKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
  const start = new Date(`${dateKey}T00:00:00.000+09:00`);
  const end = new Date(
    start.getTime() + horizonDays * 24 * 60 * 60 * 1_000 + 86_399_999
  );
  return {
    dateKey,
    endDateKey: new Intl.DateTimeFormat("en-CA", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(end),
    startIso: start.toISOString(),
    endIso: end.toISOString()
  };
}

function bookingStatusUrl(startIso, endIso) {
  const url = new URL(`${NAVER_API_BASE}/businesses/${BUSINESS_ID}/booking-status`);
  url.searchParams.set("businessTypeId", String(BUSINESS_TYPE_ID));
  url.searchParams.set("startDate", startIso);
  url.searchParams.set("endDate", endIso);
  url.searchParams.set("includeTodaySchedule", "false");
  url.searchParams.set("includeTotal", "false");
  url.searchParams.set("interval", "30");
  url.searchParams.set("schedules", "business,bizItems");
  return url;
}

async function fetchNaverJson(url, label) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json" },
      credentials: "include",
      cache: "no-store",
      signal: controller.signal
    });
    const text = await response.text();
    const contentType = response.headers.get("content-type") || "";

    if (response.status === 401 || response.status === 403 || /nidlogin\.login/i.test(response.url || "")) {
      throw naverHttpError("네이버 파트너 로그인이 필요합니다.", response);
    }
    if (!response.ok) {
      throw naverHttpError(`${label} HTTP ${response.status}: ${text.slice(0, 160)}`, response);
    }
    if (!contentType.includes("json") && /^\s*</.test(text)) {
      throw new Error("네이버 파트너 로그인 화면이 반환되었습니다.");
    }
    try {
      return JSON.parse(text);
    } catch (_) {
      throw new Error(`${label} 응답이 JSON이 아닙니다.`);
    }
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchBookingStatus(startIso, endIso) {
  return fetchNaverJson(bookingStatusUrl(startIso, endIso).href, "booking status");
}

function hashText(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function buildBookingStatusFingerprint(body) {
  if (!Array.isArray(body?.bizItems)) return "";
  const summary = body.bizItems.map(item => [
    Number(item.bizItemId),
    Object.entries(item.status || {})
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([slot, status]) => [
        slot,
        Number(status?.requestedBookingCount || 0),
        Number(status?.confirmedBookingCount || 0),
        Number(status?.completedBookingCount || 0),
        Number(status?.noshowBookingCount || 0)
      ])
  ]);
  return hashText(JSON.stringify(summary));
}

function bookingStatusInfo(body) {
  const ids = Array.isArray(body?.bizItems)
    ? body.bizItems.map(item => Number(item.bizItemId)).filter(Number.isFinite)
    : [];
  return {
    ids: ids.length ? [...new Set(ids)] : FALLBACK_BIZ_ITEM_IDS,
    fingerprint: buildBookingStatusFingerprint(body),
    body
  };
}

async function discoverBizItemIds(startIso, endIso) {
  const url = bookingStatusUrl(startIso, endIso);
  url.searchParams.set("businessTypeId", String(BUSINESS_TYPE_ID));
  url.searchParams.set("startDate", startIso);
  url.searchParams.set("endDate", endIso);
  url.searchParams.set("includeTodaySchedule", "false");
  url.searchParams.set("includeTotal", "false");
  url.searchParams.set("interval", "30");
  url.searchParams.set("schedules", "business,bizItems");

  try {
    const body = await fetchNaverJson(url.href, "상품 목록");
    return bookingStatusInfo(body);
  } catch (error) {
    console.warn("[Naver API] bizItem discovery fallback:", error);
    return { ids: FALLBACK_BIZ_ITEM_IDS, fingerprint: "", body: null, error };
  }
}

function remoteStockKey(bizItemId, scheduledDate, scheduledTime) {
  return `${Number(bizItemId)}|${scheduledDate}|${scheduledTime}`;
}

function parseRemoteStockSlots(body) {
  const slots = new Map();
  if (!Array.isArray(body?.bizItems)) return slots;
  for (const item of body.bizItems) {
    const bizItemId = Number(item?.bizItemId);
    if (!Number.isFinite(bizItemId)) continue;
    for (const [scheduledAt, status] of Object.entries(item?.status || {})) {
      const match = scheduledAt.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}):\d{2}(?:Z|[+-]\d{2}:\d{2})$/);
      if (!match) continue;
      slots.set(remoteStockKey(bizItemId, match[1], match[2]), {
        bizItemId,
        scheduledDate: match[1],
        scheduledTime: match[2],
        stock: Math.max(0, Number(status?.stock) || 0),
        remainingBookingCount: Math.max(0, Number(status?.remainingBookingCount) || 0),
        requestedBookingCount: Math.max(0, Number(status?.requestedBookingCount) || 0),
        confirmedBookingCount: Math.max(0, Number(status?.confirmedBookingCount) || 0),
        completedBookingCount: Math.max(0, Number(status?.completedBookingCount) || 0),
        noshowBookingCount: Math.max(0, Number(status?.noshowBookingCount) || 0)
      });
    }
  }
  return slots;
}

function hasNaverBooking(slot) {
  return Boolean(slot && (
    slot.requestedBookingCount > 0 ||
    slot.confirmedBookingCount > 0 ||
    slot.completedBookingCount > 0 ||
    slot.noshowBookingCount > 0
  ));
}

function isFinishedSlot(slot, now = new Date()) {
  const startsAt = new Date(`${slot.scheduledDate}T${slot.scheduledTime}:00+09:00`);
  if (Number.isNaN(startsAt.getTime())) return true;
  return startsAt.getTime() + SLOT_MINUTES * 60 * 1000 <= now.getTime();
}

async function getNaverWriteAuth() {
  const auth = await refreshNaverWriteAuth();
  return {
    csrfToken: String(auth.csrfToken || ""),
    role: String(auth.role || "")
  };
}

async function getLocalManagedStock() {
  const stored = await chrome.storage.local.get(NAVER_MANAGED_STOCK_KEY);
  const value = stored[NAVER_MANAGED_STOCK_KEY];
  return value && typeof value === "object" ? value : {};
}

async function saveLocalManagedStock(value) {
  await chrome.storage.local.set({ [NAVER_MANAGED_STOCK_KEY]: value });
}

async function fetchNaverStockPlan(startDate, endDate) {
  const url = new URL(JUMPING_SITE_STOCK_URL);
  url.searchParams.set("start", startDate);
  url.searchParams.set("end", endDate);
  const response = await fetch(url.href, {
    method: "GET",
    headers: {
      accept: "application/json",
      "x-jumping-agent-token": JUMPING_SITE_IMPORT_TOKEN
    },
    cache: "no-store"
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`stock plan HTTP ${response.status}: ${text.slice(0, 160)}`);
  return JSON.parse(text);
}

async function saveNaverStockActions(actions) {
  if (!actions.length) return;
  const response = await fetch(JUMPING_SITE_STOCK_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-jumping-agent-token": JUMPING_SITE_IMPORT_TOKEN
    },
    body: JSON.stringify({ actions })
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`stock state HTTP ${response.status}: ${text.slice(0, 160)}`);
}

async function patchNaverStock(slot, stock, auth) {
  if (!auth.role) {
    throw new Error("Open the Naver Partner booking calendar once to refresh authorization.");
  }
  if (!chrome.tabs?.query || !chrome.scripting?.executeScript) {
    throw new Error("Naver Partner page execution permission is unavailable.");
  }
  const tabs = await chrome.tabs.query({ url: "https://partner.booking.naver.com/*" });
  const tab = (tabs || []).find(value => Number.isFinite(Number(value?.id)));
  if (!tab) {
    throw new Error("Keep the Naver Partner booking calendar open while stock is synchronized.");
  }
  const results = await chrome.scripting.executeScript({
    target: { tabId: Number(tab.id) },
    world: "MAIN",
    args: [NAVER_WRITE_API_BASE, BUSINESS_ID, slot, stock, auth.role],
    func: async (apiBase, businessId, targetSlot, targetStock, role) => {
      const tokenResponse = await fetch(`${apiBase}/csrf-token`, {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json; charset=UTF-8",
          "x-booking-naver-role": "NONE"
        },
        credentials: "include",
        cache: "no-store"
      });
      const tokenText = await tokenResponse.text();
      if (!tokenResponse.ok) {
        return { ok: false, stage: "token", status: tokenResponse.status, text: tokenText.slice(0, 160) };
      }
      let tokenBody;
      try {
        tokenBody = JSON.parse(tokenText);
      } catch (_) {
        return { ok: false, stage: "token-json", status: tokenResponse.status, text: tokenText.slice(0, 160) };
      }
      const csrfToken = String(tokenBody?.csrfToken || "").trim();
      if (!/^[0-9a-f]{128}$/i.test(csrfToken)) {
        return { ok: false, stage: "token-value", status: tokenResponse.status, text: "invalid token" };
      }

      const url = `${apiBase}/businesses/${businessId}/biz-items/${targetSlot.bizItemId}/schedules`;
      const response = await fetch(url, {
        method: "PATCH",
        headers: {
          accept: "application/json",
          "content-type": "application/json; charset=UTF-8",
          "x-booking-naver-role": role,
          "x-csrf-token": csrfToken
        },
        credentials: "include",
        body: JSON.stringify({
          startTime: targetSlot.scheduledTime,
          startDate: targetSlot.scheduledDate,
          endDate: targetSlot.scheduledDate,
          status: "ON",
          stock: targetStock
        })
      });
      return {
        ok: response.ok,
        stage: "patch",
        status: response.status,
        text: (await response.text()).slice(0, 160)
      };
    }
  });
  const result = results?.[0]?.result;
  if (!result) {
    throw new Error("Naver Partner page did not return a stock result.");
  }
  if (result.status === 401 || result.status === 403) {
    throw naverHttpError("Naver Partner login or authorization refresh is required.", result);
  }
  if (!result.ok) {
    throw naverHttpError(
      `Naver stock ${result.stage} ${result.status}: ${String(result.text || "").slice(0, 160)}`,
      result
    );
  }
}

async function syncNaverStock(now = new Date(), options = {}) {
  const { dateKey, endDateKey, startIso, endIso } = getKstBookingRange(now);
  const [plan, statusBody, localManaged] = await Promise.all([
    fetchNaverStockPlan(dateKey, endDateKey),
    options.statusBody ? Promise.resolve(options.statusBody) : fetchBookingStatus(startIso, endIso),
    getLocalManagedStock()
  ]);
  let authPromise = null;
  const getAuthOnce = () => {
    if (!authPromise) authPromise = getNaverWriteAuth();
    return authPromise;
  };
  const remoteSlots = parseRemoteStockSlots(statusBody);
  const planBlockedSlots = Array.isArray(plan?.blockedSlots) ? plan.blockedSlots : [];
  const planManagedSlots = Array.isArray(plan?.managedSlots) ? plan.managedSlots : [];
  const blocked = new Map(
    planBlockedSlots
      .filter(slot => !isFinishedSlot(slot, now))
      .map(slot => [slot.slotKey, slot])
  );
  const managed = new Map();
  for (const slot of planManagedSlots) managed.set(slot.slotKey, slot);
  for (const slot of Object.values(localManaged)) {
    if (slot?.slotKey) managed.set(slot.slotKey, slot);
  }

  const actions = [];
  let closed = 0;
  let reopened = 0;

  for (const slot of blocked.values()) {
    const remote = remoteSlots.get(remoteStockKey(slot.bizItemId, slot.scheduledDate, slot.scheduledTime));
    if (!remote || hasNaverBooking(remote)) continue;
    const owned = managed.get(slot.slotKey);
    if (remote.stock > 0) {
      const originalStock = owned?.originalStock || remote.stock;
      await patchNaverStock(slot, 0, await getAuthOnce());
      localManaged[slot.slotKey] = { ...slot, originalStock };
      await saveLocalManagedStock(localManaged);
      actions.push({ action: "claim", ...slot, originalStock });
      closed += 1;
    } else if (owned && !planManagedSlots.some(value => value.slotKey === slot.slotKey)) {
      actions.push({ action: "claim", ...owned });
    }
  }

  for (const slot of managed.values()) {
    if (blocked.has(slot.slotKey)) continue;
    const remote = remoteSlots.get(remoteStockKey(slot.bizItemId, slot.scheduledDate, slot.scheduledTime));
    if (!remote) continue;
    if (!isFinishedSlot(slot, now) && !hasNaverBooking(remote) && remote.stock === 0) {
      await patchNaverStock(slot, Math.max(1, Number(slot.originalStock) || 1), await getAuthOnce());
      reopened += 1;
    }
    delete localManaged[slot.slotKey];
    await saveLocalManagedStock(localManaged);
    actions.push({ action: "release", slotKey: slot.slotKey });
  }

  await saveNaverStockActions(actions);
  return { closed, reopened, managed: managed.size, blocked: blocked.size };
}

async function fetchBookingsForItem(bizItemId, startIso, endIso) {
  const url = new URL(`${NAVER_API_BASE}/businesses/${BUSINESS_ID}/bookings`);
  url.searchParams.set("bizItemIds", String(bizItemId));
  // Do not restrict this request to RC03. A completed reservation can leave
  // the RC03 result even though it must remain in the sheet, while cancelled
  // reservations must be identified from their actual response fields.
  url.searchParams.set("dateFilter", "USEDATE");
  url.searchParams.set("startDateTime", startIso);
  url.searchParams.set("endDateTime", endIso);
  url.searchParams.set("excludeCheckoutDate", "true");
  url.searchParams.set("isShowBookingCount", "1");
  url.searchParams.set("orderBy", "");
  url.searchParams.set("page", "0");
  url.searchParams.set("size", "1000");

  const body = await fetchNaverJson(url.href, `예약 목록(${bizItemId})`);
  if (Array.isArray(body)) return body;
  if (Array.isArray(body?.content)) return body.content;
  if (Array.isArray(body?.bookings)) return body.bookings;
  throw new Error(`예약 목록(${bizItemId}) 응답 배열을 찾지 못했습니다.`);
}

function formatNaverWhenFromApi(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Seoul",
    year: "2-digit",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  const weekday = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    weekday: "short"
  }).format(date).replace("요일", "");
  const hour24 = Number(values.hour);
  const period = hour24 < 12 ? "오전" : "오후";
  const hour12 = hour24 % 12 || 12;
  return `${values.year}. ${Number(values.month)}. ${Number(values.day)}.(${weekday}) ${period} ${hour12}:${values.minute}`;
}

function readCustomAnswer(booking, titlePattern) {
  const forms = booking?.snapshotJson?.customFormInputJson;
  if (!Array.isArray(forms)) return "";
  const match = forms.find(form => titlePattern.test(String(form?.title || form?.originalTitle || "")));
  return String(match?.value || "").trim();
}

function mapApiBooking(booking) {
  const bookingId = String(booking?.bookingId || "").trim();
  const statusCode = String(booking?.bookingStatusCode || "").trim();
  const startDate =
    booking?.snapshotJson?.startDateTime ||
    booking?.startDateTime ||
    booking?.startDate ||
    "";
  const statusDescription = [
    booking?.bookingStatusName,
    booking?.bookingStatusCodeName,
    booking?.statusName,
    booking?.status,
  ].map(value => String(value || "")).join(" ");
  const paymentStatusDescription = [
    booking?.paymentStatusName,
    booking?.paymentStatusCodeName,
    booking?.paymentStatus,
    booking?.nPayChargedStatusName,
    ...(Array.isArray(booking?.payments)
      ? booking.payments.flatMap(payment => [payment?.statusName, payment?.status])
      : [])
  ].map(value => String(value || "")).join(" ");
  // completedCount/cancelledCount/userCancelledCount are customer-history
  // counters in the booking list response, not the current booking's state.
  // Only current-booking fields may classify this booking.
  const hasExplicitCompletedStatus =
    booking?.isCompleted === true ||
    /(이용완료|사용완료|COMPLETED|COMPLETE|USED|DONE)/i.test(statusDescription);
  const hasExplicitCancellationStatus =
    CANCELLED_STATUS_CODES.has(statusCode) ||
    /(?:^|\s)(?:예약\s*)?취소(?:\s*완료)?(?:\s|$)|입금\s*대기\s*취소|환불\s*완료|CANCELED|CANCELLED|REFUNDED/i
      .test(`${statusDescription} ${paymentStatusDescription}`);
  const isCancelled =
    !hasExplicitCompletedStatus &&
    (booking?.isAllRefunded === true || hasExplicitCancellationStatus);
  const isConfirmedOrCompleted =
    statusCode === CONFIRMED_STATUS_CODE || hasExplicitCompletedStatus;
  const totalCount = [
    booking?.bookingCount,
    booking?.personCount,
    booking?.totalPersonCount,
    booking?.snapshotJson?.bookingCount,
    booking?.snapshotJson?.personCount
  ]
    .map(value => Number(value || 0))
    .find(value => Number.isInteger(value) && value >= 1 && value <= 10) || 0;

  // Requested/pending/no-show states are outside the existing sheet contract.
  // Return null rather than treating an unknown state as cancellation.
  if (!isCancelled && !isConfirmedOrCompleted) return null;

  return {
    name: String(booking?.name || booking?.snapshotJson?.name || "").trim(),
    when: formatNaverWhenFromApi(startDate),
    product: String(booking?.bizItemName || booking?.snapshotJson?.bizItemName || "").trim(),
    status: hasExplicitCompletedStatus ? "이용완료" : isCancelled ? "취소" : "확정",
    bookNo: bookingId,
    phone: String(booking?.phone || booking?.snapshotJson?.phone || "").trim(),
    link: bookingId
      ? `https://partner.booking.naver.com/booking-list-view/bookings/${bookingId}`
      : "",
    teamName: readCustomAnswer(booking, /Team명/i),
    difficulty: readCustomAnswer(booking, /난이도\s*선택/i),
    totalCount
  };
}

async function collectBookingsFromNaverApiWithStatus(forceFull = false, providedStatusInfo = null) {
  const { dateKey, startIso, endIso } = getKstBookingRange();
  const statusInfo = providedStatusInfo || await discoverBizItemIds(startIso, endIso);
  const stored = await chrome.storage.local.get(API_SNAPSHOT_KEY);
  const previous = stored[API_SNAPSHOT_KEY];
  const sameDay = previous?.dateKey === dateKey;
  const fullReconcileDue = !sameDay || Date.now() - Number(previous?.lastFullPollAt || 0) >= FULL_RECONCILE_INTERVAL_MS;
  const statusChanged = !statusInfo.fingerprint || statusInfo.fingerprint !== previous?.statusFingerprint;

  // Poll the lightweight status endpoint through the fast trigger or the
  // 30-second alarm fallback. Read the heavier
  // booking lists when counts change, on manual refresh, or at the established
  // 30-second cadence as reconciliation protection against equal-count swaps.
  if (!forceFull && sameDay && !statusChanged && !fullReconcileDue) {
    console.log("[Naver API] status unchanged; detailed poll skipped");
    return { items: [], statusInfo };
  }

  const groups = await Promise.all(
    statusInfo.ids.map(id => fetchBookingsForItem(id, startIso, endIso))
  );

  const currentById = new Map();
  groups.flat().forEach(raw => {
    const item = mapApiBooking(raw);
    if (item?.bookNo) currentById.set(item.bookNo, item);
  });
  const currentItems = Array.from(currentById.values());

  await chrome.storage.local.set({
    [API_SNAPSHOT_KEY]: {
      dateKey,
      items: currentItems,
      statusFingerprint: statusInfo.fingerprint,
      lastFullPollAt: Date.now(),
      updatedAt: Date.now()
    }
  });

  const cancelledCount = currentItems.filter(item => item.status === "취소").length;
  console.log("[Naver API] tracked/cancelled:", currentItems.length, cancelledCount);
  return { items: currentItems, statusInfo };
}

async function collectBookingsFromNaverApi(forceFull = false) {
  const result = await collectBookingsFromNaverApiWithStatus(forceFull);
  return result.items;
}

// ===========================
// Booking conversion
// ===========================
function parseNaverWhen(whenStr) {
  const value = String(whenStr || "").trim();
  const match = value.match(/(\d{2})\.\s*(\d{1,2})\.\s*(\d{1,2})\.\([^)]+\)\s*(오전|오후)\s*(\d{1,2}):(\d{2})/);
  if (!match) return { useDate: "", useTime: "" };

  const year = 2000 + Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  let hour = Number(match[5]);
  const minute = Number(match[6]);

  if (match[4] === "오후" && hour < 12) hour += 12;
  if (match[4] === "오전" && hour === 12) hour = 0;

  return {
    useDate: `${year}-${pad2(month)}-${pad2(day)}`,
    useTime: `${pad2(hour)}:${pad2(minute)}`
  };
}

function isTodayBooking(item, dateKey = getKstBookingRange().dateKey) {
  return parseNaverWhen(item?.when).useDate === dateKey;
}

function parseRoomCode(product) {
  const match = String(product || "").toUpperCase().match(/\b([A-Z]\d)\b/);
  return match ? match[1] : "";
}

function shortDifficulty(difficulty) {
  const value = String(difficulty || "").trim();
  return value ? value.split("(")[0].trim() : "";
}

function buildOrdersRowsFromBookings(items) {
  const crawledAt = new Date();
  const crawlDate = fmtDate(crawledAt);
  const crawlTime = fmtTime(crawledAt);

  return items.map(item => {
    const { useDate, useTime } = parseNaverWhen(item.when);
    const statusRaw = String(item.status || "").trim();
    const status = /이용완료|사용완료/.test(statusRaw)
      ? "COMPLETED"
      : /취소|환불/.test(statusRaw)
      ? "CANCELED"
      : statusRaw.includes("확정")
        ? "RESERVED"
        : statusRaw || "UNKNOWN";

    const memo = [
      `NAVER_NAME=${item.name || ""}`,
      `PHONE=${item.phone || ""}`,
      `USE=${useDate}${useTime ? ` ${useTime}` : ""}`,
      `PRODUCT=${item.product || ""}`,
      `LINK=${item.link || ""}`,
      `CRAWLED_AT=${crawlDate} ${crawlTime}`
    ].join(" | ");

    return [
      useDate || crawlDate,
      crawlTime,
      useTime || "",
      item.bookNo ? `N-${String(item.bookNo).trim()}` : "",
      parseRoomCode(item.product),
      item.teamName || "",
      "",
      "",
      shortDifficulty(item.difficulty) || item.difficulty || "",
      0,
      0,
      0,
      "",
      status,
      "FALSE",
      "NAVER",
      memo
    ];
  });
}

async function postToOrders(items) {
  if (!items.length) return { inserted: 0 };
  const response = await fetch(KIOSK_WEBAPP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sheet: "orders", rows: buildOrdersRowsFromBookings(items) })
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); }
  catch { throw new Error(`orders 서버가 JSON을 반환하지 않았습니다: ${text.slice(0, 160)}`); }
  if (!response.ok || body.success === false) {
    throw new Error(body?.error || body?.message || `HTTP ${response.status}`);
  }
  return body;
}

async function postToMainSheet(items) {
  if (!items.length) return { inserted: 0 };
  const collectedAt = formatKstDateTime();
  const rows = items.map(item => [
    collectedAt,
    item.name || "",
    item.when || "",
    item.product || "",
    item.status || "",
    item.bookNo || "",
    item.phone || "",
    item.link || "",
    item.teamName || "",
    item.difficulty || ""
  ]);

  const response = await fetch(WEBAPP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ rows })
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); }
  catch { throw new Error(`시트 서버가 JSON을 반환하지 않았습니다: ${text.slice(0, 160)}`); }
  if (!response.ok || body.success === false) {
    throw new Error(body?.error || body?.message || `HTTP ${response.status}`);
  }
  return body;
}

async function postToJumpingSite(items) {
  if (!items.length) return { inserted: 0, updated: 0 };
  if (!JUMPING_SITE_IMPORT_TOKEN || JUMPING_SITE_IMPORT_TOKEN.startsWith("__")) {
    throw new Error("점핑배틀 웹 연동 설정이 준비되지 않았습니다.");
  }
  const response = await fetch(JUMPING_SITE_IMPORT_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-jumping-agent-token": JUMPING_SITE_IMPORT_TOKEN
    },
    body: JSON.stringify({ items })
  });
  const text = await response.text();
  let body;
  try { body = JSON.parse(text); }
  catch { throw new Error(`점핑배틀 웹이 JSON을 반환하지 않았습니다: ${text.slice(0, 160)}`); }
  if (!response.ok || body.success === false) {
    throw new Error(body?.error || body?.message || `HTTP ${response.status}`);
  }
  return body;
}

// ===========================
// Durable delivery state and outbox
// ===========================
function bookingStatusKey(status) {
  const value = String(status || "").trim();
  if (/이용완료|사용완료/.test(value)) return "COMPLETED";
  if (/취소|환불/.test(value)) return "CANCELED";
  if (/확정/.test(value)) return "CONFIRMED";
  return value || "UNKNOWN";
}

function bookingKey(item) {
  const bookNo = String(item?.bookNo || "").trim();
  if (bookNo) return `NO:${bookNo}`;
  const aux = [item?.name, item?.when, item?.product]
    .map(value => String(value || "").trim())
    .join("|");
  return aux === "||" ? "" : `AUX:${aux}`;
}

function eventKey(item) {
  const key = bookingKey(item);
  return key ? `${key}::${bookingStatusKey(item.status)}` : "";
}

function bookingSheetFingerprint(item) {
  return JSON.stringify([
    bookingStatusKey(item?.status),
    item?.name || "",
    item?.when || "",
    item?.product || "",
    item?.phone || "",
    item?.link || "",
    item?.teamName || "",
    item?.difficulty || ""
  ]);
}

function normalizeDeliveryEntry(entry) {
  if (!entry) return { sheetStatus: "", ordersStatus: "", siteStatus: "", updatedAt: 0 };
  if (typeof entry === "string") {
    return { sheetStatus: entry, ordersStatus: entry, siteStatus: "", updatedAt: 0 };
  }
  const legacy = entry.status || "";
  return {
    ...entry,
    sheetStatus: entry.sheetStatus || legacy,
    ordersStatus: entry.ordersStatus || legacy,
    siteStatus: entry.siteStatus || ""
  };
}

async function getBookingStates() {
  const data = await chrome.storage.local.get(BOOKING_STATES_KEY);
  const states = data[BOOKING_STATES_KEY];
  return states && typeof states === "object" ? states : {};
}

async function getOutbox() {
  const data = await chrome.storage.local.get(OUTBOX_KEY);
  const outbox = data[OUTBOX_KEY];
  return outbox && typeof outbox === "object" ? outbox : {};
}

async function saveOutbox(outbox) {
  const trimmed = Object.fromEntries(
    Object.entries(outbox)
      .sort(([, left], [, right]) => (right.updatedAt || 0) - (left.updatedAt || 0))
      .slice(0, MAX_OUTBOX_EVENTS)
  );
  await chrome.storage.local.set({ [OUTBOX_KEY]: trimmed });
}

async function saveBookingStates(states) {
  const trimmed = Object.fromEntries(
    Object.entries(states)
      .sort(([, left], [, right]) => (right?.updatedAt || 0) - (left?.updatedAt || 0))
      .slice(0, MAX_BOOKING_STATES)
  );
  await chrome.storage.local.set({ [BOOKING_STATES_KEY]: trimmed });
}

async function selectPendingBookings(items) {
  const [states, seenData] = await Promise.all([
    getBookingStates(),
    chrome.storage.local.get(SEEN_BOOKINGS_KEY)
  ]);
  const seen = new Set(Array.isArray(seenData[SEEN_BOOKINGS_KEY]) ? seenData[SEEN_BOOKINGS_KEY] : []);
  const indices = [];
  const todayKey = getKstBookingRange().dateKey;

  items.forEach((item, index) => {
    const key = bookingKey(item);
    if (!key) {
      indices.push(index);
      return;
    }
    const currentStatus = bookingStatusKey(item.status);
    const currentSheetFingerprint = bookingSheetFingerprint(item);
    const entry = normalizeDeliveryEntry(states[key]);
    const bookNo = String(item.bookNo || "").trim();
    const sheetEligible = isTodayBooking(item, todayKey);

    // Old versions stored only seenBookings. Treat those as already delivered
    // only when there is no richer delivery state.
    if (!states[key] && currentStatus === "CONFIRMED" && bookNo && seen.has(bookNo)) return;

    if (
      (sheetEligible && (
        entry.sheetStatus !== currentStatus ||
        entry.sheetFingerprint !== currentSheetFingerprint ||
        entry.ordersStatus !== currentStatus
      )) ||
      entry.siteStatus !== currentStatus ||
      entry.siteFingerprint !== currentSheetFingerprint
    ) {
      indices.push(index);
    }
  });
  return indices;
}

async function enqueueBookings(items, forceMainSheet) {
  const [states, outbox] = await Promise.all([getBookingStates(), getOutbox()]);
  const now = Date.now();
  const todayKey = getKstBookingRange().dateKey;

  items.forEach(item => {
    const key = bookingKey(item);
    const id = eventKey(item);
    if (!key || !id) return;

    const status = bookingStatusKey(item.status);
    const sheetFingerprint = bookingSheetFingerprint(item);
    const state = normalizeDeliveryEntry(states[key]);
    const existing = outbox[id] || {};
    const sheetEligible = isTodayBooking(item, todayKey);
    outbox[id] = {
      ...existing,
      id,
      bookingKey: key,
      status,
      item,
      sheetPending: sheetEligible && Boolean(
        forceMainSheet ||
        existing.sheetPending ||
        state.sheetStatus !== status ||
        state.sheetFingerprint !== sheetFingerprint
      ),
      ordersPending: sheetEligible && Boolean(
        existing.ordersPending ||
        (!forceMainSheet && state.ordersStatus !== status)
      ),
      sitePending: Boolean(
        existing.sitePending ||
        state.siteStatus !== status ||
        state.siteFingerprint !== sheetFingerprint
      ),
      attempts: existing.attempts || 0,
      updatedAt: now
    };
  });

  await saveOutbox(outbox);
}

async function markDestinationDelivered(items, destination) {
  const states = await getBookingStates();
  const now = Date.now();
  for (const item of items) {
    const key = bookingKey(item);
    if (!key) continue;
    const entry = normalizeDeliveryEntry(states[key]);
    entry[`${destination}Status`] = bookingStatusKey(item.status);
    if (destination === "sheet") {
      entry.sheetFingerprint = bookingSheetFingerprint(item);
    }
    entry.updatedAt = now;
    states[key] = entry;
  }
  await saveBookingStates(states);
}

async function drainOutbox() {
  const outbox = await getOutbox();
  const entries = Object.values(outbox);
  const todayKey = getKstBookingRange().dateKey;

  // Older versions could leave future bookings queued for Google Sheets.
  // Keep those bookings for the website, but discard their sheet deliveries.
  entries.forEach(entry => {
    if (entry.item && !isTodayBooking(entry.item, todayKey)) {
      entry.sheetPending = false;
      entry.ordersPending = false;
    }
  });

  const sheetEntries = entries.filter(entry => entry.sheetPending && entry.item);
  const ordersEntries = entries.filter(entry => entry.ordersPending && entry.item);
  const siteEntries = entries.filter(entry => entry.sitePending && entry.item);

  const [sheetResult, ordersResult, siteResult] = await Promise.allSettled([
    sheetEntries.length ? postToMainSheet(sheetEntries.map(entry => entry.item)) : Promise.resolve({ skipped: true }),
    ordersEntries.length ? postToOrders(ordersEntries.map(entry => entry.item)) : Promise.resolve({ skipped: true }),
    siteEntries.length ? postToJumpingSite(siteEntries.map(entry => entry.item)) : Promise.resolve({ skipped: true })
  ]);

  if (sheetResult.status === "fulfilled" && sheetEntries.length) {
    await markDestinationDelivered(sheetEntries.map(entry => entry.item), "sheet");
    sheetEntries.forEach(entry => { if (outbox[entry.id]) outbox[entry.id].sheetPending = false; });
  }
  if (ordersResult.status === "fulfilled" && ordersEntries.length) {
    await markDestinationDelivered(ordersEntries.map(entry => entry.item), "orders");
    ordersEntries.forEach(entry => { if (outbox[entry.id]) outbox[entry.id].ordersPending = false; });
  }
  if (siteResult.status === "fulfilled" && siteEntries.length) {
    await markDestinationDelivered(siteEntries.map(entry => entry.item), "site");
    const states = await getBookingStates();
    for (const entry of siteEntries) {
      const key = bookingKey(entry.item);
      if (key && states[key]) states[key].siteFingerprint = bookingSheetFingerprint(entry.item);
      if (outbox[entry.id]) outbox[entry.id].sitePending = false;
    }
    await saveBookingStates(states);
  }

  const errorMessages = [];
  if (sheetResult.status === "rejected") errorMessages.push(`sheet: ${sheetResult.reason}`);
  if (ordersResult.status === "rejected") errorMessages.push(`orders: ${ordersResult.reason}`);
  if (siteResult.status === "rejected") errorMessages.push(`site: ${siteResult.reason}`);

  Object.keys(outbox).forEach(id => {
    const entry = outbox[id];
    if (!entry.sheetPending && !entry.ordersPending && !entry.sitePending) {
      delete outbox[id];
    } else if (errorMessages.length) {
      entry.attempts = (entry.attempts || 0) + 1;
      entry.lastError = errorMessages.join(" | ");
      entry.updatedAt = Date.now();
    }
  });
  await saveOutbox(outbox);

  return {
    ok: sheetResult.status === "fulfilled" && ordersResult.status === "fulfilled" && siteResult.status === "fulfilled",
    sheetOk: sheetResult.status === "fulfilled",
    ordersOk: ordersResult.status === "fulfilled",
    siteOk: siteResult.status === "fulfilled",
    sheetSent: sheetEntries.length,
    ordersSent: ordersEntries.length,
    siteSent: siteEntries.length,
    pending: Object.keys(outbox).length,
    error: errorMessages.join(" | ")
  };
}

// ===========================
// Rate-safe fast synchronization
// ===========================
function fastSyncBackoffMs(error, failureCount) {
  const status = Number(error?.httpStatus) || 0;
  const retryAfter = Math.max(0, Number(error?.retryAfterMs) || 0);
  if (status === 401 || status === 403) return FAST_SYNC_MAX_BACKOFF_MS;

  const exponent = Math.min(5, Math.max(1, Number(failureCount) || 1));
  const calculated = FAST_SYNC_INTERVAL_MS * (2 ** exponent);
  const minimum = status === 429 ? 60 * 1000 : 30 * 1000;
  return Math.min(
    FAST_SYNC_MAX_BACKOFF_MS,
    Math.max(minimum, retryAfter, calculated)
  );
}

async function getFastSyncState() {
  const stored = await chrome.storage.local.get(FAST_SYNC_STATE_KEY);
  const value = stored[FAST_SYNC_STATE_KEY];
  return value && typeof value === "object" ? value : {};
}

async function saveFastSyncState(value) {
  await chrome.storage.local.set({ [FAST_SYNC_STATE_KEY]: value });
}

async function runFastSync(trigger = "content", pageHidden = false) {
  const now = Date.now();
  const intervalMs = pageHidden ? FAST_SYNC_HIDDEN_INTERVAL_MS : FAST_SYNC_INTERVAL_MS;
  const [state, activeRun] = await Promise.all([getFastSyncState(), getRunState()]);

  if (activeRun?.expiresAt > now) {
    return { ok: true, skipped: "active-lease", nextPollMs: intervalMs };
  }
  const waitMs = Math.max(0, Number(state.nextAllowedAt || 0) - now);
  if (waitMs > 0) {
    return { ok: true, skipped: "rate-guard", nextPollMs: Math.max(intervalMs, waitMs) };
  }

  await saveFastSyncState({
    ...state,
    nextAllowedAt: now + intervalMs,
    lastStartedAt: now,
    lastTrigger: trigger
  });

  try {
    const { startIso, endIso } = getKstBookingRange();
    const statusBody = await fetchBookingStatus(startIso, endIso);
    const result = await runAutoOnce(false, {
      trigger,
      statusInfo: bookingStatusInfo(statusBody)
    });
    if (!result?.ok) throw result?.error || new Error("fast synchronization failed");
    if (Number(result?.stockError?.httpStatus) === 429) throw result.stockError;

    await saveFastSyncState({
      failureCount: 0,
      nextAllowedAt: Date.now() + intervalMs,
      lastStartedAt: now,
      lastSuccessAt: Date.now(),
      lastTrigger: trigger
    });
    return { ok: true, nextPollMs: intervalMs };
  } catch (error) {
    const failureCount = Math.max(0, Number(state.failureCount) || 0) + 1;
    const backoffMs = fastSyncBackoffMs(error, failureCount);
    await saveFastSyncState({
      failureCount,
      nextAllowedAt: Date.now() + backoffMs,
      lastStartedAt: now,
      lastFailureAt: Date.now(),
      lastTrigger: trigger,
      lastHttpStatus: Number(error?.httpStatus) || 0,
      lastError: String(error?.message || error).slice(0, 160)
    });
    console.warn(`[Fast Sync] ${trigger} backoff ${backoffMs}ms:`, error);
    return { ok: false, nextPollMs: backoffMs };
  }
}

// ===========================
// Alarm and run lifecycle
// ===========================
async function ensureAlarm() {
  const existing = await chrome.alarms.get(AUTO_ALARM);
  if (!existing || existing.periodInMinutes !== PERIOD_MINUTES) {
    await chrome.alarms.create(AUTO_ALARM, { periodInMinutes: PERIOD_MINUTES });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm()
    .then(() => runFastSync("install", false))
    .catch(error => console.error("[Auto] install run error:", error));
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm().catch(error => console.error("[Auto] alarm setup error:", error));
});

chrome.tabs.onRemoved.addListener(async tabId => {
  const [run, stored] = await Promise.all([
    getRunState(),
    chrome.storage.local.get(AUTOMATION_SURFACE_KEY)
  ]);
  if (run?.tabId === tabId) {
    await chrome.storage.local.remove(RUN_STATE_KEY);
    await chrome.alarms.clear(RUN_TIMEOUT_ALARM);
  }
  if (stored[AUTOMATION_SURFACE_KEY]?.tabId === tabId) {
    await chrome.storage.local.remove(AUTOMATION_SURFACE_KEY);
  }
});

chrome.windows.onRemoved.addListener(async windowId => {
  const stored = await chrome.storage.local.get(AUTOMATION_SURFACE_KEY);
  if (stored[AUTOMATION_SURFACE_KEY]?.windowId === windowId) {
    await chrome.storage.local.remove(AUTOMATION_SURFACE_KEY);
  }
});

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm?.name === AUTO_ALARM) {
    runFastSync("alarm", true).catch(error => console.error("[Auto] run error:", error));
  }
  if (alarm?.name === RUN_TIMEOUT_ALARM) {
    getRunState()
      .then(run => finishRun(run?.tabId, "collection timeout"))
      .catch(error => console.error("[Auto] timeout cleanup error:", error));
  }
});

chrome.action.onClicked.addListener(() => {
  runAutoOnce(true).catch(error => console.error("[Manual] run error:", error));
});

async function runAutoOnce(isManual = false, options = {}) {
  // Version 2 no longer needs the minimized DOM automation window.
  await cleanupLegacyAutomationSurface();
  const run = await acquireRun(isManual);
  if (!run) {
    console.log("[Auto] skip (active lease)");
    return { ok: true, skipped: "active-lease" };
  }

  try {
    // Retry previously failed deliveries before polling Naver.
    const retry = await drainOutbox();
    if (!retry.ok) console.warn("[Outbox] retry remains:", retry);

    const collection = await collectBookingsFromNaverApiWithStatus(
      isManual,
      options.statusInfo || null
    );
    const collected = collection.items;
    const pendingIndices = isManual
      ? collected.map((_, index) => index)
      : await selectPendingBookings(collected);
    const pendingItems = pendingIndices.map(index => collected[index]).filter(Boolean);

    await enqueueBookings(pendingItems, isManual);
    const delivery = await drainOutbox();
    if (!delivery.ok) {
      console.warn("[Outbox] delivery remains pending:", delivery);
    }
    let stockError = null;
    try {
      const stock = await syncNaverStock(new Date(), {
        statusBody: collection.statusInfo?.body || null
      });
      await chrome.storage.local.set({
        [NAVER_STOCK_STATUS_KEY]: {
          ok: true,
          ...stock,
          updatedAt: Date.now()
        }
      });
      console.log("[Naver Stock] synchronized:", stock);
    } catch (error) {
      stockError = error;
      await chrome.storage.local.set({
        [NAVER_STOCK_STATUS_KEY]: {
          ok: false,
          message: String(error?.message || error).slice(0, 240),
          updatedAt: Date.now()
        }
      });
      // Reservation delivery must keep running even when the Naver login or
      // write authorization needs to be refreshed.
      console.warn("[Naver Stock] synchronization skipped:", error);
    }
    await finishRun(null, "api poll completed");
    return { ok: true, stockError };
  } catch (error) {
    console.error("[Auto] runner error:", error);
    await finishRun(null, "runner error");
    return { ok: false, error };
  }
}

// ===========================
// Messages from collector
// ===========================
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender?.tab?.id;

  if (message?.type === "NAVER_FAST_SYNC_TICK") {
    const senderUrl = String(sender?.tab?.url || "");
    if (!/^https:\/\/partner\.booking\.naver\.com\//i.test(senderUrl)) {
      sendResponse({ ok: false, error: "unsupported sender" });
      return false;
    }
    runFastSync("content", Boolean(message.pageHidden))
      .then(sendResponse)
      .catch(error => sendResponse({
        ok: false,
        nextPollMs: FAST_SYNC_MAX_BACKOFF_MS,
        error: String(error?.message || error).slice(0, 160)
      }));
    return true;
  }

  if (message?.type === "FILTER_BOOKINGS") {
    (async () => {
      const run = await getRunState();
      const forceRefresh = Boolean(run?.isManual && run.tabId === tabId);
      const items = Array.isArray(message.items) ? message.items : [];
      const indices = forceRefresh
        ? items.map((_, index) => index)
        : await selectPendingBookings(items);
      sendResponse({ ok: true, indices, forceRefresh });
    })().catch(error => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message?.type === "COLLECTION_ERROR" || message?.type === "COLLECTION_SKIPPED") {
    finishRun(tabId, message.type).finally(() => sendResponse({ ok: true }));
    return true;
  }

  if (message?.type !== "BOOKINGS") return false;

  (async () => {
    const run = await getRunState();
    const forceRefresh = Boolean(message.forceRefresh && run?.isManual && run.tabId === tabId);
    const items = Array.isArray(message.items) ? message.items : [];
    await enqueueBookings(items, forceRefresh);
    const result = await drainOutbox();
    sendResponse({ ...result, sent: items.length, forceRefresh });
  })()
    .catch(error => sendResponse({ ok: false, error: String(error) }))
    .finally(() => finishRun(tabId, "post completed"));
  return true;
});

// Ensure the recurring alarm also exists after a service-worker restart.
ensureAlarm().catch(error => console.error("[Auto] alarm bootstrap error:", error));
