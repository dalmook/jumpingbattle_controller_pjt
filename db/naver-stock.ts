import { getD1 } from "./control";
import { ensureReservationSchema } from "./reservations";

export const NAVER_BIZ_ITEM_BY_ROOM = {
  C1: 1000001,
  C2: 1000002,
  A1: 1000003,
  B1: 1000004,
} as const;

export type NaverRoomCode = keyof typeof NAVER_BIZ_ITEM_BY_ROOM;

export type NaverManagedSlot = {
  slotKey: string;
  roomCode: NaverRoomCode;
  scheduledDate: string;
  scheduledTime: string;
  bizItemId: number;
  originalStock: number;
};

export type NaverStockAction =
  | ({ action: "claim" } & NaverManagedSlot)
  | { action: "release"; slotKey: string };

type BlockedSlotRow = {
  room_code: string;
  scheduled_date: string;
  scheduled_time: string;
  local_count: number;
};

type ManagedSlotRow = {
  slot_key: string;
  room_code: string;
  scheduled_date: string;
  scheduled_time: string;
  biz_item_id: number;
  original_stock: number;
};

export function naverSlotKey(
  roomCode: string,
  scheduledDate: string,
  scheduledTime: string,
) {
  return `${roomCode}|${scheduledDate}|${scheduledTime}`;
}

export async function ensureNaverStockSchema() {
  const db = getD1();
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS naver_stock_managed_slots (
        slot_key TEXT PRIMARY KEY,
        room_code TEXT NOT NULL,
        scheduled_date TEXT NOT NULL,
        scheduled_time TEXT NOT NULL,
        biz_item_id INTEGER NOT NULL,
        original_stock INTEGER NOT NULL DEFAULT 1,
        managed_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS naver_stock_managed_schedule_idx
      ON naver_stock_managed_slots(scheduled_date, scheduled_time)
    `),
  ]);
}

export async function listNaverStockPlan(startDate: string, endDate: string) {
  await Promise.all([ensureReservationSchema(), ensureNaverStockSchema()]);
  const db = getD1();
  const [blockedResult, managedResult] = await Promise.all([
    db
      .prepare(`
        SELECT room_code, scheduled_date, scheduled_time, COUNT(*) AS local_count
        FROM reservations
        WHERE scheduled_date BETWEEN ? AND ?
          AND (
            source <> 'naver'
            OR schedule_overridden = 1
            OR EXISTS (
              SELECT 1 FROM reservation_events
              WHERE reservation_id = reservations.id
                AND event_type IN ('assign', 'move', 'details')
                AND created_by <> 'naver-import'
            )
          )
          AND status IN ('booked', 'arrived', 'completed')
          AND room_code IN ('C1', 'C2', 'A1', 'B1')
          AND scheduled_time <> ''
        GROUP BY room_code, scheduled_date, scheduled_time
        ORDER BY scheduled_date, scheduled_time, room_code
      `)
      .bind(startDate, endDate)
      .all<BlockedSlotRow>(),
    db
      .prepare(`
        SELECT slot_key, room_code, scheduled_date, scheduled_time,
          biz_item_id, original_stock
        FROM naver_stock_managed_slots
        WHERE scheduled_date BETWEEN ? AND ?
        ORDER BY scheduled_date, scheduled_time, room_code
      `)
      .bind(startDate, endDate)
      .all<ManagedSlotRow>(),
  ]);

  const blockedSlots = blockedResult.results.flatMap((row) => {
    const roomCode = row.room_code as NaverRoomCode;
    const bizItemId = NAVER_BIZ_ITEM_BY_ROOM[roomCode];
    if (!bizItemId) return [];
    return [{
      slotKey: naverSlotKey(roomCode, row.scheduled_date, row.scheduled_time),
      roomCode,
      scheduledDate: row.scheduled_date,
      scheduledTime: row.scheduled_time,
      bizItemId,
      localCount: Number(row.local_count) || 1,
    }];
  });

  const managedSlots = managedResult.results.flatMap((row) => {
    const roomCode = row.room_code as NaverRoomCode;
    if (NAVER_BIZ_ITEM_BY_ROOM[roomCode] !== Number(row.biz_item_id)) return [];
    return [{
      slotKey: row.slot_key,
      roomCode,
      scheduledDate: row.scheduled_date,
      scheduledTime: row.scheduled_time,
      bizItemId: Number(row.biz_item_id),
      originalStock: Math.max(1, Number(row.original_stock) || 1),
    } satisfies NaverManagedSlot];
  });

  return { blockedSlots, managedSlots };
}

export async function applyNaverStockActions(actions: NaverStockAction[]) {
  await ensureNaverStockSchema();
  if (actions.length === 0) return;
  const db = getD1();
  await db.batch(
    actions.map((action) => {
      if (action.action === "release") {
        return db
          .prepare(`DELETE FROM naver_stock_managed_slots WHERE slot_key = ?`)
          .bind(action.slotKey);
      }
      return db
        .prepare(`
          INSERT INTO naver_stock_managed_slots (
            slot_key, room_code, scheduled_date, scheduled_time,
            biz_item_id, original_stock, managed_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
          ON CONFLICT(slot_key) DO UPDATE SET
            room_code = excluded.room_code,
            scheduled_date = excluded.scheduled_date,
            scheduled_time = excluded.scheduled_time,
            biz_item_id = excluded.biz_item_id,
            updated_at = CURRENT_TIMESTAMP
        `)
        .bind(
          action.slotKey,
          action.roomCode,
          action.scheduledDate,
          action.scheduledTime,
          action.bizItemId,
          Math.max(1, action.originalStock),
        );
    }),
  );
}
