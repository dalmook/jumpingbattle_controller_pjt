import {
  B1_MEDIUM_DIFFICULTY_OPTIONS,
  calculateBaseAmount,
  dateInSeoul,
  DIFFICULTY_OPTIONS,
  getDifficultyOptions,
  getRoom,
  nextBookableTime,
  OPERATING_SLOTS,
  ROOM_OPTIONS,
} from "@/app/reservation-config";
import {
  calculateParticipantTopUp,
  canCustomerStart,
  isPaymentOrGameCritical,
  kioskSlotStartsAfterRunningGame,
  KIOSK_HOLD_MS,
  KIOSK_SESSION_IDLE_MS,
  normalizeKioskPaymentItems,
  paidGameParticipantCount,
  stampAwardQuantity,
} from "@/app/kiosk/domain";
import { GAME_MINUTES } from "@/app/admin/availability";
import { createAddOnSaleOrder, quoteAddOnSale, type AddOnSaleSelectionInput } from "./add-on-sales";
import { supportsPaymentCommands } from "./bridge-capabilities";
import {
  assertControlCommandReady,
  ensureControlSchema,
  getControlAgentId,
  getD1,
} from "./control";
import { getCustomerMemberDashboard, verifyCustomerMemberCredentials } from "./member-auth";
import { getBenefitSettings, getMemberBenefits, redeemMemberPass } from "./member-benefits";
import {
  cancelUnstartedKioskPaymentPlan,
  changePendingPaymentTransactionMethod,
  getPaymentOverview,
  getPaymentTerminalState,
  prepareParticipantTopUpPlan,
  preparePaymentTransactionRetry,
  preparePaymentPlan,
  processPaymentTransaction,
  processPreparedPaymentTransaction,
  waitForPaymentAttemptResult,
} from "./payments";
import { getPricingSettings, updatePricingSettings } from "./pricing-settings";
import { queueAutomaticParkingRegistration } from "./parking-registration";
import { createWebReservation, ensureReservationSchema, getReservationById } from "./reservations";
import { markKioskStage, measureKioskStage, type KioskLatencyTrace } from "./kiosk-latency";
import { deferOperationalPush } from "./push-notifications";
import {
  assertKioskPaymentMethodEnabled,
} from "@/app/kiosk/payment-settings";
import {
  evaluateKioskVisitCleanup,
  type KioskVisitCleanupFacts,
} from "@/app/kiosk/admin-cleanup-policy";
import {
  ensureKioskBankTransferSession,
  getKioskBankTransferSessionForTransaction,
  getKioskPaymentSettings,
  setKioskBankTransferSessionStatus,
} from "./kiosk-payment-settings";

const START_TOKEN_MS = 10 * 60_000;
const STICKY_VISIT_STATES = new Set([
  "PAYMENT_PENDING", "WAITING_STAFF_CONFIRMATION", "PREPARING", "READY_TO_PLAY", "PLAYING", "COMPLETED",
  "ABORTED", "ERROR", "START_FAILED", "STAFF_REVIEW",
]);

type VisitRow = {
  id: string;
  kiosk_id: string;
  flow_type: string;
  status: string;
  party_count: number;
  adult_count: number;
  youth_count: number;
  representative_member_id: string | null;
  customer_name: string;
  customer_phone: string;
  team_name: string;
  scheduled_date: string;
  scheduled_time: string;
  room_code: string;
  difficulty_code: string;
  difficulty_label: string;
  map_index: number;
  reservation_id: string | null;
  hold_id: string | null;
  add_ons_json: string;
  settlement_json: string;
  stamp_allocations_json: string;
  base_amount: number;
  add_on_amount: number;
  discount_amount: number;
  final_amount: number;
  start_token_hash: string;
  start_token_value: string;
  start_token_expires_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  error_code: string;
  error_message: string;
  client_revision: number;
  expires_at: string;
  created_at: string;
  updated_at: string;
};

type HoldRow = {
  id: string;
  visit_id: string;
  scheduled_date: string;
  scheduled_time: string;
  room_code: string;
  state: string;
  expires_at: string;
};

type VisitGameRow = {
  id: string;
  visit_id: string;
  sequence: number;
  status: string;
  scheduled_date: string;
  scheduled_time: string;
  room_code: string;
  room_size: string;
  difficulty_code: string;
  difficulty_label: string;
  map_index: number;
  adult_count: number;
  youth_count: number;
  party_count: number;
  game_count: number;
  base_amount: number;
  hold_id: string;
  active_slot_key: string | null;
  reservation_id: string | null;
  expires_at: string;
};

type ParticipantTopUpSettlement = {
  targetReservationId?: string;
  expectedAdultCount?: number;
  expectedYouthCount?: number;
  additionalAdultCount?: number;
  additionalYouthCount?: number;
  targetAdultCount?: number;
  targetYouthCount?: number;
  amount?: number;
  firstSplitIndex?: number;
};

let kioskSchemaReady: Promise<void> | null = null;

function json<T>(value: string, fallback: T): T {
  try { return JSON.parse(value) as T; } catch { return fallback; }
}

function bytesToHex(bytes: Uint8Array) {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomToken(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return bytesToHex(value);
}

async function sha256(value: string) {
  return bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))));
}

function clamp(value: unknown, min: number, max: number) {
  const number = Math.trunc(Number(value));
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : min;
}

function cleanText(value: unknown, max: number) {
  return String(value ?? "").trim().slice(0, max);
}

function participantTopUpSettlement(visit: VisitRow) {
  return json<{ participantTopUp?: ParticipantTopUpSettlement }>(visit.settlement_json, {})
    .participantTopUp ?? {};
}

function paymentReservationIdForVisit(visit: VisitRow) {
  if (visit.flow_type === "PARTY_TOP_UP") {
    return cleanText(participantTopUpSettlement(visit).targetReservationId, 100);
  }
  return visit.reservation_id ?? "";
}

function parseSeoulSlot(date: string, time: string) {
  return Date.parse(`${date}T${time}:00+09:00`);
}

function slotKey(date: string, time: string, roomCode: string) {
  return `${date}|${time}|${roomCode}`;
}

