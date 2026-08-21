import {
  normalizeFinalLevel,
  seoulGameDateTime,
} from "@/app/admin/game-history-utils";
import { getD1, type RoomTransition } from "./control";
import { ensureReservationSchema } from "./reservations";
import { getPricingSettings } from "./pricing-settings";

export type GameHistoryRecord = {
  id: string;
  reservationId: string;
  bookingCode: string;
  source: string;
  customerName: string;
  roomId: string;
  roomCode: string;
  roomName: string;
  teamName: string;
  mapName: string;
  difficultyLabel: string;
  adultCount: number;
  youthCount: number;
  people: number;
  score: number;
  level: string;
  baseAmount: number;
  addOnAmount: number;
  discountAmount: number;
  depositAmount: number;
  paymentAmount: number;
  paymentCardAmount: number;
  paymentCashAmount: number;
  paymentAccountAmount: number;
  paymentStatus: string;
  gameDate: string;
  gameTime: string;
  scheduledDate: string;
  scheduledTime: string;
  startedAt: string;
  endedAt: string;
  durationSeconds: number;
};

type ReservationSnapshot = {
  id: string;
  booking_code: string;
  source: string;
  customer_name: string;
  scheduled_date: string;
  scheduled_time: string;
  room_code: string;
  team_name: string;
  difficulty_label: string;
  adult_count: number;
  youth_count: number;
  total_count: number;
  base_amount: number;
  add_on_amount: number;
  discount_amount: number;
  payment_amount: number;
  payment_card_amount: number;
  payment_cash_amount: number;
  payment_account_amount: number;
  payment_status: string;
};

type GameHistoryRow = {
  id: string;
  reservation_id: string | null;
  booking_code: string;
  source: string;
  customer_name: string;
  room_id: string;
  room_code: string;
  room_name: string;
  team_name: string;
  map_name: string;
  difficulty_label: string;
  adult_count: number;
  youth_count: number;
  people: number;
  score: number;
  level: string;
  base_amount: number;
  add_on_amount: number;
  discount_amount: number;
  deposit_amount: number;
  payment_amount: number;
  payment_card_amount: number;
  payment_cash_amount: number;
  payment_account_amount: number;
  payment_status: string;
  game_date: string;
  game_time: string;
  scheduled_date: string;
  scheduled_time: string;
  started_at: string;
  ended_at: string;
  duration_seconds: number;
};

function finiteNumber(value: unknown) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toGameHistoryRecord(row: GameHistoryRow): GameHistoryRecord {
  return {
    id: row.id,
    reservationId: row.reservation_id ?? "",
    bookingCode: row.booking_code,
    source: row.source,
    customerName: row.customer_name,
    roomId: row.room_id,
    roomCode: row.room_code,
    roomName: row.room_name,
    teamName: row.team_name,
    mapName: row.map_name,
    difficultyLabel: row.difficulty_label,
    adultCount: Number(row.adult_count) || 0,
    youthCount: Number(row.youth_count) || 0,
    people: Number(row.people) || 0,
    score: Math.max(0, Number(row.score) || 0),
    level: row.level,
    baseAmount: Number(row.base_amount) || 0,
    addOnAmount: Number(row.add_on_amount) || 0,
    discountAmount: Number(row.discount_amount) || 0,
    depositAmount: Number(row.deposit_amount) || 0,
    paymentAmount: Number(row.payment_amount) || 0,
    paymentCardAmount: Number(row.payment_card_amount) || 0,
    paymentCashAmount: Number(row.payment_cash_amount) || 0,
    paymentAccountAmount: Number(row.payment_account_amount) || 0,
    paymentStatus: row.payment_status,
    gameDate: row.game_date,
    gameTime: row.game_time,
    scheduledDate: row.scheduled_date,
    scheduledTime: row.scheduled_time,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    durationSeconds: Math.max(0, Number(row.duration_seconds) || 0),
  };
}

