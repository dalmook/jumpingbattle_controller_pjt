import { randomUUID } from "node:crypto";
import { formatMemberPhone, getVehicleLast4, normalizeMemberPhone } from "@/app/admin/v2/member-utils";
import { getD1 } from "./control";
import { ensureReservationSchema } from "./reservations";

export type MemberStatus = "active" | "inactive" | "merged";

export type MemberSummary = {
  id: string;
  name: string;
  phone: string;
  normalizedPhone: string;
  phoneLast4: string;
  birthday: string;
  teamName: string;
  email: string;
  vehicleNumber: string;
  memo: string;
  status: MemberStatus;
  lastVisit: string;
  visitCount: number;
  totalSpent: number;
  createdAt: string;
  updatedAt: string;
};

export type MemberReservationHistory = {
  id: string;
  bookingCode: string;
  scheduledDate: string;
  scheduledTime: string;
  roomCode: string;
  teamName: string;
  status: string;
  totalCount: number;
  paymentAmount: number;
  paymentStatus: string;
};

export type MemberDetail = MemberSummary & {
  reservations: MemberReservationHistory[];
  futureBenefits: {
    stamps: null;
    prepaidBalance: null;
  };
};

type MemberRow = {
  id: string;
  name: string;
  phone: string;
  normalized_phone: string;
  phone_last4: string;
  birthday: string;
  team_name: string;
  email: string;
  vehicle_number: string;
  memo: string;
  status: MemberStatus;
  last_visit: string | null;
  visit_count: number;
  total_spent: number;
  created_at: string;
  updated_at: string;
};

