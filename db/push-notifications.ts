import { env } from "cloudflare:workers";
import {
  DEFAULT_NOTIFICATION_TIME,
  DEFAULT_NOTIFICATION_WEEKDAYS,
  isNotificationDue,
  normalizeWeekdays,
  seoulClock,
  validDeliveryTime,
  type NotificationSchedule,
} from "@/app/admin/notification-schedule";
import type { SalesBucket } from "@/app/admin/analytics-types";
import { getMonthlyAnalytics } from "./analytics";
import { getD1 } from "./control";
import { ensureReservationSchema } from "./reservations";
import { getRequestExecutionContext } from "vinext/shims/request-context";

type PushEnv = {
  WEB_PUSH_VAPID_PUBLIC_KEY?: string;
  WEB_PUSH_VAPID_PRIVATE_JWK?: string;
  WEB_PUSH_VAPID_SUBJECT?: string;
};

type ScheduleRow = {
  id: string;
  name: string;
  enabled: number;
  delivery_time: string;
  weekdays_json: string;
  last_sent_date: string;
  sort_order: number;
  updated_at: string;
};

type SubscriptionRow = {
  id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  device_name: string;
  device_token_hash: string;
  enabled: number;
  last_success_at: string | null;
  last_error: string;
  created_at: string;
  updated_at: string;
};

export type PushSchedule = {
  id: string;
  name: string;
  enabled: boolean;
  deliveryTime: string;
  weekdays: number[];
  lastSentDate: string;
  sortOrder: number;
  updatedAt: string;
};

export type PushScheduleInput = {
  id?: unknown;
  name?: unknown;
  enabled?: unknown;
  deliveryTime?: unknown;
  weekdays?: unknown;
};

export type PushDevice = {
  id: string;
  deviceName: string;
  enabled: boolean;
  lastSuccessAt: string;
  lastError: string;
  createdAt: string;
  updatedAt: string;
};

export type DailyBriefing = {
  date: string;
  title: string;
  body: string;
  totalRevenue: number;
  deposit: number;
  card: number;
  cash: number;
  account: number;
  gameRevenue: number;
  addOnRevenue: number;
  games: number;
  people: number;
  unpaidCount: number;
};

export const OPERATIONAL_PUSH_EVENTS = [
  "KIOSK_PAYMENT_CONFIRM_REQUIRED",
  "KIOSK_READY_TO_PLAY",
  "KIOSK_START_FAILED",
  "KIOSK_STOP_FAILED",
  "KIOSK_STAFF_HELP",
  "KIOSK_ERROR",
  "BRIDGE_OFFLINE",
  "CONTROL_ERROR",
  "KIOSK_SESSION_STARTED",
] as const;

export type OperationalPushEventType = typeof OPERATIONAL_PUSH_EVENTS[number];

export type OperationalPushSetting = {
  eventType: OperationalPushEventType;
  enabled: boolean;
  updatedAt: string;
};

const OPERATIONAL_PUSH_DEFAULTS: Record<OperationalPushEventType, boolean> = {
  KIOSK_PAYMENT_CONFIRM_REQUIRED: true,
  KIOSK_READY_TO_PLAY: true,
  KIOSK_START_FAILED: true,
  KIOSK_STOP_FAILED: true,
  KIOSK_STAFF_HELP: true,
  KIOSK_ERROR: true,
  BRIDGE_OFFLINE: true,
  CONTROL_ERROR: true,
  KIOSK_SESSION_STARTED: false,
};

let schemaReady = false;