export async function ensureGameHistorySchema() {
  const db = getD1();
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS game_records (
        id TEXT PRIMARY KEY,
        session_key TEXT NOT NULL UNIQUE,
        reservation_id TEXT,
        booking_code TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        customer_name TEXT NOT NULL DEFAULT '',
        room_id TEXT NOT NULL,
        room_code TEXT NOT NULL DEFAULT '',
        room_name TEXT NOT NULL DEFAULT '',
        team_name TEXT NOT NULL DEFAULT '',
        map_name TEXT NOT NULL DEFAULT '',
        difficulty_label TEXT NOT NULL DEFAULT '',
        adult_count INTEGER NOT NULL DEFAULT 0,
        youth_count INTEGER NOT NULL DEFAULT 0,
        people INTEGER NOT NULL DEFAULT 0,
        score INTEGER NOT NULL DEFAULT 0,
        level TEXT NOT NULL DEFAULT '',
        base_amount INTEGER NOT NULL DEFAULT 0,
        add_on_amount INTEGER NOT NULL DEFAULT 0,
        discount_amount INTEGER NOT NULL DEFAULT 0,
        deposit_amount INTEGER NOT NULL DEFAULT 0,
        payment_amount INTEGER NOT NULL DEFAULT 0,
        payment_card_amount INTEGER NOT NULL DEFAULT 0,
        payment_cash_amount INTEGER NOT NULL DEFAULT 0,
        payment_account_amount INTEGER NOT NULL DEFAULT 0,
        payment_status TEXT NOT NULL DEFAULT 'unpaid',
        game_date TEXT NOT NULL,
        game_time TEXT NOT NULL,
        scheduled_date TEXT NOT NULL DEFAULT '',
        scheduled_time TEXT NOT NULL DEFAULT '',
        started_at TEXT NOT NULL DEFAULT '',
        ended_at TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS game_records_ended_at_idx
      ON game_records(ended_at DESC)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS game_records_date_room_idx
      ON game_records(game_date, room_code, ended_at DESC)
    `),
    db.prepare(`
      CREATE INDEX IF NOT EXISTS game_records_reservation_idx
      ON game_records(reservation_id)
    `),
    db.prepare("PRAGMA optimize"),
  ]);
}

async function findReservationSnapshot(
  roomCode: string,
  teamName: string,
  gameDate: string,
  preferredReservationId: string,
) {
  const db = getD1();
  if (preferredReservationId) {
    const preferred = await db
      .prepare(`
        SELECT id, booking_code, source, customer_name, scheduled_date,
          scheduled_time, room_code, team_name, difficulty_label,
          adult_count, youth_count, total_count, base_amount, add_on_amount,
          discount_amount, payment_amount, payment_card_amount,
          payment_cash_amount, payment_account_amount, payment_status
        FROM reservations WHERE id = ? LIMIT 1
      `)
      .bind(preferredReservationId)
      .first<ReservationSnapshot>();
    if (preferred) return preferred;
  }
  if (!roomCode || !teamName) return null;
  return getD1()
    .prepare(`
      SELECT id, booking_code, source, customer_name, scheduled_date,
        scheduled_time, room_code, team_name, difficulty_label,
        adult_count, youth_count, total_count, base_amount, add_on_amount,
        discount_amount, payment_amount, payment_card_amount,
        payment_cash_amount, payment_account_amount, payment_status
      FROM reservations
      WHERE room_code = ?
        AND lower(trim(team_name)) = lower(trim(?))
        AND scheduled_date BETWEEN date(?, '-1 day') AND ?
        AND status <> 'cancelled'
      ORDER BY
        CASE WHEN scheduled_date = ? THEN 0 ELSE 1 END,
        CASE status WHEN 'completed' THEN 0 WHEN 'arrived' THEN 1 ELSE 2 END,
        updated_at DESC
      LIMIT 1
    `)
    .bind(roomCode, teamName, gameDate, gameDate, gameDate)
    .first<ReservationSnapshot>();
}

export async function recordStoppedGame(
  transition: RoomTransition,
  roomCode: string,
  roomName: string,
  preferredReservationId = "",
) {
  const score = Math.max(
    finiteNumber(transition.previousScore),
    finiteNumber(transition.nextScore),
    0,
  );
  if (score <= 0) return;

  await Promise.all([ensureGameHistorySchema(), ensureReservationSchema()]);
  const endedAt = new Date().toISOString();
  const gameClock = seoulGameDateTime(endedAt);
  const teamName = (
    transition.previousTeamName || transition.nextTeamName
  ).trim();
  const reservation = await findReservationSnapshot(
    roomCode,
    teamName,
    gameClock.date,
    preferredReservationId,
  );
  const startedAt = transition.gameStartedAt || endedAt;
  const startedTimestamp = new Date(startedAt).getTime();
  const durationSeconds = Number.isFinite(startedTimestamp)
    ? Math.max(0, Math.min(6 * 60 * 60, Math.round((Date.now() - startedTimestamp) / 1_000)))
    : 0;
  const level =
    normalizeFinalLevel(transition.nextLevel) ||
    normalizeFinalLevel(transition.previousLevel);
  const mapName =
    transition.previousMapName ||
    transition.nextMapName ||
    reservation?.difficulty_label ||
    "";
  const people = Math.max(
    finiteNumber(transition.previousPeople),
    finiteNumber(transition.nextPeople),
    finiteNumber(reservation?.total_count),
  );
  const pricing = await getPricingSettings();
  const expectedAmount = Math.max(
    0,
    finiteNumber(reservation?.base_amount) +
      finiteNumber(reservation?.add_on_amount) -
      finiteNumber(reservation?.discount_amount),
  );
  const depositAmount = reservation?.source === "naver"
    ? Math.min(finiteNumber(pricing.naverDepositAmount), expectedAmount)
    : 0;
  const splitPaymentAmount =
    finiteNumber(reservation?.payment_card_amount) +
    finiteNumber(reservation?.payment_cash_amount) +
    finiteNumber(reservation?.payment_account_amount);
  const paymentAmount = Math.max(
    finiteNumber(reservation?.payment_amount),
    splitPaymentAmount,
  );
  const sessionKey = `${transition.roomId}|${startedAt}`;
  const db = getD1();
  const id = crypto.randomUUID();
  await db
    .prepare(`
      INSERT INTO game_records (
        id, session_key, reservation_id, booking_code, source, customer_name,
        room_id, room_code, room_name, team_name, map_name, difficulty_label,
        adult_count, youth_count, people, score, level, base_amount,
        add_on_amount, discount_amount, deposit_amount, payment_amount,
        payment_card_amount, payment_cash_amount, payment_account_amount,
        payment_status, game_date, game_time, scheduled_date, scheduled_time,
        started_at, ended_at, duration_seconds, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, ?, ?, ?,
        ?, ?, ?, CURRENT_TIMESTAMP
      )
      ON CONFLICT(session_key) DO UPDATE SET
        reservation_id = excluded.reservation_id,
        booking_code = excluded.booking_code,
        source = excluded.source,
        customer_name = excluded.customer_name,
        room_code = excluded.room_code,
        room_name = excluded.room_name,
        team_name = excluded.team_name,
        map_name = excluded.map_name,
        difficulty_label = excluded.difficulty_label,
        adult_count = excluded.adult_count,
        youth_count = excluded.youth_count,
        people = excluded.people,
        score = excluded.score,
        level = excluded.level,
        base_amount = excluded.base_amount,
        add_on_amount = excluded.add_on_amount,
        discount_amount = excluded.discount_amount,
        deposit_amount = excluded.deposit_amount,
        payment_amount = excluded.payment_amount,
        payment_card_amount = excluded.payment_card_amount,
        payment_cash_amount = excluded.payment_cash_amount,
        payment_account_amount = excluded.payment_account_amount,
        payment_status = excluded.payment_status,
        ended_at = excluded.ended_at,
        duration_seconds = excluded.duration_seconds,
        updated_at = CURRENT_TIMESTAMP
    `)
    .bind(
      id,
      sessionKey,
      reservation?.id ?? null,
      reservation?.booking_code ?? "",
      reservation?.source ?? "manual",
      reservation?.customer_name ?? "",
      transition.roomId,
      roomCode,
      roomName,
      teamName || reservation?.team_name || "이름 없음",
      mapName,
      reservation?.difficulty_label ?? "",
      finiteNumber(reservation?.adult_count),
      finiteNumber(reservation?.youth_count),
      people,
      score,
      level,
      finiteNumber(reservation?.base_amount),
      finiteNumber(reservation?.add_on_amount),
      finiteNumber(reservation?.discount_amount),
      depositAmount,
      paymentAmount,
      finiteNumber(reservation?.payment_card_amount),
      finiteNumber(reservation?.payment_cash_amount),
      finiteNumber(reservation?.payment_account_amount),
      reservation?.payment_status ?? "unpaid",
      gameClock.date,
      gameClock.time,
      reservation?.scheduled_date ?? "",
      reservation?.scheduled_time ?? "",
      startedAt,
      endedAt,
      durationSeconds,
    )
    .run();
}

export async function refreshRecentStoppedGame(
  transition: RoomTransition,
) {
  const scoreChanged = transition.nextScore !== transition.previousScore;
  const level = normalizeFinalLevel(transition.nextLevel);
  const levelChanged = level !== normalizeFinalLevel(transition.previousLevel);
  if (
    transition.nextStatus !== "waiting" ||
    (!scoreChanged && !levelChanged) ||
    (transition.nextScore <= 0 && !level)
  ) {
    return;
  }
  await ensureGameHistorySchema();
  await getD1()
    .prepare(`
      UPDATE game_records
      SET
        score = CASE WHEN ? > 0 THEN ? ELSE score END,
        level = CASE WHEN ? <> '' THEN ? ELSE level END,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = (
        SELECT id FROM game_records
        WHERE room_id = ?
          AND datetime(ended_at) >= datetime('now', '-90 seconds')
        ORDER BY ended_at DESC LIMIT 1
      )
    `)
    .bind(
      Math.max(0, transition.nextScore),
      Math.max(0, transition.nextScore),
      level,
      level,
      transition.roomId,
    )
    .run();
}

function escapeLike(value: string) {
  return value.replace(/[!%_]/g, (character) => `!${character}`);
}

export async function listGameHistory(input: {
  from: string;
  to: string;
  query: string;
  roomCode: string;
  limit: number;
}) {
  await ensureGameHistorySchema();
  const clauses = ["score > 0", "game_date BETWEEN ? AND ?"];
  const bindings: Array<string | number> = [input.from, input.to];
  if (input.roomCode) {
    clauses.push("room_code = ?");
    bindings.push(input.roomCode);
  }
  if (input.query) {
    const search = `%${escapeLike(input.query.trim())}%`;
    clauses.push(`(
      team_name LIKE ? ESCAPE '!' OR
      customer_name LIKE ? ESCAPE '!' OR
      booking_code LIKE ? ESCAPE '!' OR
      map_name LIKE ? ESCAPE '!' OR
      difficulty_label LIKE ? ESCAPE '!' OR
      room_name LIKE ? ESCAPE '!' OR
      level LIKE ? ESCAPE '!' OR
      CAST(score AS TEXT) LIKE ? ESCAPE '!'
    )`);
    bindings.push(search, search, search, search, search, search, search, search);
  }
  const where = clauses.join(" AND ");
  const db = getD1();
  const [recordsResult, summary] = await Promise.all([
    db
      .prepare(`
        SELECT id, reservation_id, booking_code, source, customer_name,
          room_id, room_code, room_name, team_name, map_name, difficulty_label,
          adult_count, youth_count, people, score, level, base_amount,
          add_on_amount, discount_amount, deposit_amount, payment_amount,
          payment_card_amount, payment_cash_amount, payment_account_amount,
          payment_status, game_date, game_time, scheduled_date,
          scheduled_time, started_at, ended_at, duration_seconds
        FROM game_records
        WHERE ${where}
        ORDER BY ended_at DESC, id DESC
        LIMIT ?
      `)
      .bind(...bindings, input.limit)
      .all<GameHistoryRow>(),
    db
      .prepare(`
        SELECT COUNT(*) AS total,
          COALESCE(ROUND(AVG(score)), 0) AS average_score,
          COALESCE(MAX(score), 0) AS high_score,
          COALESCE(SUM(people), 0) AS total_people,
          COALESCE(SUM(deposit_amount + payment_amount), 0) AS total_payment
        FROM game_records WHERE ${where}
      `)
      .bind(...bindings)
      .first<{
        total: number;
        average_score: number;
        high_score: number;
        total_people: number;
        total_payment: number;
      }>(),
  ]);
  return {
    records: recordsResult.results.map(toGameHistoryRecord),
    summary: {
      total: Number(summary?.total) || 0,
      averageScore: Number(summary?.average_score) || 0,
      highScore: Number(summary?.high_score) || 0,
      totalPeople: Number(summary?.total_people) || 0,
      totalPayment: Number(summary?.total_payment) || 0,
    },
  };
}
