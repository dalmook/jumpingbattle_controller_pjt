import {
  DEFAULT_PARKING_SETTINGS,
  type ParkingSettings,
} from "@/app/parking-config";
import { getD1 } from "./control";

type ParkingSettingsRow = {
  enabled: number;
  auto_registration_enabled: number;
  registration_url: string;
  session_max_seconds: number;
  updated_at: string;
};

export type StoredParkingSettings = ParkingSettings & { updatedAt: string };

let parkingSettingsSchemaReady: Promise<void> | null = null;

async function initializeParkingSettingsSchema() {
  const db = getD1();
  await db.batch([
    db.prepare(`
      CREATE TABLE IF NOT EXISTS kiosk_parking_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 0,
        auto_registration_enabled INTEGER NOT NULL DEFAULT 0,
        registration_url TEXT NOT NULL,
        session_max_seconds INTEGER NOT NULL DEFAULT 30,
        updated_by TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      CREATE TABLE IF NOT EXISTS parking_setting_audit (
        id TEXT PRIMARY KEY,
        setting_key TEXT NOT NULL,
        previous_value TEXT NOT NULL,
        next_value TEXT NOT NULL,
        changed_by TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `),
    db.prepare(`
      INSERT OR IGNORE INTO kiosk_parking_settings (
        id, enabled, registration_url, session_max_seconds
      ) VALUES (1, ?, ?, ?)
    `).bind(
      DEFAULT_PARKING_SETTINGS.enabled ? 1 : 0,
      DEFAULT_PARKING_SETTINGS.registrationUrl,
      DEFAULT_PARKING_SETTINGS.sessionMaxSeconds,
    ),
  ]);
  const columns = await db.prepare("PRAGMA table_info(kiosk_parking_settings)").all<{ name: string }>();
  if (!columns.results.some((column) => column.name === "auto_registration_enabled")) {
    await db.prepare(`
      ALTER TABLE kiosk_parking_settings
      ADD COLUMN auto_registration_enabled INTEGER NOT NULL DEFAULT 0
    `).run();
  }
}

export async function ensureParkingSettingsSchema() {
  if (!parkingSettingsSchemaReady) {
    parkingSettingsSchemaReady = initializeParkingSettingsSchema().catch((error) => {
      parkingSettingsSchemaReady = null;
      throw error;
    });
  }
  await parkingSettingsSchemaReady;
}

function mapParkingSettings(row: ParkingSettingsRow): StoredParkingSettings {
  return {
    enabled: row.enabled === 1,
    autoRegistrationEnabled: row.auto_registration_enabled === 1,
    registrationUrl: row.registration_url,
    sessionMaxSeconds: row.session_max_seconds,
    updatedAt: row.updated_at,
  };
}

export async function getParkingSettings(): Promise<StoredParkingSettings> {
  await ensureParkingSettingsSchema();
  const row = await getD1().prepare(`
    SELECT enabled, auto_registration_enabled, registration_url, session_max_seconds, updated_at
    FROM kiosk_parking_settings WHERE id = 1
  `).first<ParkingSettingsRow>();
  if (!row) return { ...DEFAULT_PARKING_SETTINGS, updatedAt: "" };
  return mapParkingSettings(row);
}

export async function updateParkingSettings(
  settings: ParkingSettings,
  updatedBy: string,
): Promise<StoredParkingSettings> {
  await ensureParkingSettingsSchema();
  const previous = await getParkingSettings();
  const db = getD1();
  const statements = [db.prepare(`
    UPDATE kiosk_parking_settings SET
      enabled = ?, auto_registration_enabled = ?, registration_url = ?, session_max_seconds = ?,
      updated_by = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = 1
  `).bind(
    settings.enabled ? 1 : 0,
    settings.autoRegistrationEnabled ? 1 : 0,
    settings.registrationUrl,
    settings.sessionMaxSeconds,
    updatedBy,
  )];
  if (previous.autoRegistrationEnabled !== settings.autoRegistrationEnabled) {
    statements.push(db.prepare(`
      INSERT INTO parking_setting_audit
        (id, setting_key, previous_value, next_value, changed_by)
      VALUES (?, 'parkingAutoRegistrationEnabled', ?, ?, ?)
    `).bind(
      crypto.randomUUID(),
      previous.autoRegistrationEnabled ? "true" : "false",
      settings.autoRegistrationEnabled ? "true" : "false",
      updatedBy,
    ));
  }
  await db.batch(statements);
  return getParkingSettings();
}