export async function ensureMemberSchema() {
  const db = getD1();
  await ensureReservationSchema();
  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS members (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      phone TEXT NOT NULL,
      normalized_phone TEXT NOT NULL,
      phone_last4 TEXT NOT NULL DEFAULT '',
      birthday TEXT NOT NULL DEFAULT '',
      team_name TEXT NOT NULL DEFAULT '',
      email TEXT NOT NULL DEFAULT '',
      vehicle_number TEXT NOT NULL DEFAULT '',
      memo TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      merged_into_id TEXT,
      created_by TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`),
    db.prepare(`CREATE UNIQUE INDEX IF NOT EXISTS members_normalized_phone_uidx ON members(normalized_phone) WHERE normalized_phone <> ''`),
    db.prepare(`CREATE INDEX IF NOT EXISTS members_name_idx ON members(name)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS members_team_name_idx ON members(team_name)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS members_phone_last4_idx ON members(phone_last4, updated_at)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS reservations_member_idx ON reservations(member_id, scheduled_date)`),
  ]);
}

const MEMBER_METRICS = `
  SELECT m.id, m.name, m.phone, m.normalized_phone, m.phone_last4,
    m.birthday, m.team_name, m.email, m.vehicle_number, m.memo,
    m.status, m.created_at, m.updated_at,
    MAX(CASE WHEN r.status = 'completed' THEN r.scheduled_date || 'T' || r.scheduled_time END) AS last_visit,
    SUM(CASE WHEN r.status = 'completed' THEN 1 ELSE 0 END) AS visit_count,
    SUM(CASE WHEN r.status <> 'cancelled' AND r.payment_status = 'paid' THEN r.payment_amount ELSE 0 END) AS total_spent
  FROM members m
  LEFT JOIN reservations r
    ON r.member_id = m.id AND r.source <> 'member_pass_purchase'
`;

function toMember(row: MemberRow): MemberSummary {
  return {
    id: row.id,
    name: row.name,
    phone: row.phone,
    normalizedPhone: row.normalized_phone,
    phoneLast4: row.phone_last4,
    birthday: row.birthday,
    teamName: row.team_name,
    email: row.email,
    vehicleNumber: row.vehicle_number,
    memo: row.memo,
    status: row.status,
    lastVisit: row.last_visit ?? "",
    visitCount: Number(row.visit_count) || 0,
    totalSpent: Number(row.total_spent) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listMembers(query = "", limit = 200, offset = 0) {
  await ensureMemberSchema();
  const db = getD1();
  const q = query.trim();
  const digits = normalizeMemberPhone(q);
  const result = await db.prepare(`${MEMBER_METRICS}
    WHERE m.status <> 'merged'
      AND (? = '' OR m.name LIKE ? OR m.team_name LIKE ? OR m.email LIKE ?
        OR m.vehicle_number LIKE ?
        OR (? <> '' AND m.normalized_phone LIKE ?)
        OR (? <> '' AND m.phone_last4 = ?))
    GROUP BY m.id
    ORDER BY m.name COLLATE NOCASE ASC, COALESCE(last_visit, m.created_at) DESC
    LIMIT ? OFFSET ?`)
    .bind(q, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, digits, `%${digits}%`, digits, digits.slice(-4),
      Math.min(500, Math.max(1, limit)), Math.max(0, offset))
    .all<MemberRow>();
  return result.results.map(toMember);
}

export async function getMember(id: string): Promise<MemberDetail | null> {
  await ensureMemberSchema();
  const db = getD1();
  const row = await db.prepare(`${MEMBER_METRICS} WHERE m.id = ? GROUP BY m.id LIMIT 1`)
    .bind(id).first<MemberRow>();
  if (!row) return null;
  const history = await db.prepare(`SELECT id, booking_code, scheduled_date, scheduled_time,
      room_code, team_name, status, total_count, payment_amount, payment_status
    FROM reservations WHERE member_id = ? AND source <> 'member_pass_purchase'
    ORDER BY scheduled_date DESC, scheduled_time DESC LIMIT 100`)
    .bind(id).all<Record<string, unknown>>();
  return {
    ...toMember(row),
    reservations: history.results.map((item) => ({
      id: String(item.id), bookingCode: String(item.booking_code),
      scheduledDate: String(item.scheduled_date), scheduledTime: String(item.scheduled_time),
      roomCode: String(item.room_code), teamName: String(item.team_name), status: String(item.status),
      totalCount: Number(item.total_count) || 0, paymentAmount: Number(item.payment_amount) || 0,
      paymentStatus: String(item.payment_status),
    })),
    futureBenefits: { stamps: null, prepaidBalance: null },
  };
}

export async function createMember(input: { name: string; phone: string; birthday?: string; teamName?: string; email?: string; vehicleNumber?: string; memo?: string }, operator: string) {
  await ensureMemberSchema();
  const name = input.name.trim().slice(0, 40);
  const normalizedPhone = normalizeMemberPhone(input.phone);
  if (!name) throw new Error("MEMBER_NAME_REQUIRED");
  if (normalizedPhone.length < 9) throw new Error("MEMBER_PHONE_INVALID");
  const existing = await getD1().prepare(`SELECT id FROM members WHERE normalized_phone = ? LIMIT 1`)
    .bind(normalizedPhone).first<{ id: string }>();
  if (existing) return getMember(existing.id);
  const id = randomUUID();
  await getD1().prepare(`INSERT INTO members (
    id, name, phone, normalized_phone, phone_last4, birthday, team_name, email, vehicle_number, memo, created_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, name, formatMemberPhone(normalizedPhone), normalizedPhone, normalizedPhone.slice(-4),
      String(input.birthday ?? "").slice(0, 10), String(input.teamName ?? "").trim().slice(0, 80),
      String(input.email ?? "").trim().slice(0, 160), String(input.vehicleNumber ?? "").trim().slice(0, 20),
      String(input.memo ?? "").trim().slice(0, 1000), operator)
    .run();
  return getMember(id);
}

export async function updateMember(id: string, input: { name?: string; phone?: string; birthday?: string; teamName?: string; email?: string; vehicleNumber?: string; memo?: string; status?: string }) {
  await ensureMemberSchema();
  const current = await getD1().prepare(`SELECT * FROM members WHERE id = ? LIMIT 1`).bind(id).first<Record<string, unknown>>();
  if (!current) return null;
  const name = String(input.name ?? current.name).trim().slice(0, 40);
  const normalizedPhone = normalizeMemberPhone(String(input.phone ?? current.phone));
  if (!name) throw new Error("MEMBER_NAME_REQUIRED");
  if (normalizedPhone.length < 9) throw new Error("MEMBER_PHONE_INVALID");
  const status = ["active", "inactive"].includes(String(input.status)) ? String(input.status) : String(current.status);
  await getD1().prepare(`UPDATE members SET name = ?, phone = ?, normalized_phone = ?, phone_last4 = ?,
      birthday = ?, team_name = ?, email = ?, vehicle_number = ?, memo = ?, status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(name, formatMemberPhone(normalizedPhone), normalizedPhone, normalizedPhone.slice(-4),
      String(input.birthday ?? current.birthday).slice(0, 10),
      String(input.teamName ?? current.team_name).trim().slice(0, 80),
      String(input.email ?? current.email).trim().slice(0, 160),
      String(input.vehicleNumber ?? current.vehicle_number).trim().slice(0, 20),
      String(input.memo ?? current.memo).trim().slice(0, 1000), status, id)
    .run();
  return getMember(id);
}

export async function linkReservationMember(reservationId: string, memberId: string | null) {
  await ensureMemberSchema();
  let vehicleLast4 = "";
  if (memberId) {
    const member = await getD1().prepare(`SELECT id, vehicle_number FROM members WHERE id = ? AND status <> 'merged' LIMIT 1`)
      .bind(memberId).first<{ id: string; vehicle_number: string }>();
    if (!member) throw new Error("MEMBER_NOT_FOUND");
    vehicleLast4 = getVehicleLast4(member.vehicle_number);
  }
  const result = await getD1().prepare(`UPDATE reservations SET
      member_id = ?,
      vehicle_last4 = CASE WHEN ? <> '' THEN ? ELSE vehicle_last4 END,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?`)
    .bind(memberId, vehicleLast4, vehicleLast4, reservationId).run();
  return Number(result.meta.changes ?? 0) > 0;
}
