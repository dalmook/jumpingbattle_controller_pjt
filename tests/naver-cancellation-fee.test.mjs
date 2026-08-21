import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import ts from "typescript";

const root = new URL("../", import.meta.url);
const configSource = await readFile(
  new URL("app/reservation-config.ts", root),
  "utf8",
);
const compiledConfig = ts.transpileModule(configSource, {
  compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const {
  NAVER_CANCELLATION_FEE_AMOUNT,
  naverSameDayCancellationFee,
} = await import(
  `data:text/javascript;base64,${Buffer.from(compiledConfig).toString("base64")}`
);

function cancellation(overrides = {}) {
  return {
    source: "naver",
    status: "cancelled",
    scheduledDate: "2026-08-01",
    cancelledAt: "2026-07-31 15:00:00",
    ...overrides,
  };
}

test("네이버 예약을 이용일 당일 취소하면 수수료 5,000원을 계산한다", () => {
  assert.equal(NAVER_CANCELLATION_FEE_AMOUNT, 5_000);
  assert.equal(naverSameDayCancellationFee(cancellation()), 5_000);
});

test("전날 취소와 네이버 외 예약 취소는 수수료 매출에서 제외한다", () => {
  assert.equal(
    naverSameDayCancellationFee(
      cancellation({ cancelledAt: "2026-07-31 14:59:59" }),
    ),
    0,
  );
  assert.equal(
    naverSameDayCancellationFee(cancellation({ source: "web_walkin" })),
    0,
  );
  assert.equal(
    naverSameDayCancellationFee(cancellation({ status: "booked" })),
    0,
  );
});

test("migration preserves the first known cancellation time for existing rows", async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE reservations (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE reservation_events (
      reservation_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    INSERT INTO reservations VALUES
      ('with-event', 'cancelled', '2026-08-01 01:00:00', '2026-08-01 08:00:00'),
      ('without-event', 'cancelled', '2026-08-01 02:00:00', '2026-08-01 07:00:00'),
      ('active', 'booked', '2026-08-01 03:00:00', '2026-08-01 06:00:00');
    INSERT INTO reservation_events VALUES
      ('with-event', 'import_cancelled', '2026-08-01 05:00:00'),
      ('with-event', 'import_cancelled', '2026-08-01 06:00:00');
  `);

  const migration = await readFile(
    new URL("drizzle/0011_fat_mariko_yashida.sql", root),
    "utf8",
  );
  db.exec(migration.replaceAll("--> statement-breakpoint", ""));

  const rows = db
    .prepare("SELECT id, cancelled_at FROM reservations ORDER BY id")
    .all()
    .map(({ id, cancelled_at }) => ({ id, cancelled_at }));

  assert.deepEqual(rows, [
    { id: "active", cancelled_at: null },
    { id: "with-event", cancelled_at: "2026-08-01 05:00:00" },
    { id: "without-event", cancelled_at: "2026-08-01 07:00:00" },
  ]);
});