export async function ensurePushNotificationSchema() {
  if (schemaReady) return;
  const db = getD1();
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS push_notification_settings (
        id INTEGER PRIMARY KEY,
        enabled INTEGER NOT NULL DEFAULT 0,
        delivery_time TEXT NOT NULL DEFAULT '21:30',
        weekdays_json TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]',
        last_sent_date TEXT NOT NULL DEFAULT '',
        updated_by TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS push_notification_schedules (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL DEFAULT '매출 브리핑',
        enabled INTEGER NOT NULL DEFAULT 1,
        delivery_time TEXT NOT NULL DEFAULT '21:30',
        weekdays_json TEXT NOT NULL DEFAULT '[0,1,2,3,4,5,6]',
        last_sent_date TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        updated_by TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS push_notification_schedules_due_idx
      ON push_notification_schedules(enabled, delivery_time, sort_order)
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL DEFAULT '',
        auth TEXT NOT NULL DEFAULT '',
        device_name TEXT NOT NULL DEFAULT '',
        device_token_hash TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_success_at TEXT,
        last_error TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_endpoint_uidx
      ON push_subscriptions(endpoint)
    `),
    db.prepare(`
      CREATE UNIQUE INDEX IF NOT EXISTS push_subscriptions_token_uidx
      ON push_subscriptions(device_token_hash)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS push_subscriptions_enabled_idx
      ON push_subscriptions(enabled, updated_at)
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS push_dispatch_log (
        id TEXT PRIMARY KEY,
        briefing_date TEXT NOT NULL,
        dispatch_type TEXT NOT NULL DEFAULT 'scheduled',
        recipient_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        summary_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS push_dispatch_log_date_idx
      ON push_dispatch_log(briefing_date, created_at)
    `),
    db.prepare(`CREATE TABLE IF NOT EXISTS push_operational_settings (
      event_type TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1,
      updated_by TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS push_operational_events (
      id TEXT PRIMARY KEY, event_type TEXT NOT NULL, dedup_key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL, body TEXT NOT NULL, target_url TEXT NOT NULL DEFAULT '/admin/remote',
      tag TEXT NOT NULL DEFAULT 'jumping-battle-operation', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS push_operational_events_created_idx
      ON push_operational_events(created_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS push_operational_deliveries (
      event_id TEXT NOT NULL, device_id TEXT NOT NULL, delivered_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (event_id, device_id)
    )`),
  ]);
  await db
    .prepare(`
      INSERT OR IGNORE INTO push_notification_settings
      (id, enabled, delivery_time, weekdays_json)
      VALUES (1, 0, ?, ?)
    `)
    .bind(DEFAULT_NOTIFICATION_TIME, JSON.stringify(DEFAULT_NOTIFICATION_WEEKDAYS))
    .run();
  await db.prepare(`
    INSERT OR IGNORE INTO push_notification_schedules
      (id, name, enabled, delivery_time, weekdays_json, last_sent_date, sort_order, updated_by, updated_at)
    SELECT 'default', '마감 매출', enabled, delivery_time, weekdays_json,
      last_sent_date, 0, updated_by, updated_at
    FROM push_notification_settings WHERE id = 1
  `).run();
  await db.batch(OPERATIONAL_PUSH_EVENTS.map((eventType) => db.prepare(`
    INSERT OR IGNORE INTO push_operational_settings (event_type, enabled, updated_by)
    VALUES (?, ?, 'system')
  `).bind(eventType, OPERATIONAL_PUSH_DEFAULTS[eventType] ? 1 : 0)));
  schemaReady = true;
}

export async function getOperationalPushSettings(): Promise<OperationalPushSetting[]> {
  await ensurePushNotificationSchema();
  const rows = await getD1().prepare(`SELECT event_type, enabled, updated_at
    FROM push_operational_settings ORDER BY event_type`).all<{
      event_type: string; enabled: number; updated_at: string;
    }>();
  return OPERATIONAL_PUSH_EVENTS.map((eventType) => {
    const row = rows.results.find((item) => item.event_type === eventType);
    return { eventType, enabled: row ? row.enabled === 1 : OPERATIONAL_PUSH_DEFAULTS[eventType], updatedAt: row?.updated_at ?? "" };
  });
}

export async function saveOperationalPushSettings(
  values: Array<{ eventType?: unknown; enabled?: unknown }>,
  updatedBy: string,
) {
  await ensurePushNotificationSchema();
  const requested = new Map(values.map((value) => [String(value.eventType ?? ""), value.enabled === true]));
  const db = getD1();
  await db.batch(OPERATIONAL_PUSH_EVENTS.map((eventType) => db.prepare(`
    INSERT INTO push_operational_settings (event_type, enabled, updated_by, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(event_type) DO UPDATE SET enabled = excluded.enabled,
      updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP
  `).bind(eventType, (requested.has(eventType) ? requested.get(eventType) : OPERATIONAL_PUSH_DEFAULTS[eventType]) ? 1 : 0, updatedBy)));
  return getOperationalPushSettings();
}

function scheduleFromRow(row: ScheduleRow): PushSchedule {
  let weekdays: number[] = [];
  try {
    weekdays = normalizeWeekdays(JSON.parse(row.weekdays_json));
  } catch {
    weekdays = [...DEFAULT_NOTIFICATION_WEEKDAYS];
  }
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    deliveryTime: validDeliveryTime(row.delivery_time)
      ? row.delivery_time
      : DEFAULT_NOTIFICATION_TIME,
    weekdays,
    lastSentDate: row.last_sent_date,
    sortOrder: row.sort_order,
    updatedAt: row.updated_at,
  };
}

export async function getPushSchedules(): Promise<PushSchedule[]> {
  await ensurePushNotificationSchema();
  const rows = await getD1()
    .prepare(`
      SELECT id, name, enabled, delivery_time, weekdays_json,
        last_sent_date, sort_order, updated_at
      FROM push_notification_schedules
      ORDER BY sort_order, delivery_time, id
    `)
    .all<ScheduleRow>();
  return rows.results.map(scheduleFromRow);
}

export async function savePushSchedules(
  values: PushScheduleInput[],
  updatedBy: string,
) {
  if (!Array.isArray(values)) throw new Error("알림 시간 목록을 확인해주세요.");
  if (values.length > 8) throw new Error("예약 알림은 최대 8개까지 설정할 수 있습니다.");
  const schedules = values.map((value, index) => {
    const deliveryTime = String(value.deliveryTime ?? "");
    const weekdays = normalizeWeekdays(value.weekdays);
    const requestedId = String(value.id ?? "").trim();
    const id = requestedId && !requestedId.startsWith("new-")
      ? requestedId.slice(0, 80)
      : crypto.randomUUID();
    const name = String(value.name ?? "").trim().slice(0, 40) || `매출 브리핑 ${index + 1}`;
    if (!validDeliveryTime(deliveryTime)) {
      throw new Error(`${name}의 알림 시간을 다시 확인해주세요.`);
    }
    if (weekdays.length === 0) {
      throw new Error(`${name}의 발송 요일을 한 개 이상 선택해주세요.`);
    }
    return {
      id,
      name,
      enabled: value.enabled === true,
      deliveryTime,
      weekdays,
      sortOrder: index,
    };
  });
  await ensurePushNotificationSchema();
  const db = getD1();
  const statements = schedules.map((schedule) => db.prepare(`
    INSERT INTO push_notification_schedules
      (id, name, enabled, delivery_time, weekdays_json, sort_order, updated_by, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      enabled = excluded.enabled,
      delivery_time = excluded.delivery_time,
      weekdays_json = excluded.weekdays_json,
      sort_order = excluded.sort_order,
      updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP
  `).bind(
    schedule.id,
    schedule.name,
    schedule.enabled ? 1 : 0,
    schedule.deliveryTime,
    JSON.stringify(schedule.weekdays),
    schedule.sortOrder,
    updatedBy.slice(0, 120),
  ));
  const retainedIds = schedules.map((schedule) => schedule.id);
  statements.push(
    retainedIds.length > 0
      ? db.prepare(`DELETE FROM push_notification_schedules WHERE id NOT IN (${retainedIds.map(() => "?").join(",")})`).bind(...retainedIds)
      : db.prepare("DELETE FROM push_notification_schedules"),
  );
  await db.batch(statements);
  return getPushSchedules();
}

function publicKey() {
  return String((env as unknown as PushEnv).WEB_PUSH_VAPID_PUBLIC_KEY ?? "").trim();
}

export function getWebPushPublicKey() {
  const value = publicKey();
  if (!value) throw new Error("휴대폰 알림 보안키가 준비되지 않았습니다.");
  return value;
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return bytesToBase64Url(new Uint8Array(digest));
}

function newDeviceToken() {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export async function registerPushSubscription(input: {
  endpoint: string;
  p256dh: string;
  auth: string;
  deviceName: string;
}) {
  await ensurePushNotificationSchema();
  getWebPushPublicKey();
  const endpoint = String(input.endpoint ?? "").trim().slice(0, 2_000);
  if (!endpoint.startsWith("https://")) {
    throw new Error("휴대폰 알림 주소가 올바르지 않습니다.");
  }
  const deviceToken = newDeviceToken();
  const deviceTokenHash = await sha256(deviceToken);
  const id = crypto.randomUUID();
  const deviceName = String(input.deviceName || "내 휴대폰").trim().slice(0, 60);
  await getD1()
    .prepare(`
      INSERT INTO push_subscriptions
      (id, endpoint, p256dh, auth, device_name, device_token_hash, enabled)
      VALUES (?, ?, ?, ?, ?, ?, 1)
      ON CONFLICT(endpoint) DO UPDATE SET
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        device_name = excluded.device_name,
        device_token_hash = excluded.device_token_hash,
        enabled = 1,
        last_error = '',
        updated_at = CURRENT_TIMESTAMP
    `)
    .bind(
      id,
      endpoint,
      String(input.p256dh ?? "").slice(0, 500),
      String(input.auth ?? "").slice(0, 500),
      deviceName,
      deviceTokenHash,
    )
    .run();
  const row = await getD1()
    .prepare(`SELECT id FROM push_subscriptions WHERE endpoint = ?`)
    .bind(endpoint)
    .first<{ id: string }>();
  return { deviceId: row?.id ?? id, deviceToken };
}

function deviceFromRow(row: SubscriptionRow): PushDevice {
  return {
    id: row.id,
    deviceName: row.device_name,
    enabled: row.enabled === 1,
    lastSuccessAt: row.last_success_at ?? "",
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listPushDevices() {
  await ensurePushNotificationSchema();
  const result = await getD1()
    .prepare(`
      SELECT id, endpoint, p256dh, auth, device_name, device_token_hash,
        enabled, last_success_at, last_error, created_at, updated_at
      FROM push_subscriptions
      ORDER BY enabled DESC, updated_at DESC
    `)
    .all<SubscriptionRow>();
  return result.results.map(deviceFromRow);
}

export async function setPushDeviceEnabled(id: string, enabled: boolean) {
  await ensurePushNotificationSchema();
  await getD1()
    .prepare(`
      UPDATE push_subscriptions SET enabled = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
    .bind(enabled ? 1 : 0, id)
    .run();
  return listPushDevices();
}

export async function deletePushDevice(id: string) {
  await ensurePushNotificationSchema();
  await getD1().prepare(`DELETE FROM push_subscriptions WHERE id = ?`).bind(id).run();
}

function zeroBucket(): Pick<
  SalesBucket,
  | "revenue"
  | "deposit"
  | "card"
  | "cash"
  | "account"
  | "gameRevenue"
  | "addOnRevenue"
  | "games"
  | "people"
> {
  return {
    revenue: 0,
    deposit: 0,
    card: 0,
    cash: 0,
    account: 0,
    gameRevenue: 0,
    addOnRevenue: 0,
    games: 0,
    people: 0,
  };
}

function won(value: number) {
  return new Intl.NumberFormat("ko-KR").format(Math.max(0, Math.trunc(value)));
}

export async function getDailyBriefing(date = seoulClock().date): Promise<DailyBriefing> {
  await ensureReservationSchema();
  const [analytics, unpaid] = await Promise.all([
    getMonthlyAnalytics(date.slice(0, 7)),
    getD1()
      .prepare(`
        SELECT COUNT(*) AS count
        FROM reservations
        WHERE scheduled_date = ?
          AND status <> 'cancelled'
          AND payment_status <> 'paid'
      `)
      .bind(date)
      .first<{ count: number }>(),
  ]);
  const summary = analytics.days.find((day) => day.key === date) ?? zeroBucket();
  const unpaidCount = Math.max(0, Number(unpaid?.count ?? 0));
  const [, month = "", day = ""] = date.match(/^\d{4}-(\d{2})-(\d{2})$/) ?? [];
  return {
    date,
    title: `${Number(month)}월 ${Number(day)}일 매출 브리핑`,
    body: [
      `총 매출 ${won(summary.revenue)}원`,
      `예약금 ${won(summary.deposit)} · 카드 ${won(summary.card)} · 현금 ${won(summary.cash)} · 계좌 ${won(summary.account)}`,
      `게임 ${won(summary.gameRevenue)} · 부가 ${won(summary.addOnRevenue)} / ${summary.games}건 ${summary.people}명 · 미결제 ${unpaidCount}건`,
    ].join("\n"),
    totalRevenue: summary.revenue,
    deposit: summary.deposit,
    card: summary.card,
    cash: summary.cash,
    account: summary.account,
    gameRevenue: summary.gameRevenue,
    addOnRevenue: summary.addOnRevenue,
    games: summary.games,
    people: summary.people,
    unpaidCount,
  };
}

function jsonBase64Url(value: unknown) {
  return bytesToBase64Url(new TextEncoder().encode(JSON.stringify(value)));
}

async function vapidAuthorization(endpoint: string) {
  const pushEnv = env as unknown as PushEnv;
  const privateJwkText = String(pushEnv.WEB_PUSH_VAPID_PRIVATE_JWK ?? "");
  const key = publicKey();
  if (!privateJwkText || !key) {
    throw new Error("휴대폰 알림 보안키가 준비되지 않았습니다.");
  }
  const privateJwk = JSON.parse(privateJwkText) as JsonWebKey;
  const privateKey = await crypto.subtle.importKey(
    "jwk",
    privateJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const now = Math.floor(Date.now() / 1_000);
  const encoded = `${jsonBase64Url({ typ: "JWT", alg: "ES256" })}.${jsonBase64Url({
    aud: new URL(endpoint).origin,
    exp: now + 12 * 60 * 60,
    sub:
      pushEnv.WEB_PUSH_VAPID_SUBJECT ??
      "https://your-site.example",
  })}`;
  const signature = await crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    new TextEncoder().encode(encoded),
  );
  return `vapid t=${encoded}.${bytesToBase64Url(new Uint8Array(signature))}, k=${key}`;
}

async function sendEmptyWebPush(row: SubscriptionRow) {
  const response = await fetch(row.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidAuthorization(row.endpoint),
      TTL: "120",
      Urgency: "normal",
    },
  });
  if (!response.ok) {
    throw new Error(`알림 서비스 응답 ${response.status}`);
  }
}

async function enabledSubscriptionRows(deviceId?: string) {
  await ensurePushNotificationSchema();
  const db = getD1();
  const query = deviceId
    ? db
        .prepare(`
          SELECT id, endpoint, p256dh, auth, device_name, device_token_hash,
            enabled, last_success_at, last_error, created_at, updated_at
          FROM push_subscriptions WHERE enabled = 1 AND id = ?
        `)
        .bind(deviceId)
    : db.prepare(`
        SELECT id, endpoint, p256dh, auth, device_name, device_token_hash,
          enabled, last_success_at, last_error, created_at, updated_at
        FROM push_subscriptions WHERE enabled = 1
      `);
  return (await query.all<SubscriptionRow>()).results;
}

async function dispatchRows(rows: SubscriptionRow[]) {
  const db = getD1();
  let successCount = 0;
  let failureCount = 0;
  for (const row of rows) {
    try {
      await sendEmptyWebPush(row);
      successCount += 1;
      await db
        .prepare(`
          UPDATE push_subscriptions SET
            last_success_at = CURRENT_TIMESTAMP, last_error = '', updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .bind(row.id)
        .run();
    } catch (error) {
      failureCount += 1;
      const message = error instanceof Error ? error.message : "알림 발송 실패";
      const expired = /응답 (404|410)$/.test(message);
      await db
        .prepare(`
          UPDATE push_subscriptions SET
            enabled = CASE WHEN ? = 1 THEN 0 ELSE enabled END,
            last_error = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `)
        .bind(expired ? 1 : 0, message.slice(0, 300), row.id)
        .run();
    }
  }
  return { recipientCount: rows.length, successCount, failureCount };
}

export async function sendTestPush(deviceId?: string) {
  const rows = await enabledSubscriptionRows(deviceId);
  if (rows.length === 0) throw new Error("활성화된 알림 기기가 없습니다.");
  const briefing = await getDailyBriefing();
  const result = await dispatchRows(rows);
  await getD1()
    .prepare(`
      INSERT INTO push_dispatch_log
      (id, briefing_date, dispatch_type, recipient_count, success_count, failure_count, summary_json)
      VALUES (?, ?, 'test', ?, ?, ?, ?)
    `)
    .bind(
      crypto.randomUUID(),
      briefing.date,
      result.recipientCount,
      result.successCount,
      result.failureCount,
      JSON.stringify(briefing),
    )
    .run();
  if (result.successCount === 0) throw new Error("시험 알림을 보내지 못했습니다.");
  return result;
}

let nextAutomaticCheckAt = 0;

export async function dispatchDueSalesBriefing(now = new Date()) {
  const clock = seoulClock(now);
  const schedules = await getPushSchedules();
  const dueSchedules = schedules.filter((schedule) =>
    isNotificationDue(schedule as NotificationSchedule, clock),
  );
  if (dueSchedules.length === 0) return { due: false };

  const db = getD1();
  const claimedSchedules: PushSchedule[] = [];
  for (const schedule of dueSchedules) {
    const claimed = await db
      .prepare(`
        UPDATE push_notification_schedules SET
          last_sent_date = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND enabled = 1 AND last_sent_date <> ?
        RETURNING id
      `)
      .bind(clock.date, schedule.id, clock.date)
      .first<{ id: string }>();
    if (claimed) claimedSchedules.push(schedule);
  }
  if (claimedSchedules.length === 0) return { due: false };

  const [briefing, rows] = await Promise.all([
    getDailyBriefing(clock.date),
    enabledSubscriptionRows(),
  ]);
  let recipientCount = 0;
  let successCount = 0;
  let failureCount = 0;
  for (const schedule of claimedSchedules) {
    const result = await dispatchRows(rows);
    recipientCount += result.recipientCount;
    successCount += result.successCount;
    failureCount += result.failureCount;
    await db
      .prepare(`
        INSERT INTO push_dispatch_log
        (id, briefing_date, dispatch_type, recipient_count, success_count, failure_count, summary_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        crypto.randomUUID(),
        briefing.date,
        `scheduled:${schedule.id}`,
        result.recipientCount,
        result.successCount,
        result.failureCount,
        JSON.stringify({ ...briefing, scheduleName: schedule.name }),
      )
      .run();
  }
  return {
    due: true,
    scheduleCount: claimedSchedules.length,
    recipientCount,
    successCount,
    failureCount,
  };
}

type OperationalPushInput = {
  eventType: OperationalPushEventType;
  dedupKey: string;
  title: string;
  body: string;
  targetUrl?: string;
  tag?: string;
};

export async function dispatchOperationalPush(input: OperationalPushInput) {
  await ensurePushNotificationSchema();
  const db = getD1();
  const enabled = await db.prepare(`SELECT enabled FROM push_operational_settings WHERE event_type = ? LIMIT 1`)
    .bind(input.eventType).first<{ enabled: number }>();
  if (enabled?.enabled !== 1) return { dispatched: false, reason: "disabled" as const };

  const eventId = crypto.randomUUID();
  const inserted = await db.prepare(`INSERT OR IGNORE INTO push_operational_events
    (id, event_type, dedup_key, title, body, target_url)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(
      eventId,
      input.eventType,
      input.dedupKey.slice(0, 180),
      input.title.slice(0, 100),
      input.body.slice(0, 300),
      (input.targetUrl || "/admin/remote").slice(0, 300),
    ).run();
  if (!inserted.meta.changes) return { dispatched: false, reason: "duplicate" as const };

  const rows = await enabledSubscriptionRows();
  const result = await dispatchRows(rows);
  await db.prepare(`INSERT INTO push_dispatch_log
    (id, briefing_date, dispatch_type, recipient_count, success_count, failure_count, summary_json)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      crypto.randomUUID(),
      seoulClock().date,
      `operation:${input.eventType}`,
      result.recipientCount,
      result.successCount,
      result.failureCount,
      JSON.stringify({ eventId, eventType: input.eventType, tag: input.tag || input.eventType }),
    ).run();
  return { dispatched: true, eventId, ...result };
}

export function deferOperationalPush(input: OperationalPushInput) {
  const task = dispatchOperationalPush(input).catch(() => ({ dispatched: false as const, reason: "failed" as const }));
  try {
    getRequestExecutionContext().waitUntil(task);
  } catch {
    void task;
  }
}

export function maybeDispatchDueSalesBriefing() {
  if (Date.now() < nextAutomaticCheckAt) return Promise.resolve({ due: false });
  nextAutomaticCheckAt = Date.now() + 45_000;
  return dispatchDueSalesBriefing().catch(() => ({ due: false }));
}

export async function briefingForDevice(id: string, token: string) {
  await ensurePushNotificationSchema();
  const tokenHash = await sha256(token);
  const row = await getD1()
    .prepare(`
      SELECT id FROM push_subscriptions
      WHERE id = ? AND device_token_hash = ? AND enabled = 1
    `)
    .bind(id, tokenHash)
    .first<{ id: string }>();
  if (!row) return null;
  return getDailyBriefing();
}

export async function notificationForDevice(id: string, token: string) {
  await ensurePushNotificationSchema();
  const tokenHash = await sha256(token);
  const device = await getD1().prepare(`SELECT id FROM push_subscriptions
    WHERE id = ? AND device_token_hash = ? AND enabled = 1`)
    .bind(id, tokenHash).first<{ id: string }>();
  if (!device) return null;

  const event = await getD1().prepare(`SELECT e.id, e.event_type, e.title, e.body, e.target_url
    FROM push_operational_events e
    LEFT JOIN push_operational_deliveries d ON d.event_id = e.id AND d.device_id = ?
    WHERE d.event_id IS NULL AND e.created_at > datetime('now', '-1 day')
    ORDER BY e.created_at DESC LIMIT 1`)
    .bind(id).first<{ id: string; event_type: string; title: string; body: string; target_url: string }>();
  if (event) {
    await getD1().prepare(`INSERT OR IGNORE INTO push_operational_deliveries (event_id, device_id) VALUES (?, ?)`)
      .bind(event.id, id).run();
    return {
      kind: "operation",
      title: event.title,
      body: event.body,
      url: event.target_url || "/admin/remote",
      tag: `jumping-operation-${event.event_type.toLowerCase()}`,
    };
  }

  const briefing = await getDailyBriefing();
  return { ...briefing, kind: "briefing", url: "/admin/analytics", tag: "jumping-battle-daily-sales" };
}