async function initializeKioskSchema() {
  await Promise.all([ensureControlSchema(), ensureReservationSchema()]);
  const db = getD1();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS customer_visits (
      id TEXT PRIMARY KEY, session_token_hash TEXT NOT NULL UNIQUE, kiosk_id TEXT NOT NULL DEFAULT '',
      flow_type TEXT NOT NULL DEFAULT 'WALK_IN', status TEXT NOT NULL DEFAULT 'DRAFT',
      party_count INTEGER NOT NULL DEFAULT 1, game_count INTEGER NOT NULL DEFAULT 1, adult_count INTEGER NOT NULL DEFAULT 0,
      youth_count INTEGER NOT NULL DEFAULT 1, representative_member_id TEXT,
      customer_name TEXT NOT NULL DEFAULT '', customer_phone TEXT NOT NULL DEFAULT '', team_name TEXT NOT NULL DEFAULT '',
      scheduled_date TEXT NOT NULL DEFAULT '', scheduled_time TEXT NOT NULL DEFAULT '', room_code TEXT NOT NULL DEFAULT '',
      difficulty_code TEXT NOT NULL DEFAULT '', difficulty_label TEXT NOT NULL DEFAULT '', map_index INTEGER NOT NULL DEFAULT 0,
      reservation_id TEXT UNIQUE, hold_id TEXT, add_ons_json TEXT NOT NULL DEFAULT '{}', settlement_json TEXT NOT NULL DEFAULT '{}',
      stamp_allocations_json TEXT NOT NULL DEFAULT '[]', base_amount INTEGER NOT NULL DEFAULT 0,
      add_on_amount INTEGER NOT NULL DEFAULT 0, discount_amount INTEGER NOT NULL DEFAULT 0, final_amount INTEGER NOT NULL DEFAULT 0,
      start_token_hash TEXT NOT NULL DEFAULT '', start_token_value TEXT NOT NULL DEFAULT '', start_token_expires_at TEXT, started_at TEXT, completed_at TEXT,
      error_code TEXT NOT NULL DEFAULT '', error_message TEXT NOT NULL DEFAULT '', expires_at TEXT NOT NULL,
      client_revision INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS customer_visits_status_updated_idx ON customer_visits(status, updated_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS customer_visits_room_status_idx ON customer_visits(room_code, status, updated_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS customer_visits_reservation_idx ON customer_visits(reservation_id)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS customer_visit_members (
      visit_id TEXT NOT NULL, member_id TEXT NOT NULL, member_name TEXT NOT NULL DEFAULT '', role TEXT NOT NULL DEFAULT 'PARTICIPANT',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (visit_id, member_id)
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS customer_visit_members_member_idx ON customer_visit_members(member_id, created_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS customer_room_holds (
      id TEXT PRIMARY KEY, visit_id TEXT NOT NULL UNIQUE, store_code TEXT NOT NULL DEFAULT 'HWASEONG_BYEONGJEOM',
      scheduled_date TEXT NOT NULL, scheduled_time TEXT NOT NULL, room_code TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'ACTIVE', active_slot_key TEXT UNIQUE, expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS customer_room_holds_schedule_idx ON customer_room_holds(scheduled_date, scheduled_time, room_code, state)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS customer_room_holds_expiry_idx ON customer_room_holds(state, expires_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS customer_visit_games (
      id TEXT PRIMARY KEY, visit_id TEXT NOT NULL, sequence INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'HOLD',
      scheduled_date TEXT NOT NULL, scheduled_time TEXT NOT NULL, room_code TEXT NOT NULL, room_size TEXT NOT NULL,
      difficulty_code TEXT NOT NULL, difficulty_label TEXT NOT NULL DEFAULT '', map_index INTEGER NOT NULL DEFAULT 0,
      adult_count INTEGER NOT NULL DEFAULT 0, youth_count INTEGER NOT NULL DEFAULT 0, party_count INTEGER NOT NULL DEFAULT 0,
      base_amount INTEGER NOT NULL DEFAULT 0, hold_id TEXT NOT NULL DEFAULT '', active_slot_key TEXT UNIQUE,
      reservation_id TEXT, expires_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(visit_id, sequence)
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS customer_visit_games_visit_idx ON customer_visit_games(visit_id, sequence)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS customer_visit_games_reservation_idx ON customer_visit_games(reservation_id)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS customer_visit_games_schedule_idx ON customer_visit_games(scheduled_date, scheduled_time, room_code, status)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS customer_visit_games_expiry_idx ON customer_visit_games(status, expires_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS customer_product_availability (
      product_code TEXT PRIMARY KEY, status TEXT NOT NULL DEFAULT 'SALE', updated_by TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS customer_product_overrides (
      product_code TEXT PRIMARY KEY, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
      updated_by TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE TABLE IF NOT EXISTS kiosk_guidance_items (
      id TEXT PRIMARY KEY, placement TEXT NOT NULL DEFAULT 'BEFORE_GAME_START', content TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS kiosk_guidance_placement_order_idx
      ON kiosk_guidance_items(placement, sort_order)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS customer_stamp_allocations (
      id TEXT PRIMARY KEY, visit_id TEXT NOT NULL, member_id TEXT NOT NULL, quantity INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'PENDING', reference_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS customer_stamp_allocations_visit_idx ON customer_stamp_allocations(visit_id, status)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS kiosk_visit_admin_audit (
      id TEXT PRIMARY KEY, visit_id TEXT NOT NULL, reservation_id TEXT NOT NULL DEFAULT '', action TEXT NOT NULL,
      previous_status TEXT NOT NULL DEFAULT '', next_status TEXT NOT NULL DEFAULT '', reason TEXT NOT NULL DEFAULT '',
      details_json TEXT NOT NULL DEFAULT '{}', created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS kiosk_visit_admin_audit_visit_created_idx
      ON kiosk_visit_admin_audit(visit_id, created_at DESC)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS kiosk_visit_admin_audit_action_created_idx
      ON kiosk_visit_admin_audit(action, created_at DESC)`),
    db.prepare(`INSERT OR IGNORE INTO customer_product_overrides (product_code, name, sort_order, updated_by)
      VALUES ('slush', '슬러시', 10, 'system'), ('beverage', '음료', 20, 'system'), ('other', '양말', 30, 'system')`),
    db.prepare(`INSERT OR IGNORE INTO kiosk_guidance_items (id, placement, content, sort_order, active) VALUES
      ('after-payment-locker', 'AFTER_PAYMENT', '소지품과 짐은 락커에 보관해주세요.', 10, 1),
      ('after-payment-shoes', 'AFTER_PAYMENT', '실내화로 갈아 신어주세요.', 20, 1),
      ('after-payment-return', 'AFTER_PAYMENT', '준비가 끝나면 첫 화면에서 방을 선택하고 게임을 시작해주세요.', 30, 1),
      ('before-start-locker', 'BEFORE_GAME_START', '소지품과 짐을 락커에 보관했어요.', 10, 1),
      ('before-start-shoes', 'BEFORE_GAME_START', '실내화로 갈아 신었어요.', 20, 1),
      ('before-start-safety', 'BEFORE_GAME_START', '안전 안내를 확인했어요.', 30, 1),
      ('before-start-party', 'BEFORE_GAME_START', '입장 인원을 확인했어요.', 40, 1),
      ('before-start-level', 'BEFORE_GAME_START', '선택한 난이도를 확인했어요.', 50, 1),
      ('after-game-timelapse', 'AFTER_GAME', '게임이 끝나면 타임랩스 영상은 프론트에서 받아가세요.', 10, 1)`),
  ]);
  const guidanceColumns = await db.prepare("PRAGMA table_info(kiosk_guidance_items)")
    .all<{ name: string }>();
  const guidanceColumnNames = new Set(guidanceColumns.results.map((column) => column.name));
  const missingGuidanceColumns = [
    ["title", "TEXT NOT NULL DEFAULT ''"],
    ["summary", "TEXT NOT NULL DEFAULT ''"],
    ["agreement_text", "TEXT NOT NULL DEFAULT ''"],
    ["required", "INTEGER NOT NULL DEFAULT 0"],
    ["version", "INTEGER NOT NULL DEFAULT 1"],
  ].filter(([name]) => !guidanceColumnNames.has(name));
  for (const [name, definition] of missingGuidanceColumns) {
    await db.prepare(`ALTER TABLE kiosk_guidance_items ADD COLUMN ${name} ${definition}`).run();
  }
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS kiosk_guidance_agreements (
      id TEXT PRIMARY KEY, visit_id TEXT NOT NULL, guidance_id TEXT NOT NULL,
      guidance_version INTEGER NOT NULL, agreed INTEGER NOT NULL DEFAULT 1,
      agreed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(visit_id, guidance_id, guidance_version)
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS kiosk_guidance_agreements_visit_idx
      ON kiosk_guidance_agreements(visit_id, agreed_at)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS kiosk_room_recommendation_rules (
      id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', adult_min INTEGER NOT NULL DEFAULT 0,
      adult_max INTEGER NOT NULL DEFAULT 10, youth_min INTEGER NOT NULL DEFAULT 0,
      youth_max INTEGER NOT NULL DEFAULT 10, total_min INTEGER NOT NULL DEFAULT 1,
      total_max INTEGER NOT NULL DEFAULT 10, primary_size TEXT NOT NULL,
      secondary_size TEXT NOT NULL DEFAULT '', active INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 100, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE INDEX IF NOT EXISTS kiosk_room_recommendation_active_priority_idx
      ON kiosk_room_recommendation_rules(active, priority, total_min, total_max)`),
    db.prepare(`INSERT OR IGNORE INTO kiosk_room_recommendation_rules
      (id, name, total_min, total_max, primary_size, secondary_size, priority) VALUES
      ('default-small-1-4', '1~4명', 1, 4, 'SMALL', 'MEDIUM', 10),
      ('default-medium-5-6', '5~6명', 5, 6, 'MEDIUM', 'LARGE', 20),
      ('default-large-7-10', '7명 이상', 7, 10, 'LARGE', '', 30)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS kiosk_display_settings (
      id TEXT PRIMARY KEY, home_title TEXT NOT NULL DEFAULT '오늘도 신나게 뛰어볼까요?',
      home_subtitle TEXT NOT NULL DEFAULT '예약 확인 또는 현장 이용을 선택해주세요.',
      updated_by TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`INSERT OR IGNORE INTO kiosk_display_settings
      (id, home_title, home_subtitle, updated_by)
      VALUES ('main', '오늘도 신나게 뛰어볼까요?', '예약 확인 또는 현장 이용을 선택해주세요.', 'system')`),
    db.prepare(`INSERT OR IGNORE INTO kiosk_guidance_items
      (id, placement, content, title, summary, agreement_text, required, version, sort_order, active)
      VALUES ('required-safety-consent', 'REQUIRED_AGREEMENT',
        '부주의로 인한 사고·부상 및 LED로 인한 어지러움·구토 등의 증상 발생 시, 이에 대한 책임은 이용자에게 있습니다.',
        '안전 이용 안내', '게임 전 안전수칙과 이용자 책임 범위를 확인해주세요.',
        '필수 이용안내를 확인했고 동의합니다.', 1, 1, 10, 1)`),
    db.prepare(`UPDATE kiosk_guidance_items SET
      title = CASE WHEN title <> '' THEN title WHEN id = 'before-start-safety' THEN '안전 이용 안내'
        WHEN placement = 'BEFORE_GAME_START' THEN '게임 시작 전 확인'
        WHEN placement = 'AFTER_PAYMENT' THEN '이용 준비 안내' ELSE '이용 안내' END,
      summary = CASE WHEN summary = '' THEN content ELSE summary END,
      agreement_text = CASE WHEN agreement_text = '' AND id = 'before-start-safety'
        THEN '안전 이용안내를 확인했고 동의합니다.' ELSE agreement_text END,
      required = CASE WHEN id = 'before-start-safety' THEN 1 ELSE required END,
      version = MAX(1, version)`),
  ]);
}

export async function ensureKioskSchema() {
  if (!kioskSchemaReady) kioskSchemaReady = initializeKioskSchema().catch((error) => {
    kioskSchemaReady = null;
    throw error;
  });
  await kioskSchemaReady;
}

async function expireKioskRows(trace?: KioskLatencyTrace) {
  const db = getD1();
  await measureKioskStage(trace, "expire_rows", () => db.batch([
    db.prepare(`UPDATE customer_room_holds SET state = 'EXPIRED', active_slot_key = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE state = 'ACTIVE' AND datetime(expires_at) <= CURRENT_TIMESTAMP`),
    db.prepare(`UPDATE customer_visit_games SET status = 'EXPIRED', active_slot_key = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE status = 'HOLD' AND datetime(expires_at) <= CURRENT_TIMESTAMP`),
    db.prepare(`UPDATE customer_visits SET status = 'EXPIRED', reservation_id = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE status IN ('DRAFT', 'HOLD') AND datetime(expires_at) <= CURRENT_TIMESTAMP`),
  ]));
}

async function visitForToken(token: string, touch = true, trace?: KioskLatencyTrace) {
  await measureKioskStage(trace, "schema_ready", () => ensureKioskSchema());
  await expireKioskRows(trace);
  const tokenHash = await sha256(token);
  const row = await measureKioskStage(trace, "visit_lookup", () => getD1()
    .prepare(`SELECT * FROM customer_visits WHERE session_token_hash = ? LIMIT 1`)
    .bind(tokenHash).first<VisitRow>());
  if (!row) throw new Error("KIOSK_SESSION_NOT_FOUND");
  if (row.status === "EXPIRED") throw new Error("KIOSK_SESSION_EXPIRED");
  if (touch && !STICKY_VISIT_STATES.has(row.status)) {
    const expiresAt = new Date(Date.now() + KIOSK_SESSION_IDLE_MS).toISOString();
    await measureKioskStage(trace, "visit_touch", () => getD1()
      .prepare(`UPDATE customer_visits SET expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(expiresAt, row.id).run());
    row.expires_at = expiresAt;
  }
  return row;
}

function publicVisit(row: VisitRow, hold?: HoldRow | null, includeStartToken = false) {
  return {
    id: row.id,
    kioskId: row.kiosk_id,
    flowType: row.flow_type,
    status: row.status,
    draftVersion: Math.max(0, Number(row.client_revision) || 0),
    partyCount: row.party_count,
    gameCount: Math.max(1, Number(row.game_count) || 1),
    adultCount: row.adult_count,
    youthCount: row.youth_count,
    memberId: row.representative_member_id ?? "",
    customerName: row.customer_name,
    teamName: row.team_name,
    scheduledDate: row.scheduled_date,
    scheduledTime: row.scheduled_time,
    roomCode: row.room_code,
    difficultyCode: row.difficulty_code,
    difficultyLabel: row.difficulty_label,
    reservationId: paymentReservationIdForVisit(row),
    addOns: json<Record<string, unknown>>(row.add_ons_json, {}),
    settlement: json<Record<string, unknown>>(row.settlement_json, {}),
    stampAllocations: json<Array<Record<string, unknown>>>(row.stamp_allocations_json, []),
    amounts: {
      base: row.base_amount,
      addOn: row.add_on_amount,
      discount: row.discount_amount,
      final: row.final_amount,
    },
    hold: hold ? {
      id: hold.id,
      date: hold.scheduled_date,
      time: hold.scheduled_time,
      roomCode: hold.room_code,
      state: hold.state,
      expiresAt: hold.expires_at,
    } : null,
    error: row.error_code ? { code: row.error_code, message: row.error_message } : null,
    startToken: includeStartToken ? row.start_token_value : "",
    startedAt: row.started_at ?? "",
    completedAt: row.completed_at ?? "",
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createKioskVisit(input: { kioskId?: string; flowType?: string }) {
  await ensureKioskSchema();
  const token = randomToken();
  const tokenHash = await sha256(token);
  const id = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + KIOSK_SESSION_IDLE_MS).toISOString();
  const flowType = ["WALK_IN", "RESERVATION", "ADD_ON_ONLY", "PARTY_TOP_UP", "REPEAT_GAME"].includes(String(input.flowType))
    ? String(input.flowType) : "WALK_IN";
  await getD1().prepare(`INSERT INTO customer_visits
    (id, session_token_hash, kiosk_id, flow_type, expires_at)
    VALUES (?, ?, ?, ?, ?)`)
    .bind(id, tokenHash, cleanText(input.kioskId, 80), flowType, expiresAt).run();
  const visit = await visitForToken(token);
  deferOperationalPush({
    eventType: "KIOSK_SESSION_STARTED",
    dedupKey: `kiosk-session:${id}`,
    title: "키오스크 이용 시작",
    body: "새 고객 이용이 시작되었습니다.",
  });
  return { token, visit: publicVisit(visit) };
}

async function hydrateKioskVisit(row: VisitRow, trace?: KioskLatencyTrace, knownHold?: HoldRow | null) {
  const [hold, members, games] = await Promise.all([
    knownHold !== undefined
      ? Promise.resolve(knownHold)
      : row.hold_id
        ? measureKioskStage(trace, "visit_hold", () => getD1().prepare(`SELECT * FROM customer_room_holds WHERE id = ? LIMIT 1`)
          .bind(row.hold_id).first<HoldRow>(), "visit_details")
        : Promise.resolve(null),
    measureKioskStage(trace, "visit_members", () => getD1().prepare(`SELECT member_id, member_name, role FROM customer_visit_members
      WHERE visit_id = ? ORDER BY CASE role WHEN 'REPRESENTATIVE' THEN 0 ELSE 1 END, created_at`)
      .bind(row.id).all<{ member_id: string; member_name: string; role: string }>(), "visit_details"),
    measureKioskStage(trace, "visit_games", () => getD1().prepare(`SELECT * FROM customer_visit_games
      WHERE visit_id = ? AND status NOT IN ('CANCELLED', 'EXPIRED') ORDER BY sequence`)
      .bind(row.id).all<VisitGameRow>(), "visit_details"),
  ]);
  return {
    ...publicVisit(row, hold, true),
    members: members.results.map((item) => ({ memberId: item.member_id, name: item.member_name, role: item.role })),
    games: games.results.map((game) => ({
      id: game.id,
      sequence: game.sequence,
      status: game.status,
      scheduledDate: game.scheduled_date,
      scheduledTime: game.scheduled_time,
      roomCode: game.room_code,
      roomSize: game.room_size,
      difficultyCode: game.difficulty_code,
      difficultyLabel: game.difficulty_label,
      mapIndex: game.map_index,
      adultCount: game.adult_count,
      youthCount: game.youth_count,
      partyCount: game.party_count,
      baseAmount: game.base_amount,
      reservationId: game.reservation_id ?? "",
      expiresAt: game.expires_at,
    })),
  };
}

async function reloadKioskVisit(visitId: string, trace?: KioskLatencyTrace) {
  const row = await measureKioskStage(trace, "visit_reload", () => getD1()
    .prepare(`SELECT * FROM customer_visits WHERE id = ? LIMIT 1`)
    .bind(visitId).first<VisitRow>());
  if (!row) throw new Error("KIOSK_SESSION_NOT_FOUND");
  return hydrateKioskVisit(row, trace);
}

export async function getKioskVisit(token: string, trace?: KioskLatencyTrace) {
  return hydrateKioskVisit(await visitForToken(token, true, trace), trace);
}

export async function resetKioskVisit(token: string) {
  const visit = await visitForToken(token, false);
  if (isPaymentOrGameCritical(visit.status)) {
    throw new Error("KIOSK_RESET_BLOCKED");
  }
  const db = getD1();
  await db.batch([
    db.prepare(`UPDATE customer_room_holds SET state = 'CANCELLED', active_slot_key = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE visit_id = ? AND state = 'ACTIVE'`).bind(visit.id),
    db.prepare(`UPDATE customer_visit_games SET status = 'CANCELLED', active_slot_key = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE visit_id = ? AND status = 'HOLD'`).bind(visit.id),
    db.prepare(`UPDATE customer_visits SET status = 'CANCELLED',
      reservation_id = CASE WHEN status IN ('DRAFT', 'HOLD') THEN NULL ELSE reservation_id END,
      expires_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(visit.id),
  ]);
  return { ok: true };
}

export async function cancelKioskCheckout(token: string) {
  await ensureKioskSchema();
  const visit = await visitForToken(token, false);
  const db = getD1();
  const auditId = `customer-cancel-checkout:${visit.id}`;
  if (visit.status === "CANCELLED") {
    const audit = await db.prepare(`SELECT id FROM kiosk_visit_admin_audit WHERE id = ? LIMIT 1`)
      .bind(auditId).first<{ id: string }>();
    if (audit) return { ok: true, cancelled: true, alreadyCancelled: true };
  }
  if (visit.status !== "PAYMENT_PENDING") throw new Error("KIOSK_CHECKOUT_CANCEL_NOT_ALLOWED");
  if (!["WALK_IN", "REPEAT_GAME", "ADD_ON_ONLY"].includes(visit.flow_type)) {
    throw new Error("KIOSK_CHECKOUT_CANCEL_UNSUPPORTED");
  }

  const settlement = json<{
    benefit?: { type?: string; id?: string };
    passBenefit?: { id?: string };
    couponBenefit?: { id?: string };
  }>(visit.settlement_json, {});
  if (
    visit.discount_amount > 0 || settlement.benefit?.id || settlement.benefit?.type ||
    settlement.passBenefit?.id || settlement.couponBenefit?.id
  ) {
    throw new Error("KIOSK_CHECKOUT_CANCEL_BENEFIT_APPLIED");
  }

  const games = await db.prepare(`SELECT id, status, reservation_id FROM customer_visit_games
    WHERE visit_id = ? ORDER BY sequence`).bind(visit.id).all<{
      id: string;
      status: string;
      reservation_id: string | null;
    }>();
  if (games.results.some((game) => !["HOLD", "RESERVED"].includes(game.status))) {
    throw new Error("KIOSK_CHECKOUT_CANCEL_NOT_ALLOWED");
  }
  const reservationIds = Array.from(new Set([
    visit.reservation_id ?? "",
    ...games.results.map((game) => game.reservation_id ?? ""),
  ].filter(Boolean)));
  if (!visit.reservation_id || reservationIds.length < 1) {
    throw new Error("KIOSK_CHECKOUT_CANCEL_NOT_ALLOWED");
  }
  const placeholders = reservationIds.map(() => "?").join(",");
  const reservations = await db.prepare(`SELECT id, source, status, payment_status,
      payment_card_amount, payment_cash_amount, payment_account_amount
    FROM reservations WHERE id IN (${placeholders})`).bind(...reservationIds).all<{
      id: string;
      source: string;
      status: string;
      payment_status: string;
      payment_card_amount: number;
      payment_cash_amount: number;
      payment_account_amount: number;
    }>();
  const expectedSource = visit.flow_type === "ADD_ON_ONLY" ? "add_on_sale_purchase" : "kiosk_walkin";
  if (
    reservations.results.length !== reservationIds.length ||
    reservations.results.some((reservation) =>
      reservation.source !== expectedSource || reservation.status !== "booked" ||
      reservation.payment_status !== "unpaid" || reservation.payment_card_amount > 0 ||
      reservation.payment_cash_amount > 0 || reservation.payment_account_amount > 0)
  ) {
    throw new Error("KIOSK_CHECKOUT_CANCEL_NOT_ALLOWED");
  }

  const [benefitUse, nonPendingStamp, addOnOrders] = await Promise.all([
    db.prepare(`SELECT
        (SELECT COUNT(*) FROM pass_ledger WHERE reservation_id IN (${placeholders})) +
        (SELECT COUNT(*) FROM member_coupons WHERE used_reservation_id IN (${placeholders})) +
        (SELECT COUNT(*) FROM stamp_ledger WHERE reservation_id IN (${placeholders})) AS count`)
      .bind(...reservationIds, ...reservationIds, ...reservationIds).first<{ count: number }>(),
    db.prepare(`SELECT COUNT(*) AS count FROM customer_stamp_allocations
      WHERE visit_id = ? AND status <> 'PENDING'`).bind(visit.id).first<{ count: number }>(),
    db.prepare(`SELECT reservation_id, status, payment_status,
        payment_card_amount, payment_cash_amount, payment_account_amount
      FROM add_on_sale_orders WHERE reservation_id IN (${placeholders})`)
      .bind(...reservationIds).all<{
        reservation_id: string;
        status: string;
        payment_status: string;
        payment_card_amount: number;
        payment_cash_amount: number;
        payment_account_amount: number;
      }>(),
  ]);
  if (
    Number(benefitUse?.count ?? 0) > 0 || Number(nonPendingStamp?.count ?? 0) > 0 ||
    addOnOrders.results.some((order) =>
      order.status !== "PAYMENT_PENDING" || order.payment_status !== "PENDING" ||
      order.payment_card_amount > 0 || order.payment_cash_amount > 0 || order.payment_account_amount > 0)
  ) {
    throw new Error("KIOSK_CHECKOUT_CANCEL_NOT_ALLOWED");
  }

  const cancelledPlan = await cancelUnstartedKioskPaymentPlan({
    reservationId: visit.reservation_id,
    reservationIds,
    visitId: visit.id,
    requestedBy: `kiosk:${visit.kiosk_id || "main"}`,
  });
  if (
    cancelledPlan.reservationIds.length !== reservationIds.length ||
    cancelledPlan.reservationIds.some((id) => !reservationIds.includes(id))
  ) {
    throw new Error("KIOSK_CHECKOUT_CANCEL_NOT_ALLOWED");
  }

  const statements = [
    db.prepare(`UPDATE customer_room_holds SET state = 'CANCELLED', active_slot_key = NULL,
      updated_at = CURRENT_TIMESTAMP WHERE visit_id = ? AND state IN ('ACTIVE', 'CONVERTED')`).bind(visit.id),
    db.prepare(`UPDATE customer_visit_games SET status = 'CANCELLED', active_slot_key = NULL,
      updated_at = CURRENT_TIMESTAMP WHERE visit_id = ? AND status IN ('HOLD', 'RESERVED')`).bind(visit.id),
    db.prepare(`UPDATE customer_stamp_allocations SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP
      WHERE visit_id = ? AND status = 'PENDING'`).bind(visit.id),
    db.prepare(`UPDATE add_on_sale_orders SET status = 'CANCELLED', payment_status = 'CANCELLED',
      payment_id = NULL, cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE reservation_id IN (${placeholders}) AND status = 'PAYMENT_PENDING' AND payment_status = 'PENDING'
        AND payment_card_amount = 0 AND payment_cash_amount = 0 AND payment_account_amount = 0`)
      .bind(...reservationIds),
    db.prepare(`UPDATE reservations SET status = 'cancelled', active_slot_key = NULL,
      payment_amount = 0, payment_card_amount = 0, payment_cash_amount = 0,
      payment_account_amount = 0, payment_method = '', payment_status = 'unpaid',
      cancelled_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id IN (${placeholders}) AND source = ? AND status = 'booked' AND payment_status = 'unpaid'
        AND payment_card_amount = 0 AND payment_cash_amount = 0 AND payment_account_amount = 0`)
      .bind(...reservationIds, expectedSource),
    db.prepare(`UPDATE customer_visits SET status = 'CANCELLED', reservation_id = NULL, hold_id = NULL,
      representative_member_id = NULL, customer_name = '', customer_phone = '', team_name = '',
      scheduled_date = '', scheduled_time = '', room_code = '', difficulty_code = '', difficulty_label = '',
      add_ons_json = '{}', settlement_json = '{}', stamp_allocations_json = '[]',
      adult_count = 0, youth_count = 0, party_count = 0,
      base_amount = 0, add_on_amount = 0, discount_amount = 0, final_amount = 0,
      start_token_hash = '', start_token_value = '', start_token_expires_at = NULL,
      error_code = '', error_message = '', expires_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'PAYMENT_PENDING'
        AND NOT EXISTS (SELECT 1 FROM reservations WHERE id IN (${placeholders}) AND status <> 'cancelled')`)
      .bind(visit.id, ...reservationIds),
    db.prepare(`UPDATE kiosk_runtime SET current_visit_id = '', current_status = 'HOME',
      updated_at = CURRENT_TIMESTAMP WHERE current_visit_id = ?`).bind(visit.id),
    ...reservationIds.map((reservationId) => db.prepare(`INSERT OR IGNORE INTO reservation_events
      (id, reservation_id, event_type, details_json, created_by)
      VALUES (?, ?, 'kiosk_checkout_cancelled', ?, ?)`)
      .bind(
        `kiosk-checkout-cancel:${visit.id}:${reservationId}`,
        reservationId,
        JSON.stringify({ visitId: visit.id, paymentId: cancelledPlan.paymentId }),
        `kiosk:${visit.kiosk_id || "main"}`,
      )),
    db.prepare(`INSERT OR IGNORE INTO kiosk_visit_admin_audit
      (id, visit_id, reservation_id, action, previous_status, next_status, reason, details_json, created_by)
      VALUES (?, ?, ?, 'CUSTOMER_CHECKOUT_CANCEL', 'PAYMENT_PENDING', 'CANCELLED',
        '고객이 결제 시작 전에 취소', ?, ?)`)
      .bind(
        auditId,
        visit.id,
        visit.reservation_id,
        JSON.stringify({ flowType: visit.flow_type, reservationIds, paymentId: cancelledPlan.paymentId }),
        `kiosk:${visit.kiosk_id || "main"}`,
      ),
  ];
  const results = await db.batch(statements);
  if (
    Number(results[4]?.meta.changes ?? 0) !== reservationIds.length ||
    Number(results[5]?.meta.changes ?? 0) !== 1
  ) {
    throw new Error("KIOSK_CHECKOUT_CANCEL_NOT_ALLOWED");
  }
  return { ok: true, cancelled: true, alreadyCancelled: false };
}

export type KioskDraftSnapshot = {
  clientRevision?: unknown;
  adultCount?: unknown;
  youthCount?: unknown;
  customerMode?: unknown;
  teamName?: unknown;
  vehicleLast4?: unknown;
  roomCode?: unknown;
  scheduledTime?: unknown;
  difficultyCode?: unknown;
  passBenefit?: unknown;
  couponBenefit?: unknown;
  addOns?: unknown;
};

type AppliedKioskDraft = {
  visit: VisitRow;
  draftVersion: number;
  applied: boolean;
  stale: boolean;
  pricing?: Awaited<ReturnType<typeof getPricingSettings>>;
};

async function applyKioskDraftSnapshot(
  visit: VisitRow,
  input: KioskDraftSnapshot | undefined,
  trace?: KioskLatencyTrace,
): Promise<AppliedKioskDraft> {
  if (!input) {
    return { visit, draftVersion: Math.max(0, Number(visit.client_revision) || 0), applied: false, stale: false };
  }
  if (!['DRAFT', 'HOLD'].includes(visit.status)) throw new Error("KIOSK_VISIT_LOCKED");
  const clientRevision = clamp(input.clientRevision, 0, 2_000_000_000);
  const currentRevision = Math.max(0, Number(visit.client_revision) || 0);
  if (clientRevision < currentRevision) {
    return { visit, draftVersion: currentRevision, applied: false, stale: true };
  }

  const adultCount = clamp(input.adultCount ?? visit.adult_count, 0, 10);
  const youthCount = clamp(input.youthCount ?? visit.youth_count, 0, 10);
  const partyCount = adultCount + youthCount;
  if (visit.flow_type !== "ADD_ON_ONLY" && (partyCount < 1 || partyCount > 10)) {
    throw new Error("KIOSK_PARTY_INVALID");
  }
  const teamName = cleanText(input.teamName ?? visit.team_name, 10);
  const customerMode = cleanText(input.customerMode, 16).toUpperCase();
  const requestedDifficulty = cleanText(input.difficultyCode, 80);
  let difficultyCode = visit.difficulty_code;
  let difficultyLabel = visit.difficulty_label;
  let mapIndex = visit.map_index;
  if (requestedDifficulty && visit.room_code) {
    const difficulty = getDifficultyOptions(visit.room_code).find((item) => item.code === requestedDifficulty);
    if (!difficulty) throw new Error("KIOSK_DIFFICULTY_INVALID");
    difficultyCode = difficulty.code;
    difficultyLabel = difficulty.label;
    mapIndex = difficulty.mapIndex;
  }
  const pricing = await measureKioskStage(trace, "draft_pricing_read", () => getPricingSettings(), "draft_sync");
  const unitBaseAmount = visit.flow_type === "ADD_ON_ONLY" ? 0 : calculateBaseAmount(adultCount, youthCount, pricing);
  const baseAmount = unitBaseAmount * Math.max(1, Number(visit.game_count) || 1);
  const result = await measureKioskStage(trace, "draft_update", () => getD1().prepare(`UPDATE customer_visits SET
      adult_count = ?, youth_count = ?, party_count = ?, team_name = ?,
      customer_name = CASE WHEN ? = 'GUEST' AND representative_member_id IS NULL THEN '현장 고객' ELSE customer_name END,
      difficulty_code = ?, difficulty_label = ?, map_index = ?, base_amount = ?,
      final_amount = MAX(0, ? + add_on_amount - discount_amount), client_revision = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND client_revision <= ?`)
    .bind(
      adultCount, youthCount, visit.flow_type === "ADD_ON_ONLY" ? 0 : partyCount, teamName,
      customerMode, difficultyCode, difficultyLabel, mapIndex, baseAmount, baseAmount,
      clientRevision, visit.id, clientRevision,
    ).run(), "draft_sync");

  const changed = Number(result.meta?.changes ?? 0) > 0;
  if (!changed) {
    const latest = await measureKioskStage(trace, "draft_reload_stale", () => getD1()
      .prepare(`SELECT * FROM customer_visits WHERE id = ? LIMIT 1`)
      .bind(visit.id).first<VisitRow>(), "draft_sync");
    if (!latest) throw new Error("KIOSK_SESSION_NOT_FOUND");
    const latestRevision = Math.max(0, Number(latest.client_revision) || 0);
    return { visit: latest, draftVersion: latestRevision, applied: false, stale: clientRevision < latestRevision };
  }

  visit.adult_count = adultCount;
  visit.youth_count = youthCount;
  visit.party_count = visit.flow_type === "ADD_ON_ONLY" ? 0 : partyCount;
  visit.team_name = teamName;
  if (customerMode === "GUEST" && !visit.representative_member_id) visit.customer_name = "현장 고객";
  visit.difficulty_code = difficultyCode;
  visit.difficulty_label = difficultyLabel;
  visit.map_index = mapIndex;
  visit.base_amount = baseAmount;
  visit.final_amount = Math.max(0, baseAmount + visit.add_on_amount - visit.discount_amount);
  visit.client_revision = clientRevision;
  return { visit, draftVersion: clientRevision, applied: true, stale: false, pricing };
}

export async function syncKioskDraft(token: string, input: KioskDraftSnapshot, trace?: KioskLatencyTrace) {
  const visit = await visitForToken(token, true, trace);
  const applied = await applyKioskDraftSnapshot(visit, input, trace);
  return { ok: true, draftVersion: applied.draftVersion };
}

export async function updateKioskParty(token: string, input: { adultCount: unknown; youthCount: unknown; teamName?: unknown }, trace?: KioskLatencyTrace) {
  const visit = await visitForToken(token, true, trace);
  if (!['DRAFT', 'HOLD'].includes(visit.status)) throw new Error("KIOSK_VISIT_LOCKED");
  const adultCount = clamp(input.adultCount, 0, 10);
  const youthCount = clamp(input.youthCount, 0, 10);
  const partyCount = adultCount + youthCount;
  if (partyCount < 1 || partyCount > 10) throw new Error("KIOSK_PARTY_INVALID");
  const pricing = await measureKioskStage(trace, "pricing_read", () => getPricingSettings());
  const baseAmount = calculateBaseAmount(adultCount, youthCount, pricing);
  const hasTeamName = typeof input.teamName === "string";
  const teamName = cleanText(input.teamName, 10);
  await measureKioskStage(trace, "party_update", () => getD1().prepare(`UPDATE customer_visits SET adult_count = ?, youth_count = ?, party_count = ?,
    team_name = CASE WHEN ? = 1 THEN ? ELSE team_name END, base_amount = ?, final_amount = MAX(0, ? + add_on_amount - discount_amount),
    updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(adultCount, youthCount, partyCount, hasTeamName ? 1 : 0, teamName, baseAmount, baseAmount, visit.id).run());
  visit.adult_count = adultCount;
  visit.youth_count = youthCount;
  visit.party_count = partyCount;
  if (hasTeamName) visit.team_name = teamName;
  visit.base_amount = baseAmount;
  visit.final_amount = Math.max(0, baseAmount + visit.add_on_amount - visit.discount_amount);
  return hydrateKioskVisit(visit, trace);
}

export async function updateKioskTeamName(token: string, teamName: unknown, trace?: KioskLatencyTrace) {
  const visit = await visitForToken(token, true, trace);
  if (!['DRAFT', 'HOLD'].includes(visit.status)) throw new Error("KIOSK_VISIT_LOCKED");
  const nextTeamName = cleanText(teamName, 10);
  await measureKioskStage(trace, "team_update", () => getD1().prepare(`UPDATE customer_visits SET team_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(nextTeamName, visit.id).run());
  visit.team_name = nextTeamName;
  return hydrateKioskVisit(visit, trace);
}

export async function loginKioskMember(token: string, input: { phone: string; password: string; clientIdentity: string }) {
  const visit = await visitForToken(token);
  if (!['DRAFT', 'HOLD'].includes(visit.status)) throw new Error("KIOSK_VISIT_LOCKED");
  const verified = await verifyCustomerMemberCredentials(input);
  const dashboard = await getCustomerMemberDashboard(verified.memberId);
  const db = getD1();
  await db.batch([
    db.prepare(`INSERT INTO customer_visit_members (visit_id, member_id, member_name, role)
      VALUES (?, ?, ?, 'REPRESENTATIVE')
      ON CONFLICT(visit_id, member_id) DO UPDATE SET member_name = excluded.member_name, role = 'REPRESENTATIVE'`)
      .bind(visit.id, verified.memberId, verified.name),
    db.prepare(`UPDATE customer_visits SET representative_member_id = ?, customer_name = ?, customer_phone = ?,
      team_name = CASE WHEN team_name = '' THEN ? ELSE team_name END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(verified.memberId, verified.name, verified.phone, dashboard.member.teamName, visit.id),
  ]);
  return { visit: await getKioskVisit(token), member: dashboard };
}

export async function addKioskParticipantMember(token: string, input: { phone: string; password: string; clientIdentity: string }) {
  const visit = await visitForToken(token);
  if (!['DRAFT', 'HOLD'].includes(visit.status)) throw new Error("KIOSK_VISIT_LOCKED");
  const verified = await verifyCustomerMemberCredentials(input);
  const current = await getD1().prepare(`SELECT COUNT(*) AS count FROM customer_visit_members WHERE visit_id = ?`)
    .bind(visit.id).first<{ count: number }>();
  if ((Number(current?.count) || 0) >= visit.party_count) throw new Error("KIOSK_MEMBER_COUNT_EXCEEDED");
  await getD1().prepare(`INSERT INTO customer_visit_members (visit_id, member_id, member_name, role)
    VALUES (?, ?, ?, 'PARTICIPANT') ON CONFLICT(visit_id, member_id) DO UPDATE SET member_name = excluded.member_name`)
    .bind(visit.id, verified.memberId, verified.name).run();
  return { visit: await getKioskVisit(token), member: await getCustomerMemberDashboard(verified.memberId) };
}

export async function continueKioskAsGuest(token: string, input: { name?: unknown; phone?: unknown }, trace?: KioskLatencyTrace) {
  const visit = await visitForToken(token, true, trace);
  if (!['DRAFT', 'HOLD'].includes(visit.status)) throw new Error("KIOSK_VISIT_LOCKED");
  const customerName = cleanText(input.name || "현장 고객", 40);
  const customerPhone = cleanText(input.phone, 30);
  await measureKioskStage(trace, "guest_update", () => getD1().prepare(`UPDATE customer_visits SET customer_name = ?, customer_phone = ?,
    updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(customerName, customerPhone, visit.id).run());
  visit.customer_name = customerName;
  visit.customer_phone = customerPhone;
  return hydrateKioskVisit(visit, trace);
}

export async function findKioskReservations(token: string, input: { phone?: string; teamName?: string }) {
  const visit = await visitForToken(token);
  const participantTopUp = visit.flow_type === "PARTY_TOP_UP";
  const repeatGame = visit.flow_type === "REPEAT_GAME";
  const selectColumns = `SELECT id, booking_code, source, customer_name, scheduled_date, scheduled_time,
      room_code, team_name, difficulty_code, difficulty_label, map_index, adult_count, youth_count, total_count,
      base_amount, add_on_amount, discount_amount, payment_amount, payment_status, status FROM reservations`;
  let result: D1Result<Record<string, unknown>>;
  if (participantTopUp || repeatGame) {
    const teamName = cleanText(input.teamName, 10);
    const normalizedTeamName = teamName.replace(/\s+/g, "");
    if (!normalizedTeamName) throw new Error("KIOSK_TEAM_NAME_INVALID");
    result = await getD1().prepare(`${selectColumns}
      WHERE scheduled_date = ?
        AND lower(replace(trim(team_name), ' ', '')) = lower(?)
        AND ${repeatGame ? "status = 'completed' AND updated_at >= datetime('now', '-15 minutes')" : "status NOT IN ('cancelled', 'completed') AND payment_status = 'paid'"}
      ORDER BY scheduled_time DESC, created_at DESC`)
      .bind(dateInSeoul(), normalizedTeamName).all<Record<string, unknown>>();
    if (!result.results.length) return [];
    await getD1().prepare(`UPDATE customer_visits SET flow_type = ?, team_name = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(repeatGame ? "REPEAT_GAME" : "PARTY_TOP_UP", teamName, visit.id).run();
  } else {
    const digits = String(input.phone ?? "").replace(/\D/g, "");
    if (digits.length < 10) throw new Error("KIOSK_PHONE_INVALID");
    result = await getD1().prepare(`${selectColumns}
      WHERE scheduled_date = ? AND replace(replace(replace(customer_phone, '-', ''), ' ', ''), '+82', '0') = ?
        AND status NOT IN ('cancelled', 'completed')
      ORDER BY scheduled_time, created_at`)
      .bind(dateInSeoul(), digits).all<Record<string, unknown>>();
    if (!result.results.length) return [];
    await getD1().prepare(`UPDATE customer_visits SET flow_type = 'RESERVATION', customer_phone = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(digits, visit.id).run();
  }
  return result.results.map((row) => ({
    id: String(row.id), bookingCode: String(row.booking_code), source: String(row.source),
    customerName: String(row.customer_name), date: String(row.scheduled_date), time: String(row.scheduled_time),
    roomCode: String(row.room_code), teamName: String(row.team_name), difficultyCode: String(row.difficulty_code),
    difficultyLabel: String(row.difficulty_label), adultCount: Number(row.adult_count) || 0,
    youthCount: Number(row.youth_count) || 0, totalCount: Number(row.total_count) || 0,
    amount: Math.max(0, Number(row.base_amount) + Number(row.add_on_amount) - Number(row.discount_amount)),
    paymentStatus: String(row.payment_status), status: String(row.status),
  }));
}

export async function selectKioskReservation(token: string, reservationId: string) {
  const visit = await visitForToken(token);
  if (!['DRAFT', 'HOLD'].includes(visit.status)) throw new Error("KIOSK_VISIT_LOCKED");
  const reservation = await getReservationById(reservationId);
  if (!reservation || reservation.status === 'cancelled' || reservation.scheduledDate !== dateInSeoul()) {
    throw new Error("KIOSK_RESERVATION_NOT_FOUND");
  }
  const total = reservation.adultCount + reservation.youthCount;
  const db = getD1();
  if (visit.flow_type === "REPEAT_GAME") {
    if (reservation.status !== "completed") throw new Error("KIOSK_REPEAT_GAME_NOT_COMPLETED");
    const originalVisit = await db.prepare(`SELECT visit.* FROM customer_visits visit
      LEFT JOIN customer_visit_games game ON game.visit_id = visit.id
      WHERE (visit.reservation_id = ? OR game.reservation_id = ?) AND visit.status = 'COMPLETED'
      ORDER BY visit.completed_at DESC LIMIT 1`)
      .bind(reservation.id, reservation.id).first<VisitRow>();
    if (!originalVisit) throw new Error("KIOSK_REPEAT_GAME_VISIT_NOT_FOUND");
    await db.batch([
      db.prepare(`UPDATE customer_visits SET flow_type = 'REPEAT_GAME', status = 'DRAFT', reservation_id = NULL,
        representative_member_id = ?, customer_name = ?, customer_phone = ?, team_name = ?,
        scheduled_date = '', scheduled_time = '', room_code = ?, difficulty_code = ?, difficulty_label = ?, map_index = ?,
        adult_count = ?, youth_count = ?, party_count = ?, game_count = 1,
        base_amount = 0, add_on_amount = 0, discount_amount = 0, final_amount = 0,
        settlement_json = '{}', stamp_allocations_json = '[]', error_code = '', error_message = '',
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(originalVisit.representative_member_id, originalVisit.customer_name, originalVisit.customer_phone,
          originalVisit.team_name, originalVisit.room_code, originalVisit.difficulty_code, originalVisit.difficulty_label,
          originalVisit.map_index, originalVisit.adult_count, originalVisit.youth_count, originalVisit.party_count, visit.id),
      db.prepare(`INSERT OR IGNORE INTO customer_visit_members (visit_id, member_id, member_name, role)
        SELECT ?, member_id, member_name, role FROM customer_visit_members WHERE visit_id = ?`)
        .bind(visit.id, originalVisit.id),
      db.prepare(`INSERT OR IGNORE INTO kiosk_guidance_agreements
        (id, visit_id, guidance_id, guidance_version, agreed, agreed_at)
        SELECT lower(hex(randomblob(16))), ?, agreement.guidance_id, agreement.guidance_version, 1, CURRENT_TIMESTAMP
        FROM kiosk_guidance_agreements agreement
        JOIN kiosk_guidance_items item ON item.id = agreement.guidance_id AND item.version = agreement.guidance_version
        WHERE agreement.visit_id = ? AND agreement.agreed = 1 AND item.active = 1 AND item.required = 1`)
        .bind(visit.id, originalVisit.id),
    ]);
    const nextVisit = await getKioskVisit(token);
    const repeatMember = originalVisit.representative_member_id
      ? await getCustomerMemberDashboard(originalVisit.representative_member_id)
      : null;
    return { ...nextVisit, repeatMember };
  }
  if (visit.flow_type === "PARTY_TOP_UP") {
    if (reservation.status === "completed") throw new Error("KIOSK_PARTICIPANT_TOP_UP_NOT_ACTIVE");
    if (reservation.paymentStatus !== "paid") throw new Error("KIOSK_PARTICIPANT_TOP_UP_PAYMENT_REQUIRED");
    const originalVisit = await db.prepare(`SELECT status FROM customer_visits
      WHERE reservation_id = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(reservation.id).first<{ status: string }>();
    if (originalVisit && ["COMPLETED", "ABORTED", "CANCELLED", "EXPIRED"].includes(originalVisit.status)) {
      throw new Error("KIOSK_PARTICIPANT_TOP_UP_NOT_ACTIVE");
    }
    const settlement = JSON.stringify({
      participantTopUp: {
        targetReservationId: reservation.id,
        expectedAdultCount: reservation.adultCount,
        expectedYouthCount: reservation.youthCount,
        additionalAdultCount: 0,
        additionalYouthCount: 0,
        targetAdultCount: reservation.adultCount,
        targetYouthCount: reservation.youthCount,
        amount: 0,
      },
    });
    await db.prepare(`UPDATE customer_visits SET flow_type = 'PARTY_TOP_UP', status = 'HOLD',
        reservation_id = NULL, customer_name = ?, customer_phone = ?, team_name = ?,
        scheduled_date = ?, scheduled_time = ?, room_code = ?, difficulty_code = ?,
        difficulty_label = ?, map_index = ?, adult_count = ?, youth_count = ?, party_count = ?,
        settlement_json = ?, base_amount = 0, add_on_amount = 0, discount_amount = 0,
        final_amount = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(
        reservation.customerName, reservation.customerPhone, reservation.teamName,
        reservation.scheduledDate, reservation.scheduledTime, reservation.roomCode,
        reservation.difficultyCode, reservation.difficultyLabel, reservation.mapIndex,
        reservation.adultCount, reservation.youthCount, total, settlement, visit.id,
      ).run();
    return getKioskVisit(token);
  }
  const linkedVisit = await db.prepare(`SELECT id, status FROM customer_visits
    WHERE reservation_id = ? AND id <> ? LIMIT 1`).bind(reservation.id, visit.id).first<{ id: string; status: string }>();
  if (linkedVisit && !['CANCELLED', 'EXPIRED'].includes(linkedVisit.status)) {
    throw new Error("KIOSK_RESERVATION_IN_USE");
  }
  await db.batch([
    db.prepare(`UPDATE customer_visits SET reservation_id = NULL, updated_at = CURRENT_TIMESTAMP
      WHERE reservation_id = ? AND id <> ? AND status IN ('CANCELLED', 'EXPIRED')`).bind(reservation.id, visit.id),
    db.prepare(`UPDATE customer_visits SET flow_type = 'RESERVATION', status = 'HOLD', reservation_id = ?,
      customer_name = ?, customer_phone = ?, team_name = ?, scheduled_date = ?, scheduled_time = ?, room_code = ?,
      difficulty_code = ?, difficulty_label = ?, map_index = ?, adult_count = ?, youth_count = ?, party_count = ?,
      base_amount = ?, add_on_amount = ?, discount_amount = ?, final_amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(reservation.id, reservation.customerName, reservation.customerPhone, reservation.teamName,
        reservation.scheduledDate, reservation.scheduledTime, reservation.roomCode, reservation.difficultyCode,
        reservation.difficultyLabel, reservation.mapIndex, reservation.adultCount, reservation.youthCount, total,
        reservation.baseAmount, reservation.addOnAmount, reservation.discountAmount,
        Math.max(0, reservation.baseAmount + reservation.addOnAmount - reservation.discountAmount), visit.id),
  ]);
  return getKioskVisit(token);
}

export async function getKioskAvailability(
  partyCount = 1,
  options: { trace?: KioskLatencyTrace; skipExpiry?: boolean } = {},
) {
  await measureKioskStage(options.trace, "schema_ready", () => ensureKioskSchema());
  if (!options.skipExpiry) await expireKioskRows(options.trace);
  const date = dateInSeoul();
  const firstTime = nextBookableTime();
  const db = getD1();
  const [reserved, held, gameHolds, rooms] = await Promise.all([
    measureKioskStage(options.trace, "availability_reservations", () => db.prepare(`SELECT scheduled_time, room_code FROM reservations WHERE scheduled_date = ?
      AND status NOT IN ('cancelled', 'completed')`).bind(date).all<{ scheduled_time: string; room_code: string }>(), "availability"),
    measureKioskStage(options.trace, "availability_holds", () => db.prepare(`SELECT scheduled_time, room_code FROM customer_room_holds WHERE scheduled_date = ? AND state = 'ACTIVE'
      AND datetime(expires_at) > CURRENT_TIMESTAMP`).bind(date).all<{ scheduled_time: string; room_code: string }>(), "availability"),
    measureKioskStage(options.trace, "availability_game_holds", () => db.prepare(`SELECT scheduled_time, room_code FROM customer_visit_games
      WHERE scheduled_date = ? AND status = 'HOLD' AND active_slot_key IS NOT NULL
      AND datetime(expires_at) > CURRENT_TIMESTAMP`).bind(date).all<{ scheduled_time: string; room_code: string }>(), "availability"),
    measureKioskStage(options.trace, "availability_rooms", () => db.prepare(`SELECT rooms.room_id, rooms.status, rooms.remaining_seconds, rooms.updated_at,
        room_game_runtime.game_started_at
      FROM rooms
      LEFT JOIN room_game_runtime ON room_game_runtime.room_id = rooms.room_id
      ORDER BY CAST(rooms.room_id AS INTEGER)`)
      .all<{ room_id: string; status: string; remaining_seconds: number; updated_at: string; game_started_at: string | null }>(), "availability"),
  ]);
  const occupied = new Set([
    ...reserved.results.map((row) => slotKey(date, row.scheduled_time, row.room_code)),
    ...held.results.map((row) => slotKey(date, row.scheduled_time, row.room_code)),
    ...gameHolds.results.map((row) => slotKey(date, row.scheduled_time, row.room_code)),
  ]);
  const runtime = new Map(rooms.results.map((room) => [room.room_id, room]));
  const now = Date.now();
  return ROOM_OPTIONS.map((room) => {
    const state = runtime.get(room.roomId);
    const startedAt = Date.parse(state?.game_started_at ?? "");
    const fixedGameEnd = Number.isFinite(startedAt) ? startedAt + GAME_MINUTES * 60_000 : 0;
    const slots = OPERATING_SLOTS.filter((time) => time >= firstTime)
      .filter((time) => !occupied.has(slotKey(date, time, room.code)))
      .filter((time) => kioskSlotStartsAfterRunningGame({
        roomStatus: state?.status ?? "offline",
        slotStartAt: parseSeoulSlot(date, time),
        nowAt: now,
        remainingSeconds: state?.remaining_seconds,
        endsAt: fixedGameEnd,
      }))
      .slice(0, 8);
    return {
      code: room.code, roomId: room.roomId, name: room.name, size: room.size,
      recommended: `${room.min}~${room.max}명`, max: room.max,
      selectable: partyCount <= room.max && state?.status !== "offline",
      status: state?.status ?? "offline", remainingSeconds: Math.max(0, Number(state?.remaining_seconds) || 0),
      slots,
    };
  });
}

export async function getKioskRoomStatusSnapshot() {
  await ensureKioskSchema();
  const snapshotAt = new Date();
  const result = await getD1().prepare(`WITH ranked_preparation AS (
      SELECT id, room_code, status, scheduled_time, updated_at,
        ROW_NUMBER() OVER (PARTITION BY room_code ORDER BY updated_at DESC, created_at DESC) AS rank
      FROM customer_visits
      WHERE status IN ('PREPARING', 'READY_TO_PLAY') AND room_code <> ''
    )
    SELECT rooms.room_id, rooms.status, rooms.remaining_seconds, rooms.updated_at,
      room_game_runtime.game_started_at,
      ranked_preparation.id AS prepared_visit_id,
      ranked_preparation.status AS preparation_state,
      ranked_preparation.scheduled_time AS preparation_time
    FROM rooms
    LEFT JOIN room_game_runtime ON room_game_runtime.room_id = rooms.room_id
    LEFT JOIN ranked_preparation ON ranked_preparation.room_code = CASE rooms.room_id
      WHEN '0' THEN 'A1' WHEN '1' THEN 'C1' WHEN '2' THEN 'B1' WHEN '3' THEN 'C2' ELSE '' END
      AND ranked_preparation.rank = 1
    ORDER BY CAST(rooms.room_id AS INTEGER)`).all<{
      room_id: string;
      status: string;
      remaining_seconds: number;
      updated_at: string;
      game_started_at: string | null;
      prepared_visit_id: string | null;
      preparation_state: string | null;
      preparation_time: string | null;
    }>();
  const codes = new Map(ROOM_OPTIONS.map((room) => [room.roomId, room.code]));
  return {
    snapshotAt: snapshotAt.toISOString(),
    rooms: result.results.map((room) => {
      const remainingSeconds = room.status === "running" ? Math.max(0, Number(room.remaining_seconds) || 0) : 0;
      return {
        roomId: room.room_id,
        code: codes.get(room.room_id) ?? "",
        status: room.status,
        startedAt: room.game_started_at ?? "",
        endsAt: remainingSeconds > 0 ? new Date(snapshotAt.getTime() + remainingSeconds * 1_000).toISOString() : "",
        updatedAt: room.updated_at,
        preparedVisitId: room.prepared_visit_id ?? "",
        preparationState: room.preparation_state ?? "",
        preparationTime: room.preparation_time ?? "",
      };
    }),
  };
}

export async function holdKioskSlot(token: string, input: { date: string; time: string; roomCode: string; draft?: KioskDraftSnapshot }, trace?: KioskLatencyTrace) {
  let visit = await visitForToken(token, true, trace);
  visit = (await applyKioskDraftSnapshot(visit, input.draft, trace)).visit;
  if (!['DRAFT', 'HOLD'].includes(visit.status)) throw new Error("KIOSK_VISIT_LOCKED");
  const room = getRoom(input.roomCode);
  if (!room || visit.party_count > room.max || input.date !== dateInSeoul() || !OPERATING_SLOTS.includes(input.time)) {
    throw new Error("KIOSK_SLOT_INVALID");
  }
  const availability = await getKioskAvailability(visit.party_count, { trace, skipExpiry: true });
  if (!availability.find((item) => item.code === room.code)?.slots.includes(input.time)) {
    throw new Error("KIOSK_SLOT_OCCUPIED");
  }
  const db = getD1();
  const holdId = visit.hold_id ?? crypto.randomUUID();
  const expiresAt = new Date(Date.now() + KIOSK_HOLD_MS).toISOString();
  const activeKey = slotKey(input.date, input.time, room.code);
  try {
    await measureKioskStage(trace, "hold_write", () => db.batch([
      db.prepare(`UPDATE customer_room_holds SET state = 'CANCELLED', active_slot_key = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE visit_id = ? AND state = 'ACTIVE'`).bind(visit.id),
      db.prepare(`INSERT INTO customer_room_holds
        (id, visit_id, scheduled_date, scheduled_time, room_code, state, active_slot_key, expires_at)
        VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, ?)
        ON CONFLICT(visit_id) DO UPDATE SET scheduled_date = excluded.scheduled_date, scheduled_time = excluded.scheduled_time,
          room_code = excluded.room_code, state = 'ACTIVE', active_slot_key = excluded.active_slot_key,
          expires_at = excluded.expires_at, updated_at = CURRENT_TIMESTAMP`)
        .bind(holdId, visit.id, input.date, input.time, room.code, activeKey, expiresAt),
      db.prepare(`UPDATE customer_visits SET status = 'HOLD', hold_id = ?, scheduled_date = ?, scheduled_time = ?,
        room_code = ?, expires_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(holdId, input.date, input.time, room.code, expiresAt, visit.id),
    ]));
  } catch {
    throw new Error("KIOSK_SLOT_OCCUPIED");
  }
  visit.status = "HOLD";
  visit.hold_id = holdId;
  visit.scheduled_date = input.date;
  visit.scheduled_time = input.time;
  visit.room_code = room.code;
  visit.expires_at = expiresAt;
  const hold: HoldRow = {
    id: holdId,
    visit_id: visit.id,
    scheduled_date: input.date,
    scheduled_time: input.time,
    room_code: room.code,
    state: "ACTIVE",
    expires_at: expiresAt,
  };
  return hydrateKioskVisit(visit, trace, hold);
}

export async function updateKioskDifficulty(token: string, difficultyCode: string, trace?: KioskLatencyTrace) {
  const visit = await visitForToken(token, true, trace);
  if (!['DRAFT', 'HOLD'].includes(visit.status) || !visit.room_code) throw new Error("KIOSK_VISIT_LOCKED");
  const difficulty = getDifficultyOptions(visit.room_code).find((item) => item.code === difficultyCode);
  if (!difficulty) throw new Error("KIOSK_DIFFICULTY_INVALID");
  await measureKioskStage(trace, "difficulty_update", () => getD1().prepare(`UPDATE customer_visits SET difficulty_code = ?, difficulty_label = ?, map_index = ?,
    updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(difficulty.code, difficulty.label, difficulty.mapIndex, visit.id).run());
  visit.difficulty_code = difficulty.code;
  visit.difficulty_label = difficulty.label;
  visit.map_index = difficulty.mapIndex;
  return hydrateKioskVisit(visit, trace);
}

export async function getKioskCatalog(includeHidden = false) {
  await ensureKioskSchema();
  const [pricing, availability, overrides] = await Promise.all([
    getPricingSettings(),
    getD1().prepare(`SELECT product_code, status FROM customer_product_availability`).all<{ product_code: string; status: string }>(),
    getD1().prepare(`SELECT product_code, name, sort_order FROM customer_product_overrides`)
      .all<{ product_code: string; name: string; sort_order: number }>(),
  ]);
  const statuses = new Map(availability.results.map((item) => [item.product_code, item.status]));
  const metadata = new Map(overrides.results.map((item) => [item.product_code, item]));
  return [
    { code: "slush", name: "슬러시", price: pricing.slushPrice },
    { code: "beverage", name: "음료", price: pricing.beveragePrice },
    { code: "other", name: "양말", price: pricing.otherPrice },
    ...pricing.extraAddOnItems
      .filter((item) => includeHidden || item.active)
      .map((item) => ({ code: item.code, name: item.name, price: item.price, inactive: !item.active })),
  ].map((item, index) => ({
    ...item,
    name: metadata.get(item.code)?.name || item.name,
    sortOrder: metadata.get(item.code)?.sort_order ?? (index + 1) * 10,
    status: ("inactive" in item && item.inactive) ? "HIDDEN" : statuses.get(item.code) ?? "SALE",
  }))
    .filter((item) => includeHidden || item.status !== "HIDDEN")
    .sort((left, right) => left.sortOrder - right.sortOrder || left.name.localeCompare(right.name, "ko"));
}

export type KioskRoomSize = "SMALL" | "MEDIUM" | "LARGE";

const KIOSK_ROOM_CODES_BY_SIZE: Record<KioskRoomSize, string[]> = {
  SMALL: ["C1", "C2"],
  MEDIUM: ["A1", "B1"],
  LARGE: ["B1"],
};

function normalizeKioskRoomSize(value: unknown): KioskRoomSize {
  const normalized = String(value ?? "").trim().toUpperCase();
  if (normalized === "SMALL" || normalized === "소형") return "SMALL";
  if (normalized === "MEDIUM" || normalized === "중형") return "MEDIUM";
  if (normalized === "LARGE" || normalized === "대형") return "LARGE";
  throw new Error("KIOSK_ROOM_SIZE_INVALID");
}

function publicRoomRecommendationRule(row: {
  id: string; name: string; adult_min: number; adult_max: number; youth_min: number; youth_max: number;
  total_min: number; total_max: number; primary_size: string; secondary_size: string; active: number; priority: number;
}) {
  return {
    id: row.id,
    name: row.name,
    adultMin: row.adult_min,
    adultMax: row.adult_max,
    youthMin: row.youth_min,
    youthMax: row.youth_max,
    totalMin: row.total_min,
    totalMax: row.total_max,
    primarySize: row.primary_size as KioskRoomSize,
    secondarySize: row.secondary_size as KioskRoomSize | "",
    active: row.active === 1,
    priority: row.priority,
  };
}

export async function getKioskRoomRecommendationRules(includeInactive = false) {
  await ensureKioskSchema();
  const result = await getD1().prepare(`SELECT id, name, adult_min, adult_max, youth_min, youth_max,
      total_min, total_max, primary_size, secondary_size, active, priority
    FROM kiosk_room_recommendation_rules ${includeInactive ? "" : "WHERE active = 1"}
    ORDER BY priority, total_min, created_at`).all<{
      id: string; name: string; adult_min: number; adult_max: number; youth_min: number; youth_max: number;
      total_min: number; total_max: number; primary_size: string; secondary_size: string; active: number; priority: number;
    }>();
  return result.results.map(publicRoomRecommendationRule);
}

export async function getKioskRoomRecommendation(adultCount: number, youthCount: number) {
  const adult = clamp(adultCount, 0, 10);
  const youth = clamp(youthCount, 0, 10);
  const total = adult + youth;
  const rules = await getKioskRoomRecommendationRules();
  const rule = rules.find((item) => adult >= item.adultMin && adult <= item.adultMax &&
    youth >= item.youthMin && youth <= item.youthMax && total >= item.totalMin && total <= item.totalMax);
  return rule ?? { id: "fallback", name: "기본 추천", adultMin: 0, adultMax: 10, youthMin: 0, youthMax: 10,
    totalMin: 1, totalMax: 10, primarySize: total <= 4 ? "SMALL" : total <= 6 ? "MEDIUM" : "LARGE",
    secondarySize: total <= 4 ? "MEDIUM" : total <= 6 ? "LARGE" : "", active: true, priority: 999 };
}

export async function getKioskGuidance(includeInactive = false) {
  await ensureKioskSchema();
  const result = await getD1().prepare(`SELECT id, placement, content, title, summary, agreement_text,
      required, version, sort_order, active
    FROM kiosk_guidance_items ${includeInactive ? "" : "WHERE active = 1"}
    ORDER BY placement, sort_order, created_at`).all<{
      id: string; placement: string; content: string; title: string; summary: string; agreement_text: string;
      required: number; version: number; sort_order: number; active: number;
    }>();
  return result.results.map((item) => ({
    id: item.id, placement: item.placement, content: item.content,
    title: item.title || "이용 안내", summary: item.summary || item.content,
    agreementText: item.agreement_text, required: item.required === 1,
    version: Math.max(1, Number(item.version) || 1),
    sortOrder: item.sort_order, active: item.active === 1,
  }));
}

export async function getKioskDisplaySettings() {
  await ensureKioskSchema();
  const row = await getD1().prepare(`SELECT home_title, home_subtitle
    FROM kiosk_display_settings WHERE id = 'main' LIMIT 1`)
    .first<{ home_title: string; home_subtitle: string }>();
  return {
    homeTitle: row?.home_title || "오늘도 신나게 뛰어볼까요?",
    homeSubtitle: row?.home_subtitle || "예약 확인 또는 현장 이용을 선택해주세요.",
  };
}

export async function saveKioskDisplaySettings(input: {
  homeTitle: unknown; homeSubtitle: unknown; requestedBy: string;
}) {
  await ensureKioskSchema();
  const homeTitle = cleanText(input.homeTitle, 60) || "오늘도 신나게 뛰어볼까요?";
  const homeSubtitle = cleanText(input.homeSubtitle, 120) || "예약 확인 또는 현장 이용을 선택해주세요.";
  await getD1().prepare(`INSERT INTO kiosk_display_settings
      (id, home_title, home_subtitle, updated_by, updated_at)
    VALUES ('main', ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET home_title = excluded.home_title,
      home_subtitle = excluded.home_subtitle, updated_by = excluded.updated_by,
      updated_at = CURRENT_TIMESTAMP`)
    .bind(homeTitle, homeSubtitle, cleanText(input.requestedBy, 120)).run();
  return listKioskOperations();
}

async function assertRequiredGuidanceAccepted(visitId: string) {
  const missing = await getD1().prepare(`SELECT item.id
    FROM kiosk_guidance_items item
    LEFT JOIN kiosk_guidance_agreements agreement
      ON agreement.visit_id = ? AND agreement.guidance_id = item.id
      AND agreement.guidance_version = item.version AND agreement.agreed = 1
    WHERE item.placement = 'REQUIRED_AGREEMENT' AND item.active = 1 AND item.required = 1
      AND agreement.id IS NULL LIMIT 1`).bind(visitId).first();
  if (missing) throw new Error("KIOSK_REQUIRED_GUIDANCE_NOT_ACCEPTED");
}

export async function acceptKioskGuidance(token: string, guidanceIds: string[]) {
  const visit = await visitForToken(token, true);
  if (!["DRAFT", "HOLD"].includes(visit.status)) throw new Error("KIOSK_VISIT_LOCKED");
  const requested = new Set(guidanceIds.map((value) => cleanText(value, 80)).filter(Boolean));
  const required = await getD1().prepare(`SELECT id, version FROM kiosk_guidance_items
    WHERE placement = 'REQUIRED_AGREEMENT' AND active = 1 AND required = 1
    ORDER BY sort_order, created_at`).all<{ id: string; version: number }>();
  if (required.results.some((item) => !requested.has(item.id))) throw new Error("KIOSK_REQUIRED_GUIDANCE_NOT_ACCEPTED");
  const selected = await getD1().prepare(`SELECT id, version FROM kiosk_guidance_items
    WHERE placement = 'REQUIRED_AGREEMENT' AND active = 1`).all<{ id: string; version: number }>();
  const accepted = selected.results.filter((item) => requested.has(item.id));
  if (accepted.length) {
    await getD1().batch(accepted.map((item) => getD1().prepare(`INSERT INTO kiosk_guidance_agreements
      (id, visit_id, guidance_id, guidance_version, agreed, agreed_at)
      VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
      ON CONFLICT(visit_id, guidance_id, guidance_version) DO UPDATE SET agreed = 1, agreed_at = CURRENT_TIMESTAMP`)
      .bind(crypto.randomUUID(), visit.id, item.id, item.version)));
  }
  await assertRequiredGuidanceAccepted(visit.id);
  return { ok: true, agreedAt: new Date().toISOString(), guidanceIds: accepted.map((item) => item.id) };
}

function resolveKioskDifficultyForRoom(roomCode: string, roomSize: KioskRoomSize, baseCode: string) {
  const normalizedBase = baseCode.replace(/^b1-medium-/, "");
  if (roomCode === "B1" && roomSize === "MEDIUM") {
    const medium = B1_MEDIUM_DIFFICULTY_OPTIONS.find((item) => item.code === `b1-medium-${normalizedBase}`);
    if (!medium) throw new Error("KIOSK_DIFFICULTY_INVALID");
    return medium;
  }
  const difficulty = DIFFICULTY_OPTIONS.find((item) => item.code === normalizedBase);
  if (!difficulty || !getDifficultyOptions(roomCode).some((item) => item.code === difficulty.code)) {
    throw new Error("KIOSK_DIFFICULTY_INVALID");
  }
  return difficulty;
}

type KioskAutoAssignSlotState = {
  visit_status: string;
  client_revision: number;
  adult_count: number;
  youth_count: number;
  party_count: number;
  room_status: string;
  remaining_seconds: number;
  game_started_at: string | null;
  reservation_occupied: number;
  hold_occupied: number;
  game_occupied: number;
};

async function recheckKioskAutoAssignSlot(
  visit: VisitRow,
  expectedDraftVersion: number,
  scheduledDate: string,
  scheduledTime: string,
  roomCode: string,
) {
  const room = getRoom(roomCode);
  if (!room || visit.party_count > room.max || scheduledDate !== dateInSeoul() || !OPERATING_SLOTS.includes(scheduledTime)) {
    throw new Error("KIOSK_SLOT_INVALID");
  }
  const state = await getD1().prepare(`SELECT
      visits.status AS visit_status, visits.client_revision, visits.adult_count, visits.youth_count, visits.party_count,
      rooms.status AS room_status, rooms.remaining_seconds, room_game_runtime.game_started_at,
      EXISTS(SELECT 1 FROM reservations
        WHERE scheduled_date = ? AND scheduled_time = ? AND room_code = ?
          AND status NOT IN ('cancelled', 'completed')) AS reservation_occupied,
      EXISTS(SELECT 1 FROM customer_room_holds
        WHERE scheduled_date = ? AND scheduled_time = ? AND room_code = ? AND state = 'ACTIVE'
          AND datetime(expires_at) > CURRENT_TIMESTAMP) AS hold_occupied,
      EXISTS(SELECT 1 FROM customer_visit_games
        WHERE scheduled_date = ? AND scheduled_time = ? AND room_code = ? AND status = 'HOLD'
          AND active_slot_key IS NOT NULL AND datetime(expires_at) > CURRENT_TIMESTAMP) AS game_occupied
    FROM customer_visits AS visits
    JOIN rooms ON rooms.room_id = ?
    LEFT JOIN room_game_runtime ON room_game_runtime.room_id = rooms.room_id
    WHERE visits.id = ? LIMIT 1`)
    .bind(
      scheduledDate, scheduledTime, roomCode,
      scheduledDate, scheduledTime, roomCode,
      scheduledDate, scheduledTime, roomCode,
      room.roomId, visit.id,
    ).first<KioskAutoAssignSlotState>();
  if (!state) throw new Error("KIOSK_SESSION_NOT_FOUND");
  if (!["DRAFT", "HOLD"].includes(state.visit_status)) throw new Error("KIOSK_VISIT_LOCKED");
  if (
    Number(state.client_revision) !== expectedDraftVersion ||
    Number(state.adult_count) !== visit.adult_count ||
    Number(state.youth_count) !== visit.youth_count ||
    Number(state.party_count) !== visit.party_count
  ) {
    throw new Error("KIOSK_DRAFT_STALE");
  }
  const startedAt = Date.parse(state.game_started_at ?? "");
  const fixedGameEnd = Number.isFinite(startedAt) ? startedAt + GAME_MINUTES * 60_000 : 0;
  const unavailable = state.room_status === "offline" ||
    Number(state.reservation_occupied) === 1 ||
    Number(state.hold_occupied) === 1 ||
    Number(state.game_occupied) === 1 ||
    !kioskSlotStartsAfterRunningGame({
      roomStatus: state.room_status,
      slotStartAt: parseSeoulSlot(scheduledDate, scheduledTime),
      nowAt: Date.now(),
      remainingSeconds: state.remaining_seconds,
      endsAt: fixedGameEnd,
    });
  if (unavailable) throw new Error("KIOSK_SLOT_OCCUPIED");
}

export async function autoAssignKioskSlot(token: string, input: {
  roomSize: unknown; difficultyCode: unknown; afterTime?: unknown; appendGame?: unknown; draft?: KioskDraftSnapshot;
}, trace?: KioskLatencyTrace) {
  markKioskStage(trace, "AUTO_ASSIGN_START");
  const context = await measureKioskStage(trace, "AUTO_ASSIGN_CONTEXT_DONE", async () => {
    const initialVisit = await visitForToken(token, true, trace);
    return applyKioskDraftSnapshot(initialVisit, input.draft, trace);
  });
  if (input.draft) {
    const requestedDraftVersion = clamp(input.draft.clientRevision, 0, 2_000_000_000);
    if (context.stale || requestedDraftVersion < context.draftVersion) {
      throw new Error("KIOSK_DRAFT_STALE");
    }
  }
  const visit = context.visit;
  if (!["DRAFT", "HOLD"].includes(visit.status)) throw new Error("KIOSK_VISIT_LOCKED");
  const roomSize = normalizeKioskRoomSize(input.roomSize);
  const allowedCodes = KIOSK_ROOM_CODES_BY_SIZE[roomSize];
  const appendGame = input.appendGame === true;
  const precheck = await measureKioskStage(trace, "AUTO_ASSIGN_PRECHECK_DONE", async () => {
    const [existingGames, availability, pricing] = await Promise.all([
      getD1().prepare(`SELECT * FROM customer_visit_games
        WHERE visit_id = ? AND status NOT IN ('CANCELLED', 'EXPIRED') ORDER BY sequence`)
        .bind(visit.id).all<VisitGameRow>(),
      getKioskAvailability(visit.party_count, { trace, skipExpiry: true }),
      context.pricing ? Promise.resolve(context.pricing) : getPricingSettings(),
    ]);
    return { existingGames, availability, pricing };
  });
  const existingGames = precheck.existingGames;
  if (appendGame && existingGames.results.length >= 10) throw new Error("KIOSK_GAME_COUNT_INVALID");
  const previousGame = existingGames.results.at(-1);
  const requestedAfterTime = cleanText(input.afterTime, 5);
  const previousIndex = previousGame ? OPERATING_SLOTS.indexOf(previousGame.scheduled_time) : -1;
  const nextTime = previousIndex >= 0 ? OPERATING_SLOTS[previousIndex + 1] ?? "" : "";
  const afterTime = requestedAfterTime || (appendGame ? nextTime : "");
  const candidate = precheck.availability
    .filter((room) => allowedCodes.includes(room.code) && room.selectable)
    .flatMap((room) => room.slots
      .filter((time) => !afterTime || time >= afterTime)
      .map((time) => ({ room, time })))
    .sort((left, right) => left.time.localeCompare(right.time) || allowedCodes.indexOf(left.room.code) - allowedCodes.indexOf(right.room.code))[0];
  if (!candidate) throw new Error("KIOSK_SLOT_OCCUPIED");
  const difficulty = resolveKioskDifficultyForRoom(candidate.room.code, roomSize, cleanText(input.difficultyCode, 80));
  const unitBaseAmount = calculateBaseAmount(visit.adult_count, visit.youth_count, precheck.pricing);
  const scheduledDate = dateInSeoul();
  const expiresAt = new Date(Date.now() + KIOSK_HOLD_MS).toISOString();
  const db = getD1();

  await measureKioskStage(trace, "AUTO_ASSIGN_HOLD_RECHECK_DONE", () => recheckKioskAutoAssignSlot(
    visit,
    context.draftVersion,
    scheduledDate,
    candidate.time,
    candidate.room.code,
  ));

  let assignedSequence: number;
  if (!appendGame) {
    const holdId = visit.hold_id ?? crypto.randomUUID();
    const gameId = existingGames.results[0]?.id || crypto.randomUUID();
    const activeKey = slotKey(scheduledDate, candidate.time, candidate.room.code);
    let writeResults;
    try {
      writeResults = await measureKioskStage(trace, "AUTO_ASSIGN_HOLD_WRITE_DONE", () => db.batch([
        db.prepare(`UPDATE customer_room_holds SET state = 'CANCELLED', active_slot_key = NULL, updated_at = CURRENT_TIMESTAMP
          WHERE visit_id = ? AND state = 'ACTIVE' AND EXISTS (
            SELECT 1 FROM customer_visits WHERE id = ? AND status IN ('DRAFT', 'HOLD') AND client_revision = ?
              AND adult_count = ? AND youth_count = ? AND party_count = ?
          )`).bind(visit.id, visit.id, context.draftVersion, visit.adult_count, visit.youth_count, visit.party_count),
        db.prepare(`INSERT INTO customer_room_holds
          (id, visit_id, scheduled_date, scheduled_time, room_code, state, active_slot_key, expires_at)
          SELECT ?, id, ?, ?, ?, 'ACTIVE', ?, ? FROM customer_visits
          WHERE id = ? AND status IN ('DRAFT', 'HOLD') AND client_revision = ?
            AND adult_count = ? AND youth_count = ? AND party_count = ?
          ON CONFLICT(visit_id) DO UPDATE SET scheduled_date = excluded.scheduled_date,
            scheduled_time = excluded.scheduled_time, room_code = excluded.room_code, state = 'ACTIVE',
            active_slot_key = excluded.active_slot_key, expires_at = excluded.expires_at,
            updated_at = CURRENT_TIMESTAMP`)
          .bind(holdId, scheduledDate, candidate.time, candidate.room.code, activeKey, expiresAt,
            visit.id, context.draftVersion, visit.adult_count, visit.youth_count, visit.party_count),
        db.prepare(`UPDATE customer_visit_games SET status = 'CANCELLED', active_slot_key = NULL,
          updated_at = CURRENT_TIMESTAMP WHERE visit_id = ? AND sequence > 1 AND status = 'HOLD' AND EXISTS (
            SELECT 1 FROM customer_visits WHERE id = ? AND status IN ('DRAFT', 'HOLD') AND client_revision = ?
              AND adult_count = ? AND youth_count = ? AND party_count = ?
          )`).bind(visit.id, visit.id, context.draftVersion, visit.adult_count, visit.youth_count, visit.party_count),
        db.prepare(`INSERT INTO customer_visit_games
          (id, visit_id, sequence, status, scheduled_date, scheduled_time, room_code, room_size,
           difficulty_code, difficulty_label, map_index, adult_count, youth_count, party_count,
           base_amount, hold_id, active_slot_key, expires_at)
          SELECT ?, id, 1, 'HOLD', ?, ?, ?, ?, ?, ?, ?, adult_count, youth_count, party_count,
            ?, ?, NULL, ?
          FROM customer_visits WHERE id = ? AND status IN ('DRAFT', 'HOLD') AND client_revision = ?
            AND adult_count = ? AND youth_count = ? AND party_count = ?
          ON CONFLICT(visit_id, sequence) DO UPDATE SET status = 'HOLD', scheduled_date = excluded.scheduled_date,
            scheduled_time = excluded.scheduled_time, room_code = excluded.room_code, room_size = excluded.room_size,
            difficulty_code = excluded.difficulty_code, difficulty_label = excluded.difficulty_label,
            map_index = excluded.map_index, adult_count = excluded.adult_count, youth_count = excluded.youth_count,
            party_count = excluded.party_count, base_amount = excluded.base_amount, hold_id = excluded.hold_id,
            active_slot_key = NULL, expires_at = excluded.expires_at, updated_at = CURRENT_TIMESTAMP`)
          .bind(gameId, scheduledDate, candidate.time, candidate.room.code, roomSize,
            difficulty.code, difficulty.label, difficulty.mapIndex,
            unitBaseAmount, holdId, expiresAt,
            visit.id, context.draftVersion, visit.adult_count, visit.youth_count, visit.party_count),
        db.prepare(`UPDATE customer_visits SET status = 'HOLD', hold_id = ?, scheduled_date = ?, scheduled_time = ?,
          room_code = ?, difficulty_code = ?, difficulty_label = ?, map_index = ?, game_count = 1,
          base_amount = ?, final_amount = MAX(0, ? + add_on_amount - discount_amount), expires_at = ?,
          updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('DRAFT', 'HOLD') AND client_revision = ?
            AND adult_count = ? AND youth_count = ? AND party_count = ?`)
          .bind(holdId, scheduledDate, candidate.time, candidate.room.code,
            difficulty.code, difficulty.label, difficulty.mapIndex, unitBaseAmount, unitBaseAmount,
            expiresAt, visit.id, context.draftVersion, visit.adult_count, visit.youth_count, visit.party_count),
      ]));
    } catch {
      throw new Error("KIOSK_SLOT_OCCUPIED");
    }
    if (Number(writeResults.at(-1)?.meta?.changes ?? 0) < 1) throw new Error("KIOSK_DRAFT_STALE");
    assignedSequence = 1;
  } else {
    if (!previousGame) throw new Error("KIOSK_FIRST_GAME_REQUIRED");
    const sequence = previousGame.sequence + 1;
    const gameId = crypto.randomUUID();
    const activeKey = slotKey(scheduledDate, candidate.time, candidate.room.code);
    let writeResults;
    try {
      writeResults = await measureKioskStage(trace, "AUTO_ASSIGN_HOLD_WRITE_DONE", () => db.batch([
        db.prepare(`INSERT INTO customer_visit_games
          (id, visit_id, sequence, status, scheduled_date, scheduled_time, room_code, room_size,
           difficulty_code, difficulty_label, map_index, adult_count, youth_count, party_count,
           base_amount, hold_id, active_slot_key, expires_at)
          SELECT ?, id, ?, 'HOLD', ?, ?, ?, ?, ?, ?, ?, adult_count, youth_count, party_count,
            ?, ?, ?, ?
          FROM customer_visits WHERE id = ? AND status IN ('DRAFT', 'HOLD') AND client_revision = ?
            AND adult_count = ? AND youth_count = ? AND party_count = ?`)
          .bind(gameId, sequence, scheduledDate, candidate.time, candidate.room.code, roomSize,
            difficulty.code, difficulty.label, difficulty.mapIndex,
            unitBaseAmount, crypto.randomUUID(), activeKey, expiresAt,
            visit.id, context.draftVersion, visit.adult_count, visit.youth_count, visit.party_count),
        db.prepare(`UPDATE customer_visits SET game_count = game_count + 1,
          base_amount = base_amount + ?, final_amount = MAX(0, base_amount + ? + add_on_amount - discount_amount),
          expires_at = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status IN ('DRAFT', 'HOLD') AND client_revision = ?
            AND adult_count = ? AND youth_count = ? AND party_count = ?`)
          .bind(unitBaseAmount, unitBaseAmount, expiresAt, visit.id, context.draftVersion,
            visit.adult_count, visit.youth_count, visit.party_count),
      ]));
    } catch {
      throw new Error("KIOSK_SLOT_OCCUPIED");
    }
    if (Number(writeResults.at(-1)?.meta?.changes ?? 0) < 1) throw new Error("KIOSK_DRAFT_STALE");
    assignedSequence = sequence;
  }
  markKioskStage(trace, "AUTO_ASSIGN_DIFFICULTY_DONE");
  const hydrated = await measureKioskStage(trace, "AUTO_ASSIGN_FINAL_HYDRATE_DONE", () => reloadKioskVisit(visit.id, trace));
  markKioskStage(trace, "AUTO_ASSIGN_DONE");
  return {
    visit: hydrated,
    assigned: { roomSize, roomCode: candidate.room.code, time: candidate.time, difficulty, sequence: assignedSequence },
  };
}

export async function quoteKioskParticipantTopUp(token: string, input: {
  additionalAdultCount?: unknown;
  additionalYouthCount?: unknown;
}) {
  const visit = await visitForToken(token);
  if (visit.flow_type !== "PARTY_TOP_UP" || !["DRAFT", "HOLD"].includes(visit.status)) {
    throw new Error("KIOSK_PARTICIPANT_TOP_UP_INVALID_STATE");
  }
  const selected = participantTopUpSettlement(visit);
  const reservationId = cleanText(selected.targetReservationId, 100);
  if (!reservationId) throw new Error("KIOSK_RESERVATION_NOT_FOUND");
  const [reservation, pricing] = await Promise.all([
    getReservationById(reservationId),
    getPricingSettings(),
  ]);
  if (!reservation || reservation.status === "cancelled" || reservation.status === "completed") {
    throw new Error("KIOSK_PARTICIPANT_TOP_UP_NOT_ACTIVE");
  }
  if (reservation.paymentStatus !== "paid") {
    throw new Error("KIOSK_PARTICIPANT_TOP_UP_PAYMENT_REQUIRED");
  }
  const expectedAdultCount = Math.max(0, Math.trunc(Number(selected.expectedAdultCount) || 0));
  const expectedYouthCount = Math.max(0, Math.trunc(Number(selected.expectedYouthCount) || 0));
  if (
    reservation.adultCount !== expectedAdultCount ||
    reservation.youthCount !== expectedYouthCount
  ) {
    throw new Error("KIOSK_PARTICIPANT_TOP_UP_STALE");
  }
  const calculated = calculateParticipantTopUp({
    currentAdultCount: expectedAdultCount,
    currentYouthCount: expectedYouthCount,
    additionalAdultCount: Number(input.additionalAdultCount),
    additionalYouthCount: Number(input.additionalYouthCount),
    adultPrice: pricing.adultPrice,
    youthPrice: pricing.youthPrice,
  });
  const settlement = JSON.stringify({
    participantTopUp: {
      targetReservationId: reservation.id,
      expectedAdultCount,
      expectedYouthCount,
      additionalAdultCount: calculated.additionalAdultCount,
      additionalYouthCount: calculated.additionalYouthCount,
      targetAdultCount: calculated.targetAdultCount,
      targetYouthCount: calculated.targetYouthCount,
      amount: calculated.amount,
    },
  });
  await getD1().prepare(`UPDATE customer_visits SET adult_count = ?, youth_count = ?, party_count = ?,
      settlement_json = ?, base_amount = ?, add_on_amount = 0, discount_amount = 0,
      final_amount = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND flow_type = 'PARTY_TOP_UP' AND status IN ('DRAFT', 'HOLD')`)
    .bind(
      calculated.targetAdultCount, calculated.targetYouthCount, calculated.targetPartyCount,
      settlement, calculated.amount, calculated.amount, visit.id,
    ).run();
  return { visit: await getKioskVisit(token) };
}

export async function quoteKioskCheckout(token: string, input: {
  addOns?: AddOnSaleSelectionInput;
  benefitType?: string;
  benefitId?: string;
  benefitMemberId?: string;
  benefitUses?: unknown;
  passId?: string;
  passMemberId?: string;
  passUses?: unknown;
  couponId?: string;
  couponMemberId?: string;
  vehicleLast4?: string;
  draft?: KioskDraftSnapshot;
}, trace?: KioskLatencyTrace) {
  let visit = await visitForToken(token, true, trace);
  visit = (await applyKioskDraftSnapshot(visit, input.draft, trace)).visit;
  if (!["ADD_ON_ONLY", "PARTY_TOP_UP"].includes(visit.flow_type)) {
    await assertRequiredGuidanceAccepted(visit.id);
  }
  const kioskPaymentSettings = await measureKioskStage(trace, "payment_settings_read", () => getKioskPaymentSettings());
  const pricing = await measureKioskStage(trace, "pricing_read", () => getPricingSettings());
  const addOns = input.addOns ?? { slush: 0, beverage: 0, other: 0, items: [] };
  const requestedCodes = [
    Number(addOns.slush) > 0 ? "slush" : "",
    Number(addOns.beverage) > 0 ? "beverage" : "",
    Number(addOns.other) > 0 ? "other" : "",
    ...(addOns.items ?? []).filter((item) => Number(item.quantity) > 0).map((item) => item.code),
  ].filter(Boolean);
  if (requestedCodes.length) {
    const availability = await measureKioskStage(trace, "product_availability", () => getD1().prepare(`SELECT product_code, status FROM customer_product_availability
      WHERE product_code IN (${requestedCodes.map(() => "?").join(",")})`).bind(...requestedCodes).all<{ product_code: string; status: string }>());
    if (availability.results.some((item) => item.status !== "SALE")) throw new Error("KIOSK_PRODUCT_NOT_AVAILABLE");
  }
  const addOnQuote = quoteAddOnSale(addOns, pricing);
  let discount = 0;
  let passBenefit: Record<string, unknown> | null = null;
  let couponBenefit: Record<string, unknown> | null = null;
  const totalParticipantSlots = visit.party_count * Math.max(1, Number(visit.game_count) || 1);
  const passMemberId = cleanText(input.passMemberId || (input.benefitType === "pass" ? input.benefitMemberId : ""), 80);
  const couponMemberId = cleanText(input.couponMemberId || (input.benefitType === "coupon" ? input.benefitMemberId : ""), 80);
  const selectedOwnerIds = [...new Set([passMemberId, couponMemberId].filter(Boolean))];
  if (selectedOwnerIds.length > 1) throw new Error("KIOSK_BENEFIT_OWNER_MISMATCH");
  for (const ownerId of selectedOwnerIds) {
    const linked = await getD1().prepare(`SELECT member_id FROM customer_visit_members WHERE visit_id = ? AND member_id = ? LIMIT 1`)
      .bind(visit.id, ownerId).first();
    if (!linked) throw new Error("KIOSK_BENEFIT_OWNER_INVALID");
  }
  const passId = cleanText(input.passId || (input.benefitType === "pass" ? input.benefitId : ""), 100);
  if (passMemberId && passId) {
    assertKioskPaymentMethodEnabled(kioskPaymentSettings, "pass");
    const benefits = await getMemberBenefits(passMemberId);
    const pass = benefits.passes.find((item) => item.id === passId && item.status === "ACTIVE" && item.remainingUses > 0 && (!item.expiresAt || Date.parse(item.expiresAt) > Date.now()));
    if (!pass) throw new Error("KIOSK_BENEFIT_NOT_USABLE");
    const uses = Math.min(
      totalParticipantSlots,
      pass.remainingUses,
      clamp(input.passUses ?? input.benefitUses, 1, Math.min(100, totalParticipantSlots)),
    );
    const raw = await getD1().prepare(`SELECT regular_unit_price_at_purchase FROM member_passes WHERE id = ? LIMIT 1`)
      .bind(pass.id).first<{ regular_unit_price_at_purchase: number }>();
    const passDiscount = Math.min(visit.base_amount, uses * Math.max(0, Number(raw?.regular_unit_price_at_purchase) || 0));
    discount += passDiscount;
    passBenefit = { type: "pass", id: pass.id, ownerId: passMemberId, uses, name: pass.productName, discount: passDiscount };
  }
  const couponId = cleanText(input.couponId || (input.benefitType === "coupon" ? input.benefitId : ""), 100);
  if (couponMemberId && couponId) {
    assertKioskPaymentMethodEnabled(kioskPaymentSettings, "coupon");
    const benefits = await getMemberBenefits(couponMemberId);
    const coupon = benefits.coupons.find((item) => item.id === couponId && item.status === "ACTIVE" && Date.parse(item.expiresAt) > Date.now());
    if (!coupon) throw new Error("KIOSK_BENEFIT_NOT_USABLE");
    const couponAmount = Math.min(Math.max(0, visit.base_amount - discount), visit.youth_count > 0 ? pricing.youthPrice : pricing.adultPrice);
    discount += couponAmount;
    couponBenefit = { type: "coupon", id: coupon.id, ownerId: couponMemberId, uses: 1, name: coupon.name, discount: couponAmount };
  }
  let depositAmount = 0;
  if (visit.reservation_id) {
    const reservation = await getReservationById(visit.reservation_id);
    if (reservation?.source === "naver") {
      depositAmount = Math.min(pricing.naverDepositAmount, Math.max(0, visit.base_amount - discount));
    }
  }
  const final = Math.max(0, visit.base_amount + addOnQuote.amount - discount - depositAmount);
  const passUses = passBenefit ? Math.max(1, Number(passBenefit.uses) || 1) : 0;
  const couponUses = couponBenefit ? 1 : 0;
  const paidParticipants = paidGameParticipantCount({
    partyCount: totalParticipantSlots,
    passUses,
    couponUses,
    addOnOnly: visit.flow_type === "ADD_ON_ONLY",
  });
  const vehicleLast4 = /^\d{4}$/.test(String(input.vehicleLast4 || "")) ? String(input.vehicleLast4) : "";
  const settlement = {
    benefit: passBenefit || couponBenefit,
    passBenefit,
    couponBenefit,
    depositAmount,
    stampEligibleCount: paidParticipants,
    vehicleLast4,
    stampBreakdown: {
      total: totalParticipantSlots,
      paid: paidParticipants,
      pass: passUses,
      coupon: couponUses,
    },
  };
  await measureKioskStage(trace, "quote_update", () => getD1().prepare(`UPDATE customer_visits SET add_ons_json = ?, settlement_json = ?,
    add_on_amount = ?, discount_amount = ?, final_amount = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(JSON.stringify(addOns), JSON.stringify(settlement), addOnQuote.amount, discount, final, visit.id).run());
  return { visit: await reloadKioskVisit(visit.id, trace), addOnQuote, benefit: passBenefit || couponBenefit, pricing, stampBreakdown: settlement.stampBreakdown };
}

async function createReservationsForVisit(visit: VisitRow) {
  const visitSettlement = json<{ vehicleLast4?: string }>(visit.settlement_json, {});
  const vehicleLast4 = /^\d{4}$/.test(String(visitSettlement.vehicleLast4 || "")) ? String(visitSettlement.vehicleLast4) : "";
  if (visit.reservation_id) {
    const existing = await getReservationById(visit.reservation_id);
    if (!existing) throw new Error("KIOSK_RESERVATION_NOT_FOUND");
    if (vehicleLast4 && existing.vehicleLast4 !== vehicleLast4) {
      await getD1().prepare(`UPDATE reservations SET vehicle_last4 = ?,
        parking_registration_status = '', parking_registration_request_id = '', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?`).bind(vehicleLast4, existing.id).run();
      const refreshed = await getReservationById(existing.id);
      if (!refreshed) throw new Error("KIOSK_RESERVATION_NOT_FOUND");
      return { primary: refreshed, reservations: [refreshed] };
    }
    return { primary: existing, reservations: [existing] };
  }
  if (visit.flow_type === "ADD_ON_ONLY") {
    const addOns = json<AddOnSaleSelectionInput>(visit.add_ons_json, { slush: 0, beverage: 0, other: 0, items: [] });
    const order = await createAddOnSaleOrder({
      date: dateInSeoul(), slush: addOns.slush, beverage: addOns.beverage, other: addOns.other,
      items: addOns.items, requestedBy: `kiosk:${visit.kiosk_id || "main"}`,
    });
    await getD1().prepare(`UPDATE customer_visits SET reservation_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(order.reservation.id, visit.id).run();
    return { primary: order.reservation, reservations: [order.reservation] };
  }
  if (!visit.hold_id || !visit.scheduled_date || !visit.scheduled_time || !visit.room_code || !visit.difficulty_code) {
    throw new Error("KIOSK_CHECKOUT_INCOMPLETE");
  }
  const activeHold = await getD1().prepare(`SELECT id FROM customer_room_holds WHERE id = ? AND visit_id = ?
    AND state = 'ACTIVE' AND datetime(expires_at) > CURRENT_TIMESTAMP LIMIT 1`).bind(visit.hold_id, visit.id).first();
  if (!activeHold) throw new Error("KIOSK_HOLD_EXPIRED");
  let games = await getD1().prepare(`SELECT * FROM customer_visit_games
    WHERE visit_id = ? AND status = 'HOLD' ORDER BY sequence`).bind(visit.id).all<VisitGameRow>();
  if (!games.results.length) {
    games = { ...games, results: [{
      id: crypto.randomUUID(), visit_id: visit.id, sequence: 1, status: "HOLD",
      scheduled_date: visit.scheduled_date, scheduled_time: visit.scheduled_time, room_code: visit.room_code,
      room_size: getRoom(visit.room_code)?.size === "대형" ? "LARGE" : getRoom(visit.room_code)?.size === "중형" ? "MEDIUM" : "SMALL",
      difficulty_code: visit.difficulty_code, difficulty_label: visit.difficulty_label, map_index: visit.map_index,
      adult_count: visit.adult_count, youth_count: visit.youth_count, party_count: visit.party_count,
      base_amount: visit.base_amount, hold_id: visit.hold_id, active_slot_key: null,
      reservation_id: null, expires_at: visit.expires_at,
    }] };
  }
  if (games.results.some((game) => Date.parse(game.expires_at) <= Date.now())) throw new Error("KIOSK_HOLD_EXPIRED");
  const repeatGroupId = games.results.length > 1 ? crypto.randomUUID() : "";
  const createdReservations = [];
  let remainingDiscount = Math.max(0, visit.discount_amount);
  for (const game of games.results) {
    let reservation = game.reservation_id ? await getReservationById(game.reservation_id) : null;
    if (!reservation) {
      const created = await createWebReservation({
        scheduledDate: game.scheduled_date,
        scheduledTime: game.scheduled_time,
        roomCode: game.room_code,
        teamName: visit.team_name || "현장팀",
        difficultyCode: game.difficulty_code,
        difficultyLabel: game.difficulty_label,
        mapIndex: game.map_index,
        adultCount: game.adult_count,
        youthCount: game.youth_count,
        totalCount: game.party_count,
        vehicleLast4,
        consentText: "키오스크 현장 접수",
        baseAmount: game.base_amount,
        idempotencyKey: `kiosk-visit:${visit.id}:game:${game.sequence}`,
      });
      reservation = created.reservation;
    }
    const allocatedDiscount = Math.min(remainingDiscount, Math.max(0, game.base_amount));
    remainingDiscount -= allocatedDiscount;
    await getD1().batch([
      getD1().prepare(`UPDATE reservations SET source = 'kiosk_walkin', customer_name = ?, customer_phone = ?,
        member_id = ?, discount_amount = ?, repeat_group_id = ?, repeat_sequence = ?,
        memo = CASE WHEN trim(memo) = '' THEN '키오스크 현장 접수' ELSE memo END,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(visit.customer_name, visit.customer_phone, visit.representative_member_id, allocatedDiscount,
          repeatGroupId, game.sequence, reservation.id),
      getD1().prepare(`UPDATE customer_visit_games SET reservation_id = ?, status = 'RESERVED', active_slot_key = NULL,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(reservation.id, game.id),
    ]);
    const refreshed = await getReservationById(reservation.id);
    if (!refreshed) throw new Error("KIOSK_RESERVATION_NOT_FOUND");
    createdReservations.push(refreshed);
  }
  const primary = createdReservations[0];
  if (!primary) throw new Error("KIOSK_RESERVATION_NOT_FOUND");
  await getD1().batch([
    getD1().prepare(`UPDATE customer_room_holds SET state = 'CONVERTED', active_slot_key = NULL,
      updated_at = CURRENT_TIMESTAMP WHERE id = ? AND visit_id = ?`).bind(visit.hold_id, visit.id),
    getD1().prepare(`UPDATE customer_visits SET reservation_id = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(primary.id, visit.id),
  ]);
  return { primary, reservations: createdReservations };
}

async function cardReady() {
  const [agents, terminal] = await Promise.all([
    getD1().prepare(`SELECT version FROM agents WHERE last_seen > datetime('now', '-25 seconds') ORDER BY last_seen DESC`)
      .all<{ version: string }>(),
    getPaymentTerminalState(),
  ]);
  if (!agents.results.some((row) => supportsPaymentCommands(row.version))) throw new Error("PAYMENT_AGENT_OFFLINE");
  if (!terminal.connected || !terminal.paymentReady) throw new Error("PAYMENT_TERMINAL_NOT_READY");
}

async function syncKioskAddOnSummary(reservationId: string, addOns: AddOnSaleSelectionInput) {
  const catalog = await getKioskCatalog(true);
  const names = new Map(catalog.map((item) => [item.code, item.name]));
  const selections = [
    { code: "slush", quantity: Number(addOns.slush) || 0 },
    { code: "beverage", quantity: Number(addOns.beverage) || 0 },
    { code: "other", quantity: Number(addOns.other) || 0 },
    ...(addOns.items ?? []).map((item) => ({ code: item.code, quantity: Number(item.quantity) || 0 })),
  ].filter((item) => item.quantity > 0);
  if (!selections.length) return;
  const summary = selections.map((item) => `${names.get(item.code) || item.code} ${item.quantity}`).join(" · ");
  await getD1().batch([
    getD1().prepare(`UPDATE add_on_sale_orders SET item_summary = ?, updated_at = CURRENT_TIMESTAMP WHERE reservation_id = ?`)
      .bind(summary, reservationId),
    getD1().prepare(`UPDATE reservations SET team_name = CASE WHEN source = 'add_on_sale_purchase' THEN ? ELSE team_name END,
      memo = CASE WHEN source = 'add_on_sale_purchase' THEN ? ELSE memo END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(summary, `${dateInSeoul()} 부가매출 · ${summary}`, reservationId),
  ]);
}

async function markVisitAfterPayment(visitId: string, reservationId: string) {
  const flow = await getD1().prepare(`SELECT flow_type, settlement_json FROM customer_visits WHERE id = ? LIMIT 1`)
    .bind(visitId).first<{ flow_type: string; settlement_json: string }>();
  if (flow?.flow_type === "ADD_ON_ONLY") {
    await getD1().prepare(`UPDATE customer_visits SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP,
      error_code = '', error_message = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(visitId).run();
    return "";
  }
  if (flow?.flow_type === "PARTY_TOP_UP") {
    const topUp = json<{ participantTopUp?: ParticipantTopUpSettlement }>(flow.settlement_json, {})
      .participantTopUp ?? {};
    const additionalCount = Math.max(0, Math.trunc(Number(topUp.additionalAdultCount) || 0)) +
      Math.max(0, Math.trunc(Number(topUp.additionalYouthCount) || 0));
    const details = JSON.stringify({
      additionalAdultCount: Math.max(0, Math.trunc(Number(topUp.additionalAdultCount) || 0)),
      additionalYouthCount: Math.max(0, Math.trunc(Number(topUp.additionalYouthCount) || 0)),
      amount: Math.max(0, Math.trunc(Number(topUp.amount) || 0)),
    });
    await getD1().batch([
      getD1().prepare(`UPDATE customer_visits SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP,
        error_code = '', error_message = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(visitId),
      getD1().prepare(`UPDATE customer_stamp_allocations SET quantity = quantity + ?,
          updated_at = CURRENT_TIMESTAMP
        WHERE id = (
          SELECT allocation.id
          FROM customer_stamp_allocations allocation
          JOIN customer_visits original_visit ON original_visit.id = allocation.visit_id
          WHERE allocation.status = 'PENDING' AND original_visit.reservation_id = ?
          ORDER BY allocation.created_at, allocation.id
          LIMIT 1
        )`).bind(additionalCount, reservationId),
      getD1().prepare(`INSERT INTO reservation_events
          (id, reservation_id, event_type, details_json, created_by)
        VALUES (?, ?, 'participant_top_up_completed', ?, 'customer-kiosk')`)
        .bind(crypto.randomUUID(), reservationId, details),
    ]);
    return "";
  }
  const startToken = String(Math.floor(1000 + Math.random() * 9000));
  const hash = await sha256(startToken);
  const expiresAt = new Date(Date.now() + START_TOKEN_MS).toISOString();
  await getD1().batch([
    getD1().prepare(`UPDATE customer_visits SET status = 'PREPARING', start_token_hash = ?, start_token_value = ?,
      start_token_expires_at = ?, error_code = '', error_message = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(hash, startToken, expiresAt, visitId),
    getD1().prepare(`UPDATE reservations SET status = CASE WHEN status = 'booked' THEN 'arrived' ELSE status END,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(reservationId),
    getD1().prepare(`UPDATE customer_visit_games SET status = CASE WHEN reservation_id = ? THEN 'PREPARING' ELSE 'PAID_WAITING' END,
      updated_at = CURRENT_TIMESTAMP WHERE visit_id = ? AND status = 'RESERVED'`).bind(reservationId, visitId),
  ]);
  return startToken;
}

async function markVisitWaitingForStaff(visit: VisitRow, transaction: { id: string; paymentMethod: string; amount: number }) {
  const result = await getD1().prepare(`UPDATE customer_visits SET status = 'WAITING_STAFF_CONFIRMATION',
    error_code = '', error_message = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('PAYMENT_PENDING', 'WAITING_STAFF_CONFIRMATION')
      AND EXISTS (
        SELECT 1 FROM payment_attempts attempt
        JOIN payments parent ON parent.id = attempt.payment_id
        WHERE attempt.id = ? AND attempt.attempt_type = 'PAY'
          AND attempt.status = 'PENDING' AND attempt.command_id IS NULL AND attempt.active_key IS NULL
          AND parent.status IN ('PENDING', 'PARTIALLY_PAID')
          AND COALESCE(parent.full_cancel_requested, 0) = 0
      )`)
    .bind(
      `${transaction.paymentMethod === "cash" ? "현금 수납" : "계좌이체"} 확인을 기다리고 있습니다.`,
      visit.id,
      transaction.id,
    ).run();
  if (Number(result.meta.changes ?? 0) !== 1) throw new Error("PAYMENT_TRANSACTION_NOT_PENDING");
  deferOperationalPush({
    eventType: "KIOSK_PAYMENT_CONFIRM_REQUIRED",
    dedupKey: `kiosk-payment-confirm:${transaction.id}`,
    title: "키오스크 결제 확인 필요",
    body: `${visit.room_code || "방 미지정"} · ${transaction.paymentMethod === "cash" ? "현금" : "계좌이체"} 확인이 필요합니다.`,
  });
}

async function startKioskParticipantTopUpCheckout(
  token: string,
  visit: VisitRow,
  requestKey: string,
  requestedPaymentItems: Array<{ amount?: unknown; paymentMethod?: unknown }> | undefined,
  requestedPaymentMode: string,
) {
  const topUp = participantTopUpSettlement(visit);
  const reservationId = cleanText(topUp.targetReservationId, 100);
  const amount = Math.max(0, Math.trunc(Number(topUp.amount) || 0));
  if (!reservationId || amount < 1) throw new Error("KIOSK_PARTICIPANT_TOP_UP_INVALID_STATE");
  const kioskPaymentSettings = await getKioskPaymentSettings();
  const selectedPaymentItems = normalizeKioskPaymentItems(amount, requestedPaymentItems);
  selectedPaymentItems.forEach((item) => assertKioskPaymentMethodEnabled(kioskPaymentSettings, item.paymentMethod));
  const paymentMode = ["single", "equal", "custom"].includes(requestedPaymentMode)
    ? requestedPaymentMode as "single" | "equal" | "custom"
    : "single";
  const planRequestKey = cleanText(requestKey, 100) || `kiosk-topup-plan:${visit.id}`;
  const overview = await prepareParticipantTopUpPlan({
    reservationId,
    expectedAdultCount: Number(topUp.expectedAdultCount),
    expectedYouthCount: Number(topUp.expectedYouthCount),
    additionalAdultCount: Number(topUp.additionalAdultCount),
    additionalYouthCount: Number(topUp.additionalYouthCount),
    mode: paymentMode,
    count: paymentMode === "equal" ? selectedPaymentItems.length : undefined,
    paymentMethod: selectedPaymentItems[0]?.paymentMethod || "card",
    items: paymentMode === "single" ? undefined : selectedPaymentItems,
    requestKey: planRequestKey,
    requestedBy: `kiosk:${visit.kiosk_id || "main"}`,
    traceId: `KIOSK-TOPUP-${visit.id}`,
  });
  const markerPrefix = `KIOSK_PARTICIPANT_TOP_UP:${planRequestKey}:`;
  const appendedPlan = overview.plan.filter((item) => item.operatorNote.startsWith(markerPrefix));
  const firstSplitIndex = appendedPlan.length
    ? Math.min(...appendedPlan.map((item) => item.splitIndex))
    : Math.max(1, Number(overview.payment?.splitCount || 1) - selectedPaymentItems.length + 1);
  const settlement = json<Record<string, unknown>>(visit.settlement_json, {});
  await getD1().prepare(`UPDATE customer_visits SET status = 'PAYMENT_PENDING', settlement_json = ?,
      error_code = '', error_message = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(JSON.stringify({
      ...settlement,
      participantTopUp: { ...topUp, firstSplitIndex },
    }), visit.id).run();
  const next = overview.plan.find((item) => !["APPROVED", "COMPLETED"].includes(item.status));
  if (!next) {
    const startToken = await markVisitAfterPayment(visit.id, reservationId);
    return { visit: await getKioskVisit(token), overview, attempt: null, startToken };
  }
  const pendingCustomerPayments = overview.plan.filter(
    (item) => !["APPROVED", "COMPLETED"].includes(item.status),
  );
  if (pendingCustomerPayments.length > 1) {
    return { visit: await getKioskVisit(token), overview, attempt: null, startToken: "" };
  }
  if (["cash", "account"].includes(next.paymentMethod)) {
    await markVisitWaitingForStaff(visit, next);
    const transfer = next.paymentMethod === "account" && overview.payment
      ? await ensureKioskBankTransferSession({
          visitId: visit.id,
          reservationId,
          paymentId: overview.payment.id,
          transactionId: next.id,
          amount: next.amount,
        })
      : null;
    return { visit: await getKioskVisit(token), overview, attempt: null, startToken: "", transfer };
  }
  await cardReady();
  const attempt = await processPaymentTransaction({
    reservationId,
    transactionId: next.id,
    requestKey: `kiosk-topup-pay:${visit.id}:${next.splitIndex}`,
    requestedBy: `kiosk:${visit.kiosk_id || "main"}`,
    traceId: `KIOSK-TOPUP-${visit.id}`,
  });
  return {
    visit: await getKioskVisit(token),
    overview: await getPaymentOverview(reservationId),
    attempt,
    startToken: "",
  };
}

export async function startKioskCheckout(
  token: string,
  requestKey: string,
  requestedPaymentItems?: Array<{ amount?: unknown; paymentMethod?: unknown }>,
  requestedPaymentMode?: string,
) {
  let visit = await visitForToken(token);
  if (!['DRAFT', 'HOLD', 'PAYMENT_PENDING'].includes(visit.status)) throw new Error("KIOSK_CHECKOUT_INVALID_STATE");
  if (visit.flow_type === "PARTY_TOP_UP") {
    return startKioskParticipantTopUpCheckout(
      token,
      visit,
      requestKey,
      requestedPaymentItems,
      requestedPaymentMode ?? "single",
    );
  }
  const kioskPaymentSettings = await getKioskPaymentSettings();
  const preflightSettlement = json<{
    benefit?: { type?: string };
    passBenefit?: { id?: string };
    couponBenefit?: { id?: string };
  }>(visit.settlement_json, {});
  if (preflightSettlement.passBenefit?.id || preflightSettlement.benefit?.type === "pass") {
    assertKioskPaymentMethodEnabled(kioskPaymentSettings, "pass");
  }
  if (preflightSettlement.couponBenefit?.id || preflightSettlement.benefit?.type === "coupon") {
    assertKioskPaymentMethodEnabled(kioskPaymentSettings, "coupon");
  }
  const requestedMethods = Array.isArray(requestedPaymentItems)
    ? requestedPaymentItems
      .filter((item) => Math.max(0, Math.trunc(Number(item.amount) || 0)) > 0)
      .map((item) => String(item.paymentMethod ?? "").trim().toLowerCase())
    : [];
  requestedMethods.forEach((method) => assertKioskPaymentMethodEnabled(kioskPaymentSettings, method));
  const createdReservationGroup = await createReservationsForVisit(visit);
  let reservation = createdReservationGroup.primary;
  const reservationIds = createdReservationGroup.reservations.map((item) => item.id);
  if (visit.flow_type !== "ADD_ON_ONLY" && reservation.vehicleLast4) {
    await queueAutomaticParkingRegistration(reservation, `kiosk:${visit.kiosk_id || "main"}`);
  }
  visit = await visitForToken(token);
  if (visit.representative_member_id && createdReservationGroup.reservations.some((item) => item.memberId !== visit.representative_member_id)) {
    await getD1().batch(reservationIds.map((reservationId) => getD1().prepare(`UPDATE reservations SET member_id = ?,
      customer_name = CASE WHEN customer_name = '' THEN ? ELSE customer_name END,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(visit.representative_member_id, visit.customer_name, reservationId)));
    reservation = (await getReservationById(reservation.id))!;
  }
  type BenefitSelection = { type?: string; id?: string; ownerId?: string; uses?: number; discount?: number };
  const settlement = json<{
    benefit?: BenefitSelection;
    passBenefit?: BenefitSelection;
    couponBenefit?: BenefitSelection;
    stampEligibleCount?: number;
  }>(visit.settlement_json, {});
  const passBenefit = settlement.passBenefit ?? (settlement.benefit?.type === "pass" ? settlement.benefit : null);
  const couponBenefit = settlement.couponBenefit ?? (settlement.benefit?.type === "coupon" ? settlement.benefit : null);
  const benefitOwnerId = passBenefit?.ownerId || couponBenefit?.ownerId || "";
  if (benefitOwnerId && reservation.memberId !== benefitOwnerId) {
    await getD1().batch(reservationIds.map((reservationId) => getD1().prepare(`UPDATE reservations SET member_id = ?,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(benefitOwnerId, reservationId)));
    reservation = (await getReservationById(reservation.id))!;
  }
  if (passBenefit?.id) {
    const existingUse = await getD1().prepare(`SELECT id FROM pass_ledger WHERE reservation_id = ? AND type = 'USE' LIMIT 1`)
      .bind(reservation.id).first();
    if (!existingUse) {
      await redeemMemberPass(passBenefit.id, reservation.id, "customer-kiosk", passBenefit.uses ?? 1);
      reservation = (await getReservationById(reservation.id))!;
    }
  }
  const addOns = json<AddOnSaleSelectionInput>(visit.add_ons_json, { slush: 0, beverage: 0, other: 0, items: [] });
  const coupon = couponBenefit;
  const couponAmount = coupon ? Math.max(0, Math.min(Number(coupon.discount) || 0, reservation.baseAmount)) : 0;
  const addOnOnly = visit.flow_type === "ADD_ON_ONLY";
  const pricing = await getPricingSettings();
  const grossPayable = addOnOnly
    ? Math.max(0, reservation.baseAmount - reservation.discountAmount)
    : Math.max(0, visit.base_amount + visit.add_on_amount - visit.discount_amount);
  const depositAmount = reservation.source === "naver"
    ? Math.min(pricing.naverDepositAmount, Math.max(0, grossPayable - (addOnOnly ? 0 : visit.add_on_amount)))
    : 0;
  const terminalOrManualDue = Math.max(0, grossPayable - depositAmount - couponAmount);
  const selectedPaymentItems = normalizeKioskPaymentItems(terminalOrManualDue, requestedPaymentItems);
  selectedPaymentItems.forEach((item) => assertKioskPaymentMethodEnabled(kioskPaymentSettings, item.paymentMethod));
  const requestedMode = ["single", "equal", "custom"].includes(String(requestedPaymentMode))
    ? String(requestedPaymentMode) as "single" | "equal" | "custom"
    : "single";
  const paymentMode = coupon ? "custom" : requestedMode;
  const items = [
    ...(coupon ? [{ amount: couponAmount, paymentMethod: "coupon", memberCouponId: coupon.id }] : []),
    ...selectedPaymentItems,
  ];
  if (visit.representative_member_id && !addOnOnly) {
    let excludedParticipants = Math.max(0, Math.trunc(Number(passBenefit?.uses) || 0)) + (couponBenefit?.id ? 1 : 0);
    const allocationStatements = createdReservationGroup.reservations.flatMap((item) => {
      const excludedForGame = Math.min(visit.party_count, excludedParticipants);
      excludedParticipants -= excludedForGame;
      const stampQuantity = Math.max(0, visit.party_count - excludedForGame);
      if (stampQuantity < 1) return [];
      return [getD1().prepare(`INSERT INTO customer_stamp_allocations
        (id, visit_id, member_id, quantity, status, reference_key)
        VALUES (?, ?, ?, ?, 'PENDING', ?)
        ON CONFLICT(reference_key) DO UPDATE SET quantity = excluded.quantity, updated_at = CURRENT_TIMESTAMP`)
        .bind(crypto.randomUUID(), visit.id, visit.representative_member_id, stampQuantity,
          `kiosk-stamp:${visit.id}:${item.id}:${visit.representative_member_id}`)];
    });
    if (allocationStatements.length) await getD1().batch(allocationStatements);
  }
  await getD1().prepare(`UPDATE customer_visits SET status = 'PAYMENT_PENDING', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(visit.id).run();
  const overview = await preparePaymentPlan({
    reservationId: reservation.id,
    reservationIds,
    addOnAmount: addOnOnly ? 0 : visit.add_on_amount,
    discountAmount: reservation.discountAmount,
    mode: paymentMode,
    count: paymentMode === "equal" ? selectedPaymentItems.length : undefined,
    paymentMethod: selectedPaymentItems[0]?.paymentMethod || "card",
    items: paymentMode === "single" ? undefined : items.length ? items : undefined,
    addOnSale: !addOnOnly && visit.add_on_amount > 0 ? addOns : undefined,
    requestKey: cleanText(requestKey, 100) || `kiosk-plan:${visit.id}`,
    requestedBy: `kiosk:${visit.kiosk_id || "main"}`,
  });
  if (visit.add_on_amount > 0 || addOnOnly) await syncKioskAddOnSummary(reservation.id, addOns);
  let current = overview;
  for (let index = 0; index < 5; index += 1) {
    let next = current.plan.find((item) => !["APPROVED", "COMPLETED"].includes(item.status));
    if (!next) break;
    const pendingCustomerPayments = current.plan.filter(
      (item) => item.paymentMethod !== "coupon" && !["APPROVED", "COMPLETED"].includes(item.status),
    );
    if (next.paymentMethod !== "coupon" && pendingCustomerPayments.length > 1) {
      return { visit: await getKioskVisit(token), overview: current, attempt: null, startToken: "" };
    }
    if (KIOSK_AUTOMATIC_RETRYABLE_PAYMENT_STATES.has(next.status)) {
      await preparePaymentTransactionRetry({
        reservationId: reservation.id,
        transactionId: next.id,
        paymentMethod: next.paymentMethod,
        requestKey: `kiosk-retry:${cleanText(requestKey, 80) || visit.id}:${next.splitIndex}`,
        requestedBy: `kiosk:${visit.kiosk_id || "main"}`,
        traceId: `KIOSK-${visit.id}`,
      });
      current = await getPaymentOverview(reservation.id);
      next = current.plan.find((item) => !["APPROVED", "COMPLETED"].includes(item.status));
      if (!next) break;
    }
    if (["cash", "account"].includes(next.paymentMethod)) {
      await markVisitWaitingForStaff(visit, next);
      const transfer = next.paymentMethod === "account" && current.payment
        ? await ensureKioskBankTransferSession({
            visitId: visit.id,
            reservationId: reservation.id,
            paymentId: current.payment.id,
            transactionId: next.id,
            amount: next.amount,
          })
        : null;
      return { visit: await getKioskVisit(token), overview: current, attempt: null, startToken: "", transfer };
    }
    if (next.paymentMethod === "card") await cardReady();
    const attempt = await processPreparedPaymentTransaction({
      reservationId: reservation.id,
      paymentId: current.payment!.id,
      transactionId: next.id,
      expectedSplitIndex: next.splitIndex,
      requestKey: `kiosk-pay:${visit.id}:${next.splitIndex}:${next.id}`,
      requestedBy: `kiosk:${visit.kiosk_id || "main"}`,
      traceId: `KIOSK-${visit.id}`,
    });
    if (next.paymentMethod === "card") return { visit: await getKioskVisit(token), overview: current, attempt, startToken: "" };
    current = await getPaymentOverview(reservation.id);
  }
  current = await getPaymentOverview(reservation.id);
  const startToken = current.payment?.status === "PAID" ? await markVisitAfterPayment(visit.id, reservation.id) : "";
  return { visit: await getKioskVisit(token), overview: current, attempt: null, startToken };
}

export async function waitKioskPayment(token: string, attemptId: string) {
  const visit = await visitForToken(token, false);
  const reservationId = paymentReservationIdForVisit(visit);
  if (!reservationId || !["PAYMENT_PENDING", "WAITING_STAFF_CONFIRMATION"].includes(visit.status)) throw new Error("KIOSK_PAYMENT_NOT_ACTIVE");
  const result = await waitForPaymentAttemptResult({ reservationId, attemptId, timeoutMs: 15_000 });
  if (!result.changed || !result.overview) return { ...result, visit: publicVisit(visit), startToken: "" };
  const overview = result.overview;
  if (overview.payment?.status === "PAID") {
    const startToken = await markVisitAfterPayment(visit.id, reservationId);
    return { changed: true, overview, visit: await getKioskVisit(token), startToken };
  }
  if (overview.summary?.hasUnknown) {
    await getD1().prepare(`UPDATE customer_visits SET status = 'STAFF_REVIEW', error_code = 'PAYMENT_UNKNOWN',
      error_message = '결제 결과를 직원이 확인하고 있습니다.', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(visit.id).run();
    deferOperationalPush({
      eventType: "KIOSK_ERROR",
      dedupKey: `kiosk-payment-unknown:${attemptId}`,
      title: "키오스크 결제 확인 필요",
      body: `${visit.room_code || "방 미지정"} · 결제 결과를 확인해주세요.`,
    });
  }
  return { changed: true, overview, visit: await getKioskVisit(token), startToken: "" };
}

const KIOSK_AUTOMATIC_RETRYABLE_PAYMENT_STATES = new Set(["DECLINED", "USER_CANCELLED", "ERROR", "UNLINKED"]);
const KIOSK_RETRYABLE_PAYMENT_STATES = new Set([...KIOSK_AUTOMATIC_RETRYABLE_PAYMENT_STATES, "BUSY"]);

export async function processKioskPayment(
  token: string,
  transactionId: string,
  requestedPaymentMethod: string,
  requestKey: string,
) {
  const visit = await visitForToken(token, false);
  const reservationId = paymentReservationIdForVisit(visit);
  if (!reservationId || !["PAYMENT_PENDING", "WAITING_STAFF_CONFIRMATION"].includes(visit.status)) {
    throw new Error("KIOSK_PAYMENT_NOT_ACTIVE");
  }
  const paymentMethod = cleanText(requestedPaymentMethod, 20).toLowerCase();
  if (!["card", "cash", "account"].includes(paymentMethod)) throw new Error("KIOSK_PAYMENT_ITEMS_INVALID");
  const kioskPaymentSettings = await getKioskPaymentSettings();
  assertKioskPaymentMethodEnabled(kioskPaymentSettings, paymentMethod);
  const normalizedRequestKey = cleanText(requestKey, 80);
  if (!normalizedRequestKey) throw new Error("PAYMENT_REQUEST_KEY_REQUIRED");

  let overview = await getPaymentOverview(reservationId);
  let next = overview.plan.find((item) => !["APPROVED", "COMPLETED"].includes(item.status));
  if (!next || next.id !== transactionId || next.paymentMethod === "coupon") {
    throw new Error("PAYMENT_TRANSACTION_OUT_OF_ORDER");
  }

  if (KIOSK_RETRYABLE_PAYMENT_STATES.has(next.status)) {
    await preparePaymentTransactionRetry({
      reservationId,
      transactionId: next.id,
      paymentMethod,
      requestKey: `kiosk-retry:${normalizedRequestKey}`,
      requestedBy: `kiosk:${visit.kiosk_id || "main"}`,
      traceId: `KIOSK-${visit.id}`,
    });
    overview = await getPaymentOverview(reservationId);
    next = overview.plan.find((item) => !["APPROVED", "COMPLETED"].includes(item.status));
  } else if (next.status !== "PENDING") {
    throw new Error("PAYMENT_TRANSACTION_NOT_PENDING");
  }

  if (!next) throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");
  const previousPaymentMethod = next.paymentMethod;
  if (next.paymentMethod !== paymentMethod) {
    await changePendingPaymentTransactionMethod({
      reservationId,
      transactionId: next.id,
      paymentMethod,
      requestedBy: `kiosk:${visit.kiosk_id || "main"}`,
    });
    overview = await getPaymentOverview(reservationId);
    next = overview.plan.find((item) => !["APPROVED", "COMPLETED"].includes(item.status));
    if (previousPaymentMethod === "account" && paymentMethod !== "account") {
      await setKioskBankTransferSessionStatus(transactionId, "CANCELLED");
    }
  }
  if (!next) throw new Error("PAYMENT_ATTEMPT_NOT_FOUND");

  if (["cash", "account"].includes(next.paymentMethod)) {
    await markVisitWaitingForStaff(visit, next);
    const transfer = next.paymentMethod === "account" && overview.payment
      ? await ensureKioskBankTransferSession({
          visitId: visit.id,
          reservationId,
          paymentId: overview.payment.id,
          transactionId: next.id,
          amount: next.amount,
        })
      : null;
    return { visit: await getKioskVisit(token), overview, attempt: null, startToken: "", transfer };
  }

  await cardReady();
  await getD1().prepare(`UPDATE customer_visits SET status = 'PAYMENT_PENDING', error_code = '', error_message = '',
    updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(visit.id).run();
  const attempt = await processPaymentTransaction({
    reservationId,
    transactionId: next.id,
    requestKey: `kiosk-process:${normalizedRequestKey}`,
    requestedBy: `kiosk:${visit.kiosk_id || "main"}`,
    traceId: `KIOSK-${visit.id}`,
  });
  return { visit: await getKioskVisit(token), overview: await getPaymentOverview(reservationId), attempt, startToken: "" };
}

export async function getKioskRuntimeState(token: string) {
  const visit = await visitForToken(token, false);
  const reservationId = paymentReservationIdForVisit(visit);
  const overview = reservationId && ["PAYMENT_PENDING", "WAITING_STAFF_CONFIRMATION"].includes(visit.status)
    ? await getPaymentOverview(reservationId)
    : null;
  const next = overview?.plan.find((item) => !["APPROVED", "COMPLETED"].includes(item.status));
  const transfer = next?.paymentMethod === "account"
    ? await getKioskBankTransferSessionForTransaction(next.id)
    : null;
  return { visit: publicVisit(visit), overview, transfer };
}

async function recordVisitOperatorAction(
  visit: VisitRow,
  eventType: string,
  requestedBy: string,
  details: Record<string, unknown> = {},
) {
  const reservationId = paymentReservationIdForVisit(visit);
  if (!reservationId) return;
  await getD1().prepare(`INSERT INTO reservation_events
    (id, reservation_id, event_type, details_json, created_by)
    VALUES (?, ?, ?, ?, ?)`)
    .bind(crypto.randomUUID(), reservationId, eventType, JSON.stringify({
      visitId: visit.id,
      roomCode: visit.room_code,
      ...details,
    }), cleanText(requestedBy, 120)).run();
}

type KioskCleanupFactRow = VisitRow & {
  active_hold_count: number;
  approved_payment_count: number;
  paid_payment_count: number;
  paid_reservation_count: number;
  game_record_count: number;
  sales_count: number;
  pass_ledger_count: number;
  coupon_ledger_count: number;
  stamp_ledger_count: number;
  visit_stamp_allocation_count: number;
  bank_transfer_session_count: number;
};

function cleanupFacts(row: KioskCleanupFactRow): KioskVisitCleanupFacts {
  return {
    status: row.status,
    flowType: row.flow_type,
    reservationId: row.reservation_id ?? "",
    startedAt: row.started_at ?? "",
    completedAt: row.completed_at ?? "",
    activeHoldCount: Number(row.active_hold_count) || 0,
    approvedPaymentCount: Number(row.approved_payment_count) || 0,
    paidPaymentCount: Number(row.paid_payment_count) || 0,
    paidReservationCount: Number(row.paid_reservation_count) || 0,
    gameRecordCount: Number(row.game_record_count) || 0,
    salesCount: Number(row.sales_count) || 0,
    passLedgerCount: Number(row.pass_ledger_count) || 0,
    couponLedgerCount: Number(row.coupon_ledger_count) || 0,
    stampLedgerCount: Number(row.stamp_ledger_count) || 0,
    visitStampAllocationCount: Number(row.visit_stamp_allocation_count) || 0,
    bankTransferSessionCount: Number(row.bank_transfer_session_count) || 0,
  };
}

async function loadKioskCleanupFactRow(visitId: string) {
  return getD1().prepare(`SELECT v.*,
      (SELECT COUNT(*) FROM customer_room_holds h WHERE h.visit_id = v.id AND h.state = 'ACTIVE') AS active_hold_count,
      (SELECT COUNT(*) FROM payment_attempts pa WHERE pa.reservation_id = v.reservation_id
        AND pa.attempt_type = 'PAY' AND pa.status IN ('APPROVED', 'COMPLETED')) AS approved_payment_count,
      (SELECT COUNT(*) FROM payments p WHERE p.reservation_id = v.reservation_id AND p.status = 'PAID') AS paid_payment_count,
      (SELECT COUNT(*) FROM reservations r WHERE r.id = v.reservation_id
        AND (r.payment_status = 'paid' OR r.payment_card_amount > 0 OR r.payment_cash_amount > 0 OR r.payment_account_amount > 0)) AS paid_reservation_count,
      (SELECT COUNT(*) FROM game_records g WHERE g.reservation_id = v.reservation_id) AS game_record_count,
      ((SELECT COUNT(*) FROM add_on_sale_orders ao WHERE ao.reservation_id = v.reservation_id AND ao.status = 'PAID') +
       (SELECT COUNT(*) FROM pass_purchase_orders po WHERE (po.reservation_id = v.reservation_id OR po.credit_reservation_id = v.reservation_id)
         AND po.status IN ('PAID', 'REFUND_REVIEW'))) AS sales_count,
      (SELECT COUNT(*) FROM pass_ledger pl WHERE pl.reservation_id = v.reservation_id) AS pass_ledger_count,
      (SELECT COUNT(*) FROM member_coupons mc WHERE mc.used_reservation_id = v.reservation_id) AS coupon_ledger_count,
      (SELECT COUNT(*) FROM stamp_ledger sl WHERE sl.reservation_id = v.reservation_id) AS stamp_ledger_count,
      (SELECT COUNT(*) FROM customer_stamp_allocations ca WHERE ca.visit_id = v.id) AS visit_stamp_allocation_count,
      (SELECT COUNT(*) FROM kiosk_bank_transfer_sessions bt WHERE bt.visit_id = v.id) AS bank_transfer_session_count
    FROM customer_visits v WHERE v.id = ? LIMIT 1`)
    .bind(cleanText(visitId, 80)).first<KioskCleanupFactRow>();
}

export async function getKioskVisitAdminDetails(visitId: string) {
  await ensureKioskSchema();
  const row = await loadKioskCleanupFactRow(visitId);
  if (!row) throw new Error("키오스크 진행 건을 찾지 못했습니다.");
  const [hold, audit] = await Promise.all([
    getD1().prepare(`SELECT * FROM customer_room_holds WHERE visit_id = ? ORDER BY created_at DESC LIMIT 1`)
      .bind(row.id).first<HoldRow>(),
    getD1().prepare(`SELECT action, previous_status, next_status, reason, created_by, created_at
      FROM kiosk_visit_admin_audit WHERE visit_id = ? ORDER BY created_at DESC LIMIT 20`)
      .bind(row.id).all<Record<string, unknown>>(),
  ]);
  const facts = cleanupFacts(row);
  return {
    visit: publicVisit(row, hold),
    management: evaluateKioskVisitCleanup(facts),
    facts,
    audit: audit.results,
  };
}

async function queueVisitCommand(visit: VisitRow, action: "set_info" | "start" | "stop", requestedBy: string) {
  const room = getRoom(visit.room_code);
  if (!room) throw new Error("KIOSK_ROOM_INVALID");
  await assertControlCommandReady(room.roomId, action);
  const duplicate = await getD1().prepare(`SELECT id FROM commands WHERE status IN ('pending', 'claimed')
    AND (room_id = ? OR room_id = 'ALL') LIMIT 1`).bind(room.roomId).first();
  if (duplicate) throw new Error("CONTROL_ROOM_BUSY");
  const id = crypto.randomUUID();
  const payload = {
    roomId: room.roomId, action, teamName: visit.team_name || "현장팀", mapIndex: visit.map_index,
    people: visit.party_count, skipPeople: true, durationMinutes: 16,
    customerVisitId: visit.id, reservationId: visit.reservation_id,
  };
  await getD1().prepare(`INSERT INTO commands
    (id, room_id, action, payload_json, status, requested_by, target_agent_id, expires_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?, ?)`)
    .bind(id, room.roomId, action, JSON.stringify(payload), requestedBy, getControlAgentId(), new Date(Date.now() + 90_000).toISOString()).run();
  return id;
}

export async function markKioskVisitReady(visitId: string, requestedBy: string) {
  await ensureKioskSchema();
  const visit = await getD1().prepare(`SELECT * FROM customer_visits WHERE id = ? LIMIT 1`).bind(visitId).first<VisitRow>();
  if (!visit || visit.status !== "PREPARING" || !visit.reservation_id) throw new Error("KIOSK_READY_INVALID_STATE");
  const commandId = await queueVisitCommand(visit, "set_info", requestedBy);
  await getD1().prepare(`UPDATE customer_visits SET error_code = '', error_message = '게임 정보를 입력하고 있습니다.',
    updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(visit.id).run();
  await recordVisitOperatorAction(visit, "remote_manager_input", requestedBy, { commandId });
  return { commandId, visit: publicVisit(visit) };
}

export async function reinputKioskVisitInfo(visitId: string, requestedBy: string) {
  await ensureKioskSchema();
  const visit = await getD1().prepare(`SELECT * FROM customer_visits WHERE id = ? LIMIT 1`)
    .bind(cleanText(visitId, 80)).first<VisitRow>();
  if (!visit?.reservation_id || !["PREPARING", "READY_TO_PLAY", "START_FAILED", "STAFF_REVIEW"].includes(visit.status)) {
    throw new Error("KIOSK_READY_INVALID_STATE");
  }
  const commandId = await queueVisitCommand(visit, "set_info", requestedBy);
  await getD1().prepare(`UPDATE customer_visits SET status = 'PREPARING', error_code = '',
    error_message = '게임 정보를 다시 입력하고 있습니다.', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(visit.id).run();
  await recordVisitOperatorAction(visit, "remote_manager_reinput", requestedBy, { commandId });
  return { commandId, visitId: visit.id, roomCode: visit.room_code };
}

export async function startKioskGame(token: string, startToken: string) {
  const visit = await visitForToken(token, false);
  if (visit.status !== "READY_TO_PLAY" || !visit.reservation_id) throw new Error("KIOSK_START_NOT_READY");
  if (!visit.start_token_expires_at || Date.parse(visit.start_token_expires_at) <= Date.now()) throw new Error("KIOSK_START_TOKEN_EXPIRED");
  if ((await sha256(cleanText(startToken, 20))) !== visit.start_token_hash) throw new Error("KIOSK_START_TOKEN_INVALID");
  const room = getRoom(visit.room_code);
  const roomState = room ? await getD1().prepare(`SELECT status FROM rooms WHERE room_id = ? LIMIT 1`).bind(room.roomId).first<{ status: string }>() : null;
  const matches = (await sha256(cleanText(startToken, 20))) === visit.start_token_hash;
  if (!roomState || !canCustomerStart({ state: visit.status, roomStatus: roomState.status,
    hasDifficulty: Boolean(visit.difficulty_code), tokenMatches: matches,
    tokenExpiresAt: Date.parse(visit.start_token_expires_at), now: Date.now() })) throw new Error("KIOSK_ROOM_NOT_READY");
  const commandId = await queueVisitCommand(visit, "start", `kiosk:${visit.kiosk_id || "main"}`);
  await getD1().prepare(`UPDATE customer_visits SET start_token_hash = '', start_token_value = '', start_token_expires_at = NULL,
    updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(visit.id).run();
  return { commandId, status: "STARTING" };
}

export async function getKioskReadyVisitForDevice(visitId: string) {
  await ensureKioskSchema();
  const visit = await getD1().prepare(`SELECT * FROM customer_visits WHERE id = ? LIMIT 1`)
    .bind(cleanText(visitId, 80)).first<VisitRow>();
  if (!visit || !["PREPARING", "READY_TO_PLAY"].includes(visit.status) || !visit.reservation_id) {
    throw new Error("KIOSK_START_NOT_READY");
  }
  return publicVisit(visit);
}

export async function startKioskGameFromDevice(visitId: string, requestedBy = "kiosk-device") {
  await ensureKioskSchema();
  const visit = await getD1().prepare(`SELECT * FROM customer_visits WHERE id = ? LIMIT 1`)
    .bind(cleanText(visitId, 80)).first<VisitRow>();
  if (!visit || visit.status !== "READY_TO_PLAY" || !visit.reservation_id) throw new Error("KIOSK_START_NOT_READY");
  const room = getRoom(visit.room_code);
  const roomState = room ? await getD1().prepare(`SELECT status FROM rooms WHERE room_id = ? LIMIT 1`)
    .bind(room.roomId).first<{ status: string }>() : null;
  if (!roomState || !canCustomerStart({
    state: visit.status,
    roomStatus: roomState.status,
    hasDifficulty: Boolean(visit.difficulty_code),
    tokenMatches: true,
    tokenExpiresAt: Date.now() + 60_000,
    now: Date.now(),
  })) throw new Error("KIOSK_ROOM_NOT_READY");
  const commandId = await queueVisitCommand(visit, "start", cleanText(requestedBy, 120) || "kiosk-device");
  await getD1().prepare(`UPDATE customer_visits SET start_token_hash = '', start_token_value = '', start_token_expires_at = NULL,
    updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(visit.id).run();
  await recordVisitOperatorAction(visit, "remote_game_start", requestedBy, { commandId });
  return { commandId, status: "STARTING", visitId: visit.id, roomCode: visit.room_code };
}

export async function stopKioskGameFromAdmin(visitId: string, requestedBy: string) {
  await ensureKioskSchema();
  const visit = await getD1().prepare(`SELECT * FROM customer_visits WHERE id = ? LIMIT 1`)
    .bind(cleanText(visitId, 80)).first<VisitRow>();
  if (!visit?.reservation_id || visit.status !== "PLAYING") throw new Error("KIOSK_STOP_INVALID_STATE");
  const room = getRoom(visit.room_code);
  const roomState = room ? await getD1().prepare(`SELECT status FROM rooms WHERE room_id = ? LIMIT 1`)
    .bind(room.roomId).first<{ status: string }>() : null;
  if (!roomState || roomState.status !== "running") throw new Error("KIOSK_STOP_INVALID_STATE");
  const commandId = await queueVisitCommand(visit, "stop", requestedBy);
  await recordVisitOperatorAction(visit, "remote_game_stop", requestedBy, { commandId });
  return { commandId, status: "STOPPING", visitId: visit.id, roomCode: visit.room_code };
}

export async function markKioskPaymentForStaffReview(visitId: string, requestedBy: string) {
  await ensureKioskSchema();
  const visit = await getD1().prepare(`SELECT * FROM customer_visits WHERE id = ? LIMIT 1`)
    .bind(cleanText(visitId, 80)).first<VisitRow>();
  if (!visit?.reservation_id || visit.status !== "WAITING_STAFF_CONFIRMATION") {
    throw new Error("KIOSK_STAFF_PAYMENT_INVALID_STATE");
  }
  await getD1().prepare(`UPDATE customer_visits SET status = 'STAFF_REVIEW', error_code = 'PAYMENT_STAFF_REVIEW',
    error_message = '현금·계좌 결제를 관리자가 확인 중입니다.', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(visit.id).run();
  await recordVisitOperatorAction(visit, "remote_payment_review", requestedBy);
  return { visitId: visit.id, status: "STAFF_REVIEW" };
}

export async function requestKioskStaffHelp(token: string) {
  const visit = await visitForToken(token, false);
  await getD1().prepare(`UPDATE customer_visits SET error_code = 'STAFF_HELP_REQUESTED',
    error_message = '고객이 직원 호출을 요청했습니다.', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(visit.id).run();
  await recordVisitOperatorAction(visit, "kiosk_staff_help", `kiosk:${visit.kiosk_id || "main"}`);
  deferOperationalPush({
    eventType: "KIOSK_STAFF_HELP",
    dedupKey: `kiosk-staff-help:${visit.id}:${Math.floor(Date.now() / 30_000)}`,
    title: "직원 호출",
    body: `${visit.room_code || "방 미지정"} · 고객이 도움을 요청했습니다.`,
  });
  return { ok: true, visitId: visit.id };
}

export async function listKioskOperations() {
  await ensureKioskSchema();
  await expireKioskRows();
  const [visits, holds, products, guidance, roomRecommendationRules, displaySettings] = await Promise.all([
    getD1().prepare(`SELECT * FROM customer_visits
      WHERE updated_at > datetime('now', '-7 days') ORDER BY updated_at DESC LIMIT 200`).all<VisitRow>(),
    getD1().prepare(`SELECT * FROM customer_room_holds WHERE created_at > datetime('now', '-7 days')
      ORDER BY created_at DESC LIMIT 200`).all<HoldRow>(),
    getKioskCatalog(true),
    getKioskGuidance(true),
    getKioskRoomRecommendationRules(true),
    getKioskDisplaySettings(),
  ]);
  const holdMap = new Map(holds.results.map((item) => [item.visit_id, item]));
  const publicVisits = await Promise.all(visits.results.map(async (item) => {
    let pendingPayment: null | { transactionId: string; paymentId: string; splitIndex: number; paymentMethod: string; amount: number; depositorGuide: string } = null;
    if (item.status === "WAITING_STAFF_CONFIRMATION" && item.reservation_id) {
      const overview = await getPaymentOverview(item.reservation_id);
      const next = overview.plan.find((transaction) => !["APPROVED", "COMPLETED"].includes(transaction.status));
      if (next && overview.payment && ["cash", "account"].includes(next.paymentMethod)) {
        const transfer = next.paymentMethod === "account"
          ? await getKioskBankTransferSessionForTransaction(next.id)
          : null;
        pendingPayment = {
          transactionId: next.id, paymentId: overview.payment.id, splitIndex: next.splitIndex,
          paymentMethod: next.paymentMethod, amount: next.amount,
          depositorGuide: transfer?.depositorGuide ?? "",
        };
      }
    }
    const isTest = item.flow_type === "KIOSK_TEST";
    const isTemporary = !item.reservation_id && ["DRAFT", "HOLD", "CANCELLED", "EXPIRED", "ABANDONED"].includes(item.status);
    return {
      ...publicVisit(item, holdMap.get(item.id)),
      pendingPayment,
      management: {
        isTest,
        isTemporary,
        canTerminate: !["PLAYING", "COMPLETED", "CANCELLED", "EXPIRED", "ABANDONED"].includes(item.status),
        canReleaseHold: holdMap.get(item.id)?.state === "ACTIVE",
        deleteCandidate: isTest || isTemporary,
      },
    };
  }));
  return { visits: publicVisits, holds: holds.results, products, guidance, roomRecommendationRules, displaySettings };
}

export async function terminateKioskVisit(visitId: string, requestedBy: string, reason = "관리자 진행 종료") {
  await ensureKioskSchema();
  const row = await loadKioskCleanupFactRow(visitId);
  if (!row) throw new Error("키오스크 진행 건을 찾지 못했습니다.");
  const decision = evaluateKioskVisitCleanup(cleanupFacts(row));
  if (!decision.canTerminate) {
    throw new Error(row.status === "PLAYING"
      ? "게임 진행 중인 건은 정지 처리 후 종료할 수 있습니다."
      : "이미 완료 또는 종료된 진행 건입니다.");
  }
  const cleanedReason = cleanText(reason, 300) || "관리자 진행 종료";
  await getD1().batch([
    getD1().prepare(`UPDATE customer_room_holds SET state = 'CANCELLED', active_slot_key = NULL,
      updated_at = CURRENT_TIMESTAMP WHERE visit_id = ? AND state = 'ACTIVE'`).bind(row.id),
    getD1().prepare(`UPDATE commands SET status = 'expired', result = '키오스크 진행 종료', completed_at = CURRENT_TIMESTAMP
      WHERE status = 'pending' AND json_extract(payload_json, '$.customerVisitId') = ?`).bind(row.id),
    getD1().prepare(`UPDATE kiosk_runtime SET current_visit_id = '', updated_at = CURRENT_TIMESTAMP
      WHERE current_visit_id = ?`).bind(row.id),
    getD1().prepare(`UPDATE customer_visits SET status = 'ABANDONED', start_token_hash = '', start_token_value = '',
      start_token_expires_at = NULL, error_code = 'ADMIN_TERMINATED', error_message = ?, expires_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(cleanedReason, row.id),
    getD1().prepare(`INSERT INTO kiosk_visit_admin_audit
      (id, visit_id, reservation_id, action, previous_status, next_status, reason, details_json, created_by)
      VALUES (?, ?, ?, 'TERMINATE', ?, 'ABANDONED', ?, ?, ?)`)
      .bind(crypto.randomUUID(), row.id, row.reservation_id ?? "", row.status, cleanedReason,
        JSON.stringify({ holdReleased: decision.canReleaseHold }), cleanText(requestedBy, 120)),
  ]);
  return listKioskOperations();
}

export async function deleteKioskTestVisit(visitId: string, requestedBy: string, reason = "테스트 데이터 정리") {
  await ensureKioskSchema();
  const row = await loadKioskCleanupFactRow(visitId);
  if (!row) throw new Error("키오스크 진행 건을 찾지 못했습니다.");
  const decision = evaluateKioskVisitCleanup(cleanupFacts(row));
  if (!decision.canHardDelete) throw new Error(decision.deleteBlockReason || "삭제할 수 없는 진행 건입니다.");
  const cleanedReason = cleanText(reason, 300) || "테스트 데이터 정리";
  await hardDeleteKioskVisitRow(row, decision.isTest, decision.isTemporary, requestedBy, cleanedReason);
  return listKioskOperations();
}

async function hardDeleteKioskVisitRow(
  row: KioskCleanupFactRow,
  isTest: boolean,
  isTemporary: boolean,
  requestedBy: string,
  reason: string,
) {
  await getD1().batch([
    getD1().prepare(`INSERT INTO kiosk_visit_admin_audit
      (id, visit_id, reservation_id, action, previous_status, next_status, reason, details_json, created_by)
      VALUES (?, ?, '', 'HARD_DELETE', ?, 'DELETED', ?, ?, ?)`)
      .bind(crypto.randomUUID(), row.id, row.status, reason,
        JSON.stringify({ flowType: row.flow_type, temporary: isTemporary, test: isTest }),
        cleanText(requestedBy, 120)),
    getD1().prepare(`UPDATE kiosk_runtime SET current_visit_id = '', updated_at = CURRENT_TIMESTAMP
      WHERE current_visit_id = ?`).bind(row.id),
    getD1().prepare(`DELETE FROM customer_visit_members WHERE visit_id = ?`).bind(row.id),
    getD1().prepare(`DELETE FROM customer_room_holds WHERE visit_id = ?`).bind(row.id),
    getD1().prepare(`DELETE FROM customer_visits WHERE id = ?`).bind(row.id),
  ]);
}

async function getKioskCleanupCandidates() {
  const rows = await getD1().prepare(`SELECT id FROM customer_visits
    WHERE flow_type = 'KIOSK_TEST'
       OR (reservation_id IS NULL AND status IN ('CANCELLED', 'EXPIRED', 'ABANDONED'))
    ORDER BY updated_at LIMIT 300`).all<{ id: string }>();
  const candidates = (await Promise.all(rows.results.map((item) => loadKioskCleanupFactRow(item.id))))
    .filter((item): item is KioskCleanupFactRow => Boolean(item));
  return candidates.map((row) => {
    const decision = evaluateKioskVisitCleanup(cleanupFacts(row));
    return { row, decision };
  });
}

export async function previewKioskCleanup() {
  await ensureKioskSchema();
  const [expiredHolds, expiredSessions, candidates] = await Promise.all([
    getD1().prepare(`SELECT COUNT(*) AS count FROM customer_room_holds
      WHERE state = 'ACTIVE' AND datetime(expires_at) <= CURRENT_TIMESTAMP`).first<{ count: number }>(),
    getD1().prepare(`SELECT COUNT(*) AS count FROM customer_visits
      WHERE status IN ('DRAFT', 'HOLD') AND datetime(expires_at) <= CURRENT_TIMESTAMP`).first<{ count: number }>(),
    getKioskCleanupCandidates(),
  ]);
  return {
    expiredHolds: Number(expiredHolds?.count) || 0,
    expiredSessions: Number(expiredSessions?.count) || 0,
    safeDelete: candidates.filter((item) => item.decision.canHardDelete).length,
    protected: candidates.filter((item) => !item.decision.canHardDelete).length,
  };
}

export async function runKioskBulkCleanup(requestedBy: string, reason = "관리자 일괄 정리") {
  await ensureKioskSchema();
  const before = await previewKioskCleanup();
  await expireKioskRows();
  const candidates = await getKioskCleanupCandidates();
  let deleted = 0;
  for (const { row, decision } of candidates) {
    if (!decision.canHardDelete) continue;
    await hardDeleteKioskVisitRow(
      row, decision.isTest, decision.isTemporary, requestedBy,
      cleanText(reason, 300) || "관리자 일괄 정리",
    );
    deleted += 1;
  }
  return { ...(await listKioskOperations()), cleanupResult: { ...before, deleted } };
}

export async function confirmKioskManualPayment(visitId: string, transactionId: string, requestedBy: string) {
  await ensureKioskSchema();
  const visit = await getD1().prepare(`SELECT * FROM customer_visits WHERE id = ? LIMIT 1`).bind(visitId).first<VisitRow>();
  const reservationId = visit ? paymentReservationIdForVisit(visit) : "";
  if (!visit || !reservationId || visit.status !== "WAITING_STAFF_CONFIRMATION") throw new Error("KIOSK_STAFF_PAYMENT_INVALID_STATE");
  const overview = await getPaymentOverview(reservationId);
  const next = overview.plan.find((item) => !["APPROVED", "COMPLETED"].includes(item.status));
  if (!next || next.id !== transactionId || !overview.payment || !["cash", "account"].includes(next.paymentMethod)) {
    throw new Error("KIOSK_STAFF_PAYMENT_NOT_FOUND");
  }
  await processPaymentTransaction({
    reservationId,
    transactionId: next.id,
    requestKey: `kiosk-staff:${visit.id}:${next.id}`,
    requestedBy,
    traceId: `KIOSK-STAFF-${visit.id}`,
  });
  if (next.paymentMethod === "account") {
    await setKioskBankTransferSessionStatus(next.id, "CONFIRMED");
  }
  const updated = await getPaymentOverview(reservationId);
  if (updated.payment?.status === "PAID") await markVisitAfterPayment(visit.id, reservationId);
  else await getD1().prepare(`UPDATE customer_visits SET status = 'PAYMENT_PENDING', error_code = '', error_message = '',
    updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(visit.id).run();
  await recordVisitOperatorAction(visit, "remote_payment_confirm", requestedBy, {
    transactionId: next.id,
    paymentMethod: next.paymentMethod,
    amount: next.amount,
  });
  return listKioskOperations();
}

export async function forceReleaseKioskHold(visitId: string, requestedBy: string) {
  await ensureKioskSchema();
  const visit = await getD1().prepare(`SELECT * FROM customer_visits WHERE id = ? LIMIT 1`)
    .bind(cleanText(visitId, 80)).first<VisitRow>();
  if (!visit) throw new Error("키오스크 진행 건을 찾지 못했습니다.");
  const hold = await getD1().prepare(`SELECT id FROM customer_room_holds WHERE visit_id = ? AND state = 'ACTIVE' LIMIT 1`)
    .bind(visit.id).first<{ id: string }>();
  if (!hold) throw new Error("해제할 활성 홀드가 없습니다.");
  const nextStatus = visit.status === "HOLD" ? "CANCELLED" : visit.status;
  await getD1().batch([
    getD1().prepare(`UPDATE customer_room_holds SET state = 'CANCELLED', active_slot_key = NULL,
      updated_at = CURRENT_TIMESTAMP WHERE visit_id = ? AND state = 'ACTIVE'`).bind(visitId),
    getD1().prepare(`UPDATE customer_visits SET status = CASE WHEN status = 'HOLD' THEN 'CANCELLED' ELSE status END,
      error_code = CASE WHEN status = 'HOLD' THEN 'ADMIN_RELEASED' ELSE error_code END,
      error_message = CASE WHEN status = 'HOLD' THEN ? ELSE error_message END, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(`${requestedBy} 관리자가 홀드를 해제했습니다.`, visit.id),
    getD1().prepare(`INSERT INTO kiosk_visit_admin_audit
      (id, visit_id, reservation_id, action, previous_status, next_status, reason, details_json, created_by)
      VALUES (?, ?, ?, 'RELEASE_HOLD', ?, ?, '관리자 홀드 해제', ?, ?)`)
      .bind(crypto.randomUUID(), visit.id, visit.reservation_id ?? "", visit.status, nextStatus,
        JSON.stringify({ holdId: hold.id }), cleanText(requestedBy, 120)),
  ]);
  return listKioskOperations();
}

export async function setKioskProductStatus(productCode: string, status: string, requestedBy: string) {
  await ensureKioskSchema();
  if (!['SALE', 'SOLD_OUT', 'HIDDEN'].includes(status)) throw new Error("KIOSK_PRODUCT_STATUS_INVALID");
  const catalog = await getKioskCatalog(true);
  if (!catalog.some((item) => item.code === productCode) && status !== 'SALE') {
    const pricing = await getPricingSettings();
    const known = ['slush', 'beverage', 'other', ...pricing.extraAddOnItems.map((item) => item.code)];
    if (!known.includes(productCode)) throw new Error("KIOSK_PRODUCT_NOT_FOUND");
  }
  await getD1().prepare(`INSERT INTO customer_product_availability (product_code, status, updated_by, updated_at)
    VALUES (?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(product_code) DO UPDATE SET status = excluded.status,
    updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`)
    .bind(productCode, status, requestedBy).run();
  return listKioskOperations();
}

export async function saveKioskProduct(input: {
  productCode?: string; name: string; price: unknown; requestedBy: string;
}) {
  await ensureKioskSchema();
  const name = cleanText(input.name, 40);
  const price = clamp(input.price, 0, 10_000_000);
  if (!name) throw new Error("KIOSK_PRODUCT_NAME_REQUIRED");
  const pricing = await getPricingSettings();
  const fixedCodes = ["slush", "beverage", "other"];
  const productCode = cleanText(input.productCode, 40).toLowerCase() || `item-${crypto.randomUUID().slice(0, 8)}`;
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/.test(productCode)) throw new Error("KIOSK_PRODUCT_CODE_INVALID");
  const existingIndex = pricing.extraAddOnItems.findIndex((item) => item.code === productCode);
  if (!fixedCodes.includes(productCode) && existingIndex < 0 && pricing.extraAddOnItems.length >= 30) {
    throw new Error("KIOSK_PRODUCT_LIMIT");
  }
  const nextPricing = {
    ...pricing,
    slushPrice: productCode === "slush" ? price : pricing.slushPrice,
    beveragePrice: productCode === "beverage" ? price : pricing.beveragePrice,
    otherPrice: productCode === "other" ? price : pricing.otherPrice,
    extraAddOnItems: fixedCodes.includes(productCode)
      ? pricing.extraAddOnItems.map((item) => ({ ...item }))
      : existingIndex >= 0
        ? pricing.extraAddOnItems.map((item) => item.code === productCode ? { ...item, name, price, active: true } : { ...item })
        : [...pricing.extraAddOnItems.map((item) => ({ ...item })), { code: productCode, name, price, active: true }],
  };
  await updatePricingSettings(nextPricing, input.requestedBy);
  const currentOrder = await getD1().prepare(`SELECT COALESCE(MAX(sort_order), 0) AS value FROM customer_product_overrides`)
    .first<{ value: number }>();
  await getD1().batch([
    getD1().prepare(`INSERT INTO customer_product_overrides (product_code, name, sort_order, updated_by, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(product_code) DO UPDATE SET name = excluded.name,
      updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`)
      .bind(productCode, name, Math.max(10, Number(currentOrder?.value) + 10), input.requestedBy),
    getD1().prepare(`INSERT INTO customer_product_availability (product_code, status, updated_by, updated_at)
      VALUES (?, 'SALE', ?, CURRENT_TIMESTAMP) ON CONFLICT(product_code) DO UPDATE SET
      status = CASE WHEN status = 'HIDDEN' THEN 'SALE' ELSE status END, updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`)
      .bind(productCode, input.requestedBy),
  ]);
  return listKioskOperations();
}

export async function moveKioskProduct(productCode: string, direction: number, requestedBy: string) {
  await ensureKioskSchema();
  const products = await getKioskCatalog(true);
  const index = products.findIndex((item) => item.code === productCode);
  const targetIndex = index + (direction < 0 ? -1 : 1);
  if (index < 0 || targetIndex < 0 || targetIndex >= products.length) return listKioskOperations();
  const current = products[index];
  const target = products[targetIndex];
  await getD1().batch([
    getD1().prepare(`INSERT INTO customer_product_overrides (product_code, name, sort_order, updated_by, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(product_code) DO UPDATE SET sort_order = excluded.sort_order,
      updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`)
      .bind(current.code, current.name, target.sortOrder, requestedBy),
    getD1().prepare(`INSERT INTO customer_product_overrides (product_code, name, sort_order, updated_by, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(product_code) DO UPDATE SET sort_order = excluded.sort_order,
      updated_by = excluded.updated_by, updated_at = CURRENT_TIMESTAMP`)
      .bind(target.code, target.name, current.sortOrder, requestedBy),
  ]);
  return listKioskOperations();
}

export async function removeKioskProduct(productCode: string, requestedBy: string) {
  await ensureKioskSchema();
  const pricing = await getPricingSettings();
  const extra = pricing.extraAddOnItems.find((item) => item.code === productCode);
  if (extra) {
    await updatePricingSettings({
      ...pricing,
      extraAddOnItems: pricing.extraAddOnItems.map((item) => item.code === productCode ? { ...item, active: false } : { ...item }),
    }, requestedBy);
  }
  return setKioskProductStatus(productCode, "HIDDEN", requestedBy);
}

export async function saveKioskGuidance(input: {
  id?: string; placement: string; title?: string; summary?: string; content: string;
  agreementText?: string; required?: boolean; active?: boolean; requestedBy: string;
}) {
  await ensureKioskSchema();
  const placement = cleanText(input.placement, 40).toUpperCase();
  if (!["REQUIRED_AGREEMENT", "AFTER_PAYMENT", "BEFORE_GAME_START", "AFTER_GAME"].includes(placement)) throw new Error("KIOSK_GUIDANCE_PLACEMENT_INVALID");
  const title = cleanText(input.title, 60) || "이용 안내";
  const summary = cleanText(input.summary, 160);
  const content = cleanText(input.content, 1000);
  const agreementText = cleanText(input.agreementText, 160);
  if (!content) throw new Error("KIOSK_GUIDANCE_CONTENT_REQUIRED");
  const id = cleanText(input.id, 80) || crypto.randomUUID();
  const existing = await getD1().prepare(`SELECT title, summary, content, agreement_text, required, version
    FROM kiosk_guidance_items WHERE id = ? LIMIT 1`).bind(id).first<{
      title: string; summary: string; content: string; agreement_text: string; required: number; version: number;
    }>();
  const changedConsentText = Boolean(existing) && (
    existing.title !== title || existing.summary !== summary || existing.content !== content ||
    existing.agreement_text !== agreementText || existing.required !== (input.required === true ? 1 : 0)
  );
  const version = Math.max(1, Number(existing?.version) || 1) + (changedConsentText ? 1 : 0);
  const current = await getD1().prepare(`SELECT COALESCE(MAX(sort_order), 0) AS value FROM kiosk_guidance_items WHERE placement = ?`)
    .bind(placement).first<{ value: number }>();
  await getD1().prepare(`INSERT INTO kiosk_guidance_items
      (id, placement, title, summary, content, agreement_text, required, version, sort_order, active, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET placement = excluded.placement, title = excluded.title,
      summary = excluded.summary, content = excluded.content, agreement_text = excluded.agreement_text,
      required = excluded.required, version = excluded.version, active = excluded.active,
      updated_at = CURRENT_TIMESTAMP`)
    .bind(id, placement, title, summary || content, content, agreementText,
      input.required === true ? 1 : 0, version, Math.max(10, Number(current?.value) + 10), input.active === false ? 0 : 1).run();
  return listKioskOperations();
}

export async function saveKioskRoomRecommendationRule(input: {
  id?: string; name?: string; adultMin?: unknown; adultMax?: unknown; youthMin?: unknown; youthMax?: unknown;
  totalMin?: unknown; totalMax?: unknown; primarySize?: unknown; secondarySize?: unknown;
  active?: boolean; priority?: unknown;
}) {
  await ensureKioskSchema();
  const id = cleanText(input.id, 80) || crypto.randomUUID();
  const adultMin = clamp(input.adultMin, 0, 10);
  const adultMax = clamp(input.adultMax ?? 10, adultMin, 10);
  const youthMin = clamp(input.youthMin, 0, 10);
  const youthMax = clamp(input.youthMax ?? 10, youthMin, 10);
  const totalMin = clamp(input.totalMin, 1, 10);
  const totalMax = clamp(input.totalMax ?? 10, totalMin, 10);
  const primarySize = normalizeKioskRoomSize(input.primarySize);
  const secondaryRaw = cleanText(input.secondarySize, 20);
  const secondarySize = secondaryRaw ? normalizeKioskRoomSize(secondaryRaw) : "";
  if (primarySize === secondarySize) throw new Error("KIOSK_ROOM_RECOMMENDATION_DUPLICATE_SIZE");
  await getD1().prepare(`INSERT INTO kiosk_room_recommendation_rules
      (id, name, adult_min, adult_max, youth_min, youth_max, total_min, total_max,
       primary_size, secondary_size, active, priority, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET name = excluded.name, adult_min = excluded.adult_min,
      adult_max = excluded.adult_max, youth_min = excluded.youth_min, youth_max = excluded.youth_max,
      total_min = excluded.total_min, total_max = excluded.total_max, primary_size = excluded.primary_size,
      secondary_size = excluded.secondary_size, active = excluded.active, priority = excluded.priority,
      updated_at = CURRENT_TIMESTAMP`)
    .bind(id, cleanText(input.name, 60) || `${totalMin}~${totalMax}명`, adultMin, adultMax, youthMin, youthMax,
      totalMin, totalMax, primarySize, secondarySize, input.active === false ? 0 : 1,
      clamp(input.priority ?? 100, 0, 1000)).run();
  return listKioskOperations();
}

export async function removeKioskRoomRecommendationRule(id: string) {
  await ensureKioskSchema();
  await getD1().prepare(`DELETE FROM kiosk_room_recommendation_rules WHERE id = ?`).bind(cleanText(id, 80)).run();
  return listKioskOperations();
}

export async function moveKioskGuidance(id: string, direction: number) {
  await ensureKioskSchema();
  const selected = await getD1().prepare(`SELECT id, placement, sort_order FROM kiosk_guidance_items WHERE id = ? LIMIT 1`)
    .bind(id).first<{ id: string; placement: string; sort_order: number }>();
  if (!selected) throw new Error("KIOSK_GUIDANCE_NOT_FOUND");
  const rows = await getD1().prepare(`SELECT id, sort_order FROM kiosk_guidance_items WHERE placement = ? ORDER BY sort_order, created_at`)
    .bind(selected.placement).all<{ id: string; sort_order: number }>();
  const index = rows.results.findIndex((item) => item.id === id);
  const target = rows.results[index + (direction < 0 ? -1 : 1)];
  if (!target) return listKioskOperations();
  await getD1().batch([
    getD1().prepare(`UPDATE kiosk_guidance_items SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(target.sort_order, id),
    getD1().prepare(`UPDATE kiosk_guidance_items SET sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(selected.sort_order, target.id),
  ]);
  return listKioskOperations();
}

export async function removeKioskGuidance(id: string) {
  await ensureKioskSchema();
  await getD1().prepare(`DELETE FROM kiosk_guidance_items WHERE id = ?`).bind(id).run();
  return listKioskOperations();
}

export async function syncKioskCommandResult(commandId: string, succeeded: boolean, message: string) {
  await ensureKioskSchema();
  const row = await getD1().prepare(`SELECT action, payload_json FROM commands WHERE id = ? LIMIT 1`)
    .bind(commandId).first<{ action: string; payload_json: string }>();
  if (!row || !['set_info', 'start', 'stop'].includes(row.action)) return;
  const payload = json<Record<string, unknown>>(row.payload_json, {});
  const visitId = cleanText(payload.customerVisitId, 80);
  if (!visitId) return;
  if (succeeded && row.action === 'set_info') {
    await getD1().batch([
      getD1().prepare(`UPDATE customer_visits SET status = 'READY_TO_PLAY', error_code = '', error_message = '',
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'PREPARING'`).bind(visitId),
      getD1().prepare(`UPDATE customer_visit_games SET status = 'READY_TO_PLAY', updated_at = CURRENT_TIMESTAMP
        WHERE visit_id = ? AND reservation_id = (SELECT reservation_id FROM customer_visits WHERE id = ?)`)
        .bind(visitId, visitId),
    ]);
    const roomCode = ROOM_OPTIONS.find((room) => room.roomId === cleanText(payload.roomId, 20))?.code || "방 미지정";
    deferOperationalPush({
      eventType: "KIOSK_READY_TO_PLAY",
      dedupKey: `kiosk-ready:${commandId}`,
      title: "게임 시작 준비 완료",
      body: `${roomCode} · 게임을 시작할 수 있습니다.`,
    });
    return;
  }
  if (succeeded) return;
  if (row.action === 'stop') {
    await getD1().prepare(`UPDATE customer_visits SET status = 'STAFF_REVIEW', error_code = 'STOP_FAILED',
      error_message = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'PLAYING'`)
      .bind(cleanText(message, 300), visitId).run();
    const roomCode = ROOM_OPTIONS.find((room) => room.roomId === cleanText(payload.roomId, 20))?.code || "방 미지정";
    deferOperationalPush({
      eventType: "KIOSK_STOP_FAILED",
      dedupKey: `kiosk-stop-failed:${commandId}`,
      title: "게임 정지 확인 필요",
      body: `${roomCode} · 실제 정지 상태를 확인해주세요.`,
    });
    return;
  }
  await getD1().prepare(`UPDATE customer_visits SET status = 'START_FAILED', error_code = ?, error_message = ?,
    updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status IN ('PREPARING', 'READY_TO_PLAY')`)
    .bind(row.action === 'set_info' ? 'SET_INFO_FAILED' : 'START_FAILED', cleanText(message, 300), visitId).run();
  const roomCode = ROOM_OPTIONS.find((room) => room.roomId === cleanText(payload.roomId, 20))?.code || "방 미지정";
  deferOperationalPush({
    eventType: "KIOSK_START_FAILED",
    dedupKey: `kiosk-start-failed:${commandId}`,
    title: row.action === 'set_info' ? "관리자 프로그램 입력 확인 필요" : "게임 시작 확인 필요",
    body: `${roomCode} · 최신 상태를 확인한 뒤 직접 다시 시도해주세요.`,
  });
}

export async function syncKioskRoomTransition(roomId: string, previousStatus: string, nextStatus: string) {
  await ensureKioskSchema();
  const roomCode = ROOM_OPTIONS.find((room) => room.roomId === roomId)?.code;
  if (!roomCode) return;
  if (nextStatus === 'running') {
    const playingVisit = await getD1().prepare(`SELECT id, reservation_id FROM customer_visits
      WHERE room_code = ? AND status = 'READY_TO_PLAY' ORDER BY updated_at DESC LIMIT 1`)
      .bind(roomCode).first<{ id: string; reservation_id: string | null }>();
    if (playingVisit) {
      await getD1().batch([
        getD1().prepare(`UPDATE customer_visits SET status = 'PLAYING', started_at = COALESCE(started_at, CURRENT_TIMESTAMP),
          updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(playingVisit.id),
        getD1().prepare(`UPDATE customer_visit_games SET status = 'PLAYING', updated_at = CURRENT_TIMESTAMP
          WHERE visit_id = ? AND reservation_id = ?`).bind(playingVisit.id, playingVisit.reservation_id),
      ]);
    }
    return;
  }
  if (previousStatus !== 'running' || nextStatus === 'running') return;
  const visit = await getD1().prepare(`SELECT id, reservation_id, representative_member_id FROM customer_visits
    WHERE room_code = ? AND status = 'PLAYING' ORDER BY started_at DESC LIMIT 1`)
    .bind(roomCode).first<{ id: string; reservation_id: string | null; representative_member_id: string | null }>();
  if (!visit) return;
  const manualStop = await getD1().prepare(`SELECT id FROM commands WHERE room_id = ? AND action = 'stop'
    AND status = 'completed' AND completed_at > datetime('now', '-2 minutes') LIMIT 1`).bind(roomId).first();
  const status = manualStop ? 'ABORTED' : 'COMPLETED';
  const db = getD1();
  const currentGame = visit.reservation_id
    ? await db.prepare(`SELECT * FROM customer_visit_games WHERE visit_id = ? AND reservation_id = ? LIMIT 1`)
      .bind(visit.id, visit.reservation_id).first<VisitGameRow>()
    : null;
  const nextGame = status === 'COMPLETED' && currentGame
    ? await db.prepare(`SELECT * FROM customer_visit_games WHERE visit_id = ? AND sequence > ? AND status = 'PAID_WAITING'
        ORDER BY sequence LIMIT 1`).bind(visit.id, currentGame.sequence).first<VisitGameRow>()
    : null;
  const earnedMemberIds = new Set<string>();
  const statements: D1PreparedStatement[] = [
    nextGame
      ? db.prepare(`UPDATE customer_visits SET status = 'PREPARING', reservation_id = ?, scheduled_date = ?, scheduled_time = ?,
          room_code = ?, difficulty_code = ?, difficulty_label = ?, map_index = ?, started_at = NULL, completed_at = NULL,
          error_code = '', error_message = '', updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(nextGame.reservation_id, nextGame.scheduled_date, nextGame.scheduled_time, nextGame.room_code,
          nextGame.difficulty_code, nextGame.difficulty_label, nextGame.map_index, visit.id)
      : db.prepare(`UPDATE customer_visits SET status = ?, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
        .bind(status, visit.id),
  ];
  if (currentGame) {
    statements.push(db.prepare(`UPDATE customer_visit_games SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
      .bind(status, currentGame.id));
  }
  if (nextGame?.reservation_id) {
    statements.push(
      db.prepare(`UPDATE customer_visit_games SET status = 'PREPARING', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(nextGame.id),
      db.prepare(`UPDATE reservations SET status = CASE WHEN status = 'booked' THEN 'arrived' ELSE status END,
        updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(nextGame.reservation_id),
    );
  }
  if (status === 'COMPLETED') {
    const settings = await getBenefitSettings();
    const allocations = currentGame?.reservation_id
      ? await db.prepare(`SELECT id, member_id, quantity, reference_key FROM customer_stamp_allocations
          WHERE visit_id = ? AND status = 'PENDING' AND reference_key LIKE ?`)
        .bind(visit.id, `%:${currentGame.reservation_id}:%`).all<{ id: string; member_id: string; quantity: number; reference_key: string }>()
      : await db.prepare(`SELECT id, member_id, quantity, reference_key FROM customer_stamp_allocations
          WHERE visit_id = ? AND status = 'PENDING'`).bind(visit.id)
        .all<{ id: string; member_id: string; quantity: number; reference_key: string }>();
    for (const allocation of allocations.results) {
      earnedMemberIds.add(allocation.member_id);
      const stampAmount = stampAwardQuantity({
        partyCount: allocation.quantity,
        stampsPerParticipant: settings.stampEarnPerGame,
      });
      const referenceKey = visit.reservation_id
        ? `stamp-earn:reservation:${visit.reservation_id}`
        : allocation.reference_key;
      statements.push(
        db.prepare(`INSERT INTO stamp_ledger (id, member_id, type, amount, reason, source, reference_key, created_by)
          VALUES (?, ?, 'EARN', ?, '키오스크 게임 이용 완료', 'RESERVATION', ?, 'customer-kiosk')
          ON CONFLICT(reference_key) DO NOTHING`).bind(crypto.randomUUID(), allocation.member_id, stampAmount, referenceKey),
        db.prepare(`UPDATE customer_stamp_allocations SET status = 'EARNED', updated_at = CURRENT_TIMESTAMP WHERE id = ?`).bind(allocation.id),
      );
    }
  }
  await db.batch(statements);
  if (nextGame) {
    deferOperationalPush({
      eventType: "KIOSK_READY_REQUIRED",
      dedupKey: `kiosk-next-game:${visit.id}:${nextGame.sequence}`,
      title: "다음 게임 준비 필요",
      body: `${nextGame.room_code} · ${nextGame.scheduled_time} · ${nextGame.difficulty_label}`,
    });
  }
  for (const memberId of earnedMemberIds) {
    await getMemberBenefits(memberId);
  }
}
